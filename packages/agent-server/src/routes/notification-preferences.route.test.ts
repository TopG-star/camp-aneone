import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PreferenceRepository, Logger, Preference } from "@oneon/domain";
import {
  createNotificationPreferencesRouter,
  type NotificationPreferencesRouteDeps,
} from "./notification-preferences.route.js";

// ── Helpers ──────────────────────────────────────────────────

function createMockPreferenceRepo(
  overrides: Partial<PreferenceRepository> = {},
): PreferenceRepository {
  return {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    getAll: vi.fn().mockReturnValue({}),
    delete: vi.fn(),
    ...overrides,
  };
}

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function buildApp(deps: NotificationPreferencesRouteDeps, userId = "user-A"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use(
    "/api/notification-preferences",
    createNotificationPreferencesRouter(deps),
  );
  return app;
}

// ── Tests ────────────────────────────────────────────────────

describe("Notification preferences routes", () => {
  let logger: Logger;
  let preferenceRepo: PreferenceRepository;
  let app: express.Express;

  beforeEach(() => {
    logger = createMockLogger();
    preferenceRepo = createMockPreferenceRepo();
    app = buildApp({ preferenceRepo, logger });
  });

  // ── GET /api/notification-preferences ──────────────────────

  describe("GET /api/notification-preferences", () => {
    it("returns only notification-prefixed preferences for the user", async () => {
      vi.mocked(preferenceRepo.getAll).mockReturnValue([
        { key: "user:user-A:notification.enabled.urgent_item", value: "true", updatedAt: "2026-04-18T10:00:00Z" },
        { key: "user:user-A:notification.quiet_hours", value: '{"start":"22:00","end":"07:00"}', updatedAt: "2026-04-18T10:00:00Z" },
        { key: "user:user-B:notification.enabled.urgent_item", value: "false", updatedAt: "2026-04-18T10:00:00Z" },
        { key: "other.setting", value: "value", updatedAt: "2026-04-18T10:00:00Z" },
      ] satisfies Preference[]);

      const res = await request(app)
        .get("/api/notification-preferences")
        .expect(200);

      expect(res.body.preferences).toEqual({
        "notification.enabled.urgent_item": "true",
        "notification.quiet_hours": '{"start":"22:00","end":"07:00"}',
      });
      expect(res.body.preferences["other.setting"]).toBeUndefined();
    });

    it("returns empty object when no notification preferences exist", async () => {
      vi.mocked(preferenceRepo.getAll).mockReturnValue([]);

      const res = await request(app)
        .get("/api/notification-preferences")
        .expect(200);

      expect(res.body.preferences).toEqual({});
    });

    it("returns 500 on repo error", async () => {
      vi.mocked(preferenceRepo.getAll).mockImplementation(() => {
        throw new Error("DB");
      });

      const res = await request(app)
        .get("/api/notification-preferences")
        .expect(500);

      expect(res.body.error).toBe("Internal server error");
    });
  });

  // ── PUT /api/notification-preferences ──────────────────────

  describe("PUT /api/notification-preferences", () => {
    it("saves valid notification preferences", async () => {
      const res = await request(app)
        .put("/api/notification-preferences")
        .send({
          preferences: {
            "notification.enabled.urgent_item": "false",
            "notification.quiet_hours": '{"start":"22:00","end":"07:00"}',
          },
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(preferenceRepo.set).toHaveBeenCalledWith(
        "user:user-A:notification.enabled.urgent_item",
        "false",
      );
      expect(preferenceRepo.set).toHaveBeenCalledWith(
        "user:user-A:notification.quiet_hours",
        '{"start":"22:00","end":"07:00"}',
      );
    });

    it("returns 400 when preferences is missing", async () => {
      const res = await request(app)
        .put("/api/notification-preferences")
        .send({})
        .expect(400);

      expect(res.body.error).toContain("preferences must be a non-array object");
    });

    it("returns 400 when preferences is an array", async () => {
      const res = await request(app)
        .put("/api/notification-preferences")
        .send({ preferences: [] })
        .expect(400);

      expect(res.body.error).toContain("preferences must be a non-array object");
    });

    it("returns 400 when key does not start with 'notification.'", async () => {
      const res = await request(app)
        .put("/api/notification-preferences")
        .send({ preferences: { "other.key": "value" } })
        .expect(400);

      expect(res.body.error).toContain('must start with "notification."');
    });

    it("returns 400 when value is not a string", async () => {
      const res = await request(app)
        .put("/api/notification-preferences")
        .send({ preferences: { "notification.enabled.urgent_item": true } })
        .expect(400);

      expect(res.body.error).toContain("must be a string");
    });

    it("returns 500 on repo error", async () => {
      vi.mocked(preferenceRepo.set).mockImplementation(() => {
        throw new Error("DB");
      });

      const res = await request(app)
        .put("/api/notification-preferences")
        .send({ preferences: { "notification.enabled.urgent_item": "false" } })
        .expect(500);

      expect(res.body.error).toBe("Internal server error");
    });
  });
});
