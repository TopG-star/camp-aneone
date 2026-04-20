import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runIntentLoop,
  intentOutputSchema,
  type RunIntentLoopInput,
} from "./run-intent-loop.js";
import type { IntentExtractionPort, Logger } from "@oneon/domain";
import type { ToolRegistry, ToolExecutionResult } from "../tools/tool-registry.js";

// ── Helpers ──────────────────────────────────────────────────

const NOW = new Date("2026-04-17T08:00:00Z");
const TIMEZONE = "America/New_York";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockExtractor(
  responses: Array<Array<{ tool: string; parameters: Record<string, unknown> }>>
): IntentExtractionPort {
  let callIndex = 0;
  return {
    extractIntents: vi.fn(async () => {
      const response = responses[callIndex] ?? [];
      callIndex++;
      return response;
    }),
  };
}

function createMockToolRegistry(
  results: Record<string, ToolExecutionResult | Error>
): ToolRegistry {
  return {
    register: vi.fn(),
    execute: vi.fn(async (name: string, _input: unknown) => {
      const result = results[name];
      if (!result) throw new Error(`Tool "${name}" not found`);
      if (result instanceof Error) throw result;
      return result;
    }),
    list: vi.fn(() => []),
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

function defaultInput(
  overrides: Partial<RunIntentLoopInput> = {}
): RunIntentLoopInput {
  return {
    userMessage: "What are my deadlines?",
    history: [],
    toolDefinitions: [
      { name: "list_deadlines", description: "List deadlines in date range" },
    ],
    stats: {
      totalInboxItems: 10,
      unreadUrgentCount: 2,
      pendingActionsCount: 1,
      upcomingDeadlinesCount: 3,
      followUpCount: 0,
    },
    now: NOW,
    timezone: TIMEZONE,
    ...overrides,
  };
}

// ── Contract Tests: intentOutputSchema ───────────────────────

describe("intentOutputSchema", () => {
  it("accepts valid intent array with tool field", () => {
    const result = intentOutputSchema.safeParse([
      { tool: "list_deadlines", parameters: { from: "2026-04-17" } },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts empty array", () => {
    const result = intentOutputSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("accepts none intent", () => {
    const result = intentOutputSchema.safeParse([
      { tool: "none", parameters: {} },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects objects with 'type' instead of 'tool'", () => {
    const result = intentOutputSchema.safeParse([
      { type: "list_deadlines", parameters: {} },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects empty tool name", () => {
    const result = intentOutputSchema.safeParse([
      { tool: "", parameters: {} },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects non-array input", () => {
    const result = intentOutputSchema.safeParse({
      tool: "list_deadlines",
      parameters: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing parameters field", () => {
    const result = intentOutputSchema.safeParse([{ tool: "list_deadlines" }]);
    expect(result.success).toBe(false);
  });
});

// ── runIntentLoop Tests ──────────────────────────────────────

describe("runIntentLoop", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  // ── Happy Path ───────────────────────────────────────────

  it("executes a single tool and stops on none intent", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { from: "2026-04-17" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 3 deadlines", [1, 2, 3]),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("list_deadlines");
    expect(result.toolCalls[0].result?.summary).toBe("Found 3 deadlines");
    expect(result.toolCalls[0].error).toBeNull();
    expect(result.rounds).toBe(2);
    expect(result.stopped).toBe("none_intent");
  });

  it("executes multiple tools in one round", async () => {
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

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput({
        toolDefinitions: [
          { name: "list_deadlines", description: "d" },
          { name: "search_emails", description: "d" },
        ],
      })
    );

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].tool).toBe("list_deadlines");
    expect(result.toolCalls[1].tool).toBe("search_emails");
  });

  // ── Stop Conditions ──────────────────────────────────────

  it("stops on empty intents array (no_intents)", async () => {
    const extractor = createMockExtractor([[]]);
    const registry = createMockToolRegistry({});

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(0);
    expect(result.rounds).toBe(1);
    expect(result.stopped).toBe("no_intents");
  });

  it("stops on none intent (none_intent)", async () => {
    const extractor = createMockExtractor([
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({});

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(0);
    expect(result.rounds).toBe(1);
    expect(result.stopped).toBe("none_intent");
  });

  it("stops after max 3 rounds (max_rounds)", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: {} }],
      [{ tool: "list_deadlines", parameters: { status: "open" } }],
      [{ tool: "list_deadlines", parameters: { status: "done" } }],
      [{ tool: "list_deadlines", parameters: { status: "dismissed" } }], // should not run
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.rounds).toBe(3);
    expect(result.stopped).toBe("max_rounds");
    expect(result.toolCalls).toHaveLength(3);
  });

  // ── Zod Validation (Refinement #2) ──────────────────────

  it("breaks gracefully when LLM returns invalid intent shape", async () => {
    const badExtractor: IntentExtractionPort = {
      extractIntents: vi.fn(async () => {
        // Return something that won't pass Zod: 'type' instead of 'tool'
        return [{ type: "oops", parameters: {} }] as unknown as Array<{
          tool: string;
          parameters: Record<string, unknown>;
        }>;
      }),
    };
    const registry = createMockToolRegistry({});

    const result = await runIntentLoop(
      { intentExtractor: badExtractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(0);
    expect(result.stopped).toBe("invalid_intents");
    expect(logger.warn).toHaveBeenCalled();
  });

  // ── Tool Call Dedupe (Refinement #3) ─────────────────────

  it("deduplicates identical tool+params within same round", async () => {
    const extractor = createMockExtractor([
      [
        { tool: "list_deadlines", parameters: { from: "2026-04-17" } },
        { tool: "list_deadlines", parameters: { from: "2026-04-17" } }, // dupe
      ],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate tool call skipped"),
      expect.anything()
    );
  });

  it("deduplicates tool+params across rounds", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { from: "2026-04-17" } }],
      [{ tool: "list_deadlines", parameters: { from: "2026-04-17" } }], // dupe from round 1
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    // Only 1 actual execution, second round's call is deduped
    expect(result.toolCalls).toHaveLength(1);
  });

  // ── Error Handling (Refinement #8) ───────────────────────

  it("records tool execution errors without stopping the loop", async () => {
    const extractor = createMockExtractor([
      [
        { tool: "list_deadlines", parameters: {} },
        { tool: "search_emails", parameters: { query: "x" } },
      ],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: new Error("Database connection failed"),
      search_emails: makeToolResult("search_emails", "found 1"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput({
        toolDefinitions: [
          { name: "list_deadlines", description: "d" },
          { name: "search_emails", description: "d" },
        ],
      })
    );

    expect(result.toolCalls).toHaveLength(2);
    const failed = result.toolCalls.find((tc) => tc.tool === "list_deadlines")!;
    expect(failed.error).toBe("Database connection failed");
    expect(failed.result).toBeNull();

    const succeeded = result.toolCalls.find((tc) => tc.tool === "search_emails")!;
    expect(succeeded.error).toBeNull();
    expect(succeeded.result?.summary).toBe("found 1");
  });

  it("skips tool after 2 failures in the same turn", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { a: 1 } }],
      [{ tool: "list_deadlines", parameters: { a: 2 } }],
      [{ tool: "list_deadlines", parameters: { a: 3 } }], // should be skipped
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: new Error("fail"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    // 2 actual executions (both fail), 3rd round's call skipped
    const executed = result.toolCalls.filter((tc) => tc.error !== null || tc.result !== null);
    expect(executed).toHaveLength(2);
    expect(result.rounds).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
      expect.objectContaining({ tool: "list_deadlines" })
    );
  });

  it("stops with all_tools_failed when all intents are skipped", async () => {
    // After 2 failures, the tool is banned. If the LLM keeps requesting it,
    // all intents are skipped → loop stops with all_tools_failed
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { a: 1 } }], // fails (1st)
      [{ tool: "list_deadlines", parameters: { a: 2 } }], // fails (2nd)
      [{ tool: "list_deadlines", parameters: { a: 3 } }], // skipped (banned)
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: new Error("down"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls.filter((tc) => tc.error !== null)).toHaveLength(2);
    expect(result.rounds).toBe(3);
    expect(result.stopped).toBe("all_tools_failed");
  });

  // ── LLM Extraction Failure ───────────────────────────────

  it("returns gracefully when LLM extraction throws", async () => {
    const badExtractor: IntentExtractionPort = {
      extractIntents: vi.fn(async () => {
        throw new Error("LLM service unavailable");
      }),
    };
    const registry = createMockToolRegistry({});

    const result = await runIntentLoop(
      { intentExtractor: badExtractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(0);
    expect(result.stopped).toBe("extraction_error");
    expect(result.rounds).toBe(1);
    expect(logger.error).toHaveBeenCalled();
  });

  // ── Tool Call Records (Refinement #7) ────────────────────

  it("produces ToolCallRecords with all required fields", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { from: "2026-04-17" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok", [1]),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    const record = result.toolCalls[0];
    expect(record.id).toBeDefined();
    expect(record.id.length).toBeGreaterThan(0);
    expect(record.round).toBe(1);
    expect(record.tool).toBe("list_deadlines");
    expect(record.parameters).toEqual({ from: "2026-04-17" });
    expect(record.result).toEqual({ data: [1], summary: "ok" });
    expect(record.error).toBeNull();
    expect(typeof record.durationMs).toBe("number");
    expect(record.executedAt).toBeDefined();
  });

  it("records round number correctly across multiple rounds", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { r: 1 } }],
      [{ tool: "search_emails", parameters: { r: 2 } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "r1"),
      search_emails: makeToolResult("search_emails", "r2"),
    });

    const result = await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput({
        toolDefinitions: [
          { name: "list_deadlines", description: "d" },
          { name: "search_emails", description: "d" },
        ],
      })
    );

    expect(result.toolCalls[0].round).toBe(1);
    expect(result.toolCalls[1].round).toBe(2);
  });

  // ── Context Assembly ─────────────────────────────────────

  it("passes growing executedActions to extractor each round", async () => {
    const extractorFn = vi.fn<
      (msg: string, ctx: string) => Promise<Array<{ tool: string; parameters: Record<string, unknown> }>>
    >();
    extractorFn
      .mockResolvedValueOnce([{ tool: "list_deadlines", parameters: {} }])
      .mockResolvedValueOnce([{ tool: "none", parameters: {} }]);

    const extractor: IntentExtractionPort = { extractIntents: extractorFn };
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "Found 3"),
    });

    await runIntentLoop(
      { intentExtractor: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    // Second call's context should contain executed action from round 1
    const secondCallContext = extractorFn.mock.calls[1][1];
    expect(secondCallContext).toContain("list_deadlines");
    expect(secondCallContext).toContain("Found 3");
    expect(secondCallContext).toContain("ACTIONS ALREADY EXECUTED THIS TURN");
  });
});
