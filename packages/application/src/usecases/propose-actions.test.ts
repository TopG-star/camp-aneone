import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  proposeActions,
  deriveActions,
  ACTION_RISK_LEVELS,
  type ProposeActionsDeps,
} from "./propose-actions.js";
import type {
  Classification,
  Deadline,
  InboundItem,
  ActionLogEntry,
  ActionLogRepository,
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
    classifiedAt: "2026-04-10T09:01:00Z",
    classifyAttempts: 1,
    createdAt: "2026-04-10T09:00:00Z",
    updatedAt: "2026-04-10T09:01:00Z",
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
    priority: 3,
    summary: "A work email",
    actionItems: "[]",
    followUpNeeded: false,
    model: "claude-3-5-haiku-20241022",
    promptVersion: "v1",
    createdAt: "2026-04-10T09:01:00Z",
    ...overrides,
  };
}

function makeFakeActionLog(
  overrides: Partial<ActionLogEntry> = {}
): ActionLogEntry {
  return {
    id: "action-001",
    userId: null,
    resourceId: "item-001",
    actionType: "notify",
    riskLevel: "auto",
    status: "proposed",
    payloadJson: "{}",
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-10T09:02:00Z",
    updatedAt: "2026-04-10T09:02:00Z",
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

function createMockActionLogRepo(): ActionLogRepository {
  return {
    create: vi.fn().mockImplementation((entry) => ({
      id: `action-${Math.random().toString(36).slice(2, 8)}`,
      ...entry,
      createdAt: "2026-04-10T09:02:00Z",
      updatedAt: "2026-04-10T09:02:00Z",
    })),
    findByResourceAndType: vi.fn().mockReturnValue(null),
    findByStatus: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
  };
}

function createDeps(
  overrides: Partial<ProposeActionsDeps> = {}
): ProposeActionsDeps {
  return {
    actionLogRepo: createMockActionLogRepo(),
    logger: createMockLogger(),
    userId: "test-user",
    ...overrides,
  };
}

// ── deriveActions (pure rule engine) ─────────────────────────

describe("deriveActions", () => {
  it("proposes notify for urgent category", () => {
    const cls = makeFakeClassification({ category: "urgent", priority: 3 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).toContainEqual(
      expect.objectContaining({ actionType: "notify" })
    );
  });

  it("proposes notify for high priority (<=2)", () => {
    const cls = makeFakeClassification({ category: "work", priority: 2 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).toContainEqual(
      expect.objectContaining({ actionType: "notify" })
    );
  });

  it("does NOT propose notify for low priority non-urgent", () => {
    const cls = makeFakeClassification({ category: "work", priority: 4 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).not.toContainEqual(
      expect.objectContaining({ actionType: "notify" })
    );
  });

  it("proposes create_reminder for each deadline", () => {
    const cls = makeFakeClassification();
    const item = makeFakeItem();
    const deadlines = [
      makeFakeDeadline({ id: "dl-001" }),
      makeFakeDeadline({ id: "dl-002" }),
      makeFakeDeadline({ id: "dl-003" }),
    ];
    const actions = deriveActions(cls, item, deadlines);

    const reminders = actions.filter((a) => a.actionType === "create_reminder");
    expect(reminders).toHaveLength(3);
  });

  it("uses deadline.id as resourceId for reminders", () => {
    const cls = makeFakeClassification();
    const item = makeFakeItem({ id: "item-001" });
    const deadlines = [
      makeFakeDeadline({ id: "dl-AAA" }),
      makeFakeDeadline({ id: "dl-BBB" }),
    ];
    const actions = deriveActions(cls, item, deadlines);

    const reminders = actions.filter((a) => a.actionType === "create_reminder");
    expect(reminders[0].resourceId).toBe("dl-AAA");
    expect(reminders[1].resourceId).toBe("dl-BBB");
  });

  it("includes deadline details in reminder payload", () => {
    const cls = makeFakeClassification();
    const item = makeFakeItem();
    const deadlines = [makeFakeDeadline({ id: "dl-001", dueDate: "2026-04-20T00:00:00Z", description: "Submit report" })];
    const actions = deriveActions(cls, item, deadlines);

    const reminder = actions.find((a) => a.actionType === "create_reminder")!;
    const payload = JSON.parse(reminder.payloadJson);
    expect(payload.deadlineId).toBe("dl-001");
    expect(payload.dueDate).toBe("2026-04-20T00:00:00Z");
    expect(payload.description).toBe("Submit report");
    expect(payload.inboundItemId).toBe("item-001");
  });

  it("proposes zero reminders when no deadlines", () => {
    const cls = makeFakeClassification();
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    const reminders = actions.filter((a) => a.actionType === "create_reminder");
    expect(reminders).toHaveLength(0);
  });

  it("proposes draft_reply when followUpNeeded", () => {
    const cls = makeFakeClassification({ followUpNeeded: true });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).toContainEqual(
      expect.objectContaining({ actionType: "draft_reply" })
    );
  });

  it("does NOT propose draft_reply when followUpNeeded is false", () => {
    const cls = makeFakeClassification({ followUpNeeded: false });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).not.toContainEqual(
      expect.objectContaining({ actionType: "draft_reply" })
    );
  });

  it("proposes archive for spam", () => {
    const cls = makeFakeClassification({ category: "spam", priority: 5 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).toContainEqual(
      expect.objectContaining({ actionType: "archive", riskLevel: "approval_required" })
    );
  });

  it("proposes label for low-priority newsletter", () => {
    const cls = makeFakeClassification({ category: "newsletter", priority: 4 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    expect(actions).toContainEqual(
      expect.objectContaining({ actionType: "label", riskLevel: "auto" })
    );
  });

  it("does NOT propose label for high-priority newsletter", () => {
    const cls = makeFakeClassification({ category: "newsletter", priority: 2 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);

    // High priority newsletter gets notify instead of label
    expect(actions).not.toContainEqual(
      expect.objectContaining({ actionType: "label" })
    );
  });

  it("sets resourceId to item.id for non-reminder actions", () => {
    const cls = makeFakeClassification({ category: "urgent" });
    const item = makeFakeItem({ id: "my-item-id" });
    const actions = deriveActions(cls, item, []);

    for (const action of actions) {
      expect(action.resourceId).toBe("my-item-id");
    }
  });

  it("includes payload with reason in notify action", () => {
    const cls = makeFakeClassification({ category: "urgent", priority: 1 });
    const item = makeFakeItem();
    const actions = deriveActions(cls, item, []);
    const notify = actions.find((a) => a.actionType === "notify")!;
    const payload = JSON.parse(notify.payloadJson);

    expect(payload.reason).toBe("urgent_category");
    expect(payload.summary).toBeDefined();
  });

  it("multiple rules can fire on one classification", () => {
    // urgent + followUp + 2 deadlines → notify + draft_reply + 2 reminders = 4
    const cls = makeFakeClassification({
      category: "urgent",
      priority: 1,
      followUpNeeded: true,
    });
    const item = makeFakeItem();
    const deadlines = [
      makeFakeDeadline({ id: "dl-001" }),
      makeFakeDeadline({ id: "dl-002" }),
    ];
    const actions = deriveActions(cls, item, deadlines);

    expect(actions.length).toBe(4);
  });
});

// ── proposeActions (use case with idempotency) ──────────────

describe("proposeActions", () => {
  let deps: ProposeActionsDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  it("creates action log entries for derived actions", () => {
    const cls = makeFakeClassification({ category: "urgent" });
    const item = makeFakeItem();

    const result = proposeActions(deps, cls, item, []);

    expect(result.created.length).toBeGreaterThan(0);
    expect(deps.actionLogRepo.create).toHaveBeenCalled();
  });

  it("skips duplicates when action already exists", () => {
    const cls = makeFakeClassification({ category: "urgent" });
    const item = makeFakeItem();

    // First call finds existing for all actions
    (deps.actionLogRepo.findByResourceAndType as ReturnType<typeof vi.fn>)
      .mockReturnValue(makeFakeActionLog());

    const result = proposeActions(deps, cls, item, []);

    expect(result.created).toHaveLength(0);
    expect(result.skippedDuplicates).toBeGreaterThan(0);
    expect(deps.actionLogRepo.create).not.toHaveBeenCalled();
  });

  it("creates entry with status=proposed", () => {
    const cls = makeFakeClassification({ category: "urgent" });
    const item = makeFakeItem();

    proposeActions(deps, cls, item, []);

    expect(deps.actionLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "proposed" })
    );
  });

  it("passes correct riskLevel from mapping", () => {
    const cls = makeFakeClassification({ category: "spam", priority: 5 });
    const item = makeFakeItem();

    proposeActions(deps, cls, item, []);

    expect(deps.actionLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "archive",
        riskLevel: "approval_required",
      })
    );
  });

  it("checks findByResourceAndType for each derived action", () => {
    const cls = makeFakeClassification({
      category: "urgent",
      followUpNeeded: true,
    });
    const item = makeFakeItem();
    const deadlines = [makeFakeDeadline({ id: "dl-001" })];

    proposeActions(deps, cls, item, deadlines);

    // urgent → notify + draft_reply + 1 reminder = 3 checks
    expect(deps.actionLogRepo.findByResourceAndType).toHaveBeenCalledTimes(3);
  });

  it("uses deadline.id for reminder idempotency check", () => {
    const cls = makeFakeClassification();
    const item = makeFakeItem();
    const deadlines = [makeFakeDeadline({ id: "dl-XYZ" })];

    proposeActions(deps, cls, item, deadlines);

    expect(deps.actionLogRepo.findByResourceAndType).toHaveBeenCalledWith(
      "dl-XYZ",
      "create_reminder"
    );
  });

  it("logs the proposal summary", () => {
    const cls = makeFakeClassification({ category: "urgent" });
    const item = makeFakeItem();

    proposeActions(deps, cls, item, []);

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Actions proposed",
      expect.objectContaining({ itemId: "item-001" })
    );
  });

  it("returns empty created array when no rules fire", () => {
    // work, priority 3, no followUp, no deadlines → no actions
    const cls = makeFakeClassification({
      category: "work",
      priority: 3,
      followUpNeeded: false,
    });
    const item = makeFakeItem();

    const result = proposeActions(deps, cls, item, []);

    expect(result.created).toHaveLength(0);
    expect(result.skippedDuplicates).toBe(0);
  });
});

// ── Risk-level mapping ──────────────────────────────────────

describe("ACTION_RISK_LEVELS", () => {
  it("auto actions are classified correctly", () => {
    expect(ACTION_RISK_LEVELS["classify"]).toBe("auto");
    expect(ACTION_RISK_LEVELS["label"]).toBe("auto");
    expect(ACTION_RISK_LEVELS["notify"]).toBe("auto");
    expect(ACTION_RISK_LEVELS["create_reminder"]).toBe("auto");
    expect(ACTION_RISK_LEVELS["draft_reply"]).toBe("auto");
  });

  it("approval_required actions are classified correctly", () => {
    expect(ACTION_RISK_LEVELS["archive"]).toBe("approval_required");
    expect(ACTION_RISK_LEVELS["delete"]).toBe("approval_required");
    expect(ACTION_RISK_LEVELS["send"]).toBe("approval_required");
    expect(ACTION_RISK_LEVELS["forward"]).toBe("approval_required");
  });
});
