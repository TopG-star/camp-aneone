import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneon/domain";
import { WebPushNotificationAdapter } from "../web-push-notification-adapter.js";

vi.mock("web-push", () => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));

import * as webpush from "web-push";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockPushSubscriptionRepo() {
  return {
    upsert: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    findByUserId: vi.fn().mockReturnValue([]),
    deleteByEndpoint: vi.fn(),
  };
}

function createMockPreferenceRepo() {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    delete: vi.fn(),
  };
}

describe("WebPushNotificationAdapter", () => {
  const config = {
    vapidSubject: "mailto:test@example.com",
    vapidPublicKey: "public-key",
    vapidPrivateKey: "private-key",
  };

  let logger: Logger;
  let pushSubscriptionRepo: ReturnType<typeof createMockPushSubscriptionRepo>;
  let preferenceRepo: ReturnType<typeof createMockPreferenceRepo>;

  beforeEach(() => {
    logger = createMockLogger();
    pushSubscriptionRepo = createMockPushSubscriptionRepo();
    preferenceRepo = createMockPreferenceRepo();
    vi.clearAllMocks();
  });

  it("configures VAPID details on initialization", () => {
    new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      "mailto:test@example.com",
      "public-key",
      "private-key",
    );
  });

  it("sends push payload to user subscriptions", async () => {
    pushSubscriptionRepo.findByUserId.mockReturnValue([
      {
        id: "sub-1",
        userId: "user-A",
        endpoint: "https://push.example.com/1",
        keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const adapter = new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    await adapter.send({
      eventType: "urgent_item",
      title: "Urgent",
      body: "Action required",
      deepLink: "/inbox/id-1",
      userId: "user-A",
    });

    expect(pushSubscriptionRepo.findByUserId).toHaveBeenCalledWith("user-A");
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("deletes stale subscriptions on 410 response", async () => {
    pushSubscriptionRepo.findByUserId.mockReturnValue([
      {
        id: "sub-1",
        userId: "user-A",
        endpoint: "https://push.example.com/1",
        keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(
      Object.assign(new Error("Gone"), { statusCode: 410 }),
    );

    const adapter = new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    await adapter.send({
      eventType: "urgent_item",
      title: "Urgent",
      body: "Action required",
      userId: "user-A",
    });

    expect(pushSubscriptionRepo.deleteByEndpoint).toHaveBeenCalledWith(
      "https://push.example.com/1",
      "user-A",
    );
  });

  it("skips invalid keys_json entries", async () => {
    pushSubscriptionRepo.findByUserId.mockReturnValue([
      {
        id: "sub-1",
        userId: "user-A",
        endpoint: "https://push.example.com/1",
        keysJson: "{bad-json}",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    const adapter = new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    await adapter.send({
      eventType: "urgent_item",
      title: "Urgent",
      body: "Action required",
      userId: "user-A",
    });

    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("suppresses push when event is disabled for user", async () => {
    pushSubscriptionRepo.findByUserId.mockReturnValue([
      {
        id: "sub-1",
        userId: "user-A",
        endpoint: "https://push.example.com/1",
        keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    preferenceRepo.get.mockImplementation((key: string) => {
      if (key === "user:user-A:notification.push.enabled.urgent_item") {
        return "false";
      }
      return null;
    });

    const adapter = new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    await adapter.send({
      eventType: "urgent_item",
      title: "Urgent",
      body: "Action required",
      userId: "user-A",
    });

    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "Web push suppressed: event type disabled",
      expect.objectContaining({ eventType: "urgent_item" }),
    );
  });

  it("suppresses push during quiet hours using timezone preference", async () => {
    pushSubscriptionRepo.findByUserId.mockReturnValue([
      {
        id: "sub-1",
        userId: "user-A",
        endpoint: "https://push.example.com/1",
        keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    preferenceRepo.get.mockImplementation((key: string) => {
      if (key === "user:user-A:notification.quiet_hours") {
        return JSON.stringify({ start: "22:00", end: "07:00" });
      }
      if (key === "user:user-A:notification.timezone") {
        return "America/New_York";
      }
      return null;
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T02:00:00Z")); // 22:00 EDT

    const adapter = new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    await adapter.send({
      eventType: "urgent_item",
      title: "Urgent",
      body: "Action required",
      userId: "user-A",
    });

    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "Web push suppressed: quiet hours active",
      expect.objectContaining({ eventType: "urgent_item" }),
    );

    vi.useRealTimers();
  });

  it("ignores malformed quiet hours and still sends push", async () => {
    pushSubscriptionRepo.findByUserId.mockReturnValue([
      {
        id: "sub-1",
        userId: "user-A",
        endpoint: "https://push.example.com/1",
        keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
        createdAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    preferenceRepo.get.mockImplementation((key: string) => {
      if (key === "user:user-A:notification.quiet_hours") {
        return "not-valid-json";
      }
      return null;
    });

    const adapter = new WebPushNotificationAdapter({
      ...config,
      pushSubscriptionRepo,
      preferenceRepo,
      logger,
    });

    await adapter.send({
      eventType: "urgent_item",
      title: "Urgent",
      body: "Action required",
      userId: "user-A",
    });

    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Invalid quiet hours preference, ignoring",
      expect.objectContaining({ raw: "not-valid-json" }),
    );
  });
});
