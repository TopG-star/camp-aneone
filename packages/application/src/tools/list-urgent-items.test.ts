import { describe, it, expect, vi } from "vitest";
import type {
  Classification,
  InboundItem,
} from "@oneon/domain";
import {
  createListUrgentItemsTool,
  listUrgentItemsSchema,
  type ListUrgentItemsDeps,
} from "./list-urgent-items.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeClassification(
  overrides: Partial<Classification> = {}
): Classification {
  return {
    id: "cls-001",
    userId: null,
    inboundItemId: "item-001",
    category: "urgent",
    priority: 1,
    summary: "Server is down, needs immediate attention",
    actionItems: "[]",
    followUpNeeded: true,
    model: "claude-3-haiku",
    promptVersion: "1.0",
    createdAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "outlook",
    externalId: "ext-001",
    from: "boss@company.com",
    subject: "Server down - URGENT",
    bodyPreview: "The production server is down...",
    receivedAt: "2026-04-17T07:55:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: "2026-04-17T08:00:00Z",
    classifyAttempts: 1,
    createdAt: "2026-04-17T07:55:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListUrgentItemsDeps> = {}
): ListUrgentItemsDeps {
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

describe("listUrgentItemsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listUrgentItemsSchema.parse({});
    expect(result.maxPriority).toBe(2);
    expect(result.limit).toBe(20);
    expect(result.source).toBeUndefined();
    expect(result.since).toBeUndefined();
  });

  it("accepts valid complete input", () => {
    const result = listUrgentItemsSchema.parse({
      maxPriority: 3,
      source: "outlook",
      since: "2026-04-10T00:00:00Z",
      limit: 5,
    });
    expect(result.maxPriority).toBe(3);
    expect(result.source).toBe("outlook");
    expect(result.since).toBeInstanceOf(Date);
    expect(result.limit).toBe(5);
  });

  it("coerces since string to Date", () => {
    const result = listUrgentItemsSchema.parse({
      since: "2026-04-10T09:00:00Z",
    });
    expect(result.since).toBeInstanceOf(Date);
    expect(result.since!.toISOString()).toBe("2026-04-10T09:00:00.000Z");
  });

  it("rejects invalid priority values", () => {
    expect(() =>
      listUrgentItemsSchema.parse({ maxPriority: 0 })
    ).toThrow();
    expect(() =>
      listUrgentItemsSchema.parse({ maxPriority: 6 })
    ).toThrow();
  });

  it("rejects invalid source values", () => {
    expect(() =>
      listUrgentItemsSchema.parse({ source: "whatsapp" })
    ).toThrow();
  });

  it("rejects limit exceeding 100", () => {
    expect(() =>
      listUrgentItemsSchema.parse({ limit: 101 })
    ).toThrow();
  });

  it("rejects non-positive limit", () => {
    expect(() =>
      listUrgentItemsSchema.parse({ limit: 0 })
    ).toThrow();
  });

  it("rejects invalid date string for since", () => {
    expect(() =>
      listUrgentItemsSchema.parse({ since: "not-a-date" })
    ).toThrow();
  });
});

// ── Behavioral Tests ─────────────────────────────────────────

