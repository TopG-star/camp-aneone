# Phase 2 — Engine

The decision engine, placeholders, prompt assembly, the answer check, audit storage and the gateway. Still no behaviour change: nothing calls the gateway until Phase 4. Spec sections: §5.2, §5.3, §6, §7, §8.

---

### Task 5: Decision engine

Spec §6.3–§6.6. A pure function: no I/O, no clock.

**Files:**
- Create: `packages/application/src/ai-boundary/decide.ts`
- Create: `packages/application/src/ai-boundary/__tests__/builders.ts` (test helpers)
- Modify: `packages/application/src/ai-boundary/index.ts` (add `export * from "./decide.js";`)
- Test: `packages/application/src/ai-boundary/decide.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `type DenyReason`, `type WithheldReason` (exact strings in the Global Constraints)
  - `LayerSnapshot { provider: DataClass | "suspended" | "unknown"; choice: DataClass; purpose: DataClass | null }`
  - `type FieldDisposition = { kind: "sent"; d3Spans?: Array<{start:number;end:number}> } | { kind: "placeholder" } | { kind: "aggregate" } | { kind: "withheld"; reason: WithheldReason }`
  - `PartOutcome { index: number; key: string; disposition?: FieldDisposition; turns?: FieldDisposition[]; rows?: Array<{ withheld?: WithheldReason; fields: FieldDisposition[] }> }`
  - `WithheldItem { part: string; field?: string; row?: number; turn?: number; reason: WithheldReason }`
  - `type Decision = { kind: "deny"; reason: DenyReason; effectiveLimit: DataClass | null; layers; withheld; alert; scannerHits } | { kind: "allow"; effectiveLimit: DataClass; layers; parts: PartOutcome[]; withheld; alert; scannerHits }`, where `scannerHits: { D3: number; D4: number }`
  - `decide(input: DecideInput): Decision`, with `DecideInput { context: ModelContext; request: ModelRequest; provider: { entry: ProviderEntry | undefined; override?: ProviderOverride }; choiceLimit: DataClass; purposes?: Record<string, PurposeDefinition> }`
  - `HISTORY_CLASS = { user: "D1", assistant: "D2" }`, `USER_MESSAGE_CLASS = "D1"`

- [ ] **Step 1: Write the test helpers**

`__tests__/builders.ts`:

```ts
import { instruction } from "../instruction.js";
import { PROVIDER_REGISTRY } from "../providers.js";
import type { ClassifiedField, ClassifiedRow, DataClass, ModelContext, ModelRequest, PromptPart } from "../types.js";
import type { DecideInput } from "../decide.js";

export const personal: ModelContext = { kind: "personal", identityId: "u1" };
export const tenant: ModelContext = { kind: "tenant", identityId: "u1", tenantId: "t1", membershipId: "m1" };

export const field = (name: string, cls: DataClass | null, value: unknown, extra: Partial<ClassifiedField> = {}): ClassifiedField => ({
  name,
  class: cls,
  value,
  ...extra,
});
export const row = (fields: ClassifiedField[], rowClass?: DataClass): ClassifiedRow => ({ fields, ...(rowClass ? { rowClass } : {}) });
export const record = (source: string, rows: ClassifiedRow[]): PromptPart => ({ kind: "record", source, rows });
export const userMessage = (text: string): PromptPart => ({ kind: "user_message", text });
export const sys = (): PromptPart => ({ kind: "instruction", text: instruction`extra rule` });

export const emailRecord = (overrides: Partial<Record<string, unknown>> = {}) =>
  record("email", [
    row([
      field("from", "D2", overrides.from ?? "ama@example.com", { entity: { type: "person", id: String(overrides.from ?? "ama@example.com") } }),
      field("subject", "D2", overrides.subject ?? "Invoice", { freeText: true }),
      field("bodyPreview", "D2", overrides.bodyPreview ?? "Please pay by Friday.", { freeText: true }),
      field("receivedAt", "D1", "2026-10-03T09:00:00Z"),
      field("source", "D0", "gmail"),
    ]),
  ]);

export function input(overrides: Partial<DecideInput> & { request?: Partial<ModelRequest> } = {}): DecideInput {
  const { request, ...rest } = overrides;
  return {
    context: personal,
    provider: { entry: PROVIDER_REGISTRY.deepseek },
    choiceLimit: "D2",
    ...rest,
    request: { purpose: "email_classification", output: "json", parts: [emailRecord()], ...request },
  };
}
```

- [ ] **Step 2: Write the failing decision-table test**

`decide.test.ts`. Every rule in spec §6 has a row (§12):

```ts
import { describe, it, expect } from "vitest";
import { decide } from "./decide.js";
import { PROVIDER_REGISTRY } from "./providers.js";
import { emailRecord, field, input, personal, record, row, tenant, userMessage } from "./__tests__/builders.js";

describe("decide — stage 1 (whole call)", () => {
  it("C1 denies an unknown purpose", () => {
    expect(decide(input({ request: { purpose: "summarise_everything" } }))).toMatchObject({ kind: "deny", reason: "unknown_purpose" });
  });
  it("C2 denies an unknown provider", () => {
    expect(decide(input({ provider: { entry: undefined } }))).toMatchObject({ kind: "deny", reason: "provider_unavailable" });
  });
  it("C2 denies a suspended provider", () => {
    expect(decide(input({ provider: { entry: PROVIDER_REGISTRY.anthropic, override: { kind: "suspended" } } }))).toMatchObject({
      kind: "deny",
      reason: "provider_unavailable",
    });
  });
  it("C3 denies an incomplete tenant context", () => {
    expect(decide(input({ context: { ...tenant, membershipId: "" } }))).toMatchObject({ kind: "deny", reason: "invalid_context" });
  });
  it("C4 denies a declared D4 field", () => {
    const parts = [record("email", [row([field("from", "D4", "x")])])];
    expect(decide(input({ request: { parts } }))).toMatchObject({ kind: "deny", reason: "secret_present" });
  });
  it("C4 denies a row with rowClass D4", () => {
    const parts = [record("email", [row([field("source", "D0", "gmail")], "D4")])];
    expect(decide(input({ request: { parts } }))).toMatchObject({ kind: "deny", reason: "secret_present" });
  });
  it("C4 denies free text containing an API key, and counts the hit without the text", () => {
    const d = decide(input({ request: { parts: [emailRecord({ bodyPreview: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123" })] } }));
    expect(d).toMatchObject({ kind: "deny", reason: "secret_present", scannerHits: { D4: 1 } });
    expect(JSON.stringify(d)).not.toContain("sk-ant");
  });
});

describe("decide — personal opt-in", () => {
  it("denies email classification at the D1 default (required part above the limit)", () => {
    expect(decide(input({ choiceLimit: "D1" }))).toMatchObject({ kind: "deny", reason: "required_part_withheld", effectiveLimit: "D1" });
  });
  it("allows it after a D2 opt-in", () => {
    expect(decide(input({ choiceLimit: "D2" }))).toMatchObject({ kind: "allow", effectiveLimit: "D2" });
  });
});

describe("decide — stage 2 (fields)", () => {
  const chat = (parts: Parameters<typeof record>[1], limit: "D1" | "D2" = "D1", ctx = tenant) =>
    decide(input({ context: ctx, choiceLimit: limit, request: { purpose: "chat_reply", parts: [userMessage("who owes us?"), record("tool:receivables", parts)] } }));

  it("F0 withholds a whole rowClass-D3 row and sends its siblings", () => {
    const d = chat([row([field("name", "D2", "Kofi", { entity: { type: "customer", id: "c1" } })], "D3"), row([field("daysOverdue", "D1", 12)])]);
    expect(d.kind).toBe("allow");
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, reason: "row_d3" });
    if (d.kind === "allow") expect(d.parts[1].rows![1].fields[0]).toEqual({ kind: "sent" });
  });
  it("F1 withholds a field outside the purpose's allowlist, with an alert", () => {
    const d = decide(input({ request: { parts: [record("email", [row([field("source", "D0", "gmail"), field("bcc", "D2", "x")])])] } }));
    expect(d.withheld).toContainEqual({ part: "record:email", row: 0, field: "bcc", reason: "not_allowed_for_purpose" });
    expect(d.alert).toBe(true);
  });
  it("F2 withholds an unclassified field, with an alert", () => {
    const d = chat([row([field("daysOverdue", "D1", 12), field("mystery", null, "?")])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "mystery", reason: "unclassified" });
    expect(d.alert).toBe(true);
  });
  it("F3 withholds a declared D3 field even under a D2 limit", () => {
    const d = chat([row([field("daysOverdue", "D1", 12), field("buyerName", "D3", "Kofi")])], "D2", personal);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "buyerName", reason: "d3_never_sent" });
  });
  it("F4 sends a field at or below the limit", () => {
    const d = chat([row([field("daysOverdue", "D1", 12)])]);
    if (d.kind === "allow") expect(d.parts[1].rows![0].fields[0]).toEqual({ kind: "sent" });
  });
  it("F5 downgrades a declared entity to a placeholder while a sibling D2 field is withheld (spec Appendix B)", () => {
    const d = chat([row([field("name", "D2", "ABC Hospital", { entity: { type: "customer", id: "c1" } }), field("balance", "D2", 18400), field("daysOverdue", "D1", 73)])]);
    expect(d.kind).toBe("allow");
    if (d.kind === "allow") {
      expect(d.parts[1].rows![0].fields.map((f) => f.kind)).toEqual(["placeholder", "withheld", "sent"]);
    }
  });
  it("F5 never placeholders free text", () => {
    const d = chat([row([field("daysOverdue", "D1", 1), field("note", "D2", "call ABC", { freeText: true, entity: { type: "customer", id: "c1" } })])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "note", reason: "above_limit" });
  });
  it("F5 sends an aggregate over at least 5 records and suppresses a smaller one", () => {
    const d = chat([
      row([field("district", "D1", "Osu"), field("total", "D2", 900, { aggregate: { count: 5, classIfSafe: "D1" } })]),
      row([field("district", "D1", "Tema"), field("total", "D2", 400, { aggregate: { count: 2, classIfSafe: "D1" } })]),
    ]);
    if (d.kind === "allow") expect(d.parts[1].rows![0].fields[1]).toEqual({ kind: "aggregate" });
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 1, field: "total", reason: "group_too_small" });
  });
  it("F6 withholds a D2 field with no downgrade under a D1 limit", () => {
    const d = chat([row([field("daysOverdue", "D1", 1), field("balance", "D2", 10)])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "balance", reason: "above_limit" });
  });
});

describe("decide — stage 2b (free text)", () => {
  it("sends the user's message at D1 and withholds earlier assistant replies (spec §10.2)", () => {
    const d = decide(
      input({
        choiceLimit: "D1",
        request: {
          purpose: "chat_reply",
          parts: [{ kind: "history", turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "Ama owes you" }] }, userMessage("and now?")],
        },
      }),
    );
    expect(d.kind).toBe("allow");
    expect(d.withheld).toContainEqual({ part: "history", turn: 1, reason: "above_limit" });
  });
  it("removes a D3 span from a sent message and counts it", () => {
    const d = decide(input({ request: { purpose: "chat_reply", parts: [userMessage("I was diagnosed with HIV, remind me of my appointment")] } }));
    expect(d).toMatchObject({ kind: "allow", scannerHits: { D3: 1 } });
    if (d.kind === "allow") expect(d.parts[0].disposition).toMatchObject({ kind: "sent", d3Spans: [expect.any(Object)] });
  });
});

