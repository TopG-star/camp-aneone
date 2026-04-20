import { describe, it, expect, vi } from "vitest";
import type { Classification, InboundItem, Source } from "@oneon/domain";
import {
  createListFollowUpsTool,
  listFollowUpsSchema,
  type ListFollowUpsDeps,
  type FollowUpEntry,
} from "./list-follow-ups.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeClassification(
  overrides: Partial<Classification> = {}
): Classification {
  return {
    id: "cls-001",
    userId: null,
    inboundItemId: "item-001",
    category: "work",
    priority: 2,
    summary: "Quarterly report request",
    actionItems: JSON.stringify(["Review and submit by Friday"]),
    followUpNeeded: true,
    model: "claude-3-5-haiku-20241022",
    promptVersion: "1.0.0",
    createdAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "outlook" as Source,
    externalId: "ext-001",
    from: "alice@example.com",
    subject: "Quarterly report needed",
    bodyPreview: "Please submit the quarterly report.",
    receivedAt: "2026-04-17T07:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: "2026-04-17T08:00:00Z",
    classifyAttempts: 1,
    createdAt: "2026-04-17T07:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListFollowUpsDeps> = {}
): ListFollowUpsDeps {
  return {
    classificationRepo: {
      create: vi.fn(),
      findByInboundItemId: vi.fn().mockReturnValue(null),
      findAll: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    },
    inboundItemRepo: {
      upsert: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      findBySourceAndExternalId: vi.fn().mockReturnValue(null),
      findUnclassified: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      search: vi.fn().mockReturnValue([]),
      markClassified: vi.fn(),
      incrementClassifyAttempts: vi.fn(),
      count: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

// ── Schema Contract Tests ────────────────────────────────────

describe("listFollowUpsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listFollowUpsSchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.overdue).toBeUndefined();
  });

  it("accepts overdue boolean filter", () => {
    const result = listFollowUpsSchema.parse({ overdue: true });
    expect(result.overdue).toBe(true);
  });

  it("accepts custom limit", () => {
    const result = listFollowUpsSchema.parse({ limit: 5 });
    expect(result.limit).toBe(5);
  });

  it("rejects limit over 100", () => {
    expect(() => listFollowUpsSchema.parse({ limit: 200 })).toThrow();
  });

  it("rejects non-positive limit", () => {
    expect(() => listFollowUpsSchema.parse({ limit: 0 })).toThrow();
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("list_follow_ups tool", () => {
  it("returns empty list when no follow-ups exist", async () => {
    const deps = makeDeps();
    const tool = createListFollowUpsTool(deps);
    const result = await tool.execute(listFollowUpsSchema.parse({}));

    expect(result.data).toEqual([]);
    expect(result.summary).toBe("Found 0 items needing follow-up.");
  });

  it("filters classifications to followUpNeeded === true", async () => {
    const cls1 = makeClassification({ id: "cls-001", inboundItemId: "item-001", followUpNeeded: true });
    const cls2 = makeClassification({ id: "cls-002", inboundItemId: "item-002", followUpNeeded: false });
    const cls3 = makeClassification({ id: "cls-003", inboundItemId: "item-003", followUpNeeded: true });

    const deps = makeDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue([cls1, cls2, cls3]);
    vi.mocked(deps.inboundItemRepo.findById)
      .mockReturnValueOnce(makeItem({ id: "item-001", subject: "Report needed" }))
      .mockReturnValueOnce(makeItem({ id: "item-003", subject: "Budget review" }));

    const tool = createListFollowUpsTool(deps);
    const result = await tool.execute(listFollowUpsSchema.parse({}));

    const data = result.data as FollowUpEntry[];
    expect(data).toHaveLength(2);
    expect(data[0].subject).toBe("Report needed");
    expect(data[1].subject).toBe("Budget review");
  });

  it("skips items whose inbound item is not found", async () => {
    const cls = makeClassification({ followUpNeeded: true });
    const deps = makeDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue([cls]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(null);

    const tool = createListFollowUpsTool(deps);
    const result = await tool.execute(listFollowUpsSchema.parse({}));

    expect(result.data).toEqual([]);
  });

  it("returns correct shape for each follow-up entry", async () => {
    const cls = makeClassification({
      category: "urgent",
      priority: 1,
      summary: "Important task",
      followUpNeeded: true,
    });
    const item = makeItem({
      id: "item-001",
      subject: "Urgent request",
      from: "boss@example.com",
      source: "outlook" as Source,
      receivedAt: "2026-04-17T07:00:00Z",
    });

    const deps = makeDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue([cls]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item);

    const tool = createListFollowUpsTool(deps);
    const result = await tool.execute(listFollowUpsSchema.parse({}));

    const data = result.data as FollowUpEntry[];
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      id: "item-001",
      subject: "Urgent request",
      from: "boss@example.com",
      source: "outlook",
      category: "urgent",
      priority: 1,
      summary: "Important task",
      receivedAt: "2026-04-17T07:00:00Z",
    });
  });

  it("fetches enough classifications to fill limit after filtering", async () => {
    const deps = makeDeps();
    const tool = createListFollowUpsTool(deps);

    await tool.execute(listFollowUpsSchema.parse({ limit: 10 }));

    // Should request more than limit to account for filtering
    const callArgs = vi.mocked(deps.classificationRepo.findAll).mock.calls[0][0];
    expect(callArgs.limit).toBeGreaterThan(10);
  });

  it("returns singular summary for one item", async () => {
    const cls = makeClassification({ followUpNeeded: true });
    const item = makeItem();
    const deps = makeDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue([cls]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item);

    const tool = createListFollowUpsTool(deps);
    const result = await tool.execute(listFollowUpsSchema.parse({}));

    expect(result.summary).toBe("Found 1 item needing follow-up.");
  });

  it("respects limit on output", async () => {
    const classifications = Array.from({ length: 5 }, (_, i) =>
      makeClassification({ id: `cls-${i}`, inboundItemId: `item-${i}`, followUpNeeded: true })
    );
    const deps = makeDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue(classifications);
    vi.mocked(deps.inboundItemRepo.findById).mockImplementation((id) =>
      makeItem({ id, subject: `Subject ${id}` })
    );

    const tool = createListFollowUpsTool(deps);
    const result = await tool.execute(listFollowUpsSchema.parse({ limit: 3 }));

    const data = result.data as FollowUpEntry[];
    expect(data).toHaveLength(3);
  });

  it("works through ToolRegistry async execute", async () => {
    const cls = makeClassification({ followUpNeeded: true });
    const item = makeItem();
    const deps = makeDeps();
    vi.mocked(deps.classificationRepo.findAll).mockReturnValue([cls]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item);

    const registry = createToolRegistry();
    registry.register(createListFollowUpsTool(deps));

    const result = await registry.execute("list_follow_ups", {});

    expect((result.data as FollowUpEntry[])).toHaveLength(1);
    expect(result.meta.toolName).toBe("list_follow_ups");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
