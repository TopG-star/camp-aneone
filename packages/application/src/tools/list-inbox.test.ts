import { describe, it, expect, vi } from "vitest";
import type { Classification, InboundItem, Source } from "@oneon/domain";
import {
  createListInboxTool,
  listInboxSchema,
  type ListInboxDeps,
  type InboxEntry,
} from "./list-inbox.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "outlook" as Source,
    externalId: "ext-001",
    from: "alice@example.com",
    subject: "Weekly standup notes",
    bodyPreview: "Here are the notes from this week.",
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

function makeClassification(
  overrides: Partial<Classification> = {}
): Classification {
  return {
    id: "cls-001",
    userId: null,
    inboundItemId: "item-001",
    category: "work",
    priority: 3,
    summary: "Weekly standup meeting notes",
    actionItems: "[]",
    followUpNeeded: false,
    model: "claude-3-5-haiku-20241022",
    promptVersion: "1.0.0",
    createdAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ListInboxDeps> = {}): ListInboxDeps {
  return {
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
    classificationRepo: {
      create: vi.fn(),
      findByInboundItemId: vi.fn().mockReturnValue(null),
      findAll: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    },
    ...overrides,
  };
}

// ── Schema Contract Tests ────────────────────────────────────

describe("listInboxSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listInboxSchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.maxPriority).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(result.since).toBeUndefined();
  });

  it("accepts maxPriority filter (1-5)", () => {
    for (const p of [1, 2, 3, 4, 5]) {
      const result = listInboxSchema.parse({ maxPriority: p });
      expect(result.maxPriority).toBe(p);
    }
  });

  it("accepts source filter", () => {
    for (const s of ["gmail", "outlook", "teams", "github"]) {
      const result = listInboxSchema.parse({ source: s });
      expect(result.source).toBe(s);
    }
  });

  it("rejects invalid source", () => {
    expect(() => listInboxSchema.parse({ source: "whatsapp" })).toThrow();
  });

  it("coerces since to date", () => {
    const result = listInboxSchema.parse({ since: "2026-04-10T00:00:00Z" });
    expect(result.since).toBeInstanceOf(Date);
  });

  it("rejects limit over 100", () => {
    expect(() => listInboxSchema.parse({ limit: 200 })).toThrow();
  });

  it("rejects non-positive limit", () => {
    expect(() => listInboxSchema.parse({ limit: 0 })).toThrow();
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("list_inbox tool", () => {
  it("returns empty list when no items exist", async () => {
    const deps = makeDeps();
    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({}));

    expect(result.data).toEqual([]);
    expect(result.summary).toBe("Found 0 inbox items.");
  });

  it("passes source and since and limit to inboundItemRepo.findAll", async () => {
    const deps = makeDeps();
    const tool = createListInboxTool(deps);

    await tool.execute(
      listInboxSchema.parse({
        source: "outlook",
        since: "2026-04-10T00:00:00Z",
        limit: 10,
      })
    );

    expect(deps.inboundItemRepo.findAll).toHaveBeenCalledWith({
      source: "outlook",
      since: "2026-04-10T00:00:00.000Z",
      limit: 10,
    });
  });

  it("enriches items with classification data when available", async () => {
    const item = makeItem({ id: "item-001" });
    const cls = makeClassification({
      inboundItemId: "item-001",
      category: "work",
      priority: 2,
      summary: "Important meeting notes",
    });

    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(cls);

    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({}));

    const data = result.data as InboxEntry[];
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      id: "item-001",
      subject: "Weekly standup notes",
      from: "alice@example.com",
      source: "outlook",
      receivedAt: "2026-04-17T07:00:00Z",
      category: "work",
      priority: 2,
      summary: "Important meeting notes",
    });
  });

  it("includes unclassified items with null classification fields", async () => {
    const item = makeItem({ id: "item-002" });
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(null);

    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({}));

    const data = result.data as InboxEntry[];
    expect(data).toHaveLength(1);
    expect(data[0].category).toBeNull();
    expect(data[0].priority).toBeNull();
    expect(data[0].summary).toBeNull();
  });

  it("filters by maxPriority (post-query), excludes lower-priority items", async () => {
    const item1 = makeItem({ id: "item-001" });
    const item2 = makeItem({ id: "item-002" });
    const item3 = makeItem({ id: "item-003" });

    const cls1 = makeClassification({ inboundItemId: "item-001", priority: 1 });
    const cls2 = makeClassification({ inboundItemId: "item-002", priority: 3 });
    const cls3 = makeClassification({ inboundItemId: "item-003", priority: 5 });

    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([item1, item2, item3]);
    vi.mocked(deps.classificationRepo.findByInboundItemId)
      .mockReturnValueOnce(cls1)
      .mockReturnValueOnce(cls2)
      .mockReturnValueOnce(cls3);

    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({ maxPriority: 3 }));

    const data = result.data as InboxEntry[];
    expect(data).toHaveLength(2);
    expect(data[0].priority).toBe(1);
    expect(data[1].priority).toBe(3);
  });

  it("includes unclassified items when maxPriority filter is set", async () => {
    const item = makeItem({ id: "item-001" });
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(null);

    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({ maxPriority: 2 }));

    // Unclassified items should be included (unknown priority = don't exclude)
    const data = result.data as InboxEntry[];
    expect(data).toHaveLength(1);
  });

  it("returns correct summary with count", async () => {
    const items = [makeItem({ id: "item-001" }), makeItem({ id: "item-002" })];
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue(items);

    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({}));

    expect(result.summary).toBe("Found 2 inbox items.");
  });

  it("returns singular summary for one item", async () => {
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([makeItem()]);

    const tool = createListInboxTool(deps);
    const result = await tool.execute(listInboxSchema.parse({}));

    expect(result.summary).toBe("Found 1 inbox item.");
  });

  it("works through ToolRegistry async execute", async () => {
    const item = makeItem();
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([item]);

    const registry = createToolRegistry();
    registry.register(createListInboxTool(deps));

    const result = await registry.execute("list_inbox", {});

    expect((result.data as InboxEntry[])).toHaveLength(1);
    expect(result.meta.toolName).toBe("list_inbox");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
