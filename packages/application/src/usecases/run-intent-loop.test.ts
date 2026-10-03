import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runIntentLoop,
  intentOutputSchema,
  type RunIntentLoopInput,
} from "./run-intent-loop.js";
import { z } from "zod";
import type { Logger } from "@oneon/domain";
import { createToolRegistry, type ToolRegistry, type ToolExecutionResult } from "../tools/tool-registry.js";
import type { ModelTurn } from "../ai-boundary/gateway.js";
import { answered, blocked, denied, stubGateway } from "../ai-boundary/__tests__/stub-gateway.js";

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

const PERSONAL = { kind: "personal", identityId: "u1" } as const;

/** A gateway turn that answers each intent round with the next scripted intent list. */
function createMockExtractor(
  responses: Array<Array<{ tool: string; parameters: Record<string, unknown> }>>
): ModelTurn {
  let callIndex = 0;
  return stubGateway({ respond: () => answered(responses[callIndex++] ?? []) }).beginTurn(PERSONAL);
}

/** A real registry whose tools return an empty result; the model-facing output schema is empty. */
function registryWith(...names: string[]) {
  const registry = createToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      version: "1",
      description: name,
      inputSchema: z.object({}).passthrough(),
      output: { fields: {}, summaryClass: "D1" },
      execute: () => ({ data: [], summary: "ok" }),
    });
  }
  return registry;
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.rounds).toBe(3);
    expect(result.stopped).toBe("max_rounds");
    expect(result.toolCalls).toHaveLength(3);
  });

  // ── Zod Validation (Refinement #2) ──────────────────────

  it("breaks gracefully when LLM returns invalid intent shape", async () => {
    // Something that fails Zod: 'type' instead of 'tool'
    const badExtractor = stubGateway({ respond: () => answered([{ type: "oops", parameters: {} }]) }).beginTurn(PERSONAL);
    const registry = createMockToolRegistry({});

    const result = await runIntentLoop(
      { modelTurn: badExtractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls.filter((tc) => tc.error !== null)).toHaveLength(2);
    expect(result.rounds).toBe(3);
    expect(result.stopped).toBe("all_tools_failed");
  });

  // ── LLM Extraction Failure ───────────────────────────────

  it("returns gracefully when the gateway blocks the intent answer", async () => {
    const badExtractor = stubGateway({ respond: () => blocked("invalid_output") }).beginTurn(PERSONAL);
    const registry = createMockToolRegistry({});

    const result = await runIntentLoop(
      { modelTurn: badExtractor, toolRegistry: registry, logger },
      defaultInput()
    );

    expect(result.toolCalls).toHaveLength(0);
    expect(result.stopped).toBe("extraction_error");
    expect(result.rounds).toBe(1);
    expect(logger.error).toHaveBeenCalledWith("Intent extraction failed", { round: 1, kind: "blocked" });
  });

  it("stops with policy_denied when the gateway denies the intent call", async () => {
    const turn = stubGateway({ respond: () => denied("required_part_withheld") }).beginTurn(PERSONAL);
    const result = await runIntentLoop({ modelTurn: turn, toolRegistry: registryWith(), logger }, defaultInput());
    expect(result.stopped).toBe("policy_denied");
    expect(result.deniedReason).toBe("required_part_withheld");
    expect(result.toolCalls).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith("Intent extraction denied by AI data policy", { round: 1, reason: "required_part_withheld" });
  });

  it("ends the turn with extraction_error when the gateway call throws, logging only the error name", async () => {
    const turn = {
      call: vi.fn().mockRejectedValue(new TypeError("audit failed for ama@x.com")),
      restoreToolParams: (p: Record<string, unknown>) => ({ ok: true as const, params: p }),
      effectiveLimit: () => "D1" as const,
    };
    const result = await runIntentLoop({ modelTurn: turn, toolRegistry: registryWith(), logger }, defaultInput());
    expect(result.stopped).toBe("extraction_error");
    expect(logger.error).toHaveBeenCalledWith("Intent extraction threw", { round: 1, errorName: "TypeError" });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("ama@x.com");
  });

  it("logs only the error name when a tool fails", async () => {
    const turn = createMockExtractor([[{ tool: "list_deadlines", parameters: {} }], [{ tool: "none", parameters: {} }]]);
    const registry = createMockToolRegistry({ list_deadlines: new Error("bad address ama@x.com") });
    await runIntentLoop({ modelTurn: turn, toolRegistry: registry, logger }, defaultInput());
    expect(logger.warn).toHaveBeenCalledWith("Tool execution failed", { tool: "list_deadlines", round: 1, errorName: "Error" });
  });

  // ── Placeholders ─────────────────────────────────────────

  it("skips an intent whose placeholder was never issued and runs the others (Review Focus 4)", async () => {
    const turn = {
      call: vi.fn().mockResolvedValueOnce(answered([{ tool: "get_customer", parameters: { customerId: "CUSTOMER_9" } }, { tool: "list_inbox", parameters: {} }])).mockResolvedValue(answered([{ tool: "none", parameters: {} }])),
      restoreToolParams: (p: Record<string, unknown>) => (JSON.stringify(p).includes("CUSTOMER_9") ? { ok: false as const, token: "CUSTOMER_9" } : { ok: true as const, params: p }),
      effectiveLimit: () => "D2" as const,
    };
    const result = await runIntentLoop({ modelTurn: turn, toolRegistry: registryWith("get_customer", "list_inbox"), logger }, defaultInput());
    expect(result.toolCalls.map((c) => c.tool)).toEqual(["list_inbox"]);
    expect(logger.warn).toHaveBeenCalledWith("Model used an unknown placeholder", expect.objectContaining({ tool: "get_customer", token: "CUSTOMER_9" }));
  });

  it("hands an action tool the real identifier, never the placeholder (Review Focus 6)", async () => {
    const seen: unknown[] = [];
    const registry = registryWith();
    registry.register({
      name: "create_calendar_event", version: "1", description: "Request an event", inputSchema: z.object({}).passthrough(),
      output: { fields: { action: { class: "D1" } }, summaryClass: "D2" },
      execute: (input: unknown) => { seen.push(input); return { data: null, summary: "ok" }; },
    });
    const turn = {
      call: vi.fn().mockResolvedValueOnce(answered([{ tool: "create_calendar_event", parameters: { title: "Sync", attendees: ["PERSON_1"] } }])).mockResolvedValue(answered([{ tool: "none", parameters: {} }])),
      restoreToolParams: (p: Record<string, unknown>) => ({ ok: true as const, params: JSON.parse(JSON.stringify(p).replaceAll("PERSON_1", "ama@x.com")) as Record<string, unknown> }),
      effectiveLimit: () => "D1" as const,
    };
    await runIntentLoop({ modelTurn: turn, toolRegistry: registry, logger }, defaultInput());
    expect(seen).toEqual([expect.objectContaining({ attendees: ["ama@x.com"] })]);
    expect(JSON.stringify(seen)).not.toContain("PERSON_1");
  });

  it("never logs tool parameters when skipping a duplicate", async () => {
    const turn = createMockExtractor([
      [{ tool: "list_inbox", parameters: { who: "ama@x.com" } }, { tool: "list_inbox", parameters: { who: "ama@x.com" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    await runIntentLoop({ modelTurn: turn, toolRegistry: registryWith("list_inbox"), logger }, defaultInput());
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("ama@x.com");
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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
      { modelTurn: extractor, toolRegistry: registry, logger },
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

  it("injects userId into tool execution parameters when provided", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { from: "2026-04-17" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    await runIntentLoop(
      { modelTurn: extractor, toolRegistry: registry, logger },
      defaultInput({ userId: "user-123" }),
    );

    expect(registry.execute).toHaveBeenCalledWith(
      "list_deadlines",
      expect.objectContaining({
        from: "2026-04-17",
        userId: "user-123",
      }),
    );
  });

  it("overwrites AI-supplied userId/turnId/turnExcerpt with the server values", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { userId: "evil", turnId: "evil", turnExcerpt: "evil", from: "x" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    await runIntentLoop(
      { modelTurn: extractor, toolRegistry: registry, logger },
      defaultInput({ userId: "user-123", turnId: "t1" }),
    );

    expect(registry.execute).toHaveBeenCalledWith("list_deadlines", {
      from: "x",
      userId: "user-123",
      turnId: "t1",
      turnExcerpt: "What are my deadlines?",
    });
  });

  it("drops AI-supplied identity keys when the server supplies none", async () => {
    const extractor = createMockExtractor([
      [{ tool: "list_deadlines", parameters: { userId: "evil", turnId: "evil", turnExcerpt: "evil", from: "x" } }],
      [{ tool: "none", parameters: {} }],
    ]);
    const registry = createMockToolRegistry({
      list_deadlines: makeToolResult("list_deadlines", "ok"),
    });

    await runIntentLoop(
      { modelTurn: extractor, toolRegistry: registry, logger },
      defaultInput(),
    );

    expect(registry.execute).toHaveBeenCalledWith("list_deadlines", { from: "x" });
  });

  // ── Context Assembly ─────────────────────────────────────

  it("sends earlier tool results in the next round request", async () => {
    const gateway = stubGateway({
      respond: (req) => answered(req.parts.some((p) => p.kind === "record" && p.source === "tool:list_deadlines") ? [{ tool: "none", parameters: {} }] : [{ tool: "list_deadlines", parameters: {} }]),
    });
    await runIntentLoop({ modelTurn: gateway.beginTurn(PERSONAL), toolRegistry: registryWith("list_deadlines"), logger }, defaultInput());

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[0].purpose).toBe("intent_extraction");
    expect(gateway.requests[0].parts.some((p) => p.kind === "record" && p.source.startsWith("tool:"))).toBe(false);
    expect(gateway.requests[1].parts.some((p) => p.kind === "record" && p.source === "tool:list_deadlines")).toBe(true);
  });
});