describe("list_urgent_items tool", () => {
  it("returns empty data and summary when no classifications found", async () => {
    const deps = makeDeps();
    const tool = createListUrgentItemsTool(deps);

    const result = await tool.execute({ maxPriority: 2, limit: 20 });

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("0");
  });

  it("queries classifications with maxPriority mapped to minPriority", () => {
    const deps = makeDeps();
    const tool = createListUrgentItemsTool(deps);

    tool.execute({ maxPriority: 3, limit: 10 });

    expect(deps.classificationRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ minPriority: 3, limit: 10 })
    );
  });

  it("merges classification data with inbound item details", async () => {
    const cls = makeClassification();
    const item = makeItem();

    const deps = makeDeps({
      classificationRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findAll: vi.fn().mockReturnValue([cls]),
        count: vi.fn().mockReturnValue(1),
      },
      inboundItemRepo: {
        upsert: vi.fn(),
        findById: vi.fn().mockReturnValue(item),
        findBySourceAndExternalId: vi.fn(),
        findUnclassified: vi.fn(),
        findAll: vi.fn(),
        search: vi.fn(),
        markClassified: vi.fn(),
        incrementClassifyAttempts: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListUrgentItemsTool(deps);
    const result = await tool.execute({ maxPriority: 2, limit: 20 });

    expect(result.data).toHaveLength(1);
    const firstItem = (result.data as Array<unknown>)[0] as Record<
      string,
      unknown
    >;
    expect(firstItem).toEqual(
      expect.objectContaining({
        id: "item-001",
        subject: "Server down - URGENT",
        from: "boss@company.com",
        source: "outlook",
        category: "urgent",
        priority: 1,
        summary: "Server is down, needs immediate attention",
        receivedAt: "2026-04-17T07:55:00Z",
      })
    );
  });

  it("skips classifications whose inbound item is not found", async () => {
    const cls = makeClassification();
    const deps = makeDeps({
      classificationRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findAll: vi.fn().mockReturnValue([cls]),
        count: vi.fn().mockReturnValue(1),
      },
      inboundItemRepo: {
        upsert: vi.fn(),
        findById: vi.fn().mockReturnValue(null), // item not found
        findBySourceAndExternalId: vi.fn(),
        findUnclassified: vi.fn(),
        findAll: vi.fn(),
        search: vi.fn(),
        markClassified: vi.fn(),
        incrementClassifyAttempts: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListUrgentItemsTool(deps);
    const result = await tool.execute({ maxPriority: 2, limit: 20 });

    expect(result.data).toEqual([]);
  });

  it("filters results by source post-query", async () => {
    const deps = makeDeps({
      classificationRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findAll: vi.fn().mockReturnValue([
          makeClassification({ id: "cls-1", inboundItemId: "item-1" }),
          makeClassification({ id: "cls-2", inboundItemId: "item-2" }),
        ]),
        count: vi.fn().mockReturnValue(2),
      },
      inboundItemRepo: {
        upsert: vi.fn(),
        findById: vi
          .fn()
          .mockReturnValueOnce(makeItem({ id: "item-1", source: "gmail" }))
          .mockReturnValueOnce(makeItem({ id: "item-2", source: "outlook" })),
        findBySourceAndExternalId: vi.fn(),
        findUnclassified: vi.fn(),
        findAll: vi.fn(),
        search: vi.fn(),
        markClassified: vi.fn(),
        incrementClassifyAttempts: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListUrgentItemsTool(deps);
    const result = await tool.execute({ maxPriority: 2, source: "gmail", limit: 20 });

    expect(result.data).toHaveLength(1);
    expect((result.data as Array<Record<string, unknown>>)[0].source).toBe("gmail");
  });

  it("generates human-readable summary with count", async () => {
    const deps = makeDeps({
      classificationRepo: {
        create: vi.fn(),
        findByInboundItemId: vi.fn(),
        findAll: vi.fn().mockReturnValue([
          makeClassification({ id: "cls-1", inboundItemId: "item-1" }),
          makeClassification({
            id: "cls-2",
            inboundItemId: "item-2",
            priority: 2,
            category: "work",
          }),
        ]),
        count: vi.fn().mockReturnValue(2),
      },
      inboundItemRepo: {
        upsert: vi.fn(),
        findById: vi
          .fn()
          .mockReturnValueOnce(makeItem({ id: "item-1" }))
          .mockReturnValueOnce(
            makeItem({
              id: "item-2",
              subject: "Weekly report due",
              from: "manager@co.com",
            })
          ),
        findBySourceAndExternalId: vi.fn(),
        findUnclassified: vi.fn(),
        findAll: vi.fn(),        search: vi.fn(),        markClassified: vi.fn(),
        incrementClassifyAttempts: vi.fn(),
        count: vi.fn(),
      },
    });

    const tool = createListUrgentItemsTool(deps);
    const result = await tool.execute({ maxPriority: 2, limit: 20 });

    expect(result.summary).toContain("2");
    expect(typeof result.summary).toBe("string");
    expect(result.summary.length).toBeGreaterThan(0);
  });

  // ── Integration with registry ──────────────────────────────

  it("can be registered and executed through the ToolRegistry", async () => {
    const deps = makeDeps();
    const tool = createListUrgentItemsTool(deps);
    const registry = createToolRegistry();
    registry.register(tool);

    const result = await registry.execute("list_urgent_items", {});

    expect(result.data).toEqual([]);
    expect(result.meta.toolName).toBe("list_urgent_items");
    expect(result.meta.toolVersion).toBeDefined();
  });
});
