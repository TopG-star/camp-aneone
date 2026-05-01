import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Logger } from "@oneon/domain";
import {
  createPushSubscriptionsRouter,
  type PushSubscriptionsRouteDeps,
} from "./push-subscriptions.route.js";

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
    upsert: vi.fn().mockReturnValue({
      id: "sub-1",
      userId: "user-A",
      endpoint: "https://push.example.com/1",
      keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
      createdAt: "2026-05-01T00:00:00.000Z",
    }),
    findAll: vi.fn().mockReturnValue([]),
    findByUserId: vi.fn().mockReturnValue([]),
    deleteByEndpoint: vi.fn(),
  };
}

function buildApp(deps: PushSubscriptionsRouteDeps, userId = "user-A"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use("/api/push", createPushSubscriptionsRouter(deps));
  return app;
}

describe("Push subscriptions routes", () => {
  let logger: Logger;
  let pushSubscriptionRepo: ReturnType<typeof createMockPushSubscriptionRepo>;
  let app: express.Express;

  beforeEach(() => {
    logger = createMockLogger();
    pushSubscriptionRepo = createMockPushSubscriptionRepo();
    app = buildApp({
      logger,
      pushSubscriptionRepo,
      vapidPublicKey: "test-public-key",
    } as PushSubscriptionsRouteDeps);
  });

  it("returns public VAPID key", async () => {
    const res = await request(app).get("/api/push/public-key").expect(200);
    expect(res.body.publicKey).toBe("test-public-key");
  });

  it("registers a subscription for the authenticated user", async () => {
    const res = await request(app)
      .post("/api/push/subscriptions")
      .send({
        endpoint: "https://push.example.com/1",
        keys: { p256dh: "k1", auth: "a1" },
      })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(pushSubscriptionRepo.upsert).toHaveBeenCalledWith({
      endpoint: "https://push.example.com/1",
      keysJson: JSON.stringify({ p256dh: "k1", auth: "a1" }),
      userId: "user-A",
    });
  });

  it("rejects invalid subscription payload", async () => {
    const res = await request(app)
      .post("/api/push/subscriptions")
      .send({ endpoint: "https://push.example.com/1" })
      .expect(400);

    expect(res.body.error).toContain("keys");
  });

  it("deletes a subscription by endpoint", async () => {
    const res = await request(app)
      .delete("/api/push/subscriptions")
      .send({ endpoint: "https://push.example.com/1" })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(pushSubscriptionRepo.deleteByEndpoint).toHaveBeenCalledWith(
      "https://push.example.com/1",
      "user-A",
    );
  });

  it("returns 404 when VAPID key is unavailable", async () => {
    app = buildApp({
      logger,
      pushSubscriptionRepo,
      vapidPublicKey: null,
    } as PushSubscriptionsRouteDeps);

    const res = await request(app).get("/api/push/public-key").expect(404);
    expect(res.body.error).toContain("not configured");
  });
});