describe("decide — stage 3 (requirements) and part allowlist", () => {
  it("R1 denies when a required part is withheld", () => {
    expect(decide(input({ request: { purpose: "chat_reply", parts: [record("tool:x", [row([field("a", "D1", 1)])])] } }))).toMatchObject({
      kind: "deny",
      reason: "required_part_withheld",
    });
  });
  it("denies a briefing whose three sections are all empty, even with pending actions present", () => {
    const d = decide(
      input({
        choiceLimit: "D1",
        request: {
          purpose: "daily_briefing",
          output: "text",
          parts: [
            record("calendar", [row([field("title", "D2", "Dentist", { freeText: true })])]),
            record("pending_actions", [row([field("actionType", "D1", "notify")])]),
          ],
        },
      }),
    );
    expect(d).toMatchObject({ kind: "deny", reason: "required_part_withheld" });
  });
  it("withholds a part kind the purpose does not allow", () => {
    const d = decide(input({ request: { parts: [emailRecord(), userMessage("hi")] } }));
    expect(d.withheld).toContainEqual({ part: "user_message", reason: "part_not_allowed" });
  });
  it("withholds a whole record from an unknown source", () => {
    const d = decide(input({ request: { parts: [emailRecord(), record("secrets", [row([field("a", "D0", 1)])])] } }));
    expect(d.withheld).toContainEqual({ part: "record:secrets", reason: "not_allowed_for_purpose" });
  });
  it("takes the lowest layer as the effective limit (tenant hardcode D1)", () => {
    expect(decide(input({ context: tenant, choiceLimit: "D1", request: { purpose: "chat_reply", parts: [userMessage("hi")] } }))).toMatchObject({
      kind: "allow",
      effectiveLimit: "D1",
      layers: { provider: "D1", choice: "D1", purpose: "D2" },
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/decide.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
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
  const purposes = input.purposes ?? PURPOSES;
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
  const sentKeys = new Set<string>();
  for (const outcome of parts) {
    const sent =
      outcome.disposition?.kind === "sent" ||
      (outcome.turns ?? []).some((t) => t.kind === "sent") ||
      (outcome.rows ?? []).some((r) => r.fields.some((f) => f.kind !== "withheld"));
    if (sent) sentKeys.add(outcome.key);
  }
  const allMet = (def.required.all ?? []).every((k) => sentKeys.has(k));
  const anyMet = !def.required.anyOf || def.required.anyOf.some((k) => sentKeys.has(k));
  if (!allMet || !anyMet) return deny("required_part_withheld", limit);

  return { ...common, kind: "allow", effectiveLimit: limit, parts };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/decide.test.ts`
Expected: PASS (all rows).

- [ ] **Step 6: Full suite and commit**

```bash
git add packages/application/src/ai-boundary
git commit -m "feat(ai-boundary): add the MECE decision engine with a rule-by-rule table"
```

---

### Task 6: Placeholders and prompt assembly

Spec §7.1, §5.2 steps 2–3, §12 golden files.

**Files:**
- Create: `packages/application/src/ai-boundary/placeholders.ts`
- Create: `packages/application/src/ai-boundary/assemble.ts`
- Modify: `packages/application/src/ai-boundary/index.ts` (export both)
- Test: `packages/application/src/ai-boundary/placeholders.test.ts`, `assemble.test.ts`

**Interfaces:**
- Consumes: `Decision`, `PartOutcome`, `FieldDisposition` (Task 5); `removeSpans` (Task 4); `PurposeDefinition` (Task 3).
- Produces:
  - `KNOWN_ENTITY_TYPES = ["PERSON", "CUSTOMER", "SUPPLIER"]`, `TOKEN_PATTERN` (global regex)
  - `class PlaceholderMap { tokenFor(entity: EntityRef, display: string): string; lookup(token): { entity: EntityRef; display: string } | null; displays(): string[]; size: number }`
  - `ReleasedShapeEntry { part: string; field: string; outcome: "sent" | "placeholder" | "aggregate" | \`withheld:${WithheldReason}\` }`
  - `AssembledPrompt { system: string; user: string; released: ReleasedShapeEntry[]; placeholderCount: number }`
  - `assemblePrompt(request: ModelRequest, decision: Extract<Decision, { kind: "allow" }>, def: PurposeDefinition, map: PlaceholderMap): AssembledPrompt`

- [ ] **Step 1: Write the failing tests**

`placeholders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PlaceholderMap, TOKEN_PATTERN } from "./placeholders.js";

describe("PlaceholderMap", () => {
  it("numbers each entity type from 1 and reuses a token for the same entity", () => {
    const map = new PlaceholderMap();
    expect(map.tokenFor({ type: "customer", id: "c9" }, "ABC Hospital")).toBe("CUSTOMER_1");
    expect(map.tokenFor({ type: "customer", id: "c4" }, "Mensah Pharmacy")).toBe("CUSTOMER_2");
    expect(map.tokenFor({ type: "customer", id: "c9" }, "ABC Hospital")).toBe("CUSTOMER_1");
    expect(map.tokenFor({ type: "person", id: "ama@x.com" }, "ama@x.com")).toBe("PERSON_1");
    expect(map.size).toBe(3);
  });
  it("starts again at 1 in a new turn, so tokens cannot be linked across turns", () => {
    const a = new PlaceholderMap();
    const b = new PlaceholderMap();
    expect(a.tokenFor({ type: "customer", id: "c9" }, "x")).toBe(b.tokenFor({ type: "customer", id: "other" }, "y"));
  });
  it("refuses an entity type it does not know", () => {
    expect(() => new PlaceholderMap().tokenFor({ type: "patient", id: "p1" }, "x")).toThrow("Unknown entity type");
  });
  it("matches only known token shapes", () => {
    expect("CUSTOMER_1 owes; COVID_19 is not a token; PERSON_12 is".match(TOKEN_PATTERN)).toEqual(["CUSTOMER_1", "PERSON_12"]);
  });
});
```

`assemble.test.ts` (golden prompts, compared as full strings):

```ts
import { describe, it, expect } from "vitest";
import { assemblePrompt } from "./assemble.js";
import { decide } from "./decide.js";
import { PlaceholderMap } from "./placeholders.js";
import { PURPOSES } from "./purposes/index.js";
import { emailRecord, field, input, record, row, tenant, userMessage } from "./__tests__/builders.js";

function allowed(d: ReturnType<typeof decide>) {
  if (d.kind !== "allow") throw new Error(`expected allow, got ${JSON.stringify(d)}`);
  return d;
}

describe("assemblePrompt (golden)", () => {
  it("renders email classification", () => {
    const i = input();
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.email_classification, new PlaceholderMap());
    expect(out.system).toBe(PURPOSES.email_classification.instructions);
    expect(out.user).toBe(
      [
        "=== EMAIL ===",
        "- from: ama@example.com | subject: Invoice | bodyPreview: Please pay by Friday. | receivedAt: 2026-10-03T09:00:00Z | source: gmail",
      ].join("\n"),
    );
    expect(out.placeholderCount).toBe(0);
  });

  it("renders a tenant chat reply with a placeholder and a withheld balance (spec Appendix B)", () => {
    const i = input({
      context: tenant,
      choiceLimit: "D1",
      request: {
        purpose: "chat_reply",
        parts: [
          record("tool:receivables", [
            row([field("name", "D2", "ABC Hospital", { entity: { type: "customer", id: "c9" } }), field("balance", "D2", 18400), field("daysOverdue", "D1", 73)]),
          ]),
          userMessage("Which customers owe us more than GHS 5,000?"),
        ],
      },
    });
    const map = new PlaceholderMap();
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.chat_reply, map);
    expect(out.user).toBe(
      [
        "=== TOOL:RECEIVABLES ===",
        "- name: CUSTOMER_1 | daysOverdue: 73",
        "",
        "=== USER MESSAGE ===",
        "Which customers owe us more than GHS 5,000?",
      ].join("\n"),
    );
    expect(out.user).not.toContain("ABC Hospital");
    expect(out.user).not.toContain("18400");
    expect(map.lookup("CUSTOMER_1")).toEqual({ entity: { type: "customer", id: "c9" }, display: "ABC Hospital" });
    expect(out.released).toEqual([
      { part: "record:tool:receivables", field: "name", outcome: "placeholder" },
      { part: "record:tool:receivables", field: "balance", outcome: "withheld:above_limit" },
      { part: "record:tool:receivables", field: "daysOverdue", outcome: "sent" },
      { part: "user_message", field: "*", outcome: "sent" },
    ]);
  });

  it("replaces D3 spans with [removed] and omits withheld history turns", () => {
    const i = input({
      choiceLimit: "D1",
      request: {
        purpose: "chat_reply",
        parts: [
          { kind: "history", turns: [{ role: "user", text: "hello" }, { role: "assistant", text: "Ama owes GHS 400" }] },
          userMessage("I was diagnosed with HIV. Remind me tomorrow."),
        ],
      },
    });
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.chat_reply, new PlaceholderMap());
    expect(out.user).toBe(["=== HISTORY ===", "[user]: hello", "", "=== USER MESSAGE ===", "I was [removed]. Remind me tomorrow."].join("\n"));
  });

  it("renders the tool catalog for intent extraction", () => {
    const i = input({
      request: { purpose: "intent_extraction", parts: [{ kind: "tool_catalog", tools: [{ name: "list_inbox", description: "List emails" }] }, userMessage("inbox?")] },
    });
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.intent_extraction, new PlaceholderMap());
    expect(out.user).toBe(["=== TOOLS ===", "- list_inbox: List emails", "", "=== USER MESSAGE ===", "inbox?"].join("\n"));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/placeholders.test.ts src/ai-boundary/assemble.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`placeholders.ts`:

```ts
import type { EntityRef } from "./types.js";

export const KNOWN_ENTITY_TYPES = ["PERSON", "CUSTOMER", "SUPPLIER"] as const;
export const TOKEN_PATTERN = new RegExp(`\\b(?:${KNOWN_ENTITY_TYPES.join("|")})_\\d+\\b`, "g");

/** One turn's mapping between real entities and placeholders. In memory only; never logged (spec §7.1). */
export class PlaceholderMap {
  private readonly byEntity = new Map<string, string>();
  private readonly byToken = new Map<string, { entity: EntityRef; display: string }>();
  private readonly counters = new Map<string, number>();

  tokenFor(entity: EntityRef, display: string): string {
    const prefix = entity.type.toUpperCase();
    if (!(KNOWN_ENTITY_TYPES as readonly string[]).includes(prefix)) throw new Error(`Unknown entity type "${entity.type}"`);
    const key = `${prefix}:${entity.id}`;
    const existing = this.byEntity.get(key);
    if (existing) return existing;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const token = `${prefix}_${n}`;
    this.byEntity.set(key, token);
    this.byToken.set(token, { entity, display });
    return token;
  }

  lookup(token: string): { entity: EntityRef; display: string } | null {
    return this.byToken.get(token) ?? null;
  }

  displays(): string[] {
    return [...this.byToken.values()].map((v) => v.display);
  }

  get size(): number {
    return this.byToken.size;
  }
}
```

`assemble.ts`:

```ts
import type { Decision, FieldDisposition, WithheldReason } from "./decide.js";
import type { PlaceholderMap } from "./placeholders.js";
import type { PurposeDefinition } from "./purposes/index.js";
import { removeSpans } from "./scanner.js";
import type { ModelRequest } from "./types.js";

export interface ReleasedShapeEntry {
  part: string;
  field: string;
  outcome: "sent" | "placeholder" | "aggregate" | `withheld:${WithheldReason}`;
}
export interface AssembledPrompt {
  system: string;
  user: string;
  released: ReleasedShapeEntry[];
  placeholderCount: number;
}

const render = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value) ?? "null");
const shape = (d: FieldDisposition): ReleasedShapeEntry["outcome"] => (d.kind === "withheld" ? `withheld:${d.reason}` : d.kind);

export function assemblePrompt(
  request: ModelRequest,
  decision: Extract<Decision, { kind: "allow" }>,
  def: PurposeDefinition,
  map: PlaceholderMap,
): AssembledPrompt {
  const system: string[] = [def.instructions];
  const blocks: string[] = [];
  const released: ReleasedShapeEntry[] = [];

  request.parts.forEach((part, p) => {
    const outcome = decision.parts[p];
    const disposition = outcome.disposition;
    if (part.kind === "instruction") {
      if (disposition?.kind === "sent") system.push(part.text);
      return;
    }
    if (part.kind === "tool_catalog") {
      if (disposition?.kind === "sent") blocks.push(["=== TOOLS ===", ...part.tools.map((t) => `- ${t.name}: ${t.description}`)].join("\n"));
      return;
    }
    if (part.kind === "user_message") {
      released.push({ part: outcome.key, field: "*", outcome: shape(disposition!) });
      if (disposition?.kind === "sent") blocks.push(`=== USER MESSAGE ===\n${removeSpans(part.text, disposition.d3Spans ?? [])}`);
      return;
    }
    if (part.kind === "history") {
      const lines: string[] = [];
      part.turns.forEach((t, i) => {
        const d = outcome.turns![i];
        released.push({ part: outcome.key, field: `turn:${i}`, outcome: shape(d) });
        if (d.kind === "sent") lines.push(`[${t.role}]: ${removeSpans(t.text, d.d3Spans ?? [])}`);
      });
      if (lines.length > 0) blocks.push(["=== HISTORY ===", ...lines].join("\n"));
      return;
    }
    // record
    const lines: string[] = [];
    part.rows.forEach((r, ri) => {
      const rowOutcome = outcome.rows![ri];
      if (rowOutcome.withheld) {
        released.push({ part: outcome.key, field: `row:${ri}`, outcome: `withheld:${rowOutcome.withheld}` });
        return;
      }
      const cells: string[] = [];
      r.fields.forEach((f, fi) => {
        const d = rowOutcome.fields[fi];
        released.push({ part: outcome.key, field: f.name, outcome: shape(d) });
        if (d.kind === "placeholder") cells.push(`${f.name}: ${map.tokenFor(f.entity!, render(f.value))}`);
        else if (d.kind === "sent") cells.push(`${f.name}: ${typeof f.value === "string" ? removeSpans(f.value, d.d3Spans ?? []) : render(f.value)}`);
        else if (d.kind === "aggregate") cells.push(`${f.name}: ${render(f.value)}`);
      });
      if (cells.length > 0) lines.push(`- ${cells.join(" | ")}`);
    });
    if (lines.length > 0) blocks.push([`=== ${part.source.toUpperCase()} ===`, ...lines].join("\n"));
  });

  return { system: system.join("\n\n"), user: blocks.join("\n\n"), released, placeholderCount: map.size };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/placeholders.test.ts src/ai-boundary/assemble.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/application/src/ai-boundary
git commit -m "feat(ai-boundary): add turn-scoped placeholders and golden-tested prompt assembly"
```

---

### Task 7: Answer check and restoration

Spec §7.2, §7.3.

**Files:**
- Create: `packages/application/src/ai-boundary/answer-check.ts`
- Modify: `packages/application/src/ai-boundary/index.ts`
- Test: `packages/application/src/ai-boundary/answer-check.test.ts`

**Interfaces:**
- Consumes: `PlaceholderMap`, `TOKEN_PATTERN` (Task 6); `scanText` (Task 4).
- Produces:
  - `type OutputBlockReason = "masked_value_leaked" | "unknown_token" | "secret_in_output" | "invalid_output"`
  - `type CheckLog = Record<"O1" | "O2" | "O3" | "O4", "pass" | "fail" | "skipped">`
  - `checkAnswer(input: { raw: string; output: "json" | "text"; schema?: ZodTypeAny; map: PlaceholderMap; restoreNames?: boolean }): { ok: true; text: string; json?: unknown; checks: CheckLog } | { ok: false; reason: OutputBlockReason; checks: CheckLog }`. `restoreNames` defaults to true; when false, O1–O4 still run but tokens stay in place.
  - `restoreToolParams(params: Record<string, unknown>, map: PlaceholderMap): { ok: true; params: Record<string, unknown> } | { ok: false; token: string }`
  - `parseJsonLoose(raw: string): unknown`, which throws `SyntaxError` when nothing parses

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { checkAnswer, parseJsonLoose, restoreToolParams } from "./answer-check.js";
import { PlaceholderMap } from "./placeholders.js";

const mapWithAbc = () => {
  const map = new PlaceholderMap();
  map.tokenFor({ type: "customer", id: "c9" }, "ABC Hospital");
  return map;
};

describe("checkAnswer", () => {
  it("O5 restores real names for this turn's tokens", () => {
    expect(checkAnswer({ raw: "Chase CUSTOMER_1 first.", output: "text", map: mapWithAbc() })).toMatchObject({
      ok: true,
      text: "Chase ABC Hospital first.",
      checks: { O1: "pass", O2: "pass", O3: "pass", O4: "skipped" },
    });
  });
  it("O1 blocks an answer containing a real value that was replaced", () => {
    expect(checkAnswer({ raw: "Chase abc hospital first.", output: "text", map: mapWithAbc() })).toMatchObject({ ok: false, reason: "masked_value_leaked" });
  });
  it("O2 blocks a token not issued this turn", () => {
    expect(checkAnswer({ raw: "Chase CUSTOMER_2.", output: "text", map: mapWithAbc() })).toMatchObject({ ok: false, reason: "unknown_token" });
  });
  it("O3 blocks a secret in the answer", () => {
    expect(checkAnswer({ raw: "Use password: hunter2!", output: "text", map: new PlaceholderMap() })).toMatchObject({ ok: false, reason: "secret_in_output" });
  });
  it("O4 blocks JSON that fails the purpose schema, and accepts fenced JSON that passes", () => {
    const schema = z.object({ answer: z.string() });
    expect(checkAnswer({ raw: "not json", output: "json", schema, map: new PlaceholderMap() })).toMatchObject({ ok: false, reason: "invalid_output" });
    expect(checkAnswer({ raw: '```json\n{"answer":"Chase CUSTOMER_1"}\n```', output: "json", schema, map: mapWithAbc() })).toMatchObject({
      ok: true,
      json: { answer: "Chase ABC Hospital" },
    });
  });
});

describe("checkAnswer without name restoration (intent extraction)", () => {
  it("keeps tokens in place but still runs the checks", () => {
    const map = mapWithAbc();
    expect(checkAnswer({ raw: '[{"tool":"t","parameters":{"customerId":"CUSTOMER_1"}}]', output: "json", map, restoreNames: false })).toMatchObject({
      ok: true,
      json: [{ tool: "t", parameters: { customerId: "CUSTOMER_1" } }],
    });
    expect(checkAnswer({ raw: '[{"tool":"t","parameters":{"x":"CUSTOMER_7"}}]', output: "json", map, restoreNames: false })).toMatchObject({ ok: false, reason: "unknown_token" });
  });
});

describe("restoreToolParams", () => {
  it("restores an exact token to the entity id, and embedded tokens to the display name", () => {
    expect(restoreToolParams({ customerId: "CUSTOMER_1", query: "emails about CUSTOMER_1", limit: 5 }, mapWithAbc())).toEqual({
      ok: true,
      params: { customerId: "c9", query: "emails about ABC Hospital", limit: 5 },
    });
  });
  it("rejects a placeholder not issued this turn (Review Focus 4)", () => {
    expect(restoreToolParams({ customerId: "CUSTOMER_9" }, mapWithAbc())).toEqual({ ok: false, token: "CUSTOMER_9" });
  });
  it("walks nested objects and arrays", () => {
    expect(restoreToolParams({ filter: { ids: ["CUSTOMER_1"] } }, mapWithAbc())).toEqual({ ok: true, params: { filter: { ids: ["c9"] } } });
  });
});

describe("parseJsonLoose", () => {
  it("parses a bare array and a fenced object, and throws on nothing", () => {
    expect(parseJsonLoose('[{"tool":"none","parameters":{}}]')).toEqual([{ tool: "none", parameters: {} }]);
    expect(parseJsonLoose('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonLoose("no json here")).toThrow(SyntaxError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/answer-check.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
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
}): CheckResult {
  const checks: CheckLog = { O1: "skipped", O2: "skipped", O3: "skipped", O4: "skipped" };
  const restore = (s: string) => (input.restoreNames === false ? s : restoreString(s, input.map));
  const lower = input.raw.toLowerCase();
  // O1: a real value this turn replaced must not come back. Possible only via another route, so it signals a bug.
  checks.O1 = input.map.displays().some((d) => d.length >= MIN_LEAK_LENGTH && lower.includes(d.toLowerCase())) ? "fail" : "pass";
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/answer-check.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/application/src/ai-boundary
git commit -m "feat(ai-boundary): add the answer check and placeholder restoration"
```

---

### Task 8: Audit storage, choices and fingerprints

Spec §8, §2.12. Ports in `application`, SQLite repositories in `infrastructure`.

**Files:**
- Create: `packages/application/src/ai-boundary/audit.ts`
- Create: `packages/application/src/ai-boundary/fingerprints.ts`
- Create: `packages/application/src/ai-boundary/__tests__/in-memory-audit.ts`
- Create: `packages/infrastructure/src/database/migrations/015_ai_data_boundary.sql`
- Modify: `packages/infrastructure/src/database/connection.ts` (register `{ version: 15, name: "ai_data_boundary", file: "015_ai_data_boundary.sql" }`)
- Create: `packages/infrastructure/src/database/repositories/sqlite-model-audit.repository.ts`
- Create: `packages/infrastructure/src/database/repositories/sqlite-ai-data-choice.repository.ts`
- Modify: `packages/infrastructure/src/database/repositories/index.ts` (export both)
- Test: `packages/application/src/ai-boundary/fingerprints.test.ts`, `packages/infrastructure/src/database/ai-data-boundary.integration.test.ts`

**Interfaces:**
- Produces (application):
  - `ModelDecisionRecord { id: string; callId: string; createdAt: string; contextKind: "personal" | "tenant"; identityId: string; tenantId: string | null; membershipId: string | null; purpose: string; channel: string | null; provider: string; model: string | null; effectiveLimit: DataClass | null; layers: LayerSnapshot; decision: "allow" | "deny"; denyReason: DenyReason | null; released: ReleasedShapeEntry[]; withheld: WithheldItem[]; placeholderCount: number; scannerHits: { D3: number; D4: number }; alert: boolean; policyFingerprint: string; inputFingerprint: string | null; keyVersion: number }`
  - `ModelOutcomeRecord { callId: string; createdAt: string; status: "answered" | "blocked" | "failed"; blockReason: string | null; attempts: number; latencyMs: number; inputTokens: number | null; outputTokens: number | null; checks: CheckLog; outputFingerprint: string | null; keyVersion: number }`
  - `ModelAuditRepository { recordDecision(r: ModelDecisionRecord): void; recordOutcome(r: ModelOutcomeRecord): void; listRecentForIdentity(identityId: string, limit: number): Array<{ decision: ModelDecisionRecord; outcome: ModelOutcomeRecord | null }> }`
  - `AiDataChoice { id: string; identityId: string; provider: ProviderId; maxClass: "D1" | "D2"; decidedOn: string | null; note: string | null; confirmedAt: string }`
  - `AiDataChoiceRepository { current(identityId: string, provider: ProviderId): AiDataChoice | null; record(c: Omit<AiDataChoice, "id">): AiDataChoice; history(identityId: string): AiDataChoice[] }`
  - `class Fingerprinter { constructor(masterKey: string, keyVersion: number); readonly keyVersion: number; of(ctx: ModelContext, text: string): string; policy(ctx: ModelContext, snapshot: unknown): string }`. The constructor throws if the key is shorter than 32 characters.
- Produces (infrastructure): `SqliteModelAuditRepository(db)`, `SqliteAiDataChoiceRepository(db, newId?, clock?)`

- [ ] **Step 1: Write the failing tests**

`fingerprints.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Fingerprinter } from "./fingerprints.js";

const KEY = "k".repeat(32);

describe("Fingerprinter", () => {
  it("is deterministic per context and differs across contexts", () => {
    const fp = new Fingerprinter(KEY, 1);
    const a = fp.of({ kind: "personal", identityId: "u1" }, "ACCOUNT_472 GHS 18,400");
    expect(a).toBe(fp.of({ kind: "personal", identityId: "u1" }, "ACCOUNT_472 GHS 18,400"));
    expect(a).not.toBe(fp.of({ kind: "personal", identityId: "u2" }, "ACCOUNT_472 GHS 18,400"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is not a plain SHA-256 of the text (a keyed hash cannot be reversed by guessing)", async () => {
    const { createHash } = await import("node:crypto");
    const fp = new Fingerprinter(KEY, 1);
    expect(fp.of({ kind: "personal", identityId: "u1" }, "x")).not.toBe(createHash("sha256").update("x").digest("hex"));
  });
  it("refuses a master key shorter than 32 characters", () => {
    expect(() => new Fingerprinter("short", 1)).toThrow("at least 32");
  });
});
```

`ai-data-boundary.integration.test.ts`. It uses the same in-memory database setup as `action-storage.integration.test.ts`; copy its `beforeEach` that creates the DB, runs migrations and inserts user `u1`.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "./connection.js";
import { SqliteAiDataChoiceRepository } from "./repositories/sqlite-ai-data-choice.repository.js";
import { SqliteModelAuditRepository } from "./repositories/sqlite-model-audit.repository.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'gerry@test.com')").run();
});

const decision = (callId: string, overrides = {}) => ({
  id: `d-${callId}`,
  callId,
  createdAt: `2026-10-03T10:00:0${callId.slice(-1)}.000Z`,
  contextKind: "personal" as const,
  identityId: "u1",
  tenantId: null,
  membershipId: null,
  purpose: "chat_reply",
  channel: "web",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  effectiveLimit: "D1" as const,
  layers: { provider: "D2" as const, choice: "D1" as const, purpose: "D2" as const },
  decision: "allow" as const,
  denyReason: null,
  released: [{ part: "user_message", field: "*", outcome: "sent" as const }],
  withheld: [],
  placeholderCount: 0,
  scannerHits: { D3: 0, D4: 0 },
  alert: false,
  policyFingerprint: "p".repeat(64),
  inputFingerprint: "i".repeat(64),
  keyVersion: 1,
  ...overrides,
});

describe("SqliteModelAuditRepository", () => {
  it("stores decisions and outcomes and lists them newest first", () => {
    const repo = new SqliteModelAuditRepository(db);
    repo.recordDecision(decision("c1"));
    repo.recordDecision(decision("c2", { decision: "deny", denyReason: "required_part_withheld", inputFingerprint: null }));
    repo.recordOutcome({ callId: "c1", createdAt: "2026-10-03T10:00:05.000Z", status: "answered", blockReason: null, attempts: 1, latencyMs: 900, inputTokens: null, outputTokens: null, checks: { O1: "pass", O2: "pass", O3: "pass", O4: "pass" }, outputFingerprint: "o".repeat(64), keyVersion: 1 });
    const recent = repo.listRecentForIdentity("u1", 10);
    expect(recent.map((r) => r.decision.callId)).toEqual(["c2", "c1"]);
    expect(recent[0].outcome).toBeNull();
    expect(recent[1].outcome).toMatchObject({ status: "answered", attempts: 1 });
  });
  it("is append-only", () => {
    const repo = new SqliteModelAuditRepository(db);
    repo.recordDecision(decision("c1"));
    expect(() => db.prepare("UPDATE model_call_decisions SET purpose = 'x'").run()).toThrow("model_call_decisions is append-only");
    expect(() => db.prepare("DELETE FROM model_call_decisions").run()).toThrow("model_call_decisions is append-only");
  });
});

describe("SqliteAiDataChoiceRepository", () => {
  it("returns the newest choice, so a later D1 revokes an earlier D2 (Review Focus 2)", () => {
    let t = 0;
    const repo = new SqliteAiDataChoiceRepository(db, () => `id${++t}`, () => new Date(Date.UTC(2026, 9, 3, 10, 0, t)));
    expect(repo.current("u1", "deepseek")).toBeNull();
    repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03", note: "n", confirmedAt: "2026-10-03T10:00:00.000Z" });
    expect(repo.current("u1", "deepseek")?.maxClass).toBe("D2");
    repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D1", decidedOn: null, note: null, confirmedAt: "2026-10-04T10:00:00.000Z" });
    expect(repo.current("u1", "deepseek")?.maxClass).toBe("D1");
    expect(repo.history("u1")).toHaveLength(2);
  });
  it("is append-only and refuses classes other than D1 and D2", () => {
    const repo = new SqliteAiDataChoiceRepository(db);
    repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: null, note: null, confirmedAt: "2026-10-03T10:00:00.000Z" });
    expect(() => db.prepare("DELETE FROM ai_data_choices").run()).toThrow("ai_data_choices is append-only");
    expect(() => repo.record({ identityId: "u1", provider: "deepseek", maxClass: "D3" as never, decidedOn: null, note: null, confirmedAt: "x" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/fingerprints.test.ts` and `pnpm --filter @oneon/infrastructure exec vitest run src/database/ai-data-boundary.integration.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`fingerprints.ts`:

```ts
import { createHmac, hkdfSync } from "node:crypto";
import type { ModelContext } from "./types.js";

/** Keyed fingerprints (spec §8). A plain hash of small structured data could be reversed by guessing. */
export class Fingerprinter {
  constructor(private readonly masterKey: string, readonly keyVersion: number) {
    if (masterKey.length < 32) throw new Error("MODEL_AUDIT_HMAC_KEY must be at least 32 characters");
  }

  private keyFor(ctx: ModelContext): Buffer {
    const info = ctx.kind === "tenant" ? `tenant:${ctx.tenantId}` : `personal:${ctx.identityId}`;
    return Buffer.from(hkdfSync("sha256", this.masterKey, "oneon-model-audit", info, 32));
  }

  of(ctx: ModelContext, text: string): string {
    return createHmac("sha256", this.keyFor(ctx)).update(text).digest("hex");
  }

  policy(ctx: ModelContext, snapshot: unknown): string {
    return this.of(ctx, JSON.stringify(snapshot));
  }
}
```

`audit.ts`: the interfaces exactly as listed under **Interfaces**. Import the types `LayerSnapshot`, `DenyReason`, `WithheldItem` from `./decide.js`, `ReleasedShapeEntry` from `./assemble.js`, `CheckLog` from `./answer-check.js`, and `DataClass`, `ProviderId` from `./types.js`.

`__tests__/in-memory-audit.ts`:

```ts
import type { AiDataChoice, AiDataChoiceRepository, ModelAuditRepository, ModelDecisionRecord, ModelOutcomeRecord } from "../audit.js";
import type { ProviderId } from "../types.js";

export class InMemoryModelAudit implements ModelAuditRepository {
  readonly decisions: ModelDecisionRecord[] = [];
  readonly outcomes: ModelOutcomeRecord[] = [];
  recordDecision(r: ModelDecisionRecord) {
    this.decisions.push(r);
  }
  recordOutcome(r: ModelOutcomeRecord) {
    this.outcomes.push(r);
  }
  listRecentForIdentity(identityId: string, limit: number) {
    return this.decisions
      .filter((d) => d.identityId === identityId)
      .reverse()
      .slice(0, limit)
      .map((decision) => ({ decision, outcome: this.outcomes.find((o) => o.callId === decision.callId) ?? null }));
  }
}

export class InMemoryChoices implements AiDataChoiceRepository {
  readonly rows: AiDataChoice[] = [];
  current(identityId: string, provider: ProviderId) {
    return [...this.rows].reverse().find((r) => r.identityId === identityId && r.provider === provider) ?? null;
  }
  record(c: Omit<AiDataChoice, "id">) {
    const row = { ...c, id: `choice-${this.rows.length + 1}` };
    this.rows.push(row);
    return row;
  }
  history(identityId: string) {
    return this.rows.filter((r) => r.identityId === identityId);
  }
}
```

`015_ai_data_boundary.sql`:

```sql
-- Spec §8 and §2.12: personal opt-ins and the model-call audit trail. All append-only.
CREATE TABLE ai_data_choices (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL REFERENCES users (id),
  provider     TEXT NOT NULL,
  max_class    TEXT NOT NULL CHECK (max_class IN ('D1', 'D2')),
  decided_on   TEXT,
  note         TEXT,
  confirmed_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_ai_data_choices_current ON ai_data_choices (identity_id, provider, created_at);

CREATE TABLE model_call_decisions (
  id                 TEXT PRIMARY KEY,
  call_id            TEXT NOT NULL UNIQUE,
  created_at         TEXT NOT NULL,
  context_kind       TEXT NOT NULL CHECK (context_kind IN ('personal', 'tenant')),
  identity_id        TEXT NOT NULL,
  tenant_id          TEXT,
  membership_id      TEXT,
  purpose            TEXT NOT NULL,
  channel            TEXT,
  provider           TEXT NOT NULL,
  model              TEXT,
  effective_limit    TEXT,
  layers_json        TEXT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  deny_reason        TEXT,
  released_json      TEXT NOT NULL,
  withheld_json      TEXT NOT NULL,
  placeholder_count  INTEGER NOT NULL,
  scanner_d3         INTEGER NOT NULL,
  scanner_d4         INTEGER NOT NULL,
  alert              INTEGER NOT NULL CHECK (alert IN (0, 1)),
  policy_fingerprint TEXT NOT NULL,
  input_fingerprint  TEXT,
  key_version        INTEGER NOT NULL
);
CREATE INDEX idx_model_call_decisions_identity ON model_call_decisions (identity_id, created_at);

CREATE TABLE model_call_outcomes (
  call_id            TEXT PRIMARY KEY REFERENCES model_call_decisions (call_id),
  created_at         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('answered', 'blocked', 'failed')),
  block_reason       TEXT,
  attempts           INTEGER NOT NULL,
  latency_ms         INTEGER NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  checks_json        TEXT NOT NULL,
  output_fingerprint TEXT,
  key_version        INTEGER NOT NULL
);

CREATE TRIGGER ai_data_choices_no_update BEFORE UPDATE ON ai_data_choices
BEGIN SELECT RAISE(ABORT, 'ai_data_choices is append-only'); END;
CREATE TRIGGER ai_data_choices_no_delete BEFORE DELETE ON ai_data_choices
BEGIN SELECT RAISE(ABORT, 'ai_data_choices is append-only'); END;
CREATE TRIGGER model_call_decisions_no_update BEFORE UPDATE ON model_call_decisions
BEGIN SELECT RAISE(ABORT, 'model_call_decisions is append-only'); END;
CREATE TRIGGER model_call_decisions_no_delete BEFORE DELETE ON model_call_decisions
BEGIN SELECT RAISE(ABORT, 'model_call_decisions is append-only'); END;
CREATE TRIGGER model_call_outcomes_no_update BEFORE UPDATE ON model_call_outcomes
BEGIN SELECT RAISE(ABORT, 'model_call_outcomes is append-only'); END;
CREATE TRIGGER model_call_outcomes_no_delete BEFORE DELETE ON model_call_outcomes
BEGIN SELECT RAISE(ABORT, 'model_call_outcomes is append-only'); END;
```

`sqlite-ai-data-choice.repository.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AiDataChoice, AiDataChoiceRepository, ProviderId } from "@oneon/application";

type Row = { id: string; identity_id: string; provider: string; max_class: "D1" | "D2"; decided_on: string | null; note: string | null; confirmed_at: string };
const map = (r: Row): AiDataChoice => ({
  id: r.id,
  identityId: r.identity_id,
  provider: r.provider as ProviderId,
  maxClass: r.max_class,
  decidedOn: r.decided_on,
  note: r.note,
  confirmedAt: r.confirmed_at,
});

export class SqliteAiDataChoiceRepository implements AiDataChoiceRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly newId: () => string = randomUUID,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  current(identityId: string, provider: ProviderId): AiDataChoice | null {
    const row = this.db
      .prepare("SELECT * FROM ai_data_choices WHERE identity_id = ? AND provider = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(identityId, provider) as Row | undefined;
    return row ? map(row) : null;
  }

  record(c: Omit<AiDataChoice, "id">): AiDataChoice {
    const id = this.newId();
    this.db
      .prepare(
        "INSERT INTO ai_data_choices (id, identity_id, provider, max_class, decided_on, note, confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, c.identityId, c.provider, c.maxClass, c.decidedOn, c.note, c.confirmedAt, this.clock().toISOString());
    return { ...c, id };
  }

  history(identityId: string): AiDataChoice[] {
    return (this.db.prepare("SELECT * FROM ai_data_choices WHERE identity_id = ? ORDER BY created_at, rowid").all(identityId) as Row[]).map(map);
  }
}
```

`sqlite-model-audit.repository.ts`: `recordDecision` inserts every column of `model_call_decisions`, JSON-encoding `layers`, `released` and `withheld`, and writing `alert` as 0/1. `recordOutcome` inserts every column of `model_call_outcomes`, JSON-encoding `checks`. `listRecentForIdentity` selects:

```sql
SELECT d.*, o.created_at AS o_created_at, o.status, o.block_reason, o.attempts, o.latency_ms, o.input_tokens, o.output_tokens,
       o.checks_json, o.output_fingerprint, o.key_version AS o_key_version
FROM model_call_decisions d LEFT JOIN model_call_outcomes o ON o.call_id = d.call_id
WHERE d.identity_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?
```

It maps each row back to `{ decision: ModelDecisionRecord, outcome: ModelOutcomeRecord | null }`, where `outcome` is null when `o.status` is null.

In `audit.ts`, add the line `export type { ProviderId } from "./types.js";` so infrastructure can import `ProviderId` from `@oneon/application`. In `ai-boundary/index.ts`, export `audit.ts` and `fingerprints.ts`.

- [ ] **Step 4: Run to verify they pass**

Run `pnpm --filter @oneon/application build`. Then run `pnpm --filter @oneon/application exec vitest run src/ai-boundary/fingerprints.test.ts` and `pnpm --filter @oneon/infrastructure exec vitest run src/database/ai-data-boundary.integration.test.ts`.
Expected: PASS.

- [ ] **Step 5: Full suite and commit**

```bash
git add packages/application/src/ai-boundary packages/infrastructure/src/database
git commit -m "feat(ai-boundary): add append-only audit and opt-in storage with keyed fingerprints"
```

---

### Task 9: The gateway

Spec §5.2, §6.8, §8, §10.3, §12 (the invariant test). Ties Tasks 1–8 together.

**Files:**
- Create: `packages/application/src/ai-boundary/gateway.ts`
- Create: `packages/application/src/ai-boundary/__tests__/fake-provider.ts`
- Modify: `packages/application/src/ai-boundary/index.ts`
- Modify: `packages/application/package.json` (dev dependency `fast-check`: run `pnpm --filter @oneon/application add -D fast-check`)
- Test: `packages/application/src/ai-boundary/gateway.test.ts`, `gateway.invariant.test.ts`

**Interfaces:**
- Consumes: Tasks 1–8.
- Produces:
  - `type GatewayResult = { kind: "answered"; text: string; json?: unknown; withheld: WithheldItem[]; decisionId: string } | { kind: "denied"; reason: DenyReason; withheld: WithheldItem[]; decisionId: string } | { kind: "blocked"; reason: OutputBlockReason; withheld: WithheldItem[]; decisionId: string } | { kind: "failed"; message: string; withheld: WithheldItem[]; decisionId: string }`
  - `ModelRouting { standard: ProviderId; reasoning: ProviderId; shadow?: ProviderId }`
  - `ModelGatewayDeps { providers: Partial<Record<ProviderId, ModelProvider>>; registry?: Record<ProviderId, ProviderEntry>; overrides: Map<ProviderId, ProviderOverride>; routing: ModelRouting; models: Partial<Record<ProviderId, { standard: string; reasoning: string }>>; choices: AiDataChoiceRepository; audit: ModelAuditRepository; fingerprinter: Fingerprinter; maxRetries: number; timeouts: { standard: number; reasoning: number }; logger: Logger; clock?: () => Date; newId?: () => string; purposes?: Record<string, PurposeDefinition> }`
  - `ModelTurn { call(request: ModelRequest): Promise<GatewayResult>; restoreToolParams(params: Record<string, unknown>): ReturnType<typeof restoreToolParams>; effectiveLimit(purpose: string): DataClass | null }`
  - `ModelGateway { beginTurn(context: ModelContext, options?: { channel?: string }): ModelTurn }`
  - `createModelGateway(deps: ModelGatewayDeps): ModelGateway`
  - `TENANT_CHOICE_LIMIT: DataClass = "D1"`

- [ ] **Step 1: Write the fake provider**

`__tests__/fake-provider.ts`:

```ts
import { ProviderError, type ApprovedModelCall, type ModelProvider, type ProviderCompletion } from "../approved-call.js";
import type { ProviderId } from "../types.js";

/** Records every approved call it receives and answers from a queue (or a function). */
export class FakeProvider implements ModelProvider {
  readonly calls: ApprovedModelCall[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly answers: Array<string | Error | ((call: ApprovedModelCall) => string)> = [],
  ) {}
  async complete(call: ApprovedModelCall): Promise<ProviderCompletion> {
    this.calls.push(call);
    const next = this.answers.length > 1 ? this.answers.shift()! : this.answers[0] ?? "{}";
    if (next instanceof Error) throw next;
    return { text: typeof next === "function" ? next(call) : next };
  }
}
export const providerDown = () => new ProviderError("provider down", false);
```

- [ ] **Step 2: Write the failing gateway tests**

`gateway.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createModelGateway, type ModelGatewayDeps } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider, providerDown } from "./__tests__/fake-provider.js";
import { emailRecord, field, personal, record, row, tenant, userMessage } from "./__tests__/builders.js";

const CLASSIFICATION = JSON.stringify({ category: "work", priority: 2, summary: "Invoice", actionItems: [], followUpNeeded: false, deadlines: [] });
const silent = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(overrides: Partial<ModelGatewayDeps> = {}, answers: ConstructorParameters<typeof FakeProvider>[1] = [CLASSIFICATION]) {
  const deepseek = new FakeProvider("deepseek", answers);
  const audit = new InMemoryModelAudit();
  const choices = new InMemoryChoices();
  const gateway = createModelGateway({
    providers: { deepseek },
    overrides: new Map(),
    routing: { standard: "deepseek", reasoning: "deepseek" },
    models: { deepseek: { standard: "flash", reasoning: "pro" } },
    choices,
    audit,
    fingerprinter: new Fingerprinter("k".repeat(32), 1),
    maxRetries: 2,
    timeouts: { standard: 15000, reasoning: 30000 },
    logger: silent,
    clock: () => new Date("2026-10-03T10:00:00.000Z"),
    ...overrides,
  });
  return { gateway, deepseek, audit, choices };
}

const optIn = (choices: InMemoryChoices) =>
  choices.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03", note: null, confirmedAt: "2026-10-03T10:00:00.000Z" });

describe("gateway", () => {
  it("denies personal email classification before opt-in, records the decision, and never calls the provider", async () => {
    const { gateway, deepseek, audit } = setup();
    const result = await gateway.beginTurn(personal).call({ purpose: "email_classification", output: "json", parts: [emailRecord()] });
    expect(result).toMatchObject({ kind: "denied", reason: "required_part_withheld" });
    expect(deepseek.calls).toHaveLength(0);
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({ decision: "deny", effectiveLimit: "D1", inputFingerprint: null });
    expect(audit.outcomes).toHaveLength(0);
  });

  it("answers after opt-in, validates JSON and writes decision and outcome rows without content", async () => {
    const { gateway, deepseek, audit, choices } = setup();
    optIn(choices);
    const result = await gateway.beginTurn(personal).call({ purpose: "email_classification", output: "json", parts: [emailRecord()] });
    expect(result).toMatchObject({ kind: "answered", json: { category: "work" } });
    expect(deepseek.calls[0]).toMatchObject({ provider: "deepseek", model: "flash", json: true, timeoutMs: 15000 });
    expect(audit.outcomes[0]).toMatchObject({ status: "answered", attempts: 1, checks: { O4: "pass" } });
    const stored = JSON.stringify([audit.decisions, audit.outcomes]);
    expect(stored).not.toContain("Please pay by Friday");
    expect(stored).not.toContain("ama@example.com");
  });

  it("retries an invalid JSON answer with the same approved call, then blocks", async () => {
    const { gateway, deepseek, audit, choices } = setup({}, ["nope", "still nope", "never json"]);
    optIn(choices);
    const result = await gateway.beginTurn(personal).call({ purpose: "email_classification", output: "json", parts: [emailRecord()] });
    expect(result).toMatchObject({ kind: "blocked", reason: "invalid_output" });
    expect(deepseek.calls).toHaveLength(3);
    expect(new Set(deepseek.calls.map((c) => c.callId)).size).toBe(1);
    expect(audit.outcomes[0]).toMatchObject({ status: "blocked", blockReason: "invalid_output", attempts: 3 });
  });

  it("reports a provider failure as failed", async () => {
    const { gateway, choices, audit } = setup({}, [providerDown()]);
    optIn(choices);
    const result = await gateway.beginTurn(personal).call({ purpose: "email_classification", output: "json", parts: [emailRecord()] });
    expect(result).toMatchObject({ kind: "failed" });
    expect(audit.outcomes[0]).toMatchObject({ status: "failed" });
  });

  it("uses one placeholder map per turn and restores tool parameters from it (spec §7.2)", async () => {
    const answer = JSON.stringify([{ tool: "get_customer", parameters: { customerId: "CUSTOMER_1" } }]);
    const { gateway, deepseek } = setup({}, [answer]);
    const turn = gateway.beginTurn(tenant);
    const result = await turn.call({
      purpose: "intent_extraction",
      output: "json",
      parts: [userMessage("who owes?"), record("tool:receivables", [row([field("name", "D2", "ABC Hospital", { entity: { type: "customer", id: "c9" } })])])],
    });
    expect(deepseek.calls[0].user).toContain("CUSTOMER_1");
    expect(deepseek.calls[0].user).not.toContain("ABC Hospital");
    expect(result).toMatchObject({ kind: "answered", json: [{ tool: "get_customer", parameters: { customerId: "CUSTOMER_1" } }] });
    expect(turn.restoreToolParams({ customerId: "CUSTOMER_1" })).toEqual({ ok: true, params: { customerId: "c9" } });
    expect(gateway.beginTurn(tenant).restoreToolParams({ customerId: "CUSTOMER_1" })).toEqual({ ok: false, token: "CUSTOMER_1" });
  });

  it("caps tenant calls at D1 regardless of personal opt-ins", async () => {
    const { gateway, choices } = setup();
    optIn(choices);
    expect(gateway.beginTurn(tenant).effectiveLimit("chat_reply")).toBe("D1");
    expect(gateway.beginTurn(personal).effectiveLimit("chat_reply")).toBe("D2");
    expect(gateway.beginTurn(personal).effectiveLimit("unknown")).toBeNull();
  });

  it("runs the shadow copy as its own decision, and skips it when denied without affecting the main call", async () => {
    const anthropic = new FakeProvider("anthropic", [CLASSIFICATION]);
    const { gateway, choices, audit } = setup({ providers: { deepseek: new FakeProvider("deepseek", [CLASSIFICATION]), anthropic }, routing: { standard: "deepseek", reasoning: "deepseek", shadow: "anthropic" } });
    optIn(choices); // DeepSeek only: Anthropic stays at the D1 default, so its shadow copy is denied
    const result = await gateway.beginTurn(personal).call({ purpose: "email_classification", output: "json", parts: [emailRecord()] });
    await new Promise((r) => setTimeout(r, 0));
    expect(result.kind).toBe("answered");
    expect(anthropic.calls).toHaveLength(0);
    expect(audit.decisions.map((d) => [d.provider, d.channel, d.decision])).toEqual([
      ["deepseek", null, "allow"],
      ["anthropic", "shadow", "deny"],
    ]);
  });

  it("denies a suspended provider via the override", async () => {
    const { gateway, choices } = setup({ overrides: new Map([["deepseek", { kind: "suspended" }]]) });
    optIn(choices);
    expect(await gateway.beginTurn(personal).call({ purpose: "email_classification", output: "json", parts: [emailRecord()] })).toMatchObject({
      kind: "denied",
      reason: "provider_unavailable",
    });
  });
});
```

`gateway.invariant.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { createModelGateway } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider } from "./__tests__/fake-provider.js";
import { classRank, type DataClass } from "./types.js";

const classArb = fc.constantFrom<DataClass | null>("D0", "D1", "D2", "D3", null);

describe("gateway invariant (spec §12)", () => {
  it("never sends a value above the effective limit, never sends D3 or D4, never stores values or the mapping", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ cls: classArb, entity: fc.boolean(), rowD3: fc.boolean() }), { minLength: 1, maxLength: 8 }),
        fc.constantFrom<"D1" | "D2">("D1", "D2"),
        fc.constantFrom<"personal" | "tenant">("personal", "tenant"),
        async (specs, choice, kind) => {
          const provider = new FakeProvider("deepseek", [JSON.stringify({ answer: "ok", usedTools: [] })]);
          const audit = new InMemoryModelAudit();
          const choices = new InMemoryChoices();
          if (choice === "D2") choices.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: null, note: null, confirmedAt: "x" });
          const gateway = createModelGateway({
            providers: { deepseek: provider },
            overrides: new Map(),
            routing: { standard: "deepseek", reasoning: "deepseek" },
            models: { deepseek: { standard: "s", reasoning: "r" } },
            choices,
            audit,
            fingerprinter: new Fingerprinter("k".repeat(32), 1),
            maxRetries: 0,
            timeouts: { standard: 1, reasoning: 1 },
            logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          });
          const context = kind === "personal" ? { kind, identityId: "u1" } as const : { kind, identityId: "u1", tenantId: "t1", membershipId: "m1" } as const;
          const limit: DataClass = kind === "tenant" ? "D1" : choice;
          const values = specs.map((_, i) => `VAL${i}X${Math.random().toString(36).slice(2, 8)}`);
          const rows = specs.map((s, i) => ({
            ...(s.rowD3 ? { rowClass: "D3" as const } : {}),
            fields: [{ name: `f${i}`, class: s.cls, value: values[i], ...(s.entity ? { entity: { type: "customer", id: `c${i}` } } : {}) }],
          }));
          await gateway.beginTurn(context).call({ purpose: "chat_reply", output: "json", parts: [{ kind: "user_message", text: "q" }, { kind: "record", source: "tool:t", rows }] });
          const sent = provider.calls.map((c) => c.system + c.user).join("\n");
          specs.forEach((s, i) => {
            const effective = s.rowD3 ? "D3" : s.cls;
            const mayAppearRaw = effective !== null && effective !== "D3" && classRank(effective) <= classRank(limit);
            if (!mayAppearRaw) expect(sent).not.toContain(values[i]);
          });
          const stored = JSON.stringify([audit.decisions, audit.outcomes]);
          for (const v of values) expect(stored).not.toContain(v);
        },
      ),
      { numRuns: 200 },
    );
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/gateway`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

```ts
import { randomUUID } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { ApprovedModelCall, ProviderError, type ModelProvider } from "./approved-call.js";
import { checkAnswer, restoreToolParams, type OutputBlockReason } from "./answer-check.js";
import { assemblePrompt } from "./assemble.js";
import type { AiDataChoiceRepository, ModelAuditRepository } from "./audit.js";
import { decide, type DenyReason, type WithheldItem } from "./decide.js";
import type { Fingerprinter } from "./fingerprints.js";
import { PlaceholderMap } from "./placeholders.js";
import { PROVIDER_REGISTRY, providerLimit, type ProviderEntry, type ProviderOverride } from "./providers.js";
import { PURPOSES, type PurposeDefinition } from "./purposes/index.js";
import { lowerClass, type DataClass, type ModelContext, type ModelRequest, type ProviderId } from "./types.js";

export const TENANT_CHOICE_LIMIT: DataClass = "D1";

export type GatewayResult =
  | { kind: "answered"; text: string; json?: unknown; withheld: WithheldItem[]; decisionId: string }
  | { kind: "denied"; reason: DenyReason; withheld: WithheldItem[]; decisionId: string }
  | { kind: "blocked"; reason: OutputBlockReason; withheld: WithheldItem[]; decisionId: string }
  | { kind: "failed"; message: string; withheld: WithheldItem[]; decisionId: string };

export interface ModelRouting {
  standard: ProviderId;
  reasoning: ProviderId;
  shadow?: ProviderId;
}

export interface ModelGatewayDeps {
  providers: Partial<Record<ProviderId, ModelProvider>>;
  registry?: Record<ProviderId, ProviderEntry>;
  overrides: Map<ProviderId, ProviderOverride>;
  routing: ModelRouting;
  models: Partial<Record<ProviderId, { standard: string; reasoning: string }>>;
  choices: AiDataChoiceRepository;
  audit: ModelAuditRepository;
  fingerprinter: Fingerprinter;
  maxRetries: number;
  timeouts: { standard: number; reasoning: number };
  logger: Logger;
  clock?: () => Date;
  newId?: () => string;
  purposes?: Record<string, PurposeDefinition>;
}

export interface ModelTurn {
  call(request: ModelRequest): Promise<GatewayResult>;
  restoreToolParams(params: Record<string, unknown>): ReturnType<typeof restoreToolParams>;
  effectiveLimit(purpose: string): DataClass | null;
}

export interface ModelGateway {
  beginTurn(context: ModelContext, options?: { channel?: string }): ModelTurn;
}

export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const registry = deps.registry ?? PROVIDER_REGISTRY;
  const purposes = deps.purposes ?? PURPOSES;
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  const choiceLimit = (context: ModelContext, provider: ProviderId): DataClass =>
    context.kind === "tenant" ? TENANT_CHOICE_LIMIT : (deps.choices.current(context.identityId, provider)?.maxClass ?? "D1");

  const providerFor = (purpose: string): ProviderId => {
    const def = purposes[purpose];
    return def?.tier === "reasoning" ? deps.routing.reasoning : deps.routing.standard;
  };

  async function runCall(
    context: ModelContext,
    channel: string | null,
    request: ModelRequest,
    provider: ProviderId,
    map: PlaceholderMap,
  ): Promise<GatewayResult> {
    const callId = newId();
    const decisionId = newId();
    const def = purposes[request.purpose];
    const entry = deps.providers[provider] ? registry[provider] : undefined;
    const decision = decide({ context, request, provider: { entry, override: deps.overrides.get(provider) }, choiceLimit: choiceLimit(context, provider), purposes });
    const tier = def?.tier ?? "standard";
    const model = deps.models[provider]?.[tier] ?? null;
    const base = {
      id: decisionId,
      callId,
      createdAt: clock().toISOString(),
      contextKind: context.kind,
      identityId: context.identityId,
      tenantId: context.kind === "tenant" ? context.tenantId : null,
      membershipId: context.kind === "tenant" ? context.membershipId : null,
      purpose: request.purpose,
      channel,
      provider,
      model,
      effectiveLimit: decision.effectiveLimit,
      layers: decision.layers,
      withheld: decision.withheld,
      scannerHits: decision.scannerHits,
      alert: decision.alert,
      policyFingerprint: deps.fingerprinter.policy(context, { layers: decision.layers, purpose: request.purpose, provider }),
      keyVersion: deps.fingerprinter.keyVersion,
    };
    if (decision.alert) deps.logger.warn("boundary_alert", { purpose: request.purpose, callId, withheld: decision.withheld.length });

    if (decision.kind === "deny") {
      deps.audit.recordDecision({ ...base, decision: "deny", denyReason: decision.reason, released: [], placeholderCount: 0, inputFingerprint: null });
      return { kind: "denied", reason: decision.reason, withheld: decision.withheld, decisionId };
    }

    const assembled = assemblePrompt(request, decision, def, map);
    deps.audit.recordDecision({
      ...base,
      decision: "allow",
      denyReason: null,
      released: assembled.released,
      placeholderCount: assembled.placeholderCount,
      inputFingerprint: deps.fingerprinter.of(context, `${assembled.system}\n\n${assembled.user}`),
    });

    const approved = ApprovedModelCall.mint({
      callId,
      provider,
      model: model ?? "",
      system: assembled.system,
      user: assembled.user,
      json: request.output === "json",
      maxTokens: def.maxTokens,
      timeoutMs: deps.timeouts[tier],
    });

    const started = clock().getTime();
    let attempts = 0;
    let last: ReturnType<typeof checkAnswer> | null = null;
    let failure: string | null = null;
    let tokens: { input: number | null; output: number | null } = { input: null, output: null };
    while (attempts <= deps.maxRetries) {
      attempts++;
      try {
        const completion = await deps.providers[provider]!.complete(approved);
        tokens = { input: completion.inputTokens ?? null, output: completion.outputTokens ?? null };
        last = checkAnswer({ raw: completion.text, output: request.output, schema: def.outputSchema, map, restoreNames: def.restoreNames });
        failure = null;
        if (last.ok || last.reason !== "invalid_output") break;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        last = null;
        if (!(error instanceof ProviderError && error.retryable)) break;
      }
    }

    const outcomeBase = {
      callId,
      createdAt: clock().toISOString(),
      attempts,
      latencyMs: clock().getTime() - started,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      keyVersion: deps.fingerprinter.keyVersion,
    };
    if (failure !== null || last === null) {
      deps.audit.recordOutcome({ ...outcomeBase, status: "failed", blockReason: null, checks: { O1: "skipped", O2: "skipped", O3: "skipped", O4: "skipped" }, outputFingerprint: null });
      return { kind: "failed", message: failure ?? "no answer", withheld: decision.withheld, decisionId };
    }
    if (!last.ok) {
      deps.audit.recordOutcome({ ...outcomeBase, status: "blocked", blockReason: last.reason, checks: last.checks, outputFingerprint: null });
      return { kind: "blocked", reason: last.reason, withheld: decision.withheld, decisionId };
    }
    deps.audit.recordOutcome({ ...outcomeBase, status: "answered", blockReason: null, checks: last.checks, outputFingerprint: deps.fingerprinter.of(context, last.text) });
    return { kind: "answered", text: last.text, json: last.json, withheld: decision.withheld, decisionId };
  }

  return {
    beginTurn(context, options) {
      const map = new PlaceholderMap();
      const channel = options?.channel ?? null;
      return {
        async call(request) {
          const provider = providerFor(request.purpose);
          const result = await runCall(context, channel, request, provider, map);
          const shadow = deps.routing.shadow;
          if (shadow && shadow !== provider && deps.providers[shadow]) {
            // Spec §6.8: the shadow copy is its own call with its own decision; it never affects the result.
            void runCall(context, "shadow", request, shadow, map).catch((error: unknown) =>
              deps.logger.warn("Shadow model call failed", { error: error instanceof Error ? error.message : String(error) }),
            );
          }
          return result;
        },
        restoreToolParams: (params) => restoreToolParams(params, map),
        effectiveLimit(purpose) {
          const def = purposes[purpose];
          if (!def) return null;
          const provider = providerFor(purpose);
          const p = providerLimit(deps.providers[provider] ? registry[provider] : undefined, context.kind, deps.overrides.get(provider));
          if (p === "suspended" || p === "unknown") return null;
          return lowerClass(lowerClass(p, choiceLimit(context, provider)), def.limit);
        },
      };
    },
  };
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @oneon/application exec vitest run src/ai-boundary/gateway`
Expected: PASS (8 gateway tests plus the invariant test with 200 runs).

- [ ] **Step 6: Full suite and commit**

```bash
git add packages/application
git commit -m "feat(ai-boundary): add the model gateway with turns, retries, shadow calls and audit"
```
