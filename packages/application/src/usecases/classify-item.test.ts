import { describe, it, expect, vi, beforeEach } from "vitest";
import { classifyItem, ClassificationPausedError, type ClassifyItemDeps } from "./classify-item.js";
import type { GatewayResult } from "../ai-boundary/gateway.js";
import { emailClassificationRequest } from "../ai-boundary/requests/email.js";
import { answered, denied, stubGateway } from "../ai-boundary/__tests__/stub-gateway.js";
import type {
  InboundItem,
  Classification,
  Deadline,
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  TransactionRunner,
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
    subject: "Project deadline",
    bodyPreview: "The report is due Friday.",
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
    summary: "Report due Friday",
    actionItems: '["Review report"]',
    followUpNeeded: true,
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
    description: "Report due",
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
  summary: "Report due Friday",
  actionItems: ["Review report"],
  followUpNeeded: true,
  deadlines: [
    { dueDate: "2026-04-18T17:00:00Z", description: "Report due", confidence: 0.9 },
  ],
};

function createMockInboundItemRepo(): InboundItemRepository {
  return {
    upsert: vi.fn(),
    findById: vi.fn(),
    findBySourceAndExternalId: vi.fn(),
    findUnclassified: vi.fn(),
    findAll: vi.fn(),
    search: vi.fn(),
    markClassified: vi.fn(),
    incrementClassifyAttempts: vi.fn(),
    count: vi.fn(),
  };
}

function createMockClassificationRepo(): ClassificationRepository {
  return {
    create: vi.fn().mockReturnValue(makeFakeClassification()),
    findByInboundItemId: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
  };
}

function createMockDeadlineRepo(): DeadlineRepository {
  return {
    create: vi.fn().mockReturnValue(makeFakeDeadline()),
    findByInboundItemId: vi.fn(),
    findByDateRange: vi.fn(),
    findOverdue: vi.fn(),
    updateStatus: vi.fn(),
    count: vi.fn(),
  };
}

function createMockTransactionRunner(): TransactionRunner {
  return { run: vi.fn().mockImplementation((fn: () => unknown) => fn()) };
}

const failedResult = (message: string): GatewayResult => ({ kind: "failed", message, withheld: [], decisionId: "d" });

/** A stub gateway that records the requests it gets; it answers with LLM_RESULT unless told otherwise. */
function createGateway(respond: () => GatewayResult = () => answered(LLM_RESULT)) {
  return stubGateway({ respond });
}

