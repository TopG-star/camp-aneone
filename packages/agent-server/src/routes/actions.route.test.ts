import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type {
  InboundItem,
  ActionLogEntry,
  ActionLogRepository,
  InboundItemRepository,
  Logger,
} from "@oneon/domain";
import { createActionsRouter } from "./actions.route.js";

// ── Helpers ──────────────────────────────────────────────────

function makeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "act-001",
    userId: null,
    resourceId: "item-001",
    actionType: "reply_email",
    riskLevel: "approval_required",
    status: "proposed",
    payloadJson: '{"to":"test@example.com"}',
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-18T10:00:00Z",
    updatedAt: "2026-04-18T10:00:00Z",
    ...overrides,
  };
}

function makeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "gmail",
    externalId: "ext-001",
    from: "boss@company.com",
    subject: "Q4 Review",
    bodyPreview: "Please review...",
    receivedAt: "2026-04-18T09:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: "[]",
    classifiedAt: "2026-04-18T09:01:00Z",
    classifyAttempts: 1,
    createdAt: "2026-04-18T09:00:00Z",
    updatedAt: "2026-04-18T09:01:00Z",
    ...overrides,
  };
}

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

let actionLogRepo: ActionLogRepository;
let inboundItemRepo: InboundItemRepository;
let app: express.Express;

beforeEach(() => {
  actionLogRepo = {
    create: vi.fn(),
    findByResourceAndType: vi.fn(),
    findByStatus: vi.fn(),
    updateStatus: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    count: vi.fn().mockReturnValue(0),
  } as unknown as ActionLogRepository;

  inboundItemRepo = {
    findById: vi.fn().mockReturnValue(null),
  } as unknown as InboundItemRepository;

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = "user-A"; next(); });
  app.use("/api/actions", createActionsRouter({ actionLogRepo, inboundItemRepo, logger }));
});

// ── Tests ────────────────────────────────────────────────────

describe("GET /api/actions", () => {
  it("returns empty list", async () => {
    const res = await request(app).get("/api/actions");
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual([]);
    expect(res.body.pagination).toEqual({ limit: 25, offset: 0, total: 0, hasMore: false });
  });

  it("returns enriched actions with itemSubject", async () => {
    const action = makeAction();
    const item = makeItem();
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    vi.mocked(actionLogRepo.count).mockReturnValue(1);
    vi.mocked(inboundItemRepo.findById).mockReturnValue(item);

    const res = await request(app).get("/api/actions");
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0].itemSubject).toBe("Q4 Review");
  });

  it("filters by status", async () => {
    await request(app).get("/api/actions?status=approved");
    expect(actionLogRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", userId: "user-A" }),
    );
  });

  it("returns 400 for invalid limit", async () => {
    const res = await request(app).get("/api/actions?limit=0");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/actions/:id/approve", () => {
  it("approves a proposed action", async () => {
    const action = makeAction({ id: "act-001", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).post("/api/actions/act-001/approve");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "act-001", status: "approved" });
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith("act-001", "approved");
  });

  it("returns 404 for unknown action", async () => {
    vi.mocked(actionLogRepo.findAll).mockReturnValue([]);
    const res = await request(app).post("/api/actions/unknown/approve");
    expect(res.status).toBe(404);
  });

  it("returns 409 for non-proposed action", async () => {
    const action = makeAction({ id: "act-001", status: "executed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    const res = await request(app).post("/api/actions/act-001/approve");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/actions/:id/reject", () => {
  it("rejects a proposed action", async () => {
    const action = makeAction({ id: "act-002", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).post("/api/actions/act-002/reject");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "act-002", status: "rejected" });
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith("act-002", "rejected");
  });

  it("returns 409 for already approved action", async () => {
    const action = makeAction({ id: "act-002", status: "approved" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    const res = await request(app).post("/api/actions/act-002/reject");
    expect(res.status).toBe(409);
  });
});

describe("User isolation", () => {
  it("GET / passes userId to repo calls", async () => {
    await request(app).get("/api/actions");
    expect(actionLogRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-A" }),
    );
    expect(actionLogRepo.count).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-A" }),
    );
  });

  it("approve scopes lookup to authenticated user", async () => {
    const action = makeAction({ id: "act-001", status: "proposed", userId: "user-A" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    await request(app).post("/api/actions/act-001/approve").expect(200);

    expect(actionLogRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-A" }),
    );
  });
});
