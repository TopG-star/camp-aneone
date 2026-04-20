import { describe, it, expect } from "vitest";
import type { ConversationMessage } from "@oneon/domain";
import { truncateHistory } from "./truncate-history.js";

// ── Helpers ──────────────────────────────────────────────────

function makeMsg(
  overrides: Partial<ConversationMessage> & { content: string }
): ConversationMessage {
  return {
    id: "msg-001",
    userId: null,
    conversationId: "conv-001",
    role: "user",
    toolCalls: null,
    createdAt: "2026-04-16T09:00:00Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("truncateHistory", () => {
  it("returns empty array for empty input", () => {
    const result = truncateHistory([], {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 40000,
    });

    expect(result).toEqual([]);
  });

  it("passes through messages within all limits", () => {
    const msgs = [
      makeMsg({ id: "m1", content: "Hello" }),
      makeMsg({ id: "m2", content: "World" }),
    ];

    const result = truncateHistory(msgs, {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 40000,
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Hello");
    expect(result[1].content).toBe("World");
  });

  it("limits to maxMessages (keeps most recent)", () => {
    const msgs = [
      makeMsg({ id: "m1", content: "First" }),
      makeMsg({ id: "m2", content: "Second" }),
      makeMsg({ id: "m3", content: "Third" }),
    ];

    const result = truncateHistory(msgs, {
      maxMessages: 2,
      maxCharsPerMessage: 2000,
      totalBudget: 40000,
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("Second");
    expect(result[1].content).toBe("Third");
  });

  it("truncates individual message content to maxCharsPerMessage", () => {
    const longContent = "x".repeat(3000);
    const msgs = [makeMsg({ id: "m1", content: longContent })];

    const result = truncateHistory(msgs, {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 40000,
    });

    expect(result[0].content).toHaveLength(2000);
  });

  it("enforces totalBudget by dropping oldest messages", () => {
    // 3 messages of 1000 chars each = 3000 total
    const msgs = [
      makeMsg({ id: "m1", content: "a".repeat(1000) }),
      makeMsg({ id: "m2", content: "b".repeat(1000) }),
      makeMsg({ id: "m3", content: "c".repeat(1000) }),
    ];

    // Budget only allows 2 messages worth
    const result = truncateHistory(msgs, {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 2000,
    });

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("b".repeat(1000));
    expect(result[1].content).toBe("c".repeat(1000));
  });

  it("applies per-message truncation before totalBudget check", () => {
    // 2 messages of 5000 chars each; per-message cap = 2000, budget = 3000
    // After per-message truncation: 2000 + 2000 = 4000 > 3000, drop oldest
    const msgs = [
      makeMsg({ id: "m1", content: "a".repeat(5000) }),
      makeMsg({ id: "m2", content: "b".repeat(5000) }),
    ];

    const result = truncateHistory(msgs, {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 3000,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("b".repeat(2000));
  });

  it("does not mutate the original messages", () => {
    const original = makeMsg({ id: "m1", content: "x".repeat(3000) });
    const msgs = [original];

    truncateHistory(msgs, {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 40000,
    });

    expect(original.content).toHaveLength(3000);
  });

  it("handles single message exceeding totalBudget by truncating it", () => {
    const msgs = [makeMsg({ id: "m1", content: "x".repeat(5000) })];

    const result = truncateHistory(msgs, {
      maxMessages: 20,
      maxCharsPerMessage: 2000,
      totalBudget: 500,
    });

    // The last message is always kept, truncated to budget
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(500);
  });
});
