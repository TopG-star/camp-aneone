import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processUnclassifiedItems,
  type ProcessUnclassifiedItemsDeps,
  type SkipRule,
} from "./process-unclassified-items.js";
import type {
  InboundItem,
  Classification,
  Deadline,
  Logger,
} from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeFakeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "outlook",
    externalId: "ext-001",
    from: "alice@example.com",
    subject: "Hello",
    bodyPreview: "Hi there.",
    receivedAt: "2026-04-10T09:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2026-04-10T09:00:00Z",
    updatedAt: "2026-04-10T09:00:00Z",
    ...overrides,
  };
}

function makeFakeClassification(
  overrides: Partial<Classification> = {}
): Classification {
  return {
    id: "cls-001",
    userId: null,
    inboundItemId: "item-001",
    category: "work",
    priority: 2,
    summary: "Test summary",
    actionItems: "[]",
    followUpNeeded: false,
    model: "claude-3-5-haiku-20241022",
    promptVersion: "v1",
    createdAt: "2026-04-10T09:01:00Z",
    ...overrides,
  };
}

function makeFakeDeadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "dl-001",
    userId: null,
    inboundItemId: "item-001",
    dueDate: "2026-04-18T17:00:00Z",
    description: "Deadline",
    confidence: 0.9,
    status: "open",
    createdAt: "2026-04-10T09:01:00Z",
    updatedAt: "2026-04-10T09:01:00Z",
    ...overrides,
  };
}

const LLM_RESULT = {
  category: "work" as const,
  priority: 2 as const,
  summary: "Test summary",
  actionItems: [] as string[],
  followUpNeeded: false,
  deadlines: [] as Array<{ dueDate: string; description: string; confidence: number }>,
};