function createDeps(overrides: Partial<ClassifyItemDeps> = {}): ClassifyItemDeps {
  return {
    inboundItemRepo: createMockInboundItemRepo(),
    classificationRepo: createMockClassificationRepo(),
    deadlineRepo: createMockDeadlineRepo(),
    transactionRunner: createMockTransactionRunner(),
    modelGateway: createGateway(),
    logger: createMockLogger(),
    classifierModel: "claude-3-5-haiku-20241022",
    promptVersion: "v1",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("classifyItem", () => {
  let deps: ClassifyItemDeps;
  let item: InboundItem;

  beforeEach(() => {
    deps = createDeps();
    item = makeFakeItem();
  });

  // ── LLM call ────────────────────────────────────────────

  it("sends the email classification request through the gateway", async () => {
    await classifyItem(deps, item);

    const { requests } = deps.modelGateway as ReturnType<typeof stubGateway>;
    expect(requests).toEqual([emailClassificationRequest(item)]);
  });

  it.each(["provider_unavailable", "invalid_context", "unknown_purpose"] as const)(
    "throws ClassificationPausedError carrying %s without counting an attempt",
    async (reason) => {
      deps = createDeps({ modelGateway: createGateway(() => denied(reason)) });

      const error = await classifyItem(deps, item).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClassificationPausedError);
      expect(error).toMatchObject({ reason });

      expect(deps.inboundItemRepo.incrementClassifyAttempts).not.toHaveBeenCalled();
      expect(deps.classificationRepo.create).not.toHaveBeenCalled();
      expect(deps.inboundItemRepo.markClassified).not.toHaveBeenCalled();
    },
  );

  // Final review I3: a denial tied to the item's own content counts an attempt, so maxAttempts ends the retries.
  it.each(["secret_present", "required_part_withheld", "masked_value_present"] as const)(
    "throws ClassificationPausedError carrying %s and counts an attempt",
    async (reason) => {
      deps = createDeps({ modelGateway: createGateway(() => denied(reason)) });

      const error = await classifyItem(deps, item).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClassificationPausedError);
      expect(error).toMatchObject({ reason });

      expect(deps.inboundItemRepo.incrementClassifyAttempts).toHaveBeenCalledOnce();
      expect(deps.inboundItemRepo.incrementClassifyAttempts).toHaveBeenCalledWith("item-001");
      expect(deps.classificationRepo.create).not.toHaveBeenCalled();
      expect(deps.inboundItemRepo.markClassified).not.toHaveBeenCalled();
    },
  );

  // ── Transaction wrapping ────────────────────────────────

  it("wraps persistence in a single transaction", async () => {
    await classifyItem(deps, item);

    expect(deps.transactionRunner.run).toHaveBeenCalledOnce();
  });

  it("creates classification inside the transaction", async () => {
    await classifyItem(deps, item);

    expect(deps.classificationRepo.create).toHaveBeenCalledWith({
      userId: null,
      inboundItemId: "item-001",
      category: "work",
      priority: 2,
      summary: "Report due Friday",
      actionItems: '["Review report"]',
      followUpNeeded: true,
      model: "claude-3-5-haiku-20241022",
      promptVersion: "v1",
    });
  });

  it("creates deadlines inside the transaction", async () => {
    await classifyItem(deps, item);

    expect(deps.deadlineRepo.create).toHaveBeenCalledWith({
      userId: null,
      inboundItemId: "item-001",
      dueDate: "2026-04-18T17:00:00Z",
      description: "Report due",
      confidence: 0.9,
      status: "open",
    });
  });

  it("marks the item classified inside the transaction", async () => {
    await classifyItem(deps, item);

    expect(deps.inboundItemRepo.markClassified).toHaveBeenCalledWith("item-001");
  });

  // ── Return value ────────────────────────────────────────

  it("returns classification and deadlines", async () => {
    const result = await classifyItem(deps, item);

    expect(result.classification).toEqual(makeFakeClassification());
    expect(result.deadlines).toHaveLength(1);
    expect(result.deadlines[0]).toEqual(makeFakeDeadline());
  });

  it("handles multiple deadlines from LLM result", async () => {
    const multiDeadlineResult = {
      ...LLM_RESULT,
      deadlines: [
        { dueDate: "2026-04-18T17:00:00Z", description: "Report due", confidence: 0.9 },
        { dueDate: "2026-04-25T17:00:00Z", description: "Review meeting", confidence: 0.7 },
      ],
    };
    deps = createDeps({ modelGateway: createGateway(() => answered(multiDeadlineResult)) });

    const result = await classifyItem(deps, item);

    expect(deps.deadlineRepo.create).toHaveBeenCalledTimes(2);
    expect(result.deadlines).toHaveLength(2);
  });

  it("handles zero deadlines from LLM result", async () => {
    const noDeadlineResult = { ...LLM_RESULT, deadlines: [] };
    deps = createDeps({ modelGateway: createGateway(() => answered(noDeadlineResult)) });

    const result = await classifyItem(deps, item);

    expect(deps.deadlineRepo.create).not.toHaveBeenCalled();
    expect(result.deadlines).toHaveLength(0);
  });

  // ── Model & prompt version ──────────────────────────────

  it("records the configured model name", async () => {
    deps = createDeps({ classifierModel: "claude-sonnet-4-20250514" });
    await classifyItem(deps, item);

    expect(deps.classificationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-20250514" })
    );
  });

  it("records the configured prompt version", async () => {
    deps = createDeps({ promptVersion: "v2-beta" });
    await classifyItem(deps, item);

    expect(deps.classificationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ promptVersion: "v2-beta" })
    );
  });

  // ── LLM failure ─────────────────────────────────────────

  it("increments classifyAttempts on LLM failure", async () => {
    deps = createDeps({ modelGateway: createGateway(() => failedResult("API timeout")) });

    await expect(classifyItem(deps, item)).rejects.toThrow("API timeout");

    expect(deps.inboundItemRepo.incrementClassifyAttempts).toHaveBeenCalledWith("item-001");
  });

  it("does not create classification on LLM failure", async () => {
    deps = createDeps({ modelGateway: createGateway(() => failedResult("API timeout")) });

    await expect(classifyItem(deps, item)).rejects.toThrow();

    expect(deps.classificationRepo.create).not.toHaveBeenCalled();
    expect(deps.inboundItemRepo.markClassified).not.toHaveBeenCalled();
  });

  it("logs error on LLM failure", async () => {
    deps = createDeps({ modelGateway: createGateway(() => failedResult("API timeout")) });

    await expect(classifyItem(deps, item)).rejects.toThrow();

    expect(deps.logger.error).toHaveBeenCalledWith(
      "LLM classification failed, attempts incremented",
      expect.objectContaining({ itemId: "item-001" })
    );
  });

  // ── Persistence failure ─────────────────────────────────

  it("increments classifyAttempts on persistence failure", async () => {
    (deps.transactionRunner.run as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB write failed");
    });

    await expect(classifyItem(deps, item)).rejects.toThrow("DB write failed");

    expect(deps.inboundItemRepo.incrementClassifyAttempts).toHaveBeenCalledWith("item-001");
  });

  it("logs error on persistence failure", async () => {
    (deps.transactionRunner.run as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB write failed");
    });

    await expect(classifyItem(deps, item)).rejects.toThrow();

    expect(deps.logger.error).toHaveBeenCalledWith(
      "Classification persistence failed, attempts incremented",
      expect.objectContaining({ itemId: "item-001" })
    );
  });

  // ── Logging ─────────────────────────────────────────────

  it("logs successful classification", async () => {
    await classifyItem(deps, item);

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Item classified",
      expect.objectContaining({
        itemId: "item-001",
        category: "work",
        priority: 2,
        deadlineCount: 1,
      })
    );
  });

  // ── actionItems serialization ───────────────────────────

  it("JSON-stringifies the actionItems array", async () => {
    const result = {
      ...LLM_RESULT,
      actionItems: ["Draft email", "Schedule meeting"],
    };
    deps = createDeps({ modelGateway: createGateway(() => answered(result)) });

    await classifyItem(deps, item);

    expect(deps.classificationRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionItems: '["Draft email","Schedule meeting"]',
      })
    );
  });
});
