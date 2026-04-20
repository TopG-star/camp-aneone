import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ConversationMessage,
  ConversationRepository,
  IntentExtractionPort,
  SynthesisPort,
  Logger,
} from "@oneon/domain";
import { sendChatMessage, type SendChatMessageDeps } from "./send-chat-message.js";
import type { ToolRegistry, ToolExecutionResult } from "../tools/tool-registry.js";

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

function createMockExtractor(
  intents: Array<Array<{ tool: string; parameters: Record<string, unknown> }>>
): IntentExtractionPort {
  let callIndex = 0;
  return {
    extractIntents: vi.fn(async () => {
      const response = intents[callIndex] ?? [];
      callIndex++;
      return response;
    }),
  };
}

function createMockSynthesizer(response: string): SynthesisPort {
  return {
    synthesize: vi.fn(async () => response),
  };
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

  // ── Placeholder path (no intentExtractor) ──────────────────

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

  it("persists the assistant placeholder response when no extractor", async () => {
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

  it("runs intent loop when intentExtractor and toolRegistry provided", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: {} }],
      [{ tool: "none", parameters: {} }],
    ]);
    const synthesizer = createMockSynthesizer("You have 2 deadlines this week.");
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 2 deadlines"),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        intentExtractor: extractor,
        synthesizer,
        toolRegistry: registry,
      },
      { message: "What deadlines do I have?", now: NOW, timezone: "UTC", userId: "user-A" }
    );

    expect(result.response).toBe("You have 2 deadlines this week.");
    expect(extractor.extractIntents).toHaveBeenCalled();
    expect(synthesizer.synthesize).toHaveBeenCalled();
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
        intentExtractor: extractor,
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

  it("falls back to tool summaries when synthesizer fails", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: {} }],
      [{ tool: "none", parameters: {} }],
    ]);
    const failingSynthesizer: SynthesisPort = {
      synthesize: vi.fn(async () => {
        throw new Error("LLM down");
      }),
    };
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 2 deadlines"),
    });

    const result = await sendChatMessage(
      {
        conversationRepo,
        logger,
        intentExtractor: extractor,
        synthesizer: failingSynthesizer,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toBe("Found 2 deadlines");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Synthesis failed"),
      expect.anything()
    );
  });

  it("returns concatenated summaries when no synthesizer provided", async () => {
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
        intentExtractor: extractor,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toContain("2 deadlines");
    expect(result.response).toContain("5 emails found");
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
        intentExtractor: extractor,
        toolRegistry: registry,
      },
      { message: "test", now: NOW, userId: "user-A" }
    );

    expect(result.response).toContain("trouble processing");
  });
});
