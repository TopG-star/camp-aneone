import { describe, it, expect } from "vitest";
import { EMAIL_ENTRY_FIELDS, TRANSACTION_FIELDS, toolResultToRecord, type ToolOutputSchema } from "./output-schema.js";
import { decide } from "../ai-boundary/decide.js";
import { PROVIDER_REGISTRY } from "../ai-boundary/providers.js";
import { createSearchEmailsTool } from "./search-emails.js";
import { createSearchCalendarTool } from "./search-calendar.js";
import { createSearchTeamsMessagesTool } from "./search-teams-messages.js";
import { createSearchPersonalMemoryTool } from "./search-personal-memory.js";
import { createSearchFinanceTransactionsTool } from "./search-finance-transactions.js";
import { createListCalendarEventsTool } from "./list-calendar-events.js";

const inbox: ToolOutputSchema = { fields: EMAIL_ENTRY_FIELDS, summaryClass: "D1" };
const entry = { id: "i1", subject: "Invoice", from: "ama@x.com", source: "gmail", receivedAt: "2026-10-03T09:00:00Z", category: "work", priority: 2, summary: "Pay soon" };

describe("toolResultToRecord", () => {
  it("turns a list into classified rows plus a summary row", () => {
    const part = toolResultToRecord("list_inbox", inbox, { data: [entry], summary: "Found 1 inbox item." });
    expect(part.source).toBe("tool:list_inbox");
    expect(part.rows).toHaveLength(2);
    expect(part.rows[0].fields.find((f) => f.name === "from")).toEqual({ name: "from", class: "D2", value: "ama@x.com", entity: { type: "person", id: "ama@x.com" } });
    expect(part.rows[1].fields).toEqual([{ name: "summary", class: "D1", value: "Found 1 inbox item.", freeText: true }]);
  });

  it("scans every summary as free text, so a secret in it denies the call (final review C1, M1)", () => {
    const part = toolResultToRecord("list_inbox", inbox, { data: [], summary: "Found key sk-ant-abcdefghijklmnopqrstuvwxyz" });
    const d = decide({
      context: { kind: "personal", identityId: "u1" },
      provider: { entry: PROVIDER_REGISTRY.deepseek },
      choiceLimit: "D2",
      request: { purpose: "chat_reply", output: "json", parts: [{ kind: "user_message", text: "inbox?" }, part] },
    });
    expect(d).toMatchObject({ kind: "deny", reason: "secret_present" });
  });

  it("marks an undeclared field unclassified, so the gateway withholds it with an alert and still answers (Review Focus 3)", () => {
    const part = toolResultToRecord("list_inbox", inbox, { data: [{ ...entry, bcc: "boss@x.com" }], summary: "s" });
    expect(part.rows[0].fields.find((f) => f.name === "bcc")?.class).toBeNull();
    const d = decide({
      context: { kind: "personal", identityId: "u1" },
      provider: { entry: PROVIDER_REGISTRY.deepseek },
      choiceLimit: "D2",
      request: { purpose: "chat_reply", output: "json", parts: [{ kind: "user_message", text: "inbox?" }, part] },
    });
    expect(d.kind).toBe("allow");
    expect(d.alert).toBe(true);
    expect(d.withheld).toContainEqual({ part: "record:tool:list_inbox", row: 0, field: "bcc", reason: "unclassified" });
  });

  it("treats a key that Object.prototype also has as undeclared", () => {
    const obj = JSON.parse('{"constructor":"x","toString":"y"}') as Record<string, unknown>;
    const part = toolResultToRecord("list_inbox", inbox, { data: [obj], summary: "s" });
    expect(part.rows[0].fields).toEqual([
      { name: "constructor", class: null, value: "x" },
      { name: "toString", class: null, value: "y" },
    ]);
  });

  it("reads rows from a nested list and puts the remaining keys in one extra row", () => {
    const schema: ToolOutputSchema = { fields: { id: { class: "D1" }, title: { class: "D2", freeText: true }, unreadCount: { class: "D1" } }, summaryClass: "D1", rowsFrom: "notifications" };
    const part = toolResultToRecord("list_notifications", schema, { data: { notifications: [{ id: "n1", title: "t" }], unreadCount: 3 }, summary: "s" });
    expect(part.rows.map((r) => r.fields.map((f) => f.name))).toEqual([["id", "title"], ["unreadCount"], ["summary"]]);
  });

  it("applies a declared row class", () => {
    const schema: ToolOutputSchema = { fields: { name: { class: "D2", entity: "customer" }, type: { class: "D1" } }, summaryClass: "D1", rowClass: (r) => (r.type === "Individual" ? "D3" : undefined) };
    const part = toolResultToRecord("receivables", schema, { data: [{ name: "Kofi", type: "Individual" }, { name: "ABC", type: "Hospital" }], summary: "s" });
    expect(part.rows[0].rowClass).toBe("D3");
    expect(part.rows[1].rowClass).toBeUndefined();
  });

  it("handles a null result as no rows besides the summary", () => {
    expect(toolResultToRecord("create_calendar_event", { fields: { action: { class: "D1" } }, summaryClass: "D2" }, { data: null, summary: "Not created" }).rows).toHaveLength(1);
  });
});

describe("summary declarations (final review C1)", () => {
  const none = {} as never;
  it.each([
    createSearchEmailsTool(none),
    createSearchCalendarTool(none),
    createSearchTeamsMessagesTool(none),
    createSearchPersonalMemoryTool(none),
    createSearchFinanceTransactionsTool(none),
    createListCalendarEventsTool(none),
  ])("declares the $name summary D2, since it quotes a model-supplied parameter", (tool) => {
    expect(tool.output.summaryClass).toBe("D2");
  });
});

describe("transaction dedupeKey", () => {
  const tx = { id: "t1", statementId: "s1", userId: "u1", postedAt: "2026-04-03", description: "UBER TRIP HELP.UBER.COM", amountMinor: -1200, balanceMinor: 5000, dedupeKey: "2026-04-03|UBER TRIP HELP.UBER.COM|-1200", createdAt: "2026-04-04T00:00:00Z" };
  const part = () => toolResultToRecord("search_finance_transactions", { fields: TRANSACTION_FIELDS, summaryClass: "D1" }, { data: [tx], summary: "Found 1 transaction." });
  const run = (choiceLimit: "D1" | "D2") => decide({
    context: { kind: "personal", identityId: "u1" },
    provider: { entry: PROVIDER_REGISTRY.deepseek },
    choiceLimit,
    request: { purpose: "chat_reply", output: "json", parts: [{ kind: "user_message", text: "spend?" }, part()] },
  });

  it("is declared D2 free text, since it holds the description and amount", () => {
    expect(part().rows[0].fields.find((f) => f.name === "dedupeKey")).toMatchObject({ class: "D2", freeText: true, value: tx.dedupeKey });
  });

  it("is withheld at a D1 limit", () => {
    const d = run("D1");
    expect(d.kind).toBe("allow");
    expect(d.withheld).toContainEqual({ part: "record:tool:search_finance_transactions", row: 0, field: "dedupeKey", reason: "above_limit" });
  });

  it("is sent at D2, as a string that takes D3 span scanning", () => {
    const d = run("D2");
    expect(d.kind).toBe("allow");
    expect(d.withheld.filter((w) => w.field === "dedupeKey")).toEqual([]);
  });
});
