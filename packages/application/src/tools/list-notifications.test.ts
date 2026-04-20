import { describe, it, expect, vi } from "vitest";
import type { Notification, NotificationRepository } from "@oneon/domain";
import {
  createListNotificationsTool,
  listNotificationsSchema,
  type ListNotificationsDeps,
} from "./list-notifications.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeNotification(
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id: "notif-001",
    userId: null,
    eventType: "urgent_item",
    title: "Urgent email",
    body: "Something important",
    deepLink: "/items/item-001",
    read: false,
    createdAt: "2026-04-18T10:00:00Z",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<NotificationRepository> = {},
): ListNotificationsDeps {
  return {
    notificationRepo: {
      create: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      findUnread: vi.fn().mockReturnValue([]),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      countUnread: vi.fn().mockReturnValue(0),
      ...overrides,
    },
  };
}

// ── Schema Contract Tests ────────────────────────────────────

describe("listNotificationsSchema", () => {
  it("accepts empty input with defaults", () => {
    const result = listNotificationsSchema.parse({});
    expect(result.all).toBe(false);
    expect(result.limit).toBe(20);
  });

  it("accepts explicit all=true", () => {
    const result = listNotificationsSchema.parse({ all: true });
    expect(result.all).toBe(true);
  });

  it("accepts custom limit", () => {
    const result = listNotificationsSchema.parse({ limit: 50 });
    expect(result.limit).toBe(50);
  });

  it("rejects limit > 100", () => {
    expect(() => listNotificationsSchema.parse({ limit: 200 })).toThrow();
  });

  it("rejects non-positive limit", () => {
    expect(() => listNotificationsSchema.parse({ limit: 0 })).toThrow();
    expect(() => listNotificationsSchema.parse({ limit: -1 })).toThrow();
  });
});

// ── Execution Tests ──────────────────────────────────────────

describe("list_notifications tool", () => {
  it("returns unread notifications by default", () => {
    const unread = [
      makeNotification({ id: "n1" }),
      makeNotification({ id: "n2" }),
    ];
    const deps = makeDeps({
      findUnread: vi.fn().mockReturnValue(unread),
      countUnread: vi.fn().mockReturnValue(2),
    });
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: false, limit: 20 });

    expect((result as { data: { notifications: Notification[] } }).data.notifications).toHaveLength(2);
    expect(deps.notificationRepo.findUnread).toHaveBeenCalledWith(20);
  });

  it("returns all notifications when all=true", () => {
    const all = [
      makeNotification({ id: "n1", read: false }),
      makeNotification({ id: "n2", read: true }),
    ];
    const deps = makeDeps({
      findAll: vi.fn().mockReturnValue(all),
      countUnread: vi.fn().mockReturnValue(1),
    });
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: true, limit: 20 });

    expect((result as { data: { notifications: Notification[] } }).data.notifications).toHaveLength(2);
    expect(deps.notificationRepo.findAll).toHaveBeenCalledWith({ limit: 20 });
  });

  it("includes unreadCount in data", () => {
    const deps = makeDeps({
      countUnread: vi.fn().mockReturnValue(5),
    });
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: false, limit: 20 });

    expect((result as { data: { unreadCount: number } }).data.unreadCount).toBe(5);
  });

  it("returns 'no unread notifications' summary when empty", () => {
    const deps = makeDeps();
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: false, limit: 20 }) as { data: unknown; summary: string };

    expect(result.summary).toBe("No unread notifications.");
  });

  it("returns 'no notifications' summary for all=true when empty", () => {
    const deps = makeDeps();
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: true, limit: 20 }) as { data: unknown; summary: string };

    expect(result.summary).toBe("No notifications.");
  });

  it("returns count in summary", () => {
    const deps = makeDeps({
      findUnread: vi.fn().mockReturnValue([makeNotification()]),
      countUnread: vi.fn().mockReturnValue(3),
    });
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: false, limit: 20 }) as { data: unknown; summary: string };

    expect(result.summary).toBe("Found 1 notification (3 unread total).");
  });

  it("pluralizes correctly for multiple results", () => {
    const deps = makeDeps({
      findUnread: vi
        .fn()
        .mockReturnValue([makeNotification({ id: "n1" }), makeNotification({ id: "n2" })]),
      countUnread: vi.fn().mockReturnValue(2),
    });
    const tool = createListNotificationsTool(deps);
    const result = tool.execute({ all: false, limit: 20 }) as { data: unknown; summary: string };

    expect(result.summary).toBe("Found 2 notifications (2 unread total).");
  });
});
