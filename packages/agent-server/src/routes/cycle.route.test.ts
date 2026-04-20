import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Logger } from "@oneon/domain";
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
    lastCycleAt: "2026-04-18T10:00:00.000Z",
    lastError: null,
    errorCount: 0,
    isCycleInFlight: false,
    ...overrides,
  } as unknown as BackgroundLoop;
}

let app: express.Express;
let loop: BackgroundLoop | null;

beforeEach(() => {
  loop = makeLoop();
  app = express();
  app.use(express.json());
  // Inject test userId for all requests (simulates authenticated user)
  app.use((req, _res, next) => {
    req.userId = "test-user";
    next();
  });
  app.use("/api/cycle", createCycleRouter({ getBackgroundLoop: () => loop, logger }));
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

  it("returns disabled state when loop is null", async () => {
    loop = null;
    const res = await request(app).get("/api/cycle/status");
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.enabled).toBe(false);
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
    noAuthApp.use("/api/cycle", createCycleRouter({ getBackgroundLoop: () => loop, logger }));
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
