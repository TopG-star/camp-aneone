import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { personalActor, type ClassificationRepository, type ConversationMessage, type ConversationRepository, type DeadlineRepository, type InboundItem, type InboundItemRepository, type TransactionRunner } from "@oneon/domain";
import { createModelGateway, type GatewayResult, type ModelGatewayDeps } from "./gateway.js";
import { Fingerprinter } from "./fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "./__tests__/in-memory-audit.js";
import { FakeProvider, providerDown } from "./__tests__/fake-provider.js";
import { personal, tenant, userMessage } from "./__tests__/builders.js";
import type { ModelContext } from "./types.js";
import { sendChatMessage } from "../usecases/send-chat-message.js";
import { classifyItem } from "../usecases/classify-item.js";
import { generateDailyBriefing } from "../usecases/generate-daily-briefing.js";
import { runIntentLoop } from "../usecases/run-intent-loop.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import { createChatActionTools } from "../actions/chat-action-tools.js";
import { createActionRegistry } from "../actions/registry.js";
import { harness, probeDefinition } from "../actions/__tests__/orchestrator-harness.js";

const silent = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date("2026-10-08T10:00:00.000Z");
const REPLY = JSON.stringify({ answer: "Done.", usedTools: [] });

function setup(answers: string[] | Error[], overrides: Partial<ModelGatewayDeps> = {}) {
  const deepseek = new FakeProvider("deepseek", answers);
  const personalAudit = new InMemoryModelAudit();
  const tenantAudit = new InMemoryModelAudit();
  const gateway = createModelGateway({
    providers: { deepseek },
    overrides: new Map(),
    routing: { standard: "deepseek", reasoning: "deepseek" },
    models: { deepseek: { standard: "flash", reasoning: "pro" } },
    choices: new InMemoryChoices(),
    audit: personalAudit,
    auditFor: (context: ModelContext) => (context.kind === "tenant" ? tenantAudit : personalAudit),
    fingerprinter: new Fingerprinter("k".repeat(32), 1),
    maxRetries: 0,
    timeouts: { standard: 15000, reasoning: 30000 },
    logger: silent,
    clock: () => NOW,
    ...overrides,
  });
  return { gateway, deepseek, personalAudit, tenantAudit };
}

const chat = () => ({ purpose: "chat_reply", output: "json" as const, parts: [userMessage("what is on today?")] });

function conversationRepo(): ConversationRepository {
  let n = 0;
  return {
    append: vi.fn().mockImplementation((msg) => ({
      id: `msg-${String(++n).padStart(3, "0")}`,
      userId: null,
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      createdAt: "2026-10-08T09:00:00Z",
    })),
    findRecentByConversation: vi.fn().mockReturnValue([] as ConversationMessage[]),
    countByConversation: vi.fn().mockReturnValue(0),
    count: vi.fn().mockReturnValue(0),
  };
}

