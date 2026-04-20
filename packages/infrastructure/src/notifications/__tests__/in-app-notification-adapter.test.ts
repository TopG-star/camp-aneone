import { describe, it, expect, vi, beforeEach } from "vitest";
import { InAppNotificationAdapter } from "../in-app-notification-adapter.js";
import type {
  NotificationRepository,
  PreferenceRepository,
  Logger,
} from "@oneon/domain";

// ── Mock Factories ───────────────────────────────────────────

function createMockNotificationRepo(
  overrides: Partial<NotificationRepository> = {},
): NotificationRepository {
  return {
    create: vi.fn().mockImplementation((input) => ({
      id: "notif-001",
      ...input,
      createdAt: "2026-04-18T10:00:00Z",
    })),
    findById: vi.fn().mockReturnValue(null),
    findUnread: vi.fn().mockReturnValue([]),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    countUnread: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function createMockPreferenceRepo(
  overrides: Partial<PreferenceRepository> = {},
): PreferenceRepository {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
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

// ── Tests ────────────────────────────────────────────────────

describe("InAppNotificationAdapter", () => {
  let notificationRepo: NotificationRepository;
  let preferenceRepo: PreferenceRepository;
  let logger: Logger;
  let adapter: InAppNotificationAdapter;

  beforeEach(() => {
    notificationRepo = createMockNotificationRepo();
    preferenceRepo = createMockPreferenceRepo();
    logger = createMockLogger();
    adapter = new InAppNotificationAdapter({
      notificationRepo,
      preferenceRepo,
      logger,
    });
  });

  // ── Basic send ──────────────────────────────────────────

  describe("send()", () => {
    it("creates a notification in the repository", async () => {
      await adapter.send({
        eventType: "urgent_item",
        title: "Urgent: Q4 Review",
        body: "You received a priority-1 email from boss@company.com",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
      expect(notificationRepo.create).toHaveBeenCalledWith({
        eventType: "urgent_item",
        title: "Urgent: Q4 Review",
        body: "You received a priority-1 email from boss@company.com",
        deepLink: null,
        read: false,
        userId: null,
      });
    });

    it("passes deepLink when provided", async () => {
      await adapter.send({
        eventType: "action_proposed",
        title: "Action proposed",
        body: "Draft reply to boss",
        deepLink: "/actions/act-001",
      });

      expect(notificationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ deepLink: "/actions/act-001" }),
      );
    });

    it("logs the created notification", async () => {
      await adapter.send({
        eventType: "urgent_item",
        title: "Test",
        body: "Test body",
      });

      expect(logger.info).toHaveBeenCalledWith(
        "Notification created",
        expect.objectContaining({
          id: "notif-001",
          eventType: "urgent_item",
        }),
      );
    });
  });

  // ── Per-event-type toggle ───────────────────────────────

  describe("per-event-type toggle", () => {
    it("suppresses notification when event type is disabled", async () => {
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.enabled.urgent_item" ? "false" : null,
      );

      await adapter.send({
        eventType: "urgent_item",
        title: "Suppressed",
        body: "Should not be created",
      });

      expect(notificationRepo.create).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Notification suppressed: event type disabled",
        expect.objectContaining({ eventType: "urgent_item" }),
      );
    });

    it("allows notification when event type is explicitly enabled", async () => {
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.enabled.urgent_item" ? "true" : null,
      );

      await adapter.send({
        eventType: "urgent_item",
        title: "Allowed",
        body: "Should be created",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
    });

    it("allows notification when no preference is set (default enabled)", async () => {
      await adapter.send({
        eventType: "deadline_approaching",
        title: "Deadline",
        body: "Due tomorrow",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
    });

    it("only disables the specific event type, others still work", async () => {
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.enabled.urgent_item" ? "false" : null,
      );

      await adapter.send({
        eventType: "action_proposed",
        title: "Action",
        body: "Should go through",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
    });
  });

  // ── Quiet hours ─────────────────────────────────────────

  describe("quiet hours", () => {
    it("suppresses notification during quiet hours (overnight range)", async () => {
      // Quiet hours 22:00–07:00, current time is 23:30
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.quiet_hours"
            ? JSON.stringify({ start: "22:00", end: "07:00" })
            : null,
      );

      // Mock Date to 23:30
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-18T23:30:00Z"));

      await adapter.send({
        eventType: "urgent_item",
        title: "Late night",
        body: "Should be suppressed",
      });

      expect(notificationRepo.create).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Notification suppressed: quiet hours active",
        expect.objectContaining({ eventType: "urgent_item" }),
      );

      vi.useRealTimers();
    });

    it("allows notification outside quiet hours (overnight range)", async () => {
      // Quiet hours 22:00–07:00, current time is 12:00
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.quiet_hours"
            ? JSON.stringify({ start: "22:00", end: "07:00" })
            : null,
      );

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));

      await adapter.send({
        eventType: "urgent_item",
        title: "Midday",
        body: "Should go through",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it("suppresses notification during quiet hours (same-day range)", async () => {
      // Quiet hours 09:00–17:00, current time is 14:00
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.quiet_hours"
            ? JSON.stringify({ start: "09:00", end: "17:00" })
            : null,
      );

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-18T14:00:00Z"));

      await adapter.send({
        eventType: "urgent_item",
        title: "During work hours",
        body: "Should be suppressed",
      });

      expect(notificationRepo.create).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("allows notification when no quiet hours preference set", async () => {
      await adapter.send({
        eventType: "urgent_item",
        title: "No quiet hours",
        body: "Should go through",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
    });

    it("ignores malformed quiet hours JSON gracefully", async () => {
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.quiet_hours" ? "not-valid-json" : null,
      );

      await adapter.send({
        eventType: "urgent_item",
        title: "Bad JSON",
        body: "Should still create notification",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        "Invalid quiet hours preference, ignoring",
        expect.objectContaining({ raw: "not-valid-json" }),
      );
    });

    it("ignores quiet hours with missing start/end fields", async () => {
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) =>
          key === "notification.quiet_hours"
            ? JSON.stringify({ start: "22:00" })
            : null,
      );

      await adapter.send({
        eventType: "urgent_item",
        title: "Partial config",
        body: "Should go through",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();
    });

    it("uses configured timezone for quiet hours evaluation", async () => {
      // Quiet hours 22:00–07:00 in America/New_York (UTC-4 in summer)
      // System time is 2026-06-15T02:00:00Z = 22:00 EDT → within quiet hours
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) => {
          if (key === "notification.quiet_hours") {
            return JSON.stringify({ start: "22:00", end: "07:00" });
          }
          if (key === "notification.timezone") {
            return "America/New_York";
          }
          return null;
        },
      );

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-15T02:00:00Z")); // 22:00 EDT

      await adapter.send({
        eventType: "urgent_item",
        title: "NY night",
        body: "Should be suppressed in EDT",
      });

      expect(notificationRepo.create).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Notification suppressed: quiet hours active",
        expect.objectContaining({ eventType: "urgent_item" }),
      );

      vi.useRealTimers();
    });

    it("allows notification when timezone makes it outside quiet hours", async () => {
      // Quiet hours 22:00–07:00 in America/New_York (UTC-4 in summer)
      // System time is 2026-06-15T15:00:00Z = 11:00 EDT → outside quiet hours
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) => {
          if (key === "notification.quiet_hours") {
            return JSON.stringify({ start: "22:00", end: "07:00" });
          }
          if (key === "notification.timezone") {
            return "America/New_York";
          }
          return null;
        },
      );

      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-15T15:00:00Z")); // 11:00 EDT

      await adapter.send({
        eventType: "urgent_item",
        title: "NY midday",
        body: "Should go through in EDT",
      });

      expect(notificationRepo.create).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it("falls back to server time when timezone preference is invalid", async () => {
      (preferenceRepo.get as ReturnType<typeof vi.fn>).mockImplementation(
        (key: string) => {
          if (key === "notification.quiet_hours") {
            return JSON.stringify({ start: "22:00", end: "07:00" });
          }
          if (key === "notification.timezone") {
            return "Invalid/Timezone";
          }
          return null;
        },
      );

      vi.useFakeTimers();
      // 12:00 server time → outside 22:00–07:00 regardless of timezone
      vi.setSystemTime(new Date("2026-04-18T12:00:00Z"));

      await adapter.send({
        eventType: "urgent_item",
        title: "Bad timezone",
        body: "Should still create with server-time fallback",
      });

      expect(logger.warn).toHaveBeenCalledWith(
        "Invalid notification.timezone, falling back to server time",
        expect.objectContaining({ timezone: "Invalid/Timezone" }),
      );
      expect(notificationRepo.create).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });
});
