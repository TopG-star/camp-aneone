import type { ZodTypeAny } from "zod";
import { TOKEN_PATTERN, type PlaceholderMap } from "./placeholders.js";
import { scanText } from "./scanner.js";

export type OutputBlockReason = "masked_value_leaked" | "unknown_token" | "secret_in_output" | "invalid_output";
export type CheckLog = Record<"O1" | "O2" | "O3" | "O4", "pass" | "fail" | "skipped">;
export type CheckResult =
  | { ok: true; text: string; json?: unknown; checks: CheckLog }
  | { ok: false; reason: OutputBlockReason; checks: CheckLog };

const MIN_LEAK_LENGTH = 3;

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

export function checkAnswer(input: {
  raw: string;
  output: "json" | "text";
  schema?: ZodTypeAny;
  map: PlaceholderMap;
  restoreNames?: boolean;
  /** The user-written text actually sent in this request; a replaced value the person typed themselves is not an O1 leak. */
  userText?: string;
}): CheckResult {
  const checks: CheckLog = { O1: "skipped", O2: "skipped", O3: "skipped", O4: "skipped" };
  const restore = (s: string) => (input.restoreNames === false ? s : restoreString(s, input.map));
  const lower = input.raw.toLowerCase();
  const userLower = (input.userText ?? "").toLowerCase();
  // O1: a real value this turn replaced must not come back. Possible only via another route, so it signals a bug.
  // The person's own words are a sanctioned route, so a value they typed is exempt.
  checks.O1 = input.map
    .displays()
    .some((d) => d.length >= MIN_LEAK_LENGTH && lower.includes(d.toLowerCase()) && !userLower.includes(d.toLowerCase()))
    ? "fail"
    : "pass";
  if (checks.O1 === "fail") return { ok: false, reason: "masked_value_leaked", checks };
  checks.O2 = tokensIn(input.raw).some((t) => input.map.lookup(t) === null) ? "fail" : "pass";
  if (checks.O2 === "fail") return { ok: false, reason: "unknown_token", checks };
  checks.O3 = scanText(input.raw).d4.length > 0 ? "fail" : "pass";
  if (checks.O3 === "fail") return { ok: false, reason: "secret_in_output", checks };
  if (input.output === "json") {
    let parsed: unknown;
    try {
      parsed = parseJsonLoose(input.raw);
    } catch {
      checks.O4 = "fail";
      return { ok: false, reason: "invalid_output", checks };
    }
    const result = input.schema ? input.schema.safeParse(parsed) : { success: true as const, data: parsed };
    checks.O4 = result.success ? "pass" : "fail";
    if (!result.success) return { ok: false, reason: "invalid_output", checks };
    return { ok: true, text: restore(input.raw), json: deepMap(result.data, restore), checks };
  }
  return { ok: true, text: restore(input.raw), checks };
}

/** Spec §7.2: placeholders in a tool request become real identifiers before the tool runs. */
export function restoreToolParams(
  params: Record<string, unknown>,
  map: PlaceholderMap,
): { ok: true; params: Record<string, unknown> } | { ok: false; token: string } {
  let unknown: string | null = null;
  const restored = deepMap(params, (s) => {
    for (const t of tokensIn(s)) if (map.lookup(t) === null && unknown === null) unknown = t;
    const exact = map.lookup(s);
    if (exact) return exact.entity.id;
    return restoreString(s, map);
  }) as Record<string, unknown>;
  return unknown !== null ? { ok: false, token: unknown } : { ok: true, params: restored };
}
