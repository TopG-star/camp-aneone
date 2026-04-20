import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Notification, NotificationRepository, Logger } from "@oneon/domain";
import {
  createNotificationRouter,
  type NotificationRouteDeps,
} from "./notification.route.js";

// ── Helpers ──────────────────────────────────────────────────

function makeNotification(overrides: Partial<Notification> = {}): Notification {
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
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function buildApp(deps: NotificationRouteDeps, userId = "user-A"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use("/api/notifications", createNotificationRouter(deps));
  return app;
}

// ── Tests ────────────────────────────────────────────────────

describe("Notification routes", () => {
  let logger: Logger;
  let notificationRepo: NotificationRepository;
  let app: express.Express;

  beforeEach(() => {
    logger = createMockLogger();
    notificationRepo = createMockNotificationRepo();
    app = buildApp({ notificationRepo, logger });
  });

  // ── GET / ──────────────────────────────────────────────────

  describe("GET /api/notifications", () => {
    it("returns unread notifications by default", async () => {
      const unread = [makeNotification({ id: "n1" }), makeNotification({ id: "n2" })];
      vi.mocked(notificationRepo.findUnread).mockReturnValue(unread);

      const res = await request(app).get("/api/notifications").expect(200);

      expect(res.body.notifications).toHaveLength(2);
      expect(notificationRepo.findUnread).toHaveBeenCalledWith(50, "user-A");
    });

    it("returns all notifications when all=true", async () => {
      const all = [
        makeNotification({ id: "n1", read: false }),
        makeNotification({ id: "n2", read: true }),
      ];
      vi.mocked(notificationRepo.findAll).mockReturnValue(all);

      const res = await request(app)
        .get("/api/notifications?all=true")
        .expect(200);

      expect(res.body.notifications).toHaveLength(2);
      expect(notificationRepo.findAll).toHaveBeenCalledWith({
        limit: 50,
        offset: 0,
        userId: "user-A",
      });
    });

    it("respects limit and offset query params", async () => {
      vi.mocked(notificationRepo.findAll).mockReturnValue([]);

      await request(app)
        .get("/api/notifications?all=true&limit=10&offset=20")
        .expect(200);

      expect(notificationRepo.findAll).toHaveBeenCalledWith({
        limit: 10,
        offset: 20,
        userId: "user-A",
      });
    });

    it("clamps limit to 200 max", async () => {
      vi.mocked(notificationRepo.findAll).mockReturnValue([]);

      await request(app)
        .get("/api/notifications?all=true&limit=999")
        .expect(200);

      expect(notificationRepo.findAll).toHaveBeenCalledWith({
        limit: 200,
        offset: 0,
        userId: "user-A",
      });
    });

    it("returns 500 on repo error", async () => {
      vi.mocked(notificationRepo.findUnread).mockImplementation(() => {
        throw new Error("DB crash");
      });

      const res = await request(app).get("/api/notifications").expect(500);

      expect(res.body.error).toBe("Internal server error");
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // ── GET /count ─────────────────────────────────────────────

  describe("GET /api/notifications/count", () => {
    it("returns unread notification count", async () => {
      vi.mocked(notificationRepo.countUnread).mockReturnValue(7);

      const res = await request(app)
        .get("/api/notifications/count")
        .expect(200);

      expect(res.body.count).toBe(7);
    });

    it("returns 0 when no unread", async () => {
      const res = await request(app)
        .get("/api/notifications/count")
        .expect(200);

      expect(res.body.count).toBe(0);
    });

    it("returns 500 on repo error", async () => {
      vi.mocked(notificationRepo.countUnread).mockImplementation(() => {
        throw new Error("DB");
      });

      const res = await request(app)
        .get("/api/notifications/count")
        .expect(500);

      expect(res.body.error).toBe("Internal server error");
    });
  });

  // ── PATCH /:id/read ────────────────────────────────────────

  describe("PATCH /api/notifications/:id/read", () => {
    it("marks a notification as read", async () => {
      vi.mocked(notificationRepo.findById).mockReturnValue(
        makeNotification({ id: "notif-001", userId: "user-A" }),
      );

      const res = await request(app)
        .patch("/api/notifications/notif-001/read")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(notificationRepo.markRead).toHaveBeenCalledWith("notif-001");
    });

    it("returns 404 when notification belongs to another user", async () => {
      vi.mocked(notificationRepo.findById).mockReturnValue(
        makeNotification({ id: "notif-001", userId: "user-B" }),
      );

      const res = await request(app)
        .patch("/api/notifications/notif-001/read")
        .expect(404);

      expect(res.body.error).toBe("Notification not found");
      expect(notificationRepo.markRead).not.toHaveBeenCalled();
    });

    it("returns 404 when notification does not exist", async () => {
      vi.mocked(notificationRepo.findById).mockReturnValue(null);

      const res = await request(app)
        .patch("/api/notifications/notif-999/read")
        .expect(404);

      expect(res.body.error).toBe("Notification not found");
    });

    it("returns 500 on repo error", async () => {
      vi.mocked(notificationRepo.findById).mockImplementation(() => {
        throw new Error("DB");
      });

      const res = await request(app)
        .patch("/api/notifications/notif-001/read")
        .expect(500);

      expect(res.body.error).toBe("Internal server error");
    });
  });

  // ── POST /mark-all-read ───────────────────────────────────

  describe("POST /api/notifications/mark-all-read", () => {
    it("marks all notifications as read", async () => {
      const res = await request(app)
        .post("/api/notifications/mark-all-read")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(notificationRepo.markAllRead).toHaveBeenCalledWith("user-A");
    });

    it("returns 500 on repo error", async () => {
      vi.mocked(notificationRepo.markAllRead).mockImplementation(() => {
        throw new Error("DB");
      });

      const res = await request(app)
        .post("/api/notifications/mark-all-read")
        .expect(500);

      expect(res.body.error).toBe("Internal server error");
    });
  });

  // ── User isolation ─────────────────────────────────────────

  describe("User isolation", () => {
    it("countUnread is scoped to the authenticated user", async () => {
      vi.mocked(notificationRepo.countUnread).mockReturnValue(3);

      await request(app).get("/api/notifications/count").expect(200);

      expect(notificationRepo.countUnread).toHaveBeenCalledWith("user-A");
    });

    it("markAllRead is scoped to the authenticated user", async () => {
      await request(app).post("/api/notifications/mark-all-read").expect(200);

      expect(notificationRepo.markAllRead).toHaveBeenCalledWith("user-A");
    });
  });
});
