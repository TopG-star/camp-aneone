import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type {
  ConversationMessage,
  ConversationRepository,
  Logger,
} from "@oneon/domain";
import { sendChatMessage, type SendChatMessageDeps } from "./send-chat-message.js";
import { createToolRegistry, type ToolRegistry, type ToolExecutionResult } from "../tools/tool-registry.js";
import { createModelGateway, type GatewayResult } from "../ai-boundary/gateway.js";
import { Fingerprinter } from "../ai-boundary/fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "../ai-boundary/__tests__/in-memory-audit.js";
import { FakeProvider } from "../ai-boundary/__tests__/fake-provider.js";
import { answered, denied, stubGateway } from "../ai-boundary/__tests__/stub-gateway.js";
import { DATA_WITHHELD_NOTE } from "./synthesize-response.js";

// ── Helpers ──────────────────────────────────────────────────

const NOW = new Date("2026-04-17T08:00:00Z");

function createMockConversationRepo(
  overrides: Partial<ConversationRepository> = {}
): ConversationRepository {
  let callCount = 0;
  return {
    append: vi.fn().mockImplementation((msg) => {
      callCount++;
      return {
        id: `msg-${String(callCount).padStart(3, "0")}`,
        userId: null,
        conversationId: msg.conversationId,
        role: msg.role,
        content: msg.content,
        toolCalls: msg.toolCalls,
        createdAt: "2026-04-16T09:00:00Z",
      } satisfies ConversationMessage;
    }),
    findRecentByConversation: vi.fn().mockReturnValue([]),
    countByConversation: vi.fn().mockReturnValue(0),
    count: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * A stub gateway: intent rounds answer from the script, and the chat reply is
 * denied unless a reply is given (the tool summaries then become the response).
 */
function createMockExtractor(
  intents: Array<Array<{ tool: string; parameters: Record<string, unknown> }>>,
  reply: GatewayResult = denied("required_part_withheld"),
) {
  let callIndex = 0;
  return stubGateway({
    respond: (req) => (req.purpose === "chat_reply" ? reply : answered(intents[callIndex++] ?? [])),
  });
}

/** A real registry with one tool that returns `result`, declaring only the action as model-visible. */
function registryWithTool(name: string, result: { data: unknown; summary: string }) {
  const registry = createToolRegistry();
  registry.register({
    name,
    version: "1",
    description: name,
    inputSchema: z.object({}).passthrough(),
    output: { fields: { action: { class: "D1" } }, summaryClass: "D2" },
    execute: () => result,
  });
  return registry;
}

function createMockToolRegistry(
  results: Record<string, ToolExecutionResult>
): ToolRegistry {
  return {
    register: vi.fn(),
    execute: vi.fn(async (name: string) => {
      const result = results[name];
      if (!result) throw new Error(`Tool "${name}" not found`);
      return result;
    }),
    list: vi.fn(() =>
      Object.keys(results).map((name) => ({
        name,
        version: "1.0.0",
        description: `${name} tool`,
      }))
    ),
    get: vi.fn(),
    has: vi.fn((name: string) => name in results),
  };
}

function makeToolResult(
  name: string,
  summary: string,
  data: unknown = {}
): ToolExecutionResult {
  return {
    data,
    summary,
    meta: {
      toolName: name,
      toolVersion: "1.0.0",
      durationMs: 10,
      executedAt: NOW,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("sendChatMessage", () => {
  let deps: SendChatMessageDeps;
  let conversationRepo: ConversationRepository;
  let logger: Logger;

  beforeEach(() => {
    conversationRepo = createMockConversationRepo();
    logger = createMockLogger();
    deps = { conversationRepo, logger };
  });

  // ── Placeholder path (no modelGateway) ──────────────────

  it("persists the user message via conversationRepo.append", async () => {
    await sendChatMessage(deps, { message: "Hello Oneon", userId: "user-A" });

    expect(conversationRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: "Hello Oneon",
        toolCalls: null,
      })
    );
  });

  it("persists the assistant placeholder response when no gateway", async () => {
    await sendChatMessage(deps, { message: "Hello", userId: "user-A" });

    const calls = (conversationRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    // Second call is the assistant message
    expect(calls[1][0]).toEqual(
      expect.objectContaining({
        role: "assistant",
        toolCalls: null,
      })
    );
    expect(calls[1][0].content).toContain("not connected to tools yet");
  });

  it("returns both userMessageId and assistantMessageId", async () => {
    const result = await sendChatMessage(deps, { message: "Hello", userId: "user-A" });

    expect(result.userMessageId).toBe("msg-001");
    expect(result.assistantMessageId).toBe("msg-002");
  });

  it("returns the placeholder response text when no extractor", async () => {
    const result = await sendChatMessage(deps, { message: "Hello", userId: "user-A" });

    expect(result.response).toContain("not connected to tools yet");
  });

  // ── Conversation ID management ─────────────────────────────

  it("generates a new conversationId when none provided", async () => {
    const result = await sendChatMessage(deps, { message: "Hello", userId: "user-A" });

    expect(result.conversationId).toBeTruthy();
    expect(typeof result.conversationId).toBe("string");
    expect(result.conversationId.length).toBeGreaterThan(0);
  });

  it("uses the provided conversationId", async () => {
    const result = await sendChatMessage(deps, {
      message: "Hello",
      conversationId: "conv-existing",
      userId: "user-A",
    });

    expect(result.conversationId).toBe("conv-existing");
    expect(conversationRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-existing" })
    );
  });

  it("passes conversationId to both user and assistant messages", async () => {
    await sendChatMessage(deps, {
      message: "Hello",
      conversationId: "conv-ABC",
      userId: "user-A",
    });

    const calls = (conversationRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].conversationId).toBe("conv-ABC");
    expect(calls[1][0].conversationId).toBe("conv-ABC");
  });

  // ── History retrieval ──────────────────────────────────────

  it("retrieves recent history for the conversation", async () => {
    await sendChatMessage(deps, {
      message: "Hello",
      conversationId: "conv-001",
      userId: "user-A",
    });

    expect(conversationRepo.findRecentByConversation).toHaveBeenCalledWith(
      "conv-001",
      20,
      "user-A"
    );
  });

  it("includes history in the result", async () => {
    const existingMessages: ConversationMessage[] = [
      {
        id: "old-001",
        userId: null,
        conversationId: "conv-001",
        role: "user",
        content: "Previous message",
        toolCalls: null,
        createdAt: "2026-04-16T08:00:00Z",
      },
    ];

    conversationRepo = createMockConversationRepo({
      findRecentByConversation: vi.fn().mockReturnValue(existingMessages),
    });
    deps = { conversationRepo, logger };

    const result = await sendChatMessage(deps, {
      message: "Hello",
      conversationId: "conv-001",
      userId: "user-A",
    });

    expect(result.history).toHaveLength(1);
    expect(result.history[0].content).toBe("Previous message");
  });

  // ── Logging ────────────────────────────────────────────────

  it("logs the chat message event", async () => {
    await sendChatMessage(deps, {
      message: "Hello",
      conversationId: "conv-001",
      userId: "user-A",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Chat message processed",
      expect.objectContaining({ conversationId: "conv-001" })
    );
  });

  // ── Intent Loop Path ──────────────────────────────────────

  it("runs intent loop when modelGateway and toolRegistry provided", async () => {
    const extractor = createMockExtractor(
      [
        [{ tool: "list_deadlines", parameters: {} }],
        [{ tool: "none", parameters: {} }],
      ],
      answered({ answer: "You have 2 deadlines this week.", usedTools: ["list_deadlines"] }),
    );
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 2 deadlines"),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "What deadlines do I have?", now: NOW, timezone: "UTC", userId: "user-A" }
    );

    expect(result.response).toBe("You have 2 deadlines this week.");
    expect(extractor.requests.map((r) => r.purpose)).toEqual(["intent_extraction", "intent_extraction", "chat_reply"]);
  });

  it("passes the turn id to tools and returns the actions they requested", async () => {
    const extractor = createMockExtractor([
      [{ tool: "create_calendar_event", parameters: { title: "Call" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const action = { id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" };
    const registry = createMockToolRegistry({
      create_calendar_event: makeToolResult("create_calendar_event", "Waiting…", { action }),
    });

    const result = await sendChatMessage(
      { conversationRepo, logger, modelGateway: extractor, toolRegistry: registry },
      { message: "Set up a call", now: NOW, userId: "user-A" }
    );

    expect(result.actions).toEqual([action]);
    expect(registry.execute).toHaveBeenCalledWith(
      "create_calendar_event",
      expect.objectContaining({ turnId: result.userMessageId, turnExcerpt: "Set up a call" })
    );
  });

  it("persists tool calls JSON in assistant message", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: {} }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    const appendCalls = (conversationRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = appendCalls[1][0];
    expect(assistantCall.toolCalls).not.toBeNull();

    const parsed = JSON.parse(assistantCall.toolCalls!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool).toBe("list_deadlines");
  });

  it("falls back to tool summaries when the chat reply fails", async () => {
    const extractor = createMockExtractor(
      [
        [{ tool: "list_deadlines", parameters: {} }],
        [{ tool: "none", parameters: {} }],
      ],
      { kind: "failed", message: "Model call failed", withheld: [], decisionId: "d" },
    );
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 2 deadlines"),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toBe("Found 2 deadlines");
    expect(logger.warn).toHaveBeenCalledWith("Chat reply unavailable", { kind: "failed" });
  });

  it("adds the withheld note to the summaries when the chat reply is denied", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: {} }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 2 deadlines"),
    });

    const result = await sendChatMessage(
      { conversationRepo, logger, modelGateway: extractor, toolRegistry: registry },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toBe(`Found 2 deadlines\n\n${DATA_WITHHELD_NOTE}`);
  });

  it("adds the withheld note to an answer when tool data was withheld", async () => {
    const reply: GatewayResult = {
      ...answered({ answer: "Two deadlines.", usedTools: [] }),
      withheld: [{ part: "record:tool:list_deadlines", reason: "above_limit" }],
    };
    const extractor = createMockExtractor(
      [
        [{ tool: "list_deadlines", parameters: {} }],
        [{ tool: "none", parameters: {} }],
      ],
      reply,
    );
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 2 deadlines"),
    });

    const result = await sendChatMessage(
      { conversationRepo, logger, modelGateway: extractor, toolRegistry: registry },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toBe(`Two deadlines.\n\n${DATA_WITHHELD_NOTE}`);
  });

  it("uses one turn per message for the intent rounds and the reply", async () => {
    const beginTurn = vi.fn();
    const inner = createMockExtractor([[{ tool: "list_deadlines", parameters: {} }], [{ tool: "none", parameters: {} }]]);
    beginTurn.mockImplementation((ctx, opts) => inner.beginTurn(ctx, opts));
    const registry = createMockToolRegistry({ list_deadlines: makeToolResult("list_deadlines", "ok") });

    await sendChatMessage(
      { conversationRepo, logger, modelGateway: { beginTurn }, toolRegistry: registry },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(beginTurn).toHaveBeenCalledTimes(1);
    expect(beginTurn).toHaveBeenCalledWith({ kind: "personal", identityId: "user-A" }, { channel: "web" });
  });

  it("returns concatenated summaries when the chat reply is denied", async () => {
    const extractor = createMockExtractor([
      [
        { tool: "list_deadlines", parameters: {} },
        { tool: "search_emails", parameters: { query: "urgent" } },
      ],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "2 deadlines"),
      search_emails: makeToolResult("search_emails", "5 emails found"),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toContain("2 deadlines");
    expect(result.response).toContain("5 emails found");
  });

  it("returns finance tool summaries for finance intents", async () => {
    const extractor = createMockExtractor([
      [{ tool: "search_finance_transactions", parameters: { q: "uber" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      search_finance_transactions: makeToolResult(
        "search_finance_transactions",
        'Found 2 transactions for "uber".'
      ),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "Show my uber transactions", now: NOW, userId: "user-A" }
    );

    expect(result.response).toContain('Found 2 transactions for "uber".');

    const appendCalls = (conversationRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = appendCalls[1][0];
    const parsedToolCalls = JSON.parse(assistantCall.toolCalls as string) as Array<{
      tool: string;
    }>;
    expect(parsedToolCalls[0].tool).toBe("search_finance_transactions");
  });

  it("returns teams tool summaries for teams intents", async () => {
    const extractor = createMockExtractor([
      [
        {
          tool: "search_teams_messages",
          parameters: { query: "release" },
        },
      ],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      search_teams_messages: makeToolResult(
        "search_teams_messages",
        'Found 1 Teams message(s) matching "release".',
      ),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "Find Teams updates about release", now: NOW, userId: "user-A" },
    );

    expect(result.response).toContain(
      'Found 1 Teams message(s) matching "release".',
    );

    const appendCalls = (conversationRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = appendCalls[1][0];
    const parsedToolCalls = JSON.parse(assistantCall.toolCalls as string) as Array<{
      tool: string;
    }>;
    expect(parsedToolCalls[0].tool).toBe("search_teams_messages");
  });

  it("Alfred-like milestone: returns memory-grounded response for style planning prompts", async () => {
    const extractor = createMockExtractor([
      [
        {
          tool: "search_personal_memory",
          parameters: { query: "response style for action proposals", includeDocs: true },
        },
      ],
      [{ tool: "none", parameters: {} }],
    ]);

    const registry = createMockToolRegistry({
      search_personal_memory: makeToolResult(
        "search_personal_memory",
        'Found 2 personal memory matches for "response style for action proposals".',
        [
          { source: "note", title: "Style", snippet: "Keep output concise and direct." },
          { source: "doc", title: "docs/style.md", snippet: "Use concise, action-oriented language." },
        ],
      ),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "Draft my plan in my usual style", now: NOW, userId: "user-A" },
    );

    expect(registry.execute).toHaveBeenCalledWith(
      "search_personal_memory",
      expect.objectContaining({
        query: "response style for action proposals",
        includeDocs: true,
        userId: "user-A",
      }),
    );
    expect(result.response).toContain("Found 2 personal memory matches");
  });

  it("returns fallback when loop produces no tool calls", async () => {
    const extractor = createMockExtractor([
      [], // empty intents → stops immediately
    ]);
    const registry = createMockToolRegistry({});

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: extractor,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toContain("trouble processing");
  });

  it("still answers at the D1 default, leaving earlier assistant replies out (Review Focus 1)", async () => {
    const provider = new FakeProvider("deepseek", [JSON.stringify([{ tool: "none", parameters: {} }])]);
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
    const seeded: ConversationMessage[] = [
      { id: "h1", userId: "u1", conversationId: "user:u1", role: "user", content: "hi", toolCalls: null, createdAt: "2026-04-16T08:00:00Z" },
      { id: "h2", userId: "u1", conversationId: "user:u1", role: "assistant", content: "Ama owes you GHS 400", toolCalls: null, createdAt: "2026-04-16T08:00:01Z" },
    ];
    conversationRepo = createMockConversationRepo({ findRecentByConversation: vi.fn().mockReturnValue(seeded) });

    const result = await sendChatMessage(
      { conversationRepo, logger, modelGateway: gateway, toolRegistry: createMockToolRegistry({}) },
      { message: "anything new?", now: NOW, userId: "u1" }
    );

    expect(result.response.length).toBeGreaterThan(0);
    expect(provider.calls[0].user).not.toContain("Ama owes you");
    expect(provider.calls[0].user).toContain("anything new?");
  });

  it("still lists the requested action when the chat reply is denied (Review Focus 7)", async () => {
    const action = { id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" };
    let intentRounds = 0;
    const gateway = stubGateway({
      respond: (req) =>
        req.purpose === "chat_reply"
          ? denied("required_part_withheld")
          : answered(intentRounds++ === 0 ? [{ tool: "create_calendar_event", parameters: { title: "Sync" } }] : [{ tool: "none", parameters: {} }]),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        modelGateway: gateway,
        toolRegistry: registryWithTool("create_calendar_event", { data: { action }, summary: "Waiting for your approval in Action Center." }),
      },
      { message: "book a sync", now: NOW, userId: "u1" }
    );

    expect(result.actions).toEqual([action]);
    expect(result.response).toContain("Waiting for your approval");
  });
});
