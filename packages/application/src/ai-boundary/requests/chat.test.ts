import { describe, it, expect, vi } from "vitest";
import { createModelGateway } from "../gateway.js";
import { Fingerprinter } from "../fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "../__tests__/in-memory-audit.js";
import { FakeProvider } from "../__tests__/fake-provider.js";
import { z } from "zod";
import { TOOL_RECORD_ROW_CAP, TOOL_STRING_CHAR_CAP, buildChatReplyRequest, buildIntentRequest, historyTurns } from "./chat.js";
import { createToolRegistry } from "../../tools/tool-registry.js";
import { EMAIL_ENTRY_FIELDS } from "../../tools/output-schema.js";

const registry = createToolRegistry();
registry.register({
  name: "list_inbox",
  version: "1",
  description: "List emails",
  inputSchema: z.object({}),
  output: { fields: EMAIL_ENTRY_FIELDS, summaryClass: "D1" },
  execute: () => ({ data: [], summary: "" }),
});
const stats = { totalInboxItems: 3, unreadUrgentCount: 1, pendingActionsCount: 0, upcomingDeadlinesCount: 2, followUpCount: 0 };
const history = [
  { id: "m1", role: "user", content: "hi" },
  { id: "m2", role: "assistant", content: "Ama owes you" },
] as never;
const call = {
  id: "c1", round: 1, tool: "list_inbox", parameters: {}, error: null, durationMs: 1, executedAt: "t",
  result: { data: [{ id: "i1", subject: "Invoice", from: "ama@x.com", source: "gmail", receivedAt: "t", category: "work", priority: 2, summary: "s" }], summary: "Found 1 inbox item." },
};

