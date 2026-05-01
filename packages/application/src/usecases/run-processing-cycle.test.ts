import { describe, it, expect, vi } from "vitest";
import {
  runProcessingCycle,
  type RunProcessingCycleDeps,
  type RunProcessingCycleOptions,
} from "./run-processing-cycle.js";
import type {
  InboundItem,
  Classification,
  Deadline,
  ActionLogEntry,
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  ActionLogRepository,
  TransactionRunner,
  LLMPort,
  Logger,
  NotificationPort,
  NotificationRepository,
} from "@oneon/domain";
import type { Category, Priority } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeItem(id: string, overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id,
    userId: null,
    source: "outlook",
    externalId: `ext-${id}`,
    from: "sender@example.com",
    subject: `Subject ${id}`,
    bodyPreview: "Preview body",
    receivedAt: "2026-04-17T08:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeClassification(
  itemId: string,
  overrides: Partial<Classification> = {}
): Classification {
  return {
    id: `cls-${itemId}`,
    userId: null,
    inboundItemId: itemId,
    category: "actionable" as Category,
    priority: 2 as Priority,
    summary: `Summary for ${itemId}`,
    actionItems: "[]",
    followUpNeeded: false,
    model: "claude-3-5-haiku",
    promptVersion: "v1",
    createdAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeDeadline(
  itemId: string,
  overrides: Partial<Deadline> = {}
): Deadline {
  return {
    id: `dl-${itemId}`,
    userId: null,
    inboundItemId: itemId,
    dueDate: "2026-04-20",
    description: "Report due",
    confidence: 0.9,
    status: "open",
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function makeActionEntry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "action-1",
    userId: null,
    resourceId: "item-1",
    actionType: "notify",
    riskLevel: "auto",
    status: "proposed",
    payloadJson: "{}",
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-17T08:00:00Z",
    updatedAt: "2026-04-17T08:00:00Z",
    ...overrides,
  };
}

function createDeps(
  overrides: Partial<RunProcessingCycleDeps> = {}
): RunProcessingCycleDeps {
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

  const classificationRepo: ClassificationRepository = {
    create: vi.fn(),
    findByInboundItemId: vi.fn(() => null),
    findAll: vi.fn(() => []),
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

  const actionLogRepo: ActionLogRepository = {
    create: vi.fn((input) => ({
      id: `action-${Math.random().toString(36).slice(2, 6)}`,
      ...input,
      createdAt: "2026-04-17T08:00:00Z",
      updatedAt: "2026-04-17T08:00:00Z",
    })) as ActionLogRepository["create"],
    findByResourceAndType: vi.fn(() => null),
    findByStatus: vi.fn(() => []),
    updateStatus: vi.fn(),
    findAll: vi.fn(() => []),
    count: vi.fn(() => 0),
  };

  const transactionRunner: TransactionRunner = {
    run: vi.fn((fn: () => unknown) => fn()) as TransactionRunner["run"],
  };

  const llmPort: LLMPort = {
    classify: vi.fn(async () => ({
      category: "actionable" as Category,
      priority: 2 as Priority,
      summary: "Test summary",
      actionItems: [] as string[],
      followUpNeeded: false,
      deadlines: [] as Array<{ dueDate: string; description: string; confidence: number }>,
    })),
    extractIntents: vi.fn(async () => []),
    synthesize: vi.fn(async () => "response"),
  };

  return {
    userId: "test-user",
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    actionLogRepo,
    transactionRunner,
    llmPort,
    logger: createMockLogger(),
    classifierModel: "claude-3-5-haiku",
    promptVersion: "v1",
    maxAttempts: 3,
    skipRules: [],
    featureAutoExecute: false,
    ...overrides,
  };
}

function defaultOptions(
  overrides: Partial<RunProcessingCycleOptions> = {}
): RunProcessingCycleOptions {
  return {
    batchSize: 10,
    maxDurationMs: 60_000,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("runProcessingCycle", () => {
  it("returns empty summary when no unclassified items exist", async () => {
    const deps = createDeps();
    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.total).toBe(0);
    expect(result.actionsProposed).toBe(0);
    expect(result.actionsAutoExecuted).toBe(0);
    expect(result.abortedEarly).toBe(false);
  });

  it("classifies items and proposes actions for classified results", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", {
      category: "urgent" as Category,
      priority: 1 as Priority,
    });

    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item1);

    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent email",
      actionItems: ["Respond ASAP"],
      followUpNeeded: true,
      deadlines: [{ dueDate: "2026-04-20", description: "Report due", confidence: 0.9 }],
    });

    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.create).mockReturnValue(makeDeadline(item1.id));
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([
      makeDeadline(item1.id),
    ]);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.total).toBe(1);
    expect(result.classification.classified).toBe(1);
    expect(result.actionsProposed).toBeGreaterThan(0);
  });

  it("does NOT propose actions for items that failed classification", async () => {
    const item1 = makeItem("item-1");

    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);

    vi.mocked(deps.llmPort.classify).mockRejectedValue(new Error("LLM error"));
    vi.mocked(deps.inboundItemRepo.incrementClassifyAttempts).mockReturnValue(undefined);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.failed).toBe(1);
    expect(result.actionsProposed).toBe(0);
    expect(deps.actionLogRepo.create).not.toHaveBeenCalled();
  });

  it("auto-executes actions when featureAutoExecute is true", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", { category: "urgent" as Category, priority: 1 as Priority });

    const deps = createDeps({ featureAutoExecute: true });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item1);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);

    const notifyAction = makeActionEntry({
      id: "act-1",
      resourceId: item1.id,
      actionType: "notify",
      riskLevel: "auto",
      status: "proposed",
    });
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(notifyAction);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.actionsAutoExecuted).toBeGreaterThanOrEqual(1);
    expect(deps.actionLogRepo.updateStatus).toHaveBeenCalled();
  });

  it("does NOT auto-execute when featureAutoExecute is false", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", { category: "urgent" as Category, priority: 1 as Priority });

    const deps = createDeps({ featureAutoExecute: false });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item1);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);

    const notifyAction = makeActionEntry({ riskLevel: "auto", status: "proposed" });
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(notifyAction);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.actionsAutoExecuted).toBe(0);
    expect(deps.actionLogRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("aborts early when maxDurationMs is exceeded", async () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem(`item-${i}`));
    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue(items);

    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "actionable" as Category,
      priority: 3 as Priority,
      summary: "Test",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });

    let fakeTime = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      fakeTime += 50_000;
      return fakeTime;
    });

    vi.mocked(deps.classificationRepo.create).mockReturnValue(
      makeClassification("item-0")
    );
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);

    const result = await runProcessingCycle(
      deps,
      defaultOptions({ maxDurationMs: 60_000 })
    );

    expect(result.abortedEarly).toBe(true);
    expect(result.classification.total).toBeLessThan(5);

    vi.restoreAllMocks();
  });

  it("only proposes actions for newly classified items (not max_attempts)", async () => {
    const item1 = makeItem("item-1", { classifyAttempts: 999 });
    const item2 = makeItem("item-2");

    const deps = createDeps({ maxAttempts: 3 });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1, item2]);
    vi.mocked(deps.inboundItemRepo.findById).mockImplementation((id: string) => {
      if (id === "item-2") return item2;
      return null;
    });

    const cls2 = makeClassification("item-2", { category: "urgent" as Category, priority: 1 as Priority });
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls2);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(
      makeActionEntry({ resourceId: "item-2" })
    );

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.skippedMaxAttempts).toBe(1);
    expect(result.classification.classified).toBe(1);
    expect(result.actionsProposed).toBeGreaterThan(0);
  });

  it("includes durationMs in summary", async () => {
    const deps = createDeps();
    const result = await runProcessingCycle(deps, defaultOptions());

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("survives proposeActions errors and continues", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", { category: "urgent" as Category, priority: 1 as Priority });

    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item1);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);

    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockImplementation(() => {
      throw new Error("DB write failed");
    });

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.classified).toBe(1);
    expect(result.actionErrors).toBe(1);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  // ── Notification integration ──────────────────────────────

  it("sends urgent_item notification when classification priority <= 2", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", {
      category: "urgent" as Category,
      priority: 1 as Priority,
    });

    const notificationPort: NotificationPort = { send: vi.fn().mockResolvedValue(undefined) };

    const deps = createDeps({ notificationPort });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Critical issue",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(
      makeActionEntry({ resourceId: "item-1", actionType: "notify", riskLevel: "auto" }),
    );

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(notificationPort.send).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "urgent_item",
        title: "Urgent: Subject item-1",
        deepLink: "/items/item-1",
        userId: "test-user",
      }),
    );
    expect(result.notificationsSent).toBeGreaterThanOrEqual(1);
  });

  it("does NOT send urgent_item notification for low-priority items", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", {
      category: "newsletter" as Category,
      priority: 5 as Priority,
    });

    const notificationPort: NotificationPort = { send: vi.fn().mockResolvedValue(undefined) };

    const deps = createDeps({ notificationPort });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "newsletter" as Category,
      priority: 5 as Priority,
      summary: "Newsletter",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(
      makeActionEntry({ resourceId: "item-1", actionType: "label", riskLevel: "auto" }),
    );

    await runProcessingCycle(deps, defaultOptions());

    expect(notificationPort.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "urgent_item" }),
    );
  });

  it("sends action_proposed notification for approval_required actions", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", {
      category: "spam" as Category,
      priority: 5 as Priority,
    });

    const notificationPort: NotificationPort = { send: vi.fn().mockResolvedValue(undefined) };

    const deps = createDeps({ notificationPort });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "spam" as Category,
      priority: 5 as Priority,
      summary: "Spam",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);

    const archiveAction = makeActionEntry({
      id: "act-archive",
      resourceId: "item-1",
      actionType: "archive",
      riskLevel: "approval_required",
      status: "proposed",
    });
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(archiveAction);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(notificationPort.send).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "action_proposed",
        title: "Action requires approval: archive",
        deepLink: "/actions/act-archive",
        userId: "test-user",
      }),
    );
    expect(result.notificationsSent).toBeGreaterThanOrEqual(1);
  });

  it("calls checkApproachingDeadlines when notificationPort and notificationRepo are provided", async () => {
    const notificationPort: NotificationPort = { send: vi.fn().mockResolvedValue(undefined) };
    const notificationRepo: NotificationRepository = {
      create: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      findUnread: vi.fn().mockReturnValue([]),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      countUnread: vi.fn().mockReturnValue(0),
    };

    const deps = createDeps({ notificationPort, notificationRepo, deadlineLeadDays: 3 });

    // Add a deadline that will be found
    vi.mocked(deps.deadlineRepo.findByDateRange).mockReturnValue([
      makeDeadline("item-1"),
    ]);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalled();
    expect(notificationPort.send).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deadline_approaching",
        userId: "test-user",
      }),
    );
    expect(result.notificationsSent).toBeGreaterThanOrEqual(1);
  });

  it("skips deadline check when notificationPort is null", async () => {
    const deps = createDeps();

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(deps.deadlineRepo.findByDateRange).not.toHaveBeenCalled();
    expect(result.notificationsSent).toBe(0);
  });

  it("survives notification send failures gracefully", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", {
      category: "urgent" as Category,
      priority: 1 as Priority,
    });

    const notificationPort: NotificationPort = {
      send: vi.fn().mockRejectedValue(new Error("notification failure")),
    };

    const deps = createDeps({ notificationPort });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.llmPort.classify).mockResolvedValue({
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Critical",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    });
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);
    vi.mocked(deps.actionLogRepo.findByResourceAndType).mockReturnValue(null);
    vi.mocked(deps.actionLogRepo.create).mockReturnValue(
      makeActionEntry({ resourceId: "item-1" }),
    );

    const result = await runProcessingCycle(deps, defaultOptions());

    // Should NOT crash — classification should still succeed
    expect(result.classification.classified).toBe(1);
    expect(deps.logger.error).toHaveBeenCalledWith(
      "Failed to send urgent_item notification",
      expect.objectContaining({ itemId: "item-1" }),
    );
  });

  it("includes notificationsSent in summary even when zero", async () => {
    const deps = createDeps();
    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.notificationsSent).toBe(0);
  });
});
