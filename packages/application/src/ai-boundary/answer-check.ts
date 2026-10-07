import type { ZodTypeAny } from "zod";
import { TOKEN_PATTERN, type PlaceholderMap } from "./placeholders.js";
import { findRestoredValue } from "./restored-values.js";
import { scanText } from "./scanner.js";

export type OutputBlockReason = "masked_value_leaked" | "unknown_token" | "secret_in_output" | "invalid_output";
export type CheckLog = Record<"O1" | "O2" | "O3" | "O4", "pass" | "fail" | "skipped">;
export type CheckResult =
  | { ok: true; text: string; json?: unknown; checks: CheckLog }
  | { ok: false; reason: OutputBlockReason; checks: CheckLog };

export function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim();
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) attempts.push(fenced[1].trim());
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const start = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (start !== undefined) attempts.push(trimmed.slice(start, Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]")) + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  throw new SyntaxError("No JSON found in model output");
}

const tokensIn = (text: string): string[] => text.match(new RegExp(TOKEN_PATTERN.source, "g")) ?? [];

function restoreString(text: string, map: PlaceholderMap): string {
  return text.replace(new RegExp(TOKEN_PATTERN.source, "g"), (token) => map.lookup(token)?.display ?? token);
}

function deepMap(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => deepMap(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepMap(v, fn)]));
  return value;
}

/** Every string in a parsed value, object keys included, as JSON.parse decoded them. */
function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}

export function checkAnswer(input: {
  raw: string;
  output: "json" | "text";
  schema?: ZodTypeAny;
  map: PlaceholderMap;
  restoreNames?: boolean;
  /** The user-written text actually sent in this request; a replaced value the person typed themselves is not an O1 leak. */
  userText?: string;
  /** Oneon-authored text (instructions, tool catalog, salutation); a name that also appears there is not an O1 leak. */
  authoredText?: string;
}): CheckResult {
  const checks: CheckLog = { O1: "skipped", O2: "skipped", O3: "skipped", O4: "skipped" };
  const restore = (s: string) => (input.restoreNames === false ? s : restoreString(s, input.map));
  const userText = input.userText ?? "";
  // JSON escapes (\uXXXX) decode only on parse, so O1-O3 must also see the decoded strings.
  let parsed: unknown;
  let parseOk = false;
  if (input.output === "json") {
    try {
      parsed = parseJsonLoose(input.raw);
      parseOk = true;
    } catch {
      // O4 reports the failure after O1-O3 have run over the raw text
    }
  }
  const texts = parseOk ? [input.raw, ...collectStrings(parsed, [])] : [input.raw];
  // O1: a real value this turn replaced must not come back. Possible only via another route, so it signals a bug.
  // The person's own words are a sanctioned route, so a value they typed is exempt.
  checks.O1 = findRestoredValue(texts.join("\n"), input.map, userText, input.authoredText) ? "fail" : "pass";
  if (checks.O1 === "fail") return { ok: false, reason: "masked_value_leaked", checks };
  checks.O2 = texts.some((t) => tokensIn(t).some((tok) => input.map.lookup(tok) === null)) ? "fail" : "pass";
  if (checks.O2 === "fail") return { ok: false, reason: "unknown_token", checks };
  checks.O3 = texts.some((t) => scanText(t).d4.length > 0) ? "fail" : "pass";
  if (checks.O3 === "fail") return { ok: false, reason: "secret_in_output", checks };
  if (input.output === "json") {
    const result = !parseOk ? null : input.schema ? input.schema.safeParse(parsed) : { success: true as const, data: parsed };
    if (!result || !result.success) {
      checks.O4 = "fail";
      return { ok: false, reason: "invalid_output", checks };
    }
    // Restoring a name can lengthen a string past a schema limit, so validate again after restoring.
    const restored = deepMap(result.data, restore);
    const again = input.schema ? input.schema.safeParse(restored) : { success: true as const, data: restored };
    if (!again.success) {
      checks.O4 = "fail";
      return { ok: false, reason: "invalid_output", checks };
    }
    checks.O4 = "pass";
    return { ok: true, text: restore(input.raw), json: again.data, checks };
  }
  return { ok: true, text: restore(input.raw), checks };
}

/** Spec §7.2: placeholders in a tool request become real identifiers before the tool runs. */
export function restoreToolParams(
  params: Record<string, unknown>,
  map: PlaceholderMap,
): { ok: true; params: Record<string, unknown> } | { ok: false; token: string } {
  let unknown: string | null = null;
  const scanKeys = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(scanKeys);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        for (const t of tokensIn(k)) if (map.lookup(t) === null && unknown === null) unknown = t;
        scanKeys(x);
      }
  };
  scanKeys(params);
  const restored = deepMap(params, (s) => {
    for (const t of tokensIn(s)) if (map.lookup(t) === null && unknown === null) unknown = t;
    const exact = map.lookup(s.trim());
    if (exact) return exact.entity.id;
    return restoreString(s, map);
  }) as Record<string, unknown>;
  return unknown !== null ? { ok: false, token: unknown } : { ok: true, params: restored };
}
