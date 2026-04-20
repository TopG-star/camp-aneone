import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkApproachingDeadlines,
  type CheckApproachingDeadlinesDeps,
} from "../check-approaching-deadlines.js";
import type {
  Deadline,
  DeadlineRepository,
  NotificationPort,
  NotificationRepository,
  Notification,
  Logger,
} from "@oneon/domain";

// ── Fixtures ─────────────────────────────────────────────────

function makeDeadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "dl-001",
    userId: null,
    inboundItemId: "item-001",
    dueDate: "2026-04-20T09:00:00Z",
    description: "Submit Q4 report",
    confidence: 0.9,
    status: "open",
    createdAt: "2026-04-17T10:00:00Z",
    updatedAt: "2026-04-17T10:00:00Z",
    ...overrides,
  };
}

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "notif-001",
    userId: null,
    eventType: "deadline_approaching",
    title: "Deadline approaching",
    body: "Due soon",
    deepLink: null,
    read: false,
    createdAt: "2026-04-18T10:00:00Z",
    ...overrides,
  };
}

function createMockDeadlineRepo(
  overrides: Partial<DeadlineRepository> = {},
): DeadlineRepository {
  return {
    create: vi.fn(),
    findByInboundItemId: vi.fn().mockReturnValue([]),
    findByDateRange: vi.fn().mockReturnValue([]),
    findOverdue: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    count: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function createMockNotificationPort(): NotificationPort {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockNotificationRepo(
  overrides: Partial<NotificationRepository> = {},
): NotificationRepository {
  return {
    create: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findUnread: vi.fn().mockReturnValue([]),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    countUnread: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeDeps(
  overrides: Partial<CheckApproachingDeadlinesDeps> = {},
): CheckApproachingDeadlinesDeps {
  return {
    deadlineRepo: createMockDeadlineRepo(),
    notificationPort: createMockNotificationPort(),
    notificationRepo: createMockNotificationRepo(),
    logger: createMockLogger(),
    userId: "test-user",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("checkApproachingDeadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-18T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries deadlines within the lead-time window", async () => {
    const deps = makeDeps();
    await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalledWith(
      expect.stringContaining("2026-04-18"),
      expect.stringContaining("2026-04-20"),
      "open",
      "test-user",
    );
  });

  it("sends notification for each approaching deadline", async () => {
    const deadlines = [
      makeDeadline({ id: "dl-001", description: "Submit Q4 report" }),
      makeDeadline({ id: "dl-002", description: "Code review PR #42" }),
    ];
    const deps = makeDeps({
      deadlineRepo: createMockDeadlineRepo({
        findByDateRange: vi.fn().mockReturnValue(deadlines),
      }),
    });

    const result = await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(deps.notificationPort.send).toHaveBeenCalledTimes(2);
    expect(deps.notificationPort.send).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "deadline_approaching",
        title: "Deadline approaching: Submit Q4 report",
        deepLink: "/deadlines/dl-001",
      }),
    );
    expect(result.notified).toBe(2);
    expect(result.checked).toBe(2);
  });

  it("skips deadlines that already have a recent notification", async () => {
    const deadlines = [makeDeadline({ id: "dl-001" })];
    const existingNotification = makeNotification({
      deepLink: "/deadlines/dl-001",
      // Created today — within the 2-day dedupe window
      createdAt: "2026-04-18T08:00:00Z",
    });

    const deps = makeDeps({
      deadlineRepo: createMockDeadlineRepo({
        findByDateRange: vi.fn().mockReturnValue(deadlines),
      }),
      notificationRepo: createMockNotificationRepo({
        findAll: vi.fn().mockReturnValue([existingNotification]),
      }),
    });

    const result = await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(deps.notificationPort.send).not.toHaveBeenCalled();
    expect(result.skippedAlreadyNotified).toBe(1);
    expect(result.notified).toBe(0);
  });

  it("re-notifies when previous notification is outside the dedupe window", async () => {
    const deadlines = [makeDeadline({ id: "dl-001" })];
    const oldNotification = makeNotification({
      deepLink: "/deadlines/dl-001",
      // Created 5 days ago — outside the 2-day dedupe window
      createdAt: "2026-04-13T10:00:00Z",
    });

    const deps = makeDeps({
      deadlineRepo: createMockDeadlineRepo({
        findByDateRange: vi.fn().mockReturnValue(deadlines),
      }),
      notificationRepo: createMockNotificationRepo({
        findAll: vi.fn().mockReturnValue([oldNotification]),
      }),
    });

    const result = await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(deps.notificationPort.send).toHaveBeenCalledTimes(1);
    expect(result.notified).toBe(1);
    expect(result.skippedAlreadyNotified).toBe(0);
  });

  it("returns zero counts when no deadlines are approaching", async () => {
    const deps = makeDeps();
    const result = await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(result.checked).toBe(0);
    expect(result.notified).toBe(0);
    expect(result.skippedAlreadyNotified).toBe(0);
  });

  it("does not log when no notifications are sent", async () => {
    const deps = makeDeps();
    await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it("logs when notifications are sent", async () => {
    const deps = makeDeps({
      deadlineRepo: createMockDeadlineRepo({
        findByDateRange: vi.fn().mockReturnValue([makeDeadline()]),
      }),
    });

    await checkApproachingDeadlines(deps, { leadDays: 2 });

    expect(deps.logger.info).toHaveBeenCalledWith(
      "Deadline approaching notifications sent",
      expect.objectContaining({ notified: 1 }),
    );
  });

  it("formats due date in the notification body", async () => {
    const deps = makeDeps({
      deadlineRepo: createMockDeadlineRepo({
        findByDateRange: vi
          .fn()
          .mockReturnValue([
            makeDeadline({ dueDate: "2026-04-20T09:00:00Z" }),
          ]),
      }),
    });

    await checkApproachingDeadlines(deps, { leadDays: 3 });

    expect(deps.notificationPort.send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Apr"),
      }),
    );
  });

  it("uses configurable lead days", async () => {
    const deps = makeDeps();
    await checkApproachingDeadlines(deps, { leadDays: 7 });

    // Should query 7 days from now: 2026-04-18 to 2026-04-25
    expect(deps.deadlineRepo.findByDateRange).toHaveBeenCalledWith(
      expect.stringContaining("2026-04-18"),
      expect.stringContaining("2026-04-25"),
      "open",
      "test-user",
    );
  });
});
