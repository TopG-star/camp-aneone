import { PURPOSES, allowedFieldsFor, type PurposeDefinition } from "./purposes/index.js";
import { providerLimit, type ProviderEntry, type ProviderOverride } from "./providers.js";
import { scanText } from "./scanner.js";
import { classRank, higherClass, lowerClass, partKey, type ClassifiedField, type DataClass, type ModelContext, type ModelRequest } from "./types.js";

export type DenyReason = "unknown_purpose" | "provider_unavailable" | "invalid_context" | "secret_present" | "required_part_withheld";
export type WithheldReason =
  | "not_allowed_for_purpose"
  | "unclassified"
  | "d3_never_sent"
  | "row_d3"
  | "above_limit"
  | "group_too_small"
  | "part_not_allowed";

export const USER_MESSAGE_CLASS: DataClass = "D1";
export const HISTORY_CLASS: Record<"user" | "assistant", DataClass> = { user: "D1", assistant: "D2" };

export interface LayerSnapshot {
  provider: DataClass | "suspended" | "unknown";
  choice: DataClass;
  purpose: DataClass | null;
}
type Spans = Array<{ start: number; end: number }>;
export type FieldDisposition =
  | { kind: "sent"; d3Spans?: Spans }
  | { kind: "placeholder" }
  | { kind: "aggregate" }
  | { kind: "withheld"; reason: WithheldReason };
export interface PartOutcome {
  index: number;
  key: string;
  disposition?: FieldDisposition;
  turns?: FieldDisposition[];
  rows?: Array<{ withheld?: WithheldReason; fields: FieldDisposition[] }>;
}
export interface WithheldItem {
  part: string;
  field?: string;
  row?: number;
  turn?: number;
  reason: WithheldReason;
}
interface Common {
  layers: LayerSnapshot;
  withheld: WithheldItem[];
  alert: boolean;
  scannerHits: { D3: number; D4: number };
}
export type Decision =
  | (Common & { kind: "deny"; reason: DenyReason; effectiveLimit: DataClass | null })
  | (Common & { kind: "allow"; effectiveLimit: DataClass; parts: PartOutcome[] });

export interface DecideInput {
  context: ModelContext;
  request: ModelRequest;
  provider: { entry: ProviderEntry | undefined; override?: ProviderOverride };
  choiceLimit: DataClass;
  purposes?: Record<string, PurposeDefinition>;
}

const within = (c: DataClass, limit: DataClass) => classRank(c) <= classRank(limit);

function contextComplete(ctx: ModelContext): boolean {
  if (!ctx.identityId) return false;
  return ctx.kind === "personal" || (!!ctx.tenantId && !!ctx.membershipId);
}

