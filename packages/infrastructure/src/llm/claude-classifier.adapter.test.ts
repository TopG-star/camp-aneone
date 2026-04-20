import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeClassifierAdapter, type ClaudeClassifierConfig } from "./claude-classifier.adapter.js";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";
import { classificationSchema, intentSchema } from "./classification.schema.js";
import type { Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const VALID_CLASSIFICATION = {
  category: "work",
  priority: 2,
  summary: "Meeting request from team lead.",
  actionItems: ["Accept meeting invite", "Prepare agenda"],
  followUpNeeded: true,
  deadlines: [
    {
      dueDate: "2025-01-15T10:00:00Z",
      description: "Team standup",
      confidence: 0.9,
    },
  ],
};

const VALID_INTENTS = [
  {
    tool: "list_calendar_events",
    parameters: { date: "2025-01-15", subject: "Sync" },
  },
];

function mockAnthropicResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// ── Classification Schema Tests ──────────────────────────────

describe("classificationSchema", () => {
  it("accepts valid classification output", () => {
    const result = classificationSchema.safeParse(VALID_CLASSIFICATION);
    expect(result.success).toBe(true);
  });

  it("rejects invalid category", () => {
    const result = classificationSchema.safeParse({
      ...VALID_CLASSIFICATION,
      category: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects priority out of range", () => {
    const result = classificationSchema.safeParse({
      ...VALID_CLASSIFICATION,
      priority: 6,
    });
    expect(result.success).toBe(false);
  });

  it("rejects priority 0", () => {
    const result = classificationSchema.safeParse({
      ...VALID_CLASSIFICATION,
      priority: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty summary", () => {
    const result = classificationSchema.safeParse({
      ...VALID_CLASSIFICATION,
      summary: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence > 1", () => {
    const result = classificationSchema.safeParse({
      ...VALID_CLASSIFICATION,
      deadlines: [{ dueDate: "2025-01-15", description: "x", confidence: 1.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty actionItems and deadlines arrays", () => {
    const result = classificationSchema.safeParse({
      ...VALID_CLASSIFICATION,
      actionItems: [],
      deadlines: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = classificationSchema.safeParse({
      category: "work",
    });
    expect(result.success).toBe(false);
  });
});

describe("intentSchema", () => {
  it("accepts valid intent array", () => {
    const result = intentSchema.safeParse(VALID_INTENTS);
    expect(result.success).toBe(true);
  });

  it("accepts empty array", () => {
    const result = intentSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("rejects non-array", () => {
    const result = intentSchema.safeParse({ type: "test" });
    expect(result.success).toBe(false);
  });
});

// ── Circuit Breaker Tests ────────────────────────────────────

describe("CircuitBreaker", () => {
  let logger: Logger;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    logger = createMockLogger();
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      logger,
    });
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
  });

  it("passes through calls in closed state", async () => {
    const result = await breaker.execute(async () => "hello");
    expect(result).toBe("hello");
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after reaching failure threshold", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow("fail");
    }
    expect(breaker.getState()).toBe("open");
  });

  it("rejects calls in open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow("fail");
    }

    await expect(
      breaker.execute(async () => "should not run")
    ).rejects.toThrow(CircuitOpenError);
  });

  it("opens immediately on 401 status code", async () => {
    const authError = Object.assign(new Error("Unauthorized"), { status: 401 });
    await expect(breaker.execute(async () => { throw authError; })).rejects.toThrow("Unauthorized");
    expect(breaker.getState()).toBe("open");
  });

  it("opens immediately on 403 status code", async () => {
    const forbiddenError = Object.assign(new Error("Forbidden"), { status: 403 });
    await expect(breaker.execute(async () => { throw forbiddenError; })).rejects.toThrow("Forbidden");
    expect(breaker.getState()).toBe("open");
  });

  it("transitions to half-open after reset timeout", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("open");

    // Simulate time passing by manipulating the internal state
    // We use _reset + re-trigger to test the timeout logic
    // Instead, let's directly test via the timestamp approach
    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(breaker.getState()).toBe("half-open");
    vi.useRealTimers();
  });

  it("closes after successful call in half-open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("open");

    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(breaker.getState()).toBe("half-open");

    const result = await breaker.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
    vi.useRealTimers();
  });

  it("reopens on failure in half-open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    }

    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(breaker.getState()).toBe("half-open");

    await expect(breaker.execute(async () => { throw new Error("still broken"); })).rejects.toThrow();
    // After 3 total failures + 1 more = 4, which is ≥ threshold, it opens again
    expect(breaker.getState()).toBe("open");
    vi.useRealTimers();
  });

  it("resets failure count on success", async () => {
    const error = new Error("fail");
    // 2 failures (below threshold of 3)
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();

    // 1 success resets
    await breaker.execute(async () => "ok");
    expect(breaker.getState()).toBe("closed");

    // 2 more failures should still not open
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    expect(breaker.getState()).toBe("closed");
  });
});

// ── Claude Classifier Adapter Tests ──────────────────────────

describe("ClaudeClassifierAdapter", () => {
  let logger: Logger;
  let mockCreate: ReturnType<typeof vi.fn>;
  let adapter: ClaudeClassifierAdapter;

  const defaultConfig: ClaudeClassifierConfig = {
    apiKey: "test-api-key",
    classifierModel: "claude-3-5-haiku-20241022",
    synthesisModel: "claude-sonnet-4-20250514",
    maxRetries: 1,
    timeoutMs: 5000,
    circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60000 },
    logger: createMockLogger(),
  };

  beforeEach(() => {
    logger = createMockLogger();
    mockCreate = vi.fn();

    adapter = new ClaudeClassifierAdapter({
      ...defaultConfig,
      logger,
    });

    // Mock the internal Anthropic client
    const mockClient = { messages: { create: mockCreate } };
    (adapter as unknown as { client: typeof mockClient }).client = mockClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("classify()", () => {
    const classifyInput = {
      from: "boss@company.com",
      subject: "Urgent: Q4 Review",
      bodyPreview: "Please review the Q4 numbers by EOD.",
      source: "outlook",
    };

    it("returns valid classification on first attempt", async () => {
      mockCreate.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify(VALID_CLASSIFICATION))
      );

      const result = await adapter.classify(classifyInput);

      expect(result.category).toBe("work");
      expect(result.priority).toBe(2);
      expect(result.summary).toBe("Meeting request from team lead.");
      expect(result.actionItems).toHaveLength(2);
      expect(result.followUpNeeded).toBe(true);
      expect(result.deadlines).toHaveLength(1);
    });

    it("retries on JSON parse failure and succeeds", async () => {
      mockCreate
        .mockResolvedValueOnce(mockAnthropicResponse("not json at all"))
        .mockResolvedValueOnce(
          mockAnthropicResponse(JSON.stringify(VALID_CLASSIFICATION))
        );

      const result = await adapter.classify(classifyInput);
      expect(result.category).toBe("work");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("retries on Zod validation failure and succeeds", async () => {
      const invalidOutput = { ...VALID_CLASSIFICATION, category: "invalid" };
      mockCreate
        .mockResolvedValueOnce(
          mockAnthropicResponse(JSON.stringify(invalidOutput))
        )
        .mockResolvedValueOnce(
          mockAnthropicResponse(JSON.stringify(VALID_CLASSIFICATION))
        );

      const result = await adapter.classify(classifyInput);
      expect(result.category).toBe("work");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting retries on persistent validation failure", async () => {
      const invalidOutput = { ...VALID_CLASSIFICATION, category: "invalid" };
      mockCreate.mockResolvedValue(
        mockAnthropicResponse(JSON.stringify(invalidOutput))
      );

      await expect(adapter.classify(classifyInput)).rejects.toThrow(
        "Zod validation failed"
      );
      // maxRetries=1 → attempt 0 + attempt 1 = 2 calls
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("throws immediately on non-parse API errors", async () => {
      const apiError = Object.assign(new Error("Rate limited"), {
        status: 429,
      });
      mockCreate.mockRejectedValueOnce(apiError);

      await expect(adapter.classify(classifyInput)).rejects.toThrow(
        "Rate limited"
      );
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("throws when response has no text block", async () => {
      mockCreate.mockResolvedValueOnce({ content: [] });

      await expect(adapter.classify(classifyInput)).rejects.toThrow(
        "No text content in Claude response"
      );
    });

    it("passes correct model and system prompt to Claude", async () => {
      mockCreate.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify(VALID_CLASSIFICATION))
      );

      await adapter.classify(classifyInput);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 1024,
          system: expect.stringContaining("email classification assistant"),
          messages: [
            {
              role: "user",
              content: expect.stringContaining("boss@company.com"),
            },
          ],
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });
  });

  describe("synthesize()", () => {
    it("returns synthesized text", async () => {
      mockCreate.mockResolvedValueOnce(
        mockAnthropicResponse("Here is your summary.")
      );

      const result = await adapter.synthesize("Summarize my day");
      expect(result).toBe("Here is your summary.");
    });

    it("uses synthesis model", async () => {
      mockCreate.mockResolvedValueOnce(mockAnthropicResponse("ok"));

      await adapter.synthesize("test");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-sonnet-4-20250514",
        }),
        expect.anything()
      );
    });
  });

  describe("extractIntents()", () => {
    it("returns parsed intents on valid response", async () => {
      mockCreate.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify(VALID_INTENTS))
      );

      const result = await adapter.extractIntents("Schedule a meeting", "calendar context");
      expect(result).toHaveLength(1);
      expect(result[0].tool).toBe("list_calendar_events");
    });

    it("retries on invalid JSON and succeeds", async () => {
      mockCreate
        .mockResolvedValueOnce(mockAnthropicResponse("broken"))
        .mockResolvedValueOnce(
          mockAnthropicResponse(JSON.stringify(VALID_INTENTS))
        );

      const result = await adapter.extractIntents("test", "context");
      expect(result).toHaveLength(1);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting retries", async () => {
      mockCreate.mockResolvedValue(mockAnthropicResponse("not json"));

      await expect(
        adapter.extractIntents("test", "context")
      ).rejects.toThrow();
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("uses classifier model (Haiku) not synthesis model", async () => {
      mockCreate.mockResolvedValueOnce(
        mockAnthropicResponse(JSON.stringify(VALID_INTENTS))
      );

      await adapter.extractIntents("test", "context");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "claude-3-5-haiku-20241022",
        }),
        expect.anything()
      );
    });
  });

  describe("circuit breaker integration", () => {
    it("rejects calls when circuit is open (after 401)", async () => {
      const authError = Object.assign(new Error("Unauthorized"), {
        status: 401,
      });
      mockCreate.mockRejectedValueOnce(authError);

      await expect(
        adapter.classify({
          from: "a",
          subject: "b",
          bodyPreview: "c",
          source: "outlook",
        })
      ).rejects.toThrow("Unauthorized");

      // Second call should be blocked by circuit breaker
      await expect(
        adapter.classify({
          from: "a",
          subject: "b",
          bodyPreview: "c",
          source: "outlook",
        })
      ).rejects.toThrow(CircuitOpenError);

      // Mock should only have been called once
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });
});
