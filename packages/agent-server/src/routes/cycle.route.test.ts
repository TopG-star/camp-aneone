import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { ActionLogRepository, Logger } from "@oneon/domain";
import type { BackgroundLoop } from "../background-loop.js";
import { createCycleRouter } from "./cycle.route.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeLoop(overrides: Partial<BackgroundLoop> = {}): BackgroundLoop {
  return {
    isRunning: vi.fn().mockReturnValue(true),
    start: vi.fn(),
    stop: vi.fn(),
    triggerNow: vi.fn().mockReturnValue(true),
    getRecentErrors: vi.fn().mockReturnValue([]),
    lastCycleAt: "2026-04-18T10:00:00.000Z",
    lastError: null,
    errorCount: 0,
    isCycleInFlight: false,
    ...overrides,
  } as unknown as BackgroundLoop;
}

let app: express.Express;
let loop: BackgroundLoop | null;
let actionLogRepo: ActionLogRepository;

beforeEach(() => {
  loop = makeLoop();
  actionLogRepo = {
    create: vi.fn(),
    findByResourceAndType: vi.fn(),
    findByStatus: vi.fn(),
    updateStatus: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
  } as unknown as ActionLogRepository;
  app = express();
  app.use(express.json());
  // Inject test userId for all requests (simulates authenticated user)
  app.use((req, _res, next) => {
    req.userId = "test-user";
    next();
  });
  app.use("/api/cycle", createCycleRouter({ getBackgroundLoop: () => loop, actionLogRepo, logger }));
});

describe("GET /api/cycle/status", () => {
  it("returns cycle status when loop is running", async () => {
    const res = await request(app).get("/api/cycle/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      running: true,
      lastCycleAt: "2026-04-18T10:00:00.000Z",
      lastError: null,
      consecutiveErrors: 0,
      enabled: true,
    });
  });

  it("reports enabled=true when loop exists but is currently paused", async () => {
    loop = makeLoop();
    vi.mocked(loop.isRunning).mockReturnValue(false);

    const res = await request(app).get("/api/cycle/status");

    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.enabled).toBe(true);
  });

  it("returns disabled state when loop is null", async () => {
    loop = null;
    const res = await request(app).get("/api/cycle/status");
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.enabled).toBe(false);
  });
});

describe("GET /api/cycle/errors", () => {
  it("returns combined loop and action execution errors sorted by most recent", async () => {
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();

    vi.mocked(loop!.getRecentErrors).mockReturnValue([
      {
        id: "loop-1",
        occurredAt: older,
        component: "classifier",
        stage: "classify",
        userId: "test-user",
        message: "2 classification failures",
      },
    ]);

    vi.mocked(actionLogRepo.findAll).mockReturnValue([
      {
        id: "act-1",
        userId: "test-user",
        resourceId: "item-1",
        actionType: "archive",
        riskLevel: "approval_required",
        status: "approved",
        payloadJson: "{}",
        resultJson: null,
        errorJson: '{"message":"SMTP timeout"}',
        rollbackJson: null,
        createdAt: older,
        updatedAt: now,
      },
    ] as any);

    const res = await request(app).get("/api/cycle/errors");
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(2);
    expect(res.body.errors[0]).toMatchObject({
      component: "actions",
      stage: "execute",
      scope: "action",
      actionId: "act-1",
      message: "SMTP timeout",
      actionHref: "/actions#action-act-1",
    });
    expect(res.body.errors[1]).toMatchObject({
      component: "classifier",
      stage: "classify",
      scope: "global",
      actionId: null,
      actionHref: null,
    });
  });

  it("returns 401 when no userId is present", async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use(
      "/api/cycle",
      createCycleRouter({ getBackgroundLoop: () => loop, actionLogRepo, logger }),
    );

    const res = await request(noAuthApp).get("/api/cycle/errors");
    expect(res.status).toBe(401);
  });

  it("enforces limit query", async () => {
    vi.mocked(loop!.getRecentErrors).mockReturnValue([
      {
        id: "loop-1",
        occurredAt: new Date().toISOString(),
        component: "classifier",
        stage: "classify",
        userId: "test-user",
        message: "1 failure",
      },
    ]);

    vi.mocked(actionLogRepo.findAll).mockReturnValue([
      {
        id: "act-1",
        userId: "test-user",
        resourceId: "item-1",
        actionType: "archive",
        riskLevel: "approval_required",
        status: "approved",
        payloadJson: "{}",
        resultJson: null,
        errorJson: '{"message":"failed"}',
        rollbackJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ] as any);

    const res = await request(app).get("/api/cycle/errors?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
  });

  it("filters by component, stage, and scope", async () => {
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();

    vi.mocked(loop!.getRecentErrors).mockReturnValue([
      {
        id: "loop-1",
        occurredAt: older,
        component: "classifier",
        stage: "classify",
        userId: "test-user",
        message: "classifier failure",
      },
    ]);

    vi.mocked(actionLogRepo.findAll).mockReturnValue([
      {
        id: "act-1",
        userId: "test-user",
        resourceId: "item-1",
        actionType: "archive",
        riskLevel: "approval_required",
        status: "approved",
        payloadJson: "{}",
        resultJson: null,
        errorJson: '{"message":"SMTP timeout"}',
        rollbackJson: null,
        createdAt: older,
        updatedAt: now,
      },
    ] as any);

    const res = await request(app).get(
      "/api/cycle/errors?component=actions&stage=execute&scope=action",
    );
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({
      component: "actions",
      stage: "execute",
      scope: "action",
    });
  });

  it("returns 400 for invalid scope query", async () => {
    const res = await request(app).get("/api/cycle/errors?scope=invalid");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cycle/run-now", () => {
  it("triggers a manual cycle for the authenticated user", async () => {
    const res = await request(app).post("/api/cycle/run-now");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ triggered: true });
    expect(loop!.triggerNow).toHaveBeenCalledWith("test-user");
  });

  it("returns 401 when no userId on request", async () => {
    // Create app without userId middleware
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use(
      "/api/cycle",
      createCycleRouter({ getBackgroundLoop: () => loop, actionLogRepo, logger }),
    );
    const res = await request(noAuthApp).post("/api/cycle/run-now");
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("User not authenticated");
  });

  it("returns 409 when loop is null", async () => {
    loop = null;
    const res = await request(app).post("/api/cycle/run-now");
    expect(res.status).toBe(409);
    expect(res.body.triggered).toBe(false);
  });

  it("returns 409 when loop is not running", async () => {
    loop = makeLoop();
    vi.mocked(loop!.isRunning).mockReturnValue(false);
    const res = await request(app).post("/api/cycle/run-now");
    expect(res.status).toBe(409);
  });

  it("returns 409 when cycle is already in flight", async () => {
    vi.mocked(loop!.triggerNow).mockReturnValue(false);
    const res = await request(app).post("/api/cycle/run-now");
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("A cycle is already in flight");
  });
});
