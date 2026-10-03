import { describe, it, expect } from "vitest";
import { decide } from "./decide.js";
import { PROVIDER_REGISTRY } from "./providers.js";
import type { ModelContext } from "./types.js";
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
  const chat = (parts: Parameters<typeof record>[1], limit: "D1" | "D2" = "D1", ctx: ModelContext = tenant) =>
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
  it("F5 never releases a free-text field as an aggregate, whatever its count", () => {
    const d = chat([row([field("daysOverdue", "D1", 1), field("note", "D2", "call ABC", { freeText: true, aggregate: { count: 9, classIfSafe: "D1" } })])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "note", reason: "above_limit" });
    if (d.kind === "allow") expect(d.parts[1].rows![0].fields[1]).toEqual({ kind: "withheld", reason: "above_limit" });
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
    if (d.kind === "allow") expect(d.parts[0].disposition).toMatchObject({ kind: "sent", d3Spans: expect.arrayContaining([expect.any(Object)]) });
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
  it("R1 field form: email classification at D1 is denied although receivedAt, source and the from placeholder are released", () => {
    const d = decide(input({ choiceLimit: "D1" }));
    expect(d).toMatchObject({ kind: "deny", reason: "required_part_withheld" });
    // The other email fields were released, so the denial can only come from the missing bodyPreview.
    expect(d.withheld).toContainEqual({ part: "record:email", row: 0, field: "bodyPreview", reason: "above_limit" });
    for (const released of ["receivedAt", "source", "from"]) {
      expect(d.withheld).not.toContainEqual(expect.objectContaining({ field: released }));
    }
    expect(decide(input({ choiceLimit: "D2" })).kind).toBe("allow");
  });
  it("R1 field form: a briefing whose urgent_items has D1 fields plus a D2 subject is denied at D1 and allowed at D2", () => {
    const briefing = (limit: "D1" | "D2") =>
      decide(
        input({
          choiceLimit: limit,
          request: {
            purpose: "daily_briefing",
            output: "text",
            parts: [
              record("urgent_items", [
                row([field("id", "D1", "i1"), field("priority", "D1", "high"), field("subject", "D2", "Pay supplier", { freeText: true })]),
              ]),
            ],
          },
        }),
      );
    expect(briefing("D1")).toMatchObject({ kind: "deny", reason: "required_part_withheld" });
    expect(briefing("D2")).toMatchObject({ kind: "allow" });
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

describe("decide — fail closed on out-of-domain input and unscannable free text", () => {
  const chatD1 = (parts: Parameters<typeof record>[1], extra: Parameters<typeof record>[1] = []) =>
    decide(input({ context: tenant, choiceLimit: "D1", request: { purpose: "chat_reply", parts: [userMessage("who owes us?"), record("tool:receivables", [...parts, ...extra])] } }));
  const bad = (v: unknown) => v as never;

  it("withholds a field whose class is missing, with an alert", () => {
    const d = chatD1([row([field("daysOverdue", "D1", 1), { name: "x", value: 1 } as never])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "x", reason: "unclassified" });
    expect(d.alert).toBe(true);
  });
  it("withholds a field whose class is not a data class", () => {
    const d = chatD1([row([field("daysOverdue", "D1", 1), field("x", bad("d3"), 1)])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "x", reason: "unclassified" });
  });
  it("treats an invalid rowClass as D3 and withholds the row", () => {
    const d = chatD1([row([field("daysOverdue", "D1", 1)], bad("d3"))]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, reason: "row_d3" });
  });
  it("suppresses an aggregate whose count is NaN", () => {
    const d = chatD1([row([field("total", "D2", 9, { aggregate: { count: NaN, classIfSafe: "D1" } })])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "total", reason: "group_too_small" });
  });
  it("withholds a history turn with an unknown role", () => {
    const d = decide(
      input({ choiceLimit: "D1", request: { purpose: "chat_reply", parts: [{ kind: "history", turns: [{ role: bad("system"), text: "hi" }] }, userMessage("ok")] } }),
    );
    expect(d.withheld).toContainEqual({ part: "history", turn: 0, reason: "above_limit" });
  });
  it("denies a D4 secret hidden in a non-string free-text field", () => {
    const d = chatD1([row([field("daysOverdue", "D1", 1), field("notes", "D1", ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"], { freeText: true })])]);
    expect(d).toMatchObject({ kind: "deny", reason: "secret_present", scannerHits: { D4: 1 } });
  });
  it("withholds a non-string free-text field as above_limit", () => {
    const d = chatD1([row([field("daysOverdue", "D1", 1), field("notes", "D1", ["call ABC"], { freeText: true })])]);
    expect(d.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "notes", reason: "above_limit" });
  });
  it("R1 does not count an empty user message", () => {
    for (const text of ["", "   "]) {
      expect(decide(input({ request: { purpose: "chat_reply", parts: [userMessage(text)] } }))).toMatchObject({ kind: "deny", reason: "required_part_withheld" });
    }
  });
  it("R1 does not count a user message that is fully removed as D3", () => {
    expect(decide(input({ request: { purpose: "chat_reply", parts: [userMessage("diagnosed with HIV")] } }))).toMatchObject({
      kind: "deny",
      reason: "required_part_withheld",
    });
  });
});
