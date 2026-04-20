import { describe, it, expect, vi } from "vitest";
import type { Classification, InboundItem, Source } from "@oneon/domain";
import {
  createSearchEmailsTool,
  searchEmailsSchema,
  type SearchEmailsDeps,
  type SearchEmailEntry,
} from "./search-emails.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "outlook" as Source,
    externalId: "ext-001",
    from: "alice@example.com",
    subject: "Quarterly budget report",
    bodyPreview: "Please find attached the quarterly budget.",
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
    priority: 2,
    summary: "Quarterly budget report attached",
    actionItems: "[]",
    followUpNeeded: false,
    model: "claude-3-5-haiku-20241022",
    promptVersion: "1.0.0",
    createdAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SearchEmailsDeps> = {}): SearchEmailsDeps {
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

describe("searchEmailsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = searchEmailsSchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.query).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(result.category).toBeUndefined();
  });

  it("accepts full input", () => {
    const result = searchEmailsSchema.parse({
      query: "budget",
      source: "gmail",
      category: "work",
      limit: 10,
    });
    expect(result.query).toBe("budget");
    expect(result.source).toBe("gmail");
    expect(result.category).toBe("work");
    expect(result.limit).toBe(10);
  });

  it("accepts all valid sources", () => {
    for (const s of ["gmail", "outlook", "teams", "github"]) {
      expect(searchEmailsSchema.parse({ source: s }).source).toBe(s);
    }
  });

  it("accepts all valid categories", () => {
    for (const c of ["urgent", "work", "personal", "newsletter", "transactional", "spam"]) {
      expect(searchEmailsSchema.parse({ category: c }).category).toBe(c);
    }
  });

  it("rejects invalid source", () => {
    expect(() => searchEmailsSchema.parse({ source: "whatsapp" })).toThrow();
  });

  it("rejects invalid category", () => {
    expect(() => searchEmailsSchema.parse({ category: "unknown" })).toThrow();
  });

  it("rejects limit over 100", () => {
    expect(() => searchEmailsSchema.parse({ limit: 200 })).toThrow();
  });

  it("rejects non-positive limit", () => {
    expect(() => searchEmailsSchema.parse({ limit: 0 })).toThrow();
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("search_emails tool", () => {
  it("returns empty list when no items match", async () => {
    const deps = makeDeps();
    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(searchEmailsSchema.parse({ query: "nonexistent" }));

    expect(result.data).toEqual([]);
    expect(result.summary).toBe('Found 0 results for "nonexistent".');
    expect(deps.inboundItemRepo.search).toHaveBeenCalledWith({
      query: "nonexistent",
      limit: 20,
    });
  });

  it("delegates to inboundItemRepo.search with query + source + limit", async () => {
    const deps = makeDeps();
    const tool = createSearchEmailsTool(deps);

    await tool.execute(
      searchEmailsSchema.parse({ query: "budget", source: "outlook", limit: 5 })
    );

    expect(deps.inboundItemRepo.search).toHaveBeenCalledWith({
      query: "budget",
      source: "outlook",
      limit: 5,
    });
  });

  it("falls back to findAll when no query provided", async () => {
    const deps = makeDeps();
    const tool = createSearchEmailsTool(deps);

    await tool.execute(searchEmailsSchema.parse({ source: "gmail" }));

    expect(deps.inboundItemRepo.findAll).toHaveBeenCalledWith({
      source: "gmail",
      limit: 20,
    });
    expect(deps.inboundItemRepo.search).not.toHaveBeenCalled();
  });

  it("enriches results with classification data", async () => {
    const item = makeItem({ id: "item-001" });
    const cls = makeClassification({
      inboundItemId: "item-001",
      category: "work",
      priority: 2,
      summary: "Budget report",
    });

    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.search).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(cls);

    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(searchEmailsSchema.parse({ query: "budget" }));

    const data = result.data as SearchEmailEntry[];
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual({
      id: "item-001",
      subject: "Quarterly budget report",
      from: "alice@example.com",
      source: "outlook",
      receivedAt: "2026-04-17T07:00:00Z",
      category: "work",
      priority: 2,
      summary: "Budget report",
    });
  });

  it("returns null classification fields for unclassified items", async () => {
    const item = makeItem({ id: "item-001" });
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.search).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(null);

    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(searchEmailsSchema.parse({ query: "budget" }));

    const data = result.data as SearchEmailEntry[];
    expect(data[0].category).toBeNull();
    expect(data[0].priority).toBeNull();
    expect(data[0].summary).toBeNull();
  });

  it("filters by category post-query", async () => {
    const item1 = makeItem({ id: "item-001" });
    const item2 = makeItem({ id: "item-002" });

    const cls1 = makeClassification({ inboundItemId: "item-001", category: "work" });
    const cls2 = makeClassification({ inboundItemId: "item-002", category: "newsletter" });

    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.search).mockReturnValue([item1, item2]);
    vi.mocked(deps.classificationRepo.findByInboundItemId)
      .mockReturnValueOnce(cls1)
      .mockReturnValueOnce(cls2);

    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(
      searchEmailsSchema.parse({ query: "report", category: "work" })
    );

    const data = result.data as SearchEmailEntry[];
    expect(data).toHaveLength(1);
    expect(data[0].category).toBe("work");
  });

  it("excludes unclassified items when category filter is set", async () => {
    const item = makeItem({ id: "item-001" });
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.search).mockReturnValue([item]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(null);

    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(
      searchEmailsSchema.parse({ query: "report", category: "work" })
    );

    expect(result.data).toEqual([]);
  });

  it("returns correct summary with count and query", async () => {
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.search).mockReturnValue([makeItem()]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(
      makeClassification()
    );

    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(searchEmailsSchema.parse({ query: "budget" }));

    expect(result.summary).toBe('Found 1 result for "budget".');
  });

  it("returns generic summary when no query provided", async () => {
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.findAll).mockReturnValue([makeItem(), makeItem({ id: "item-002" })]);

    const tool = createSearchEmailsTool(deps);
    const result = await tool.execute(searchEmailsSchema.parse({}));

    expect(result.summary).toBe("Found 2 inbox items.");
  });

  it("works through ToolRegistry async execute", async () => {
    const deps = makeDeps();
    vi.mocked(deps.inboundItemRepo.search).mockReturnValue([makeItem()]);
    vi.mocked(deps.classificationRepo.findByInboundItemId).mockReturnValue(
      makeClassification()
    );

    const registry = createToolRegistry();
    registry.register(createSearchEmailsTool(deps));

    const result = await registry.execute("search_emails", { query: "budget" });

    expect((result.data as SearchEmailEntry[])).toHaveLength(1);
    expect(result.meta.toolName).toBe("search_emails");
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });
});