describe("chat requests", () => {
  it("maps conversation history to user and assistant turns", () => {
    expect(historyTurns(history)).toEqual([{ role: "user", text: "hi" }, { role: "assistant", text: "Ama owes you" }]);
  });

  it("builds the intent request: catalog, context, history, message, tool results", () => {
    const req = buildIntentRequest({
      userMessage: "inbox?", history, toolDefinitions: [{ name: "list_inbox", description: "List emails" }], stats,
      now: new Date("2026-10-03T10:00:00Z"), timezone: "Africa/Accra", persona: null, toolCalls: [call], registry,
    });
    expect(req.purpose).toBe("intent_extraction");
    expect(req.parts.map((p) => (p.kind === "record" ? `record:${p.source}` : p.kind))).toEqual([
      "tool_catalog", "record:context", "history", "user_message", "record:tool:list_inbox",
    ]);
  });

  it("builds the reply request with a persona record and no tool catalog", () => {
    const req = buildChatReplyRequest({
      userMessage: "inbox?", history, toolCalls: [call], registry,
      persona: { preferredName: "Gerry", nickname: null, salutationMode: "sir_with_name", communicationStyle: "concise" } as never,
    });
    expect(req.purpose).toBe("chat_reply");
    expect(req.parts.some((p) => p.kind === "tool_catalog")).toBe(false);
    const persona = req.parts.find((p) => p.kind === "record" && p.source === "persona");
    expect(persona).toMatchObject({ rows: [{ fields: [{ name: "salutation", class: "D1", value: "Sir Gerry" }, { name: "communicationStyle", class: "D1", value: "concise" }] }] });
  });

  it("turns a failed tool call into a tool_error record", () => {
    const req = buildChatReplyRequest({ userMessage: "x", history: [], persona: null, toolCalls: [{ ...call, result: null, error: "Calendar not configured" }], registry });
    const record = req.parts.find((p) => p.kind === "record" && p.source === "tool_error");
    expect(record).toMatchObject({
      rows: [{ fields: [
        { name: "tool", class: "D0", value: "list_inbox" },
        { name: "status", class: "D1", value: "failed" },
        { name: "error", class: "D2", freeText: true, value: "Calendar not configured" },
      ] }],
    });
  });

  it("at the D1 default the tool error text is withheld while the status is sent", async () => {
    const provider = new FakeProvider("deepseek", [JSON.stringify({ answer: "ok", usedTools: [] })]);
    const gateway = createModelGateway({
      providers: { deepseek: provider },
      overrides: new Map(),
      routing: { standard: "deepseek", reasoning: "deepseek" },
      models: { deepseek: { standard: "s", reasoning: "r" } },
      choices: new InMemoryChoices(),
      audit: new InMemoryModelAudit(),
      fingerprinter: new Fingerprinter("k".repeat(32), 1),
      maxRetries: 0,
      timeouts: { standard: 1000, reasoning: 1000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const req = buildChatReplyRequest({ userMessage: "x", history: [], persona: null, toolCalls: [{ ...call, result: null, error: "No calendar for zed@x.com" }], registry });
    const result = await gateway.beginTurn({ kind: "personal", identityId: "u1" }).call(req);
    expect(result.kind).toBe("answered");
    expect(result.withheld).toContainEqual(expect.objectContaining({ part: "record:tool_error", field: "error", reason: "above_limit" }));
    expect(provider.calls[0].user).not.toContain("zed@x.com");
    expect(provider.calls[0].user).toContain("failed");
  });

  // Final review I4: intent rounds re-send every tool result, so each record is bounded.
  describe("tool record caps", () => {
    const entry = (n: number) => ({ id: `i${n}`, subject: "Invoice", from: "ama@x.com", source: "gmail", receivedAt: "t", category: "work", priority: 2, summary: "s" });
    const withRows = (n: number, summary = "Found many.") => ({ ...call, result: { data: Array.from({ length: n }, (_, i) => entry(i)), summary } });
    const toolRecord = (req: ReturnType<typeof buildChatReplyRequest>) => {
      const part = req.parts.find((p) => p.kind === "record" && p.source === "tool:list_inbox");
      if (part?.kind !== "record") throw new Error("no tool record");
      return part;
    };

    it("exports the limits", () => {
      expect(TOOL_RECORD_ROW_CAP).toBe(25);
      expect(TOOL_STRING_CHAR_CAP).toBe(1000);
    });

    it("keeps 25 data rows, then a D1 truncated row, with the summary last", () => {
      for (const build of [buildChatReplyRequest, buildIntentRequest]) {
        const req = build({
          userMessage: "inbox?", history: [], toolDefinitions: [], stats, now: new Date(), timezone: "UTC", persona: null, toolCalls: [withRows(30)], registry,
        });
        const rows = toolRecord(req).rows;
        expect(rows).toHaveLength(TOOL_RECORD_ROW_CAP + 2);
        expect(rows[TOOL_RECORD_ROW_CAP - 1].fields.find((f) => f.name === "id")?.value).toBe("i24");
        expect(rows[TOOL_RECORD_ROW_CAP].fields).toEqual([{ name: "truncated", class: "D1", value: "5 more rows not shown" }]);
        expect(rows[TOOL_RECORD_ROW_CAP + 1].fields[0]).toMatchObject({ name: "summary", value: "Found many." });
      }
    });

    it("adds no truncated row at or under the cap", () => {
      const rows = toolRecord(buildChatReplyRequest({ userMessage: "inbox?", history: [], persona: null, toolCalls: [withRows(25)], registry })).rows;
      expect(rows).toHaveLength(26);
      expect(rows.some((r) => r.fields.some((f) => f.name === "truncated"))).toBe(false);
    });

    it("cuts every string value, nested ones and the summary included, to 1,000 characters before the gateway classifies it", () => {
      const long = "x".repeat(1500);
      const cut = "x".repeat(1000);
      const big = { ...call, result: { data: [{ ...entry(0), subject: long, extra: { note: long } }], summary: long } };
      const failed = { ...call, id: "c2", result: null, error: long };
      const req = buildChatReplyRequest({ userMessage: "inbox?", history: [], persona: null, toolCalls: [big, failed], registry });
      const rows = toolRecord(req).rows;
      expect(rows[0].fields.find((f) => f.name === "subject")?.value).toBe(cut);
      expect(rows[0].fields.find((f) => f.name === "extra")?.value).toEqual({ note: cut });
      expect(rows[1].fields[0].value).toBe(cut);
      const error = req.parts.find((p) => p.kind === "record" && p.source === "tool_error");
      expect(error?.kind === "record" && error.rows[0].fields.find((f) => f.name === "error")?.value).toBe(cut);
    });
  });
});