export function decide(input: DecideInput): Decision {
  const purposes: Record<string, PurposeDefinition> = input.purposes ?? PURPOSES;
  const def = Object.prototype.hasOwnProperty.call(purposes, input.request.purpose) ? purposes[input.request.purpose] : undefined;
  const pLimit = providerLimit(input.provider.entry, input.context.kind, input.provider.override);
  const common: Common = {
    layers: { provider: pLimit, choice: input.choiceLimit, purpose: def?.limit ?? null },
    withheld: [],
    alert: false,
    scannerHits: { D3: 0, D4: 0 },
  };
  const deny = (reason: DenyReason, effectiveLimit: DataClass | null): Decision => ({ ...common, kind: "deny", reason, effectiveLimit });

  // ── Stage 1 ──
  if (!def) return deny("unknown_purpose", null);
  if (pLimit === "suspended" || pLimit === "unknown") return deny("provider_unavailable", null);
  if (!contextComplete(input.context)) return deny("invalid_context", null);
  const limit = lowerClass(lowerClass(pLimit, input.choiceLimit), def.limit);

  // C4: declared D4, rowClass D4, or a scanner D4 hit in any free text. Scan results are kept for stage 2b.
  const scans = new Map<string, Spans>();
  let secret = false;
  const scanFree = (key: string, text: string) => {
    const result = scanText(text);
    if (result.d4.length > 0) {
      secret = true;
      common.scannerHits.D4 += result.d4.length;
    }
    if (result.d3Spans.length > 0) scans.set(key, result.d3Spans);
  };
  input.request.parts.forEach((part, p) => {
    if (part.kind === "user_message") scanFree(`${p}`, part.text);
    if (part.kind === "history") part.turns.forEach((t, i) => scanFree(`${p}:${i}`, t.text));
    if (part.kind === "record") {
      part.rows.forEach((r, ri) => {
        if (r.rowClass === "D4") secret = true;
        r.fields.forEach((f, fi) => {
          if (f.class === "D4") secret = true;
          if (f.freeText && typeof f.value === "string") scanFree(`${p}:${ri}:${fi}`, f.value);
        });
      });
    }
  });
  if (secret) return deny("secret_present", limit);

  // ── Stage 2 ──
  const sentWith = (key: string): FieldDisposition => {
    const spans = scans.get(key);
    if (spans) common.scannerHits.D3 += 1; // one hit per text, however many overlapping patterns matched
    return spans ? { kind: "sent", d3Spans: spans } : { kind: "sent" };
  };
  const withhold = (item: WithheldItem): FieldDisposition => {
    common.withheld.push(item);
    if (item.reason === "not_allowed_for_purpose" || item.reason === "unclassified") common.alert = true;
    return { kind: "withheld", reason: item.reason };
  };

  const parts: PartOutcome[] = input.request.parts.map((part, p) => {
    const key = partKey(part);
    if (!def.allowedParts.includes(part.kind)) return { index: p, key, disposition: withhold({ part: key, reason: "part_not_allowed" }) };
    switch (part.kind) {
      case "instruction":
      case "tool_catalog":
        return { index: p, key, disposition: { kind: "sent" } };
      case "user_message":
        return {
          index: p,
          key,
          disposition: within(USER_MESSAGE_CLASS, limit) ? sentWith(`${p}`) : withhold({ part: key, reason: "above_limit" }),
        };
      case "history":
        return {
          index: p,
          key,
          turns: part.turns.map((t, i) =>
            within(HISTORY_CLASS[t.role], limit) ? sentWith(`${p}:${i}`) : withhold({ part: key, turn: i, reason: "above_limit" }),
          ),
        };
      case "record": {
        const allowed = allowedFieldsFor(def, part.source);
        if (allowed === null) {
          common.withheld.push({ part: key, reason: "not_allowed_for_purpose" });
          common.alert = true;
          return { index: p, key, rows: part.rows.map(() => ({ withheld: "not_allowed_for_purpose" as const, fields: [] })) };
        }
        const rows = part.rows.map((r, ri) => {
          if (r.rowClass === "D3") {
            common.withheld.push({ part: key, row: ri, reason: "row_d3" });
            return { withheld: "row_d3" as const, fields: [] };
          }
          const fields = r.fields.map((f, fi) => fieldDisposition(f, r.rowClass, allowed, limit, def.minGroupSize, `${p}:${ri}:${fi}`, (reason) =>
            withhold({ part: key, row: ri, field: f.name, reason }),
          ));
          return { fields };
        });
        return { index: p, key, rows };
      }
    }
  });

  function fieldDisposition(
    f: ClassifiedField,
    rowClass: DataClass | undefined,
    allowed: readonly string[] | "declared",
    lim: DataClass,
    minGroup: number,
    scanKey: string,
    hold: (reason: WithheldReason) => FieldDisposition,
  ): FieldDisposition {
    if (allowed !== "declared" && !allowed.includes(f.name)) return hold("not_allowed_for_purpose"); // F1
    if (f.class === null) return hold("unclassified"); // F2
    const effective = rowClass ? higherClass(f.class, rowClass) : f.class;
    if (effective === "D3") return hold("d3_never_sent"); // F3
    if (within(effective, lim)) return f.freeText ? sentWith(scanKey) : { kind: "sent" }; // F4
    if (f.aggregate) {
      // F5 (aggregate)
      if (f.aggregate.count < minGroup) return hold("group_too_small");
      return within(f.aggregate.classIfSafe, lim) ? { kind: "aggregate" } : hold("above_limit");
    }
    if (f.entity && !f.freeText && within("D1", lim)) return { kind: "placeholder" }; // F5 (placeholder)
    return hold("above_limit"); // F6
  }

  // ── Stage 3 ──
  // A required key is either a bare part key (met when the part released anything) or
  // "record:<source>#<field>" (met when a non-withheld row released that named field).
  const sentKeys = new Set<string>();
  const sentFieldKeys = new Set<string>();
  for (const outcome of parts) {
    const part = input.request.parts[outcome.index];
    const sent =
      outcome.disposition?.kind === "sent" ||
      (outcome.turns ?? []).some((t) => t.kind === "sent") ||
      (outcome.rows ?? []).some((r) => r.fields.some((f) => f.kind !== "withheld"));
    if (sent) sentKeys.add(outcome.key);
    if (part.kind === "record") {
      (outcome.rows ?? []).forEach((r, ri) => {
        if (r.withheld) return;
        r.fields.forEach((f, fi) => {
          if (f.kind !== "withheld") sentFieldKeys.add(`${outcome.key}#${part.rows[ri].fields[fi].name}`);
        });
      });
    }
  }
  const met = (k: string) => (k.includes("#") ? sentFieldKeys.has(k) : sentKeys.has(k));
  const allMet = (def.required.all ?? []).every(met);
  const anyMet = !def.required.anyOf || def.required.anyOf.some(met);
  if (!allMet || !anyMet) return deny("required_part_withheld", limit);

  return { ...common, kind: "allow", effectiveLimit: limit, parts };
}
