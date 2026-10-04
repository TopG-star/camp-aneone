import { describe, it, expect, vi } from "vitest";
import { createModelGateway, type ModelGatewayDeps } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider, providerDown } from "./__tests__/fake-provider.js";
import type { PromptPart } from "./types.js";
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

  // Controller ruling P2: a value the person typed themselves is not an O1 leak; the same value from a tool record is.
  const echoAnswer = JSON.stringify([{ tool: "find_email", parameters: { from: "ama@x.com" } }]);
  const toolRecord = () => record("tool:mail", [row([field("from", "D2", "ama@x.com", { entity: { type: "person", id: "p1" } })])]);

  it("does not block an echo of an address the person typed in this request (P2)", async () => {
    const { gateway, deepseek } = setup({}, [echoAnswer]);
    const result = await gateway.beginTurn(personal).call({
      purpose: "intent_extraction",
      output: "json",
      parts: [userMessage("did ama@x.com email me?"), toolRecord()],
    });
    expect(deepseek.calls[0].user).toContain("PERSON_1");
    expect(result).toMatchObject({ kind: "answered", json: [{ tool: "find_email", parameters: { from: "ama@x.com" } }] });
  });

  it("blocks an echo of a replaced value the person did not type (spec ruling 4)", async () => {
    const { gateway } = setup({}, [echoAnswer]);
    const result = await gateway.beginTurn(personal).call({
      purpose: "intent_extraction",
      output: "json",
      parts: [userMessage("who emailed me?"), toolRecord()],
    });
    expect(result).toMatchObject({ kind: "blocked", reason: "masked_value_leaked" });
  });

  // Final review C1: the input-side check. A value the turn replaced with a placeholder must not reach a below-D2 prompt another way.
  const NONE = JSON.stringify([{ tool: "none", parameters: {} }]);
  const inbox = () => record("tool:mail", [row([field("from", "D2", "ama@x.com", { entity: { type: "person", id: "ama@x.com" } })])]);
  const echo = () => record("tool:search", [row([field("summary", "D1", 'Found 1 result for "AMA@X.COM".', { freeText: true })])]);

  it("denies masked_value_present when a replaced value reaches a D1 prompt another way, and sends nothing", async () => {
    const { gateway, deepseek, audit } = setup({}, [NONE]);
    const turn = gateway.beginTurn(personal);
    expect(await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), inbox()] })).toMatchObject({ kind: "answered" });
    const result = await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), inbox(), echo()] });
    expect(result).toMatchObject({ kind: "denied", reason: "masked_value_present" });
    expect(deepseek.calls).toHaveLength(1);
    expect(audit.decisions[1]).toMatchObject({
      decision: "deny",
      denyReason: "masked_value_present",
      alert: true,
      effectiveLimit: "D1",
      released: [],
      placeholderCount: 0,
      inputFingerprint: null,
    });
    expect(audit.outcomes).toHaveLength(1);
    expect(JSON.stringify([audit.decisions, audit.outcomes]).toLowerCase()).not.toContain("ama@x.com");
    expect(silent.warn).toHaveBeenCalledWith("boundary_alert", expect.objectContaining({ purpose: "intent_extraction", reason: "masked_value_present" }));
  });

  it.each([
    ["the bare address of a header-form sender", "Found ama@x.com in 3 results."],
    ["a plus-addressed variant", "Found Ama+news@x.com in 3 results."],
    ["the name part", "Found mail from Ama Mensah yesterday."],
  ])("denies masked_value_present for %s", async (_label, summary) => {
    const headerInbox = () => record("tool:mail", [row([field("from", "D2", "Ama Mensah <ama@x.com>", { entity: { type: "person", id: "ama@x.com" } })])]);
    const echoed = () => record("tool:search", [row([field("summary", "D1", summary, { freeText: true })])]);
    const { gateway, deepseek } = setup({}, [NONE]);
    const turn = gateway.beginTurn(personal);
    await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), headerInbox()] });
    const result = await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), headerInbox(), echoed()] });
    expect(result).toMatchObject({ kind: "denied", reason: "masked_value_present" });
    expect(deepseek.calls).toHaveLength(1);
  });

  it("does not deny a sender whose name appears in the tool catalog (Oneon-authored text), but still denies its bare address", async () => {
    const github = () => record("tool:mail", [row([field("from", "D2", "GitHub <notifications@github.com>", { entity: { type: "person", id: "notifications@github.com" } })])]);
    const catalog: PromptPart = {
      kind: "tool_catalog",
      tools: [
        { name: "list_github_prs", description: "List open pull requests on GitHub" },
        { name: "search_calendar", description: "Search Google Calendar events" },
      ],
    };
    const { gateway, deepseek } = setup({}, [NONE, NONE]);
    const turn = gateway.beginTurn(personal);
    expect(await turn.call({ purpose: "intent_extraction", output: "json", parts: [catalog, userMessage("who emailed me?"), github()] })).toMatchObject({ kind: "answered" });
    const echoedAddress = record("tool:search", [row([field("summary", "D1", "Found mail from notifications@github.com", { freeText: true })])]);
    const denied = await turn.call({ purpose: "intent_extraction", output: "json", parts: [catalog, userMessage("who emailed me?"), github(), echoedAddress] });
    expect(denied).toMatchObject({ kind: "denied", reason: "masked_value_present" });
    expect(deepseek.calls).toHaveLength(1);
  });

  it("does not scan record headers: a restored name in a tool name is not a leak", async () => {
    const github = () => record("tool:list_github_prs", [row([field("from", "D2", "GitHub <notifications@github.com>", { entity: { type: "person", id: "notifications@github.com" } })])]);
    const { gateway } = setup({}, [NONE]);
    const result = await gateway.beginTurn(personal).call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), github()] });
    expect(result).toMatchObject({ kind: "answered" });
  });

  it("does not deny a replaced value the person typed in this request", async () => {
    const { gateway, deepseek } = setup({}, [NONE]);
    const turn = gateway.beginTurn(personal);
    await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), inbox()] });
    const result = await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("did ama@x.com email me?"), inbox(), echo()] });
    expect(result).toMatchObject({ kind: "answered" });
    expect(deepseek.calls).toHaveLength(2);
  });

  it("does not apply the input check to a call whose limit is D2", async () => {
    const anthropic = new FakeProvider("anthropic", [JSON.stringify({ answer: "PERSON_1 emailed you.", usedTools: [] })]);
    const { gateway, choices, deepseek } = setup({ providers: { deepseek: new FakeProvider("deepseek", [NONE]), anthropic }, routing: { standard: "deepseek", reasoning: "anthropic" } });
    choices.record({ identityId: "u1", provider: "anthropic", maxClass: "D2", decidedOn: "2026-10-04", note: null, confirmedAt: "2026-10-04T10:00:00.000Z" });
    const turn = gateway.beginTurn(personal);
    await turn.call({ purpose: "intent_extraction", output: "json", parts: [userMessage("who emailed me?"), inbox()] }); // D1 at DeepSeek: issues PERSON_1
    const result = await turn.call({ purpose: "chat_reply", output: "json", parts: [userMessage("who emailed me?"), inbox(), echo()] }); // D2 at Anthropic
    expect(deepseek.calls).toHaveLength(0);
    expect(result).toMatchObject({ kind: "answered" });
    expect(anthropic.calls[0].user).toContain("AMA@X.COM");
  });

  it("keeps shadow placeholders out of the main turn's map (spec §6.8)", async () => {
    const mainAnswer = JSON.stringify({ answer: "ABC Hospital owes the most.", usedTools: [] });
    const shadowAnswer = JSON.stringify({ answer: "CUSTOMER_1 owes the most.", usedTools: [] });
    const anthropic = new FakeProvider("anthropic", [shadowAnswer]);
    const { gateway, choices } = setup({
      providers: { deepseek: new FakeProvider("deepseek", [mainAnswer]), anthropic },
      routing: { standard: "deepseek", reasoning: "deepseek", shadow: "anthropic" },
    });
    optIn(choices); // main at D2; the shadow provider stays at the D1 default
    const turn = gateway.beginTurn(personal);
    const request = () => ({
      purpose: "chat_reply",
      output: "json" as const,
      parts: [userMessage("who owes?"), record("tool:receivables", [row([field("name", "D2", "ABC Hospital", { entity: { type: "customer", id: "c9" } })])])],
    });
    const first = await turn.call(request());
    const second = await turn.call(request());
    await new Promise((r) => setTimeout(r, 0));
    expect(first.kind).toBe("answered");
    expect(second.kind).toBe("answered");
    expect(anthropic.calls).toHaveLength(2);
    expect(anthropic.calls[0].user).toContain("CUSTOMER_1");
    expect(turn.restoreToolParams({ customerId: "CUSTOMER_1" })).toEqual({ ok: false, token: "CUSTOMER_1" });
  });

  it("answers with a result and a decision row for an entity type the placeholder map cannot name", async () => {
    const { gateway, audit } = setup({}, [JSON.stringify({ answer: "ok", usedTools: [] })]);
    const result = await gateway.beginTurn(tenant).call({
      purpose: "chat_reply",
      output: "json",
      parts: [userMessage("who owes?"), record("tool:receivables", [row([field("name", "D2", "Corner Pharmacy", { entity: { type: "pharmacy", id: "p1" } })])])],
    });
    expect(result.kind).toBe("answered");
    expect(result.withheld).toContainEqual({ part: "record:tool:receivables", row: 0, field: "name", reason: "unclassified" });
    expect(audit.decisions).toHaveLength(1);
    expect(audit.decisions[0]).toMatchObject({ decision: "allow", alert: true });
    expect(JSON.stringify(audit.decisions)).not.toContain("Corner Pharmacy");
  });

  it("counts placeholders per call, not per turn", async () => {
    const { gateway, audit } = setup({}, [JSON.stringify({ answer: "ok", usedTools: [] })]);
    const turn = gateway.beginTurn(tenant);
    const withName = record("tool:receivables", [row([field("name", "D2", "ABC Hospital", { entity: { type: "customer", id: "c9" } })])]);
    await turn.call({ purpose: "chat_reply", output: "json", parts: [userMessage("who owes?"), withName] });
    await turn.call({ purpose: "chat_reply", output: "json", parts: [userMessage("and now?")] });
    expect(audit.decisions.map((d) => d.placeholderCount)).toEqual([1, 0]);
  });
});
