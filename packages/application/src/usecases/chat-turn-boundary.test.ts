import { describe, it, expect, vi } from "vitest";
import type { ClassificationRepository, InboundItem, InboundItemRepository } from "@oneon/domain";
import { createModelGateway } from "../ai-boundary/gateway.js";
import { Fingerprinter } from "../ai-boundary/fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "../ai-boundary/__tests__/in-memory-audit.js";
import { FakeProvider } from "../ai-boundary/__tests__/fake-provider.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import { createListInboxTool } from "../tools/list-inbox.js";
import { createSearchEmailsTool } from "../tools/search-emails.js";
import { runIntentLoop } from "./run-intent-loop.js";
import { synthesizeResponse } from "./synthesize-response.js";

// Real gateway, real intent loop, real tools: the boundary is checked end to end at the personal D1 default.

const silent = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SENDER = "Ama Mensah <ama.mensah@example.com>";
const ADDRESS = "ama.mensah@example.com";

const item: InboundItem = {
  id: "item-1",
  userId: "u1",
  source: "gmail",
  externalId: "ext-1",
  from: SENDER,
  subject: "Quarterly figures",
  bodyPreview: "See attached.",
  receivedAt: "2026-10-03T09:00:00Z",
  rawJson: "{}",
  threadId: null,
  labels: "[]",
  classifiedAt: null,
  classifyAttempts: 0,
  createdAt: "2026-10-03T09:00:00Z",
  updatedAt: "2026-10-03T09:00:00Z",
};

function mailRepos() {
  const inboundItemRepo = {
    findAll: vi.fn(() => [item]),
    search: vi.fn(({ query }: { query: string }) => (item.from.toLowerCase().includes(query.toLowerCase()) ? [item] : [])),
    findById: vi.fn(() => item),
  } as unknown as InboundItemRepository;
  const classificationRepo = { findByInboundItemId: vi.fn(() => null) } as unknown as ClassificationRepository;
  return { inboundItemRepo, classificationRepo };
}

function gatewayWith(answers: string[]) {
  const deepseek = new FakeProvider("deepseek", answers);
  const gateway = createModelGateway({
    providers: { deepseek },
    overrides: new Map(),
    routing: { standard: "deepseek", reasoning: "deepseek" },
    models: { deepseek: { standard: "flash", reasoning: "pro" } },
    choices: new InMemoryChoices(), // no opt-in: the personal D1 default
    audit: new InMemoryModelAudit(),
    fingerprinter: new Fingerprinter("k".repeat(32), 1),
    maxRetries: 0,
    timeouts: { standard: 15000, reasoning: 30000 },
    logger: silent,
  });
  return { gateway, deepseek };
}

const loopInput = (userMessage: string) => ({
  userMessage,
  userId: "u1",
  turnId: "msg-1",
  history: [],
  toolDefinitions: [],
  stats: { totalInboxItems: 1, unreadUrgentCount: 0, pendingActionsCount: 0, upcomingDeadlinesCount: 0, followUpCount: 0 },
  now: new Date("2026-10-04T08:00:00Z"),
  timezone: "UTC",
});

describe("chat turn at the personal D1 default", () => {
  it("never sends a sender's real address after the model searches by its placeholder (C1)", async () => {
    const { inboundItemRepo, classificationRepo } = mailRepos();
    const registry = createToolRegistry();
    registry.register(createListInboxTool({ inboundItemRepo, classificationRepo }));
    registry.register(createSearchEmailsTool({ inboundItemRepo, classificationRepo }));
    const { gateway, deepseek } = gatewayWith([
      JSON.stringify([{ tool: "list_inbox", parameters: {} }]),
      JSON.stringify([{ tool: "search_emails", parameters: { query: "PERSON_1" } }]),
      JSON.stringify([{ tool: "none", parameters: {} }]),
      JSON.stringify({ answer: "PERSON_1 emailed you once.", usedTools: ["search_emails"] }),
    ]);
    const turn = gateway.beginTurn({ kind: "personal", identityId: "u1" }, { channel: "web" });

    const loop = await runIntentLoop({ modelTurn: turn, toolRegistry: registry, logger: silent }, loopInput("Show me everything from whoever emailed me last"));
    const reply = await synthesizeResponse(
      { modelTurn: turn, logger: silent },
      { userMessage: "Show me everything from whoever emailed me last", toolCalls: loop.toolCalls, history: [], persona: null, registry },
    );

    // The scenario happened: the inbox listing showed PERSON_1, and the search ran with the real address.
    expect(deepseek.calls[1].user).toContain("from: PERSON_1");
    expect(inboundItemRepo.search).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining(ADDRESS) }));
    expect(loop.toolCalls.map((c) => c.tool)).toEqual(["list_inbox", "search_emails"]);
    expect(reply.kind).toBe("answered");
    expect(deepseek.calls).toHaveLength(4);
    // No provider call, before or after the search, carries the real address or name.
    for (const call of deepseek.calls) {
      expect(`${call.system}\n${call.user}`).not.toContain(ADDRESS);
      expect(`${call.system}\n${call.user}`).not.toContain("Ama Mensah");
    }
  });
});