function createDeps(
  overrides: Partial<ProcessUnclassifiedItemsDeps> = {}
): ProcessUnclassifiedItemsDeps {
  return {
    inboundItemRepo: {
      upsert: vi.fn(),
      findById: vi.fn(),
      findBySourceAndExternalId: vi.fn(),
      findUnclassified: vi.fn().mockReturnValue([]),
      findAll: vi.fn(),
      search: vi.fn(),
      markClassified: vi.fn(),
      incrementClassifyAttempts: vi.fn(),
      count: vi.fn(),
    },
    classificationRepo: {
      create: vi.fn().mockReturnValue(makeFakeClassification()),
      findByInboundItemId: vi.fn(),
      findAll: vi.fn(),
      count: vi.fn(),
    },
    deadlineRepo: {
      create: vi.fn().mockReturnValue(makeFakeDeadline()),
      findByInboundItemId: vi.fn(),
      findByDateRange: vi.fn(),
      findOverdue: vi.fn(),
      updateStatus: vi.fn(),
      count: vi.fn(),
    },
    transactionRunner: {
      run: vi.fn().mockImplementation((fn: () => unknown) => fn()),
    },
    llmPort: {
      classify: vi.fn().mockResolvedValue(LLM_RESULT),
      synthesize: vi.fn(),
      extractIntents: vi.fn(),
    },
    logger: createMockLogger(),
    classifierModel: "claude-3-5-haiku-20241022",
    promptVersion: "v1",
    maxAttempts: 3,
    skipRules: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("processUnclassifiedItems", () => {
  let deps: ProcessUnclassifiedItemsDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  // ── Empty batch ──────────────────────────────────────────

  it("returns zero counts when no unclassified items", async () => {
    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.total).toBe(0);
    expect(summary.classified).toBe(0);
    expect(summary.skippedByRule).toBe(0);
    expect(summary.skippedMaxAttempts).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results).toHaveLength(0);
  });

  it("calls findUnclassified with the batch size", async () => {
    await processUnclassifiedItems(deps, 25);

    expect(deps.inboundItemRepo.findUnclassified).toHaveBeenCalledWith(25);
  });

  // ── LLM classification (happy path) ─────────────────────

  it("classifies items via LLM and records outcome", async () => {
    const item = makeFakeItem();
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.classified).toBe(1);
    expect(summary.results[0].outcome).toBe("classified");
    expect(summary.results[0].itemId).toBe("item-001");
  });

  it("classifies multiple items sequentially", async () => {
    const items = [
      makeFakeItem({ id: "item-001" }),
      makeFakeItem({ id: "item-002" }),
      makeFakeItem({ id: "item-003" }),
    ];
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue(items);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.total).toBe(3);
    expect(summary.classified).toBe(3);
    expect(deps.llmPort.classify).toHaveBeenCalledTimes(3);
  });

  // ── Max attempts ─────────────────────────────────────────

  it("skips items that have reached max attempts", async () => {
    const item = makeFakeItem({ id: "item-bad", classifyAttempts: 3 });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.skippedMaxAttempts).toBe(1);
    expect(summary.classified).toBe(0);
    expect(summary.results[0].outcome).toBe("max_attempts");
    expect(deps.llmPort.classify).not.toHaveBeenCalled();
  });

  it("skips items that have exceeded max attempts", async () => {
    const item = makeFakeItem({ id: "item-bad", classifyAttempts: 5 });
    deps = createDeps({ maxAttempts: 3 });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.skippedMaxAttempts).toBe(1);
  });

  it("logs a warning for max-attempts items", async () => {
    const item = makeFakeItem({ classifyAttempts: 3 });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    await processUnclassifiedItems(deps, 10);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      "Skipping item: max classify attempts reached",
      expect.objectContaining({ itemId: "item-001", attempts: 3, maxAttempts: 3 })
    );
  });

  // ── Skip rules ───────────────────────────────────────────

  it("applies skip rules and creates classification with model=skip_rules", async () => {
    const item = makeFakeItem({
      labels: '["CATEGORY_PROMOTIONS"]',
      source: "outlook",
    });
    const skipRule: SkipRule = {
      labelPattern: "CATEGORY_PROMOTIONS",
      category: "newsletter",
      priority: 5,
    };
    deps = createDeps({ skipRules: [skipRule] });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.skippedByRule).toBe(1);
    expect(summary.classified).toBe(0);
    expect(summary.results[0].outcome).toBe("skip_rule");
    expect(deps.llmPort.classify).not.toHaveBeenCalled();
  });

  it("skip rule creates classification with correct fields", async () => {
    const item = makeFakeItem({ labels: '["CATEGORY_SOCIAL"]' });
    const skipRule: SkipRule = {
      labelPattern: "CATEGORY_SOCIAL",
      category: "spam",
      priority: 5,
    };
    deps = createDeps({ skipRules: [skipRule] });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    await processUnclassifiedItems(deps, 10);

    expect(deps.classificationRepo.create).toHaveBeenCalledWith({
      userId: null,
      inboundItemId: "item-001",
      category: "spam",
      priority: 5,
      summary: expect.stringContaining("CATEGORY_SOCIAL"),
      actionItems: "[]",
      followUpNeeded: false,
      model: "skip_rules",
      promptVersion: "v1",
    });
  });

  it("skip rule marks the item classified", async () => {
    const item = makeFakeItem({ labels: '["CATEGORY_PROMOTIONS"]' });
    deps = createDeps({
      skipRules: [{ labelPattern: "CATEGORY_PROMOTIONS", category: "newsletter", priority: 5 }],
    });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    await processUnclassifiedItems(deps, 10);

    expect(deps.inboundItemRepo.markClassified).toHaveBeenCalledWith("item-001");
  });

  it("skip rule wraps persistence in a transaction", async () => {
    const item = makeFakeItem({ labels: '["CATEGORY_PROMOTIONS"]' });
    deps = createDeps({
      skipRules: [{ labelPattern: "CATEGORY_PROMOTIONS", category: "newsletter", priority: 5 }],
    });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    await processUnclassifiedItems(deps, 10);

    expect(deps.transactionRunner.run).toHaveBeenCalledOnce();
  });

  // ── Source-aware skip rules ──────────────────────────────

  it("source-aware skip rule matches correct source", async () => {
    const item = makeFakeItem({
      source: "outlook",
      labels: '["CATEGORY_PROMOTIONS"]',
    });
    const rule: SkipRule = {
      source: "outlook",
      labelPattern: "CATEGORY_PROMOTIONS",
      category: "newsletter",
      priority: 5,
    };
    deps = createDeps({ skipRules: [rule] });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.skippedByRule).toBe(1);
  });

  it("source-aware skip rule does NOT match wrong source", async () => {
    const item = makeFakeItem({
      source: "gmail",
      labels: '["CATEGORY_PROMOTIONS"]',
    });
    const rule: SkipRule = {
      source: "outlook",
      labelPattern: "CATEGORY_PROMOTIONS",
      category: "newsletter",
      priority: 5,
    };
    deps = createDeps({ skipRules: [rule] });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.skippedByRule).toBe(0);
    expect(summary.classified).toBe(1);
  });

  it("skip rule without source matches any source", async () => {
    const gmailItem = makeFakeItem({
      id: "item-gmail",
      source: "gmail",
      labels: '["CATEGORY_PROMOTIONS"]',
    });
    const outlookItem = makeFakeItem({
      id: "item-outlook",
      source: "outlook",
      labels: '["CATEGORY_PROMOTIONS"]',
    });
    const rule: SkipRule = {
      labelPattern: "CATEGORY_PROMOTIONS",
      category: "newsletter",
      priority: 5,
    };
    deps = createDeps({ skipRules: [rule] });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([
      gmailItem,
      outlookItem,
    ]);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.skippedByRule).toBe(2);
  });

  // ── Mixed batch ──────────────────────────────────────────

  it("handles mixed batch: skip-rule + max-attempts + LLM classified", async () => {
    const items = [
      makeFakeItem({ id: "item-skip", labels: '["CATEGORY_PROMOTIONS"]' }),
      makeFakeItem({ id: "item-maxed", classifyAttempts: 3 }),
      makeFakeItem({ id: "item-llm", labels: "[]" }),
    ];
    deps = createDeps({
      skipRules: [{ labelPattern: "CATEGORY_PROMOTIONS", category: "newsletter", priority: 5 }],
    });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue(items);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.total).toBe(3);
    expect(summary.skippedByRule).toBe(1);
    expect(summary.skippedMaxAttempts).toBe(1);
    expect(summary.classified).toBe(1);
    expect(summary.failed).toBe(0);
  });

  // ── LLM failure ──────────────────────────────────────────

  it("counts LLM failures and continues processing", async () => {
    const items = [
      makeFakeItem({ id: "item-fail" }),
      makeFakeItem({ id: "item-ok" }),
    ];
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue(items);
    (deps.llmPort.classify as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("LLM down"))
      .mockResolvedValueOnce(LLM_RESULT);

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.failed).toBe(1);
    expect(summary.classified).toBe(1);
    expect(summary.results[0].outcome).toBe("failed");
    expect(summary.results[0].error).toContain("LLM down");
    expect(summary.results[1].outcome).toBe("classified");
  });

  // ── Skip rule persistence failure ─────────────────────────

  it("counts skip rule persistence failure as failed", async () => {
    const item = makeFakeItem({ labels: '["CATEGORY_PROMOTIONS"]' });
    deps = createDeps({
      skipRules: [{ labelPattern: "CATEGORY_PROMOTIONS", category: "newsletter", priority: 5 }],
    });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);
    (deps.transactionRunner.run as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB locked");
    });

    const summary = await processUnclassifiedItems(deps, 10);

    expect(summary.failed).toBe(1);
    expect(summary.skippedByRule).toBe(0);
    expect(summary.results[0].outcome).toBe("failed");
  });

  // ── Summary logging ──────────────────────────────────────

  it("logs batch summary at the end", async () => {
    const items = [makeFakeItem()];
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue(items);

    await processUnclassifiedItems(deps, 10);

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Classification batch complete",
      expect.objectContaining({
        total: 1,
        classified: 1,
        skippedByRule: 0,
        skippedMaxAttempts: 0,
        failed: 0,
      })
    );
  });

  // ── Priority ordering: max-attempts > skip-rules > LLM ──

  it("checks max attempts before skip rules", async () => {
    const item = makeFakeItem({
      classifyAttempts: 3,
      labels: '["CATEGORY_PROMOTIONS"]',
    });
    deps = createDeps({
      skipRules: [{ labelPattern: "CATEGORY_PROMOTIONS", category: "newsletter", priority: 5 }],
    });
    (deps.inboundItemRepo.findUnclassified as ReturnType<typeof vi.fn>).mockReturnValue([item]);

    const summary = await processUnclassifiedItems(deps, 10);

    // Max attempts takes precedence over skip rule
    expect(summary.skippedMaxAttempts).toBe(1);
    expect(summary.skippedByRule).toBe(0);
  });
});
