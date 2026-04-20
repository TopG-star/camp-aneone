import { describe, it, expect } from "vitest";
import {
  buildChatContext,
  type BuildChatContextInput,
  type ChatContextStats,
  type ToolCallRecord,
} from "./build-chat-context.js";
import type { ConversationMessage } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

const NOW = new Date("2026-04-17T08:00:00Z");
const TIMEZONE = "America/New_York";

function makeMessage(
  overrides: Partial<ConversationMessage> = {}
): ConversationMessage {
  return {
    id: "msg-1",
    userId: null,
    conversationId: "conv-1",
    role: "user",
    content: "Hello",
    toolCalls: null,
    createdAt: "2026-04-17T07:55:00Z",
    ...overrides,
  };
}

function makeStats(overrides: Partial<ChatContextStats> = {}): ChatContextStats {
  return {
    totalInboxItems: 0,
    unreadUrgentCount: 0,
    pendingActionsCount: 0,
    upcomingDeadlinesCount: 0,
    followUpCount: 0,
    ...overrides,
  };
}

function makeToolCallRecord(
  overrides: Partial<ToolCallRecord> = {}
): ToolCallRecord {
  return {
    id: "tc-1",
    round: 1,
    tool: "list_deadlines",
    parameters: { from: "2026-04-17" },
    result: { data: [], summary: "No deadlines found" },
    error: null,
    durationMs: 42,
    executedAt: "2026-04-17T08:00:01Z",
    ...overrides,
  };
}

function defaultInput(
  overrides: Partial<BuildChatContextInput> = {}
): BuildChatContextInput {
  return {
    stats: makeStats(),
    history: [],
    toolDefinitions: [],
    executedActions: [],
    now: NOW,
    timezone: TIMEZONE,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("buildChatContext", () => {
  it("returns a string containing all 5 section headers", () => {
    const result = buildChatContext(defaultInput());

    expect(result).toContain("=== SYSTEM ===");
    expect(result).toContain("=== HISTORY ===");
    expect(result).toContain("=== LOCAL CONTEXT ===");
    expect(result).toContain("=== TOOLS ===");
    expect(result).toContain("=== ACTIONS ALREADY EXECUTED THIS TURN ===");
  });

  it("injects now and timezone into SYSTEM block", () => {
    const result = buildChatContext(defaultInput());

    expect(result).toContain("2026-04-17T08:00:00");
    expect(result).toContain("America/New_York");
  });

  it("includes history messages in HISTORY block", () => {
    const history = [
      makeMessage({ role: "user", content: "What are my deadlines?" }),
      makeMessage({
        id: "msg-2",
        role: "assistant",
        content: "You have 3 deadlines this week.",
      }),
    ];

    const result = buildChatContext(defaultInput({ history }));

    expect(result).toContain("[user]: What are my deadlines?");
    expect(result).toContain("[assistant]: You have 3 deadlines this week.");
  });

  it("shows empty history notice when no messages", () => {
    const result = buildChatContext(defaultInput({ history: [] }));

    expect(result).toContain("No previous messages");
  });

  it("includes stats in LOCAL CONTEXT block", () => {
    const stats = makeStats({
      totalInboxItems: 142,
      unreadUrgentCount: 5,
      pendingActionsCount: 3,
      upcomingDeadlinesCount: 7,
      followUpCount: 2,
    });

    const result = buildChatContext(defaultInput({ stats }));

    expect(result).toContain("Total inbox items: 142");
    expect(result).toContain("Unread urgent: 5");
    expect(result).toContain("Pending actions: 3");
    expect(result).toContain("Upcoming deadlines: 7");
    expect(result).toContain("Follow-ups needed: 2");
  });

  it("lists tool definitions in TOOLS block", () => {
    const toolDefinitions = [
      { name: "list_deadlines", description: "List deadlines in date range" },
      { name: "search_emails", description: "Search emails by query" },
    ];

    const result = buildChatContext(defaultInput({ toolDefinitions }));

    expect(result).toContain("- list_deadlines: List deadlines in date range");
    expect(result).toContain("- search_emails: Search emails by query");
  });

  it("shows no tools notice when definitions empty", () => {
    const result = buildChatContext(
      defaultInput({ toolDefinitions: [] })
    );

    expect(result).toContain("No tools available");
  });

  it("shows executed actions with summaries and IDs", () => {
    const executedActions = [
      makeToolCallRecord({
        id: "tc-abc",
        tool: "list_deadlines",
        result: { data: [1, 2], summary: "Found 2 deadlines" },
      }),
      makeToolCallRecord({
        id: "tc-def",
        round: 1,
        tool: "search_emails",
        result: { data: [], summary: "No matching emails" },
        error: null,
      }),
    ];

    const result = buildChatContext(defaultInput({ executedActions }));

    expect(result).toContain("tc-abc");
    expect(result).toContain("list_deadlines");
    expect(result).toContain("Found 2 deadlines");
    expect(result).toContain("tc-def");
    expect(result).toContain("search_emails");
    expect(result).toContain("No matching emails");
  });

  it("shows error summary for failed tool calls", () => {
    const executedActions = [
      makeToolCallRecord({
        id: "tc-err",
        tool: "list_inbox",
        result: null,
        error: "Tool validation failed",
      }),
    ];

    const result = buildChatContext(defaultInput({ executedActions }));

    expect(result).toContain("tc-err");
    expect(result).toContain("list_inbox");
    expect(result).toContain("ERROR: Tool validation failed");
  });

  it("shows no actions notice when executedActions empty", () => {
    const result = buildChatContext(defaultInput({ executedActions: [] }));

    expect(result).toContain("No actions executed yet");
  });

  it("preserves block ordering: SYSTEM → HISTORY → LOCAL CONTEXT → TOOLS → ACTIONS", () => {
    const result = buildChatContext(
      defaultInput({
        history: [makeMessage()],
        toolDefinitions: [{ name: "t1", description: "d1" }],
        executedActions: [makeToolCallRecord()],
        stats: makeStats({ totalInboxItems: 1 }),
      })
    );

    const systemIdx = result.indexOf("=== SYSTEM ===");
    const historyIdx = result.indexOf("=== HISTORY ===");
    const contextIdx = result.indexOf("=== LOCAL CONTEXT ===");
    const toolsIdx = result.indexOf("=== TOOLS ===");
    const actionsIdx = result.indexOf("=== ACTIONS ALREADY EXECUTED THIS TURN ===");

    expect(systemIdx).toBeLessThan(historyIdx);
    expect(historyIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(actionsIdx);
  });
});