describe("link ids on the model-call audit", () => {
  it("gives every result its call id, whatever the outcome", async () => {
    const results: Array<{ result: GatewayResult; audit: InMemoryModelAudit }> = [];
    {
      const { gateway, personalAudit } = setup([REPLY]);
      results.push({ result: await gateway.beginTurn(personal).call(chat()), audit: personalAudit });
    }
    {
      const { gateway, personalAudit } = setup([REPLY]);
      results.push({ result: await gateway.beginTurn(personal).call({ purpose: "no_such_purpose", output: "json", parts: [userMessage("hi")] }), audit: personalAudit });
    }
    {
      const { gateway, personalAudit } = setup(["this is not json"]);
      results.push({ result: await gateway.beginTurn(personal).call(chat()), audit: personalAudit });
    }
    {
      const { gateway, personalAudit } = setup([providerDown()]);
      results.push({ result: await gateway.beginTurn(personal).call(chat()), audit: personalAudit });
    }

    expect(results.map((r) => r.result.kind)).toEqual(["answered", "denied", "blocked", "failed"]);
    for (const { result, audit } of results) {
      expect(audit.decisions).toHaveLength(1);
      // The decision's own call id, not a second one.
      expect(result.callId).toBe(audit.decisions[0].callId);
      expect(result.decisionId).toBe(audit.decisions[0].id);
      if (result.kind !== "denied") expect(audit.outcomes[0].callId).toBe(result.callId);
    }
  });

  it("chat model calls record conversation and turn ids", async () => {
    const { gateway, personalAudit } = setup([REPLY, "this is not json"]);
    const turn = gateway.beginTurn(personal, { channel: "web", conversationId: "user:u1", turnId: "msg-001" });

    await turn.call(chat());
    await turn.call({ purpose: "no_such_purpose", output: "json", parts: [userMessage("hi")] });

    // Allowed and denied decisions alike.
    expect(personalAudit.decisions.map((d) => d.decision)).toEqual(["allow", "deny"]);
    for (const decision of personalAudit.decisions) expect(decision).toMatchObject({ conversationId: "user:u1", turnId: "msg-001", channel: "web" });
  });

  it("a whole chat turn through sendChatMessage records the user message row as the turn", async () => {
    const { gateway, deepseek, personalAudit } = setup([
      JSON.stringify([{ tool: "list_notes", parameters: {} }]),
      JSON.stringify([{ tool: "none", parameters: {} }]),
      JSON.stringify({ answer: "Here you go", usedTools: ["list_notes"] }),
    ]);
    const registry = createToolRegistry();
    registry.register({
      name: "list_notes",
      version: "1",
      description: "list_notes",
      inputSchema: z.object({}).passthrough(),
      output: { fields: { note: { class: "D1" } }, summaryClass: "D1" },
      execute: () => ({ data: { note: "n" }, summary: "1 note" }),
    });

    const result = await sendChatMessage({ conversationRepo: conversationRepo(), logger: silent, modelGateway: gateway, toolRegistry: registry }, { message: "show notes", now: NOW, userId: "u1" });

    expect(deepseek.calls).toHaveLength(3);
    expect(personalAudit.decisions.map((d) => d.purpose)).toEqual(["intent_extraction", "intent_extraction", "chat_reply"]);
    expect(result.userMessageId).toBe("msg-001");
    for (const decision of personalAudit.decisions) {
      expect(decision).toMatchObject({ conversationId: result.conversationId, turnId: result.userMessageId });
    }
  });

  it("a tenant chat turn records the ids in the tenant's own audit, not the personal one", async () => {
    const { gateway, personalAudit, tenantAudit } = setup([REPLY]);

    await gateway.beginTurn(tenant, { channel: "web", conversationId: "user:u1", turnId: "msg-009" }).call(chat());

    expect(tenantAudit.decisions[0]).toMatchObject({ contextKind: "tenant", tenantId: "t1", conversationId: "user:u1", turnId: "msg-009" });
    expect(personalAudit.decisions).toEqual([]);
  });

  it("the shadow copy of a call belongs to the same turn", async () => {
    const shadow = new FakeProvider("anthropic", [REPLY]);
    const { gateway, personalAudit } = setup([REPLY], {
      providers: { deepseek: new FakeProvider("deepseek", [REPLY]), anthropic: shadow },
      routing: { standard: "deepseek", reasoning: "deepseek", shadow: "anthropic" },
      models: { deepseek: { standard: "flash", reasoning: "pro" }, anthropic: { standard: "s", reasoning: "r" } },
    });

    await gateway.beginTurn(personal, { channel: "web", conversationId: "user:u1", turnId: "msg-001" }).call(chat());
    await vi.waitFor(() => expect(personalAudit.decisions).toHaveLength(2));

    expect(personalAudit.decisions.map((d) => d.channel).sort()).toEqual(["shadow", "web"]);
    for (const decision of personalAudit.decisions) expect(decision).toMatchObject({ conversationId: "user:u1", turnId: "msg-001" });
  });

  it("email classification and the briefing record null", async () => {
    const classification = JSON.stringify({ category: "work", priority: 2, summary: "Report due", actionItems: [], followUpNeeded: false, deadlines: [] });
    // The person has opted in to D2 for this provider, so the mail call is allowed rather than withheld.
    const choices = new InMemoryChoices();
    choices.record({ identityId: "u1", provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-01", note: "test", confirmedAt: "2026-10-01T00:00:00.000Z" });
    const { gateway, personalAudit } = setup([classification, "Your briefing."], { choices });
    const item: InboundItem = {
      id: "item-1", userId: "u1", source: "gmail", externalId: "e1", from: "ama@example.com", subject: "Report", bodyPreview: "Due Friday",
      receivedAt: "2026-10-08T08:00:00Z", rawJson: "{}", threadId: null, labels: "[]", classifiedAt: null, classifyAttempts: 0,
      createdAt: "2026-10-08T08:00:00Z", updatedAt: "2026-10-08T08:00:00Z",
    };
    await classifyItem(
      {
        inboundItemRepo: { markClassified: vi.fn(), incrementClassifyAttempts: vi.fn() } as unknown as InboundItemRepository,
        classificationRepo: { create: vi.fn().mockReturnValue({ category: "work", priority: 2 }) } as unknown as ClassificationRepository,
        deadlineRepo: { create: vi.fn() } as unknown as DeadlineRepository,
        transactionRunner: { run: (fn: () => unknown) => fn() } as unknown as TransactionRunner,
        modelGateway: gateway,
        logger: silent,
        classifierModel: "m",
        promptVersion: "v1",
      },
      item,
    );
    await generateDailyBriefing(
      {
        classificationRepo: { findAll: () => [], count: () => 0, findByInboundItemId: () => null, create: vi.fn() } as unknown as ClassificationRepository,
        inboundItemRepo: { findById: () => null, count: () => 0 } as unknown as InboundItemRepository,
        deadlineRepo: {
          findByDateRange: () => [{ id: "d1", userId: null, inboundItemId: "item-1", dueDate: "2026-10-09", description: "Report due", confidence: 0.9, status: "open", createdAt: "x", updatedAt: "x" }],
        } as unknown as DeadlineRepository,
        listPendingActions: () => [],
        modelGateway: gateway,
        logger: silent,
      },
      { now: NOW, timezone: "UTC", userId: "u1" },
    );

    expect(personalAudit.decisions.map((d) => [d.purpose, d.channel])).toEqual([
      ["email_classification", "background"],
      ["daily_briefing", "briefing"],
    ]);
    for (const decision of personalAudit.decisions) expect(decision).toMatchObject({ conversationId: null, turnId: null });
  });

  it("a call with no link options records null", async () => {
    const { gateway, personalAudit } = setup([REPLY]);

    await gateway.beginTurn(personal).call(chat());

    expect(personalAudit.decisions[0]).toMatchObject({ conversationId: null, turnId: null });
  });
});

describe("an action proposed in chat", () => {
  function chatActionSetup() {
    const answers = [
      JSON.stringify([{ tool: "create_calendar_event", parameters: { n: 1 } }]),
      JSON.stringify([{ tool: "none", parameters: {} }]),
      JSON.stringify({ answer: "Requested.", usedTools: ["create_calendar_event"] }),
    ];
    const { gateway, personalAudit } = setup(answers);
    // The probe stands in for a calendar action: same tool name, a simple input.
    const definitions = [probeDefinition({ type: "create_calendar_event" })];
    const h = harness(definitions);
    const registry = createToolRegistry();
    for (const tool of createChatActionTools({ requestAction: h.orchestrator.requestAction, registry: createActionRegistry(definitions), aiModel: "test", clock: () => NOW })) {
      registry.register(tool);
    }
    return { gateway, h, registry, audit: personalAudit };
  }

  it("an action proposed in chat records the proposing model call id", async () => {
    const { gateway, h, registry, audit } = chatActionSetup();

    const result = await sendChatMessage({ conversationRepo: conversationRepo(), logger: silent, modelGateway: gateway, toolRegistry: registry }, { message: "book a call", now: NOW, userId: "u1" });

    const [instance] = [...h.repo.instances.values()];
    expect(result.actions.map((a) => a.id)).toEqual([instance.id]);
    // The first intent call proposed it.
    const [proposing] = audit.decisions;
    expect(proposing.purpose).toBe("intent_extraction");
    expect(instance.modelCallId).toBe(proposing.callId);
  });

  it("joining the action to its model call finds the turn that caused it", async () => {
    const { gateway, h, registry, audit } = chatActionSetup();

    const result = await sendChatMessage({ conversationRepo: conversationRepo(), logger: silent, modelGateway: gateway, toolRegistry: registry }, { message: "book a call", now: NOW, userId: "u1" });

    const [instance] = [...h.repo.instances.values()];
    const joined = audit.decisions.find((d) => d.callId === instance.modelCallId);
    expect(joined).toMatchObject({ conversationId: result.conversationId, turnId: result.userMessageId });
    // The same turn the action's own chat evidence names.
    expect(instance.evidence).toContainEqual(expect.objectContaining({ kind: "chat_turn", data: expect.objectContaining({ turnId: result.userMessageId }) }));
  });

  it("takes the call id of the round that produced the intent", async () => {
    const answers = [
      JSON.stringify([{ tool: "peek", parameters: {} }]),
      JSON.stringify([{ tool: "create_calendar_event", parameters: { n: 2 } }]),
      JSON.stringify([{ tool: "none", parameters: {} }]),
    ];
    const { gateway, personalAudit } = setup(answers);
    const definitions = [probeDefinition({ type: "create_calendar_event" })];
    const h = harness(definitions);
    const registry = createToolRegistry();
    registry.register({ name: "peek", version: "1", description: "peek", inputSchema: z.object({}).passthrough(), output: { fields: {}, summaryClass: "D1" }, execute: () => ({ data: [], summary: "ok" }) });
    for (const tool of createChatActionTools({ requestAction: h.orchestrator.requestAction, registry: createActionRegistry(definitions), aiModel: "test", clock: () => NOW })) registry.register(tool);

    await runIntentLoop(
      { modelTurn: gateway.beginTurn(personal, { channel: "web", conversationId: "user:u1", turnId: "msg-001" }), toolRegistry: registry, logger: silent },
      { userMessage: "do it", userId: "u1", turnId: "msg-001", history: [], toolDefinitions: [], stats: { totalInboxItems: 0, unreadUrgentCount: 0, pendingActionsCount: 0, upcomingDeadlinesCount: 0, followUpCount: 0 }, now: NOW, timezone: "UTC" },
    );

    const [instance] = [...h.repo.instances.values()];
    expect(personalAudit.decisions).toHaveLength(3);
    expect(instance.modelCallId).toBe(personalAudit.decisions[1].callId);
  });

  it("does not let the model set the call id", async () => {
    const answers = [JSON.stringify([{ tool: "create_calendar_event", parameters: { n: 1, modelCallId: "forged" } }]), JSON.stringify([{ tool: "none", parameters: {} }])];
    const { gateway, personalAudit } = setup(answers);
    const definitions = [probeDefinition({ type: "create_calendar_event" })];
    const h = harness(definitions);
    const registry = createToolRegistry();
    for (const tool of createChatActionTools({ requestAction: h.orchestrator.requestAction, registry: createActionRegistry(definitions), aiModel: "test", clock: () => NOW })) registry.register(tool);

    await runIntentLoop(
      { modelTurn: gateway.beginTurn(personal), toolRegistry: registry, logger: silent },
      { userMessage: "do it", userId: "u1", turnId: "msg-001", history: [], toolDefinitions: [], stats: { totalInboxItems: 0, unreadUrgentCount: 0, pendingActionsCount: 0, upcomingDeadlinesCount: 0, followUpCount: 0 }, now: NOW, timezone: "UTC" },
    );

    const [instance] = [...h.repo.instances.values()];
    expect(instance.modelCallId).toBe(personalAudit.decisions[0].callId);
    expect(instance.modelCallId).not.toBe("forged");
  });

  it("an action created any other way has no model call id", async () => {
    const h = harness();

    const outcome = await h.orchestrator.requestAction({
      type: "probe",
      input: { n: 1 },
      actor: personalActor("u1"),
      initiator: "rule:test",
      keyContext: { source: "rule", resourceId: "r1" },
      evidence: [],
      resourceRef: null,
    });

    expect(outcome.kind).toBe("created");
    if (outcome.kind === "created") expect(outcome.instance.modelCallId).toBeNull();
  });

  it("stores the call id it is given", async () => {
    const h = harness();

    const outcome = await h.orchestrator.requestAction({
      type: "probe",
      input: { n: 1 },
      actor: personalActor("u1"),
      initiator: "user",
      keyContext: { source: "chat", turnId: "msg-001" },
      evidence: [],
      resourceRef: null,
      modelCallId: "call-7",
    });

    if (outcome.kind !== "created") throw new Error("not created");
    expect(outcome.instance.modelCallId).toBe("call-7");
    expect(h.repo.instances.get(outcome.instance.id)?.modelCallId).toBe("call-7");
  });
});
