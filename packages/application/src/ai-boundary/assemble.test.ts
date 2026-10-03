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

  it("assembles a part decide withheld as part_not_allowed without error (history in email classification)", () => {
    const i = input({ request: { parts: [{ kind: "history", turns: [{ role: "user", text: "hello" }] }, emailRecord()] } });
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.email_classification, new PlaceholderMap());
    expect(out.user).not.toContain("hello");
    expect(out.user).not.toContain("HISTORY");
    expect(out.released[0]).toEqual({ part: "history", field: "*", outcome: "withheld:part_not_allowed" });
  });

  it("assembles a disallowed record part without error and renders nothing for it", () => {
    const def = {
      ...PURPOSES.email_classification,
      allowedParts: ["instruction", "user_message"] as typeof PURPOSES.email_classification.allowedParts,
      required: { all: ["user_message"] },
    };
    const i = { ...input({ request: { parts: [userMessage("hi"), emailRecord()] } }), purposes: { email_classification: def } };
    const out = assemblePrompt(i.request, allowed(decide(i)), def, new PlaceholderMap());
    expect(out.user).toBe(["=== USER MESSAGE ===", "hi"].join("\n"));
    expect(out.released).toEqual([
      { part: "user_message", field: "*", outcome: "sent" },
      { part: "record:email", field: "*", outcome: "withheld:part_not_allowed" },
    ]);
  });

  it("renders an aggregate cell and records its group size in the released shape", () => {
    const i = input({
      context: tenant,
      choiceLimit: "D1",
      request: {
        purpose: "chat_reply",
        parts: [
          record("tool:sales", [row([field("district", "D1", "Osu"), field("total", "D2", 900, { aggregate: { count: 5, classIfSafe: "D1" } })])]),
          userMessage("totals?"),
        ],
      },
    });
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.chat_reply, new PlaceholderMap());
    expect(out.user).toBe(["=== TOOL:SALES ===", "- district: Osu | total: 900", "", "=== USER MESSAGE ===", "totals?"].join("\n"));
    expect(out.released).toContainEqual({ part: "record:tool:sales", field: "total", outcome: "aggregate(5)" });
  });

  it("renders the tool catalog for intent extraction", () => {
    const i = input({
      request: { purpose: "intent_extraction", parts: [{ kind: "tool_catalog", tools: [{ name: "list_inbox", description: "List emails" }] }, userMessage("inbox?")] },
    });
    const out = assemblePrompt(i.request, allowed(decide(i)), PURPOSES.intent_extraction, new PlaceholderMap());
    expect(out.user).toBe(["=== TOOLS ===", "- list_inbox: List emails", "", "=== USER MESSAGE ===", "inbox?"].join("\n"));
  });
});
