import { describe, it, expect, vi } from "vitest";
import {
  createDailyBriefingTool,
  dailyBriefingSchema,
  type DailyBriefingDeps,
} from "./daily-briefing.js";
import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  SynthesisPort,
  Logger,
} from "@oneon/domain";
import type { ToolResult } from "./tool-registry.js";
import { InMemoryActionRepo } from "../actions/__tests__/in-memory-repos.js";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function createToolDeps(overrides: Partial<DailyBriefingDeps> = {}): DailyBriefingDeps {
  const classificationRepo: ClassificationRepository = {
    create: vi.fn(),
    findByInboundItemId: vi.fn(() => null),
    findAll: vi.fn(() => []),
    count: vi.fn(() => 0),
  };

  const inboundItemRepo: InboundItemRepository = {
    upsert: vi.fn(),
    findById: vi.fn(() => null),
    findBySourceAndExternalId: vi.fn(() => null),
    findUnclassified: vi.fn(() => []),
    findAll: vi.fn(() => []),
    search: vi.fn(() => []),
    markClassified: vi.fn(),
    incrementClassifyAttempts: vi.fn(),
    count: vi.fn(() => 0),
  };

  const deadlineRepo: DeadlineRepository = {
    create: vi.fn(),
    findByInboundItemId: vi.fn(() => []),
    findByDateRange: vi.fn(() => []),
    findOverdue: vi.fn(() => []),
    updateStatus: vi.fn(),
    count: vi.fn(() => 0),
  };

  const instanceRepo = new InMemoryActionRepo(() => new Date("2026-10-01T12:00:00Z"));

  const synthesizer: SynthesisPort = {
    synthesize: vi.fn(async () => "Your morning briefing."),
  };

  return {
    classificationRepo,
    inboundItemRepo,
    deadlineRepo,
    instanceRepo,
    synthesizer,
    logger: createMockLogger(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("dailyBriefingSchema", () => {
  it("accepts empty object", () => {
    const result = dailyBriefingSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts explicit timezone", () => {
    const result = dailyBriefingSchema.safeParse({ timezone: "America/New_York" });
    expect(result.success).toBe(true);
    expect(result.data?.timezone).toBe("America/New_York");
  });

  it("accepts an optional userId and rejects an empty one", () => {
    expect(dailyBriefingSchema.safeParse({ userId: "u1" }).data?.userId).toBe("u1");
    expect(dailyBriefingSchema.safeParse({ userId: "" }).success).toBe(false);
  });

  it("defaults timezone to UTC", () => {
    const result = dailyBriefingSchema.safeParse({});
    expect(result.data?.timezone).toBe("UTC");
  });
});

describe("createDailyBriefingTool", () => {
  it("has name 'daily_briefing' and correct metadata", () => {
    const tool = createDailyBriefingTool(createToolDeps());

    expect(tool.name).toBe("daily_briefing");
    expect(tool.version).toBe("1.0.0");
    expect(tool.description).toContain("briefing");
  });

  it("execute returns { data, summary } structure", async () => {
    const tool = createDailyBriefingTool(createToolDeps());
    const result = await tool.execute({ timezone: "UTC" }) as ToolResult;

    expect(result.data).toBeDefined();
    expect(result.data).toHaveProperty("date");
    expect(result.data).toHaveProperty("urgentItems");
    expect(result.data).toHaveProperty("deadlines");
    expect(result.data).toHaveProperty("pendingActions");
    expect(result.data).toHaveProperty("calendar");
    expect(typeof result.summary).toBe("string");
  });

  it("data.calendar always has { status, events } shape", async () => {
    const tool = createDailyBriefingTool(createToolDeps());
    const result = await tool.execute({ timezone: "UTC" }) as ToolResult;

    const cal = (result.data as Record<string, unknown>).calendar as {
      status: string;
      events: unknown[];
    };
    expect(cal).toHaveProperty("status");
    expect(cal).toHaveProperty("events");
    expect(Array.isArray(cal.events)).toBe(true);
  });

  it("summary is the synthesized text, not JSON", async () => {
    const synthesizer: SynthesisPort = {
      synthesize: vi.fn(async () => "Good morning! Here is your day."),
    };
    const tool = createDailyBriefingTool(createToolDeps({ synthesizer }));
    const result = await tool.execute({ timezone: "UTC" }) as ToolResult;

    expect(result.summary).toBe("Good morning! Here is your day.");
  });

  it("passes timezone through to the use case", async () => {
    const deps = createToolDeps();
    const tool = createDailyBriefingTool(deps);
    await tool.execute({ timezone: "Asia/Tokyo", userId: "u1" });

    // If timezone is respected, the date queried from repos should differ
    // We just verify it ran without errors — timezone logic tested in use case tests
    expect(deps.classificationRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1" }));
  });

  it("handles execute being async (returns Promise)", async () => {
    const tool = createDailyBriefingTool(createToolDeps());
    const resultPromise = tool.execute({ timezone: "UTC" });

    // Tool should return a promise (async tool)
    expect(resultPromise).toBeInstanceOf(Promise);
    const result = await resultPromise;
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("summary");
  });

  it("lists only the session user's awaiting-approval actions as pending", async () => {
    const instanceRepo = new InMemoryActionRepo(() => new Date("2026-10-01T12:00:00Z"));
    const base = {
      scope: "personal" as const, tenantId: null, locationIds: [], actionType: "create_reminder", definitionVersion: "1",
      initiator: "system", initiatorUserId: null, input: {}, evidence: [], retryOf: null, attemptNumber: 1,
    };
    for (const [id, userId] of [["a1", "u1"], ["a2", "u2"]] as const) {
      instanceRepo.create({ ...base, id, ownerId: userId, userId, idempotencyKey: id, resourceRef: `deadline:${id}` }, { kind: "system" });
      instanceRepo.appendTransition({ actionId: id, expectedStatus: "proposed", toStatus: "validating", actor: { kind: "system" } });
      instanceRepo.appendTransition({ actionId: id, expectedStatus: "validating", toStatus: "awaiting_approval", actor: { kind: "system" } });
    }
    const synthesize = vi.fn(async () => "ok");
    const tool = createDailyBriefingTool(createToolDeps({ instanceRepo, synthesizer: { synthesize } }));

    const result = await tool.execute(dailyBriefingSchema.parse({ userId: "u1" })) as ToolResult;
    expect((result.data as { pendingActions: unknown[] }).pendingActions).toEqual([
      { actionType: "create_reminder", resourceId: "deadline:a1", riskLevel: "L1" },
    ]);

    const anonymous = await tool.execute(dailyBriefingSchema.parse({})) as ToolResult;
    expect((anonymous.data as { pendingActions: unknown[] }).pendingActions).toEqual([]);
  });
});
