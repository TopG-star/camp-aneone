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
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  TransactionRunner,
  Logger,
  NotificationPort,
  NotificationRepository,
} from "@oneon/domain";
import type { ActionInstance, Category, Priority } from "@oneon/domain";
import type { ActionRequest, RequestOutcome } from "../actions/orchestrator/types.js";
import type { ClassificationOutput } from "../ai-boundary/purposes/schemas.js";
import { answered, blocked, denied, stubGateway } from "../ai-boundary/__tests__/stub-gateway.js";
import { createModelGateway } from "../ai-boundary/gateway.js";
import { Fingerprinter } from "../ai-boundary/fingerprints.js";
import { InMemoryChoices, InMemoryModelAudit } from "../ai-boundary/__tests__/in-memory-audit.js";
import { FakeProvider } from "../ai-boundary/__tests__/fake-provider.js";

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

const DEFAULT_CLASSIFICATION: ClassificationOutput = {
  category: "work",
  priority: 2,
  summary: "Test summary",
  actionItems: [],
  followUpNeeded: false,
  deadlines: [],
};
// Tests reassign this where they previously stubbed llmPort.classify; the stub gateway answers with it.
let currentClassification: ClassificationOutput = DEFAULT_CLASSIFICATION;

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

  const transactionRunner: TransactionRunner = {
    run: vi.fn((fn: () => unknown) => fn()) as TransactionRunner["run"],
  };

  currentClassification = { ...DEFAULT_CLASSIFICATION };
  const modelGateway = stubGateway({ respond: () => answered(currentClassification) });

  return {
    userId: "test-user",
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    transactionRunner,
    modelGateway,
    logger: createMockLogger(),
    classifierModel: "claude-3-5-haiku",
    promptVersion: "v1",
    maxAttempts: 3,
    skipRules: [],
    requestAction: vi.fn(async (req: ActionRequest): Promise<RequestOutcome> => ({
      kind: "created",
      instance: { id: `a-${req.type}`, status: req.type === "notify" ? "completed" : "awaiting_approval" } as ActionInstance,
    })),
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

    currentClassification = {
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent email",
      actionItems: ["Respond ASAP"],
      followUpNeeded: true,
      deadlines: [{ dueDate: "2026-04-20", description: "Report due", confidence: 0.9 }],
    };

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
    expect(deps.requestAction).toHaveBeenCalled();
    const types = vi.mocked(deps.requestAction).mock.calls.map(([req]) => req.type);
    expect(types).toContain("notify");
  });

  it("tells the classifier when the email arrived, so relative deadlines resolve correctly", async () => {
    const item1 = makeItem("item-1");
    const deps = createDeps({ modelGateway: stubGateway({ respond: () => blocked("invalid_output") }) });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);

    await runProcessingCycle(deps, defaultOptions());

    const { requests } = deps.modelGateway as ReturnType<typeof stubGateway>;
    expect(requests).toHaveLength(1);
    const fields = (requests[0].parts[0] as { rows: Array<{ fields: Array<{ name: string; value: string }> }> }).rows[0].fields;
    expect(fields.find((f) => f.name === "receivedAt")?.value).toBe("2026-04-17T08:00:00Z");
  });

  it("does NOT propose actions for items that failed classification", async () => {
    const item1 = makeItem("item-1");

    const deps = createDeps({ modelGateway: stubGateway({ respond: () => blocked("invalid_output") }) });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);

    vi.mocked(deps.inboundItemRepo.incrementClassifyAttempts).mockReturnValue(undefined);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.failed).toBe(1);
    expect(result.actionsProposed).toBe(0);
    expect(deps.requestAction).not.toHaveBeenCalled();
  });

  it("aborts early when maxDurationMs is exceeded", async () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItem(`item-${i}`));
    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue(items);

    currentClassification = {
      category: "actionable" as Category,
      priority: 3 as Priority,
      summary: "Test",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    };

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
    currentClassification = {
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    };
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls2);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.skippedMaxAttempts).toBe(1);
    expect(result.classification.classified).toBe(1);
    expect(result.actionsProposed).toBeGreaterThan(0);
    const requested = vi.mocked(deps.requestAction).mock.calls.map(([req]) => req.resourceRef);
    expect(requested.every((ref) => ref === "inbound_item:item-2")).toBe(true);
  });

  it("includes durationMs in summary", async () => {
    const deps = createDeps();
    const result = await runProcessingCycle(deps, defaultOptions());

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("survives a failing action request and continues", async () => {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", { category: "urgent" as Category, priority: 1 as Priority });

    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    vi.mocked(deps.inboundItemRepo.findById).mockReturnValue(item1);
    currentClassification = {
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    };
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);

    vi.mocked(deps.requestAction).mockRejectedValueOnce(new Error("DB write failed"));

    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.classification.classified).toBe(1);
    expect(result.actionErrors).toBe(1);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("keeps requesting an item's other actions, and the next item's, after one request throws (I4)", async () => {
    const items = [makeItem("item-1"), makeItem("item-2")];
    const deps = createDeps();
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue(items);
    currentClassification = {
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Urgent with a deadline",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    };
    vi.mocked(deps.classificationRepo.create).mockImplementation((c) => makeClassification(c.inboundItemId, { category: "urgent" as Category, priority: 1 as Priority }));
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockImplementation((itemId) => [makeDeadline(itemId, { dueDate: "2099-01-01" })]);
    // The first request (item-1's notify) throws, e.g. capabilitiesFor failing.
    vi.mocked(deps.requestAction).mockRejectedValueOnce(new Error("token provider construction failed"));

    const summary = await runProcessingCycle(deps, defaultOptions());

    const requested = vi.mocked(deps.requestAction).mock.calls.map(([req]) => `${req.resourceRef}:${req.type}`);
    expect(requested).toEqual([
      expect.stringMatching(/item-1.*:notify$/),
      expect.stringMatching(/:create_reminder$/),
      expect.stringMatching(/item-2.*:notify$/),
      expect.stringMatching(/:create_reminder$/),
    ]);
    expect(summary.actionErrors).toBe(1);
    expect(summary.actionsProposed).toBe(3);
  });

  function arrangePriority1Item(deps: RunProcessingCycleDeps) {
    const item1 = makeItem("item-1");
    const cls1 = makeClassification("item-1", { category: "urgent" as Category, priority: 1 as Priority });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    currentClassification = {
      category: "urgent" as Category,
      priority: 1 as Priority,
      summary: "Critical issue",
      actionItems: [],
      followUpNeeded: false,
      deadlines: [],
    };
    vi.mocked(deps.classificationRepo.create).mockReturnValue(cls1);
    vi.mocked(deps.inboundItemRepo.markClassified).mockReturnValue(undefined);
    vi.mocked(deps.deadlineRepo.findByInboundItemId).mockReturnValue([]);
  }

  it("requests notify for priority ≤ 2 and sends no direct urgent notification", async () => {
    const notificationPort: NotificationPort = { send: vi.fn().mockResolvedValue(undefined) };
    const deps = createDeps({ notificationPort });
    arrangePriority1Item(deps);
    const summary = await runProcessingCycle(deps, defaultOptions());
    const types = vi.mocked(deps.requestAction).mock.calls.map(([req]) => req.type);
    expect(types).toContain("notify");
    const directUrgent = vi.mocked(notificationPort.send).mock.calls.filter(([n]) => n.eventType === "urgent_item");
    expect(directUrgent).toHaveLength(0);
    expect(summary.notificationsSent).toBe(1);
    expect(summary.actionsAutoExecuted).toBe(1);
  });

  it("passes the user as a personal actor", async () => {
    const deps = createDeps();
    arrangePriority1Item(deps);
    await runProcessingCycle(deps, defaultOptions());
    const [req] = vi.mocked(deps.requestAction).mock.calls[0];
    expect(req.actor).toEqual({ userId: deps.userId, scope: "personal", tenantId: null, roles: ["owner"], permissions: [], locationIds: [] });
  });

  it("counts refused requests as action errors", async () => {
    const deps = createDeps();
    arrangePriority1Item(deps);
    vi.mocked(deps.requestAction).mockResolvedValue({ kind: "refused", reason: "invalid_input", issues: ["x"] });
    const summary = await runProcessingCycle(deps, defaultOptions());
    expect(summary.actionErrors).toBeGreaterThan(0);
    expect(summary.actionsProposed).toBe(0);
  });

  // ── Notification integration ──────────────────────────────

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

  it("includes notificationsSent in summary even when zero", async () => {
    const deps = createDeps();
    const result = await runProcessingCycle(deps, defaultOptions());

    expect(result.notificationsSent).toBe(0);
  });

  it("pauses classification without touching items when the policy limit is below D2 (spec §10.3)", async () => {
    const item1 = makeItem("item-1");
    const deps = createDeps({ modelGateway: stubGateway({ limit: "D1" }) });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    const result = await runProcessingCycle(deps, defaultOptions());
    expect(result.classification).toMatchObject({ classified: 0, failed: 0, pausedByPolicy: 1 });
    expect(deps.inboundItemRepo.incrementClassifyAttempts).not.toHaveBeenCalled();
    expect((deps.modelGateway as ReturnType<typeof stubGateway>).requests).toHaveLength(0);
  });

  // Final review I3: a denial tied to the item's own content counts an attempt, so maxAttempts ends the retries.
  it.each(["secret_present", "required_part_withheld", "masked_value_present"] as const)(
    "counts a %s denial as paused and as an attempt, not as a failure",
    async (reason) => {
      const item1 = makeItem("item-1");
      const deps = createDeps({ modelGateway: stubGateway({ respond: () => denied(reason) }) });
      vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
      const result = await runProcessingCycle(deps, defaultOptions());
      expect(result.classification).toMatchObject({ pausedByPolicy: 1, failed: 0 });
      expect(deps.inboundItemRepo.incrementClassifyAttempts).toHaveBeenCalledWith("item-1");
    },
  );

  it.each(["provider_unavailable", "invalid_context", "unknown_purpose"] as const)(
    "counts a %s denial as paused without counting an attempt",
    async (reason) => {
      const item1 = makeItem("item-1");
      const deps = createDeps({ modelGateway: stubGateway({ respond: () => denied(reason) }) });
      vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
      const result = await runProcessingCycle(deps, defaultOptions());
      expect(result.classification).toMatchObject({ pausedByPolicy: 1, failed: 0 });
      expect(deps.inboundItemRepo.incrementClassifyAttempts).not.toHaveBeenCalled();
    },
  );

  it("counts a blocked answer as a failed attempt", async () => {
    const item1 = makeItem("item-1");
    const deps = createDeps({ modelGateway: stubGateway({ respond: () => blocked("invalid_output") }) });
    vi.mocked(deps.inboundItemRepo.findUnclassified).mockReturnValue([item1]);
    const result = await runProcessingCycle(deps, defaultOptions());
    expect(result.classification.failed).toBe(1);
    expect(deps.inboundItemRepo.incrementClassifyAttempts).toHaveBeenCalledWith("item-1");
  });

  it("classifies after opt-in and pauses again after the person revokes it (Review Focus 2)", async () => {
    const choices = new InMemoryChoices();
    const gateway = createModelGateway({
      providers: { deepseek: new FakeProvider("deepseek", [JSON.stringify({ category: "work", priority: 3, summary: "s", actionItems: [], followUpNeeded: false, deadlines: [] })]) },
      overrides: new Map(),
      routing: { standard: "deepseek", reasoning: "deepseek" },
      models: { deepseek: { standard: "s", reasoning: "r" } },
      choices,
      audit: new InMemoryModelAudit(),
      fingerprinter: new Fingerprinter("k".repeat(32), 1),
      maxRetries: 0,
      timeouts: { standard: 1000, reasoning: 1000 },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    choices.record({ identityId: "user-1", provider: "deepseek", maxClass: "D2", decidedOn: "2026-10-03", note: null, confirmedAt: "t1" });
    const first = createDeps({ modelGateway: gateway, userId: "user-1" });
    vi.mocked(first.inboundItemRepo.findUnclassified).mockReturnValue([makeItem("item-1")]);
    vi.mocked(first.classificationRepo.create).mockReturnValue(makeClassification("item-1"));
    expect((await runProcessingCycle(first, defaultOptions())).classification.classified).toBe(1);

    choices.record({ identityId: "user-1", provider: "deepseek", maxClass: "D1", decidedOn: null, note: null, confirmedAt: "t2" });
    const second = createDeps({ modelGateway: gateway, userId: "user-1" });
    vi.mocked(second.inboundItemRepo.findUnclassified).mockReturnValue([makeItem("item-2")]);
    expect((await runProcessingCycle(second, defaultOptions())).classification).toMatchObject({ classified: 0, pausedByPolicy: 1 });
  });
});
