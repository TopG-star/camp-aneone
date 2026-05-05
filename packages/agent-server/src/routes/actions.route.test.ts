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

function createApp(manualExecuteRequired = false): express.Express {
  const nextApp = express();
  nextApp.use(express.json());
  nextApp.use((req, _res, next) => { req.userId = "user-A"; next(); });
  nextApp.use(
    "/api/actions",
    createActionsRouter({
      actionLogRepo,
      inboundItemRepo,
      logger,
      manualExecuteRequired,
    }),
  );
  return nextApp;
}

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

  app = createApp();
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
    expect(res.body.actions[0].executionStatus).toBe("not_started");
  });

  it("derives executionStatus from lifecycle and error/result fields", async () => {
    vi.mocked(actionLogRepo.findAll).mockReturnValue([
      makeAction({ id: "act-proposed", status: "proposed", errorJson: null, resultJson: null }),
      makeAction({ id: "act-approved-running", status: "approved", errorJson: null, resultJson: null }),
      makeAction({ id: "act-approved-failed", status: "approved", errorJson: '{"message":"boom"}', resultJson: null }),
      makeAction({ id: "act-executed", status: "executed", errorJson: null, resultJson: '{"ok":true}' }),
    ]);
    vi.mocked(actionLogRepo.count).mockReturnValue(4);

    const res = await request(app).get("/api/actions");
    expect(res.status).toBe(200);

    const byId = new Map(res.body.actions.map((a: { id: string; executionStatus: string }) => [a.id, a.executionStatus]));
    expect(byId.get("act-proposed")).toBe("not_started");
    expect(byId.get("act-approved-running")).toBe("running");
    expect(byId.get("act-approved-failed")).toBe("failed");
    expect(byId.get("act-executed")).toBe("succeeded");
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

describe("GET /api/actions/:id", () => {
  it("returns one enriched action by id", async () => {
    const action = makeAction({ id: "act-100", status: "approved", errorJson: '{"message":"boom"}' });
    const item = makeItem({ id: "item-001", subject: "Escalated follow-up" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    vi.mocked(inboundItemRepo.findById).mockReturnValue(item);

    const res = await request(app).get("/api/actions/act-100");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "act-100",
      status: "approved",
      executionStatus: "failed",
      itemSubject: "Escalated follow-up",
    });
  });

  it("returns 404 when action does not exist", async () => {
    vi.mocked(actionLogRepo.findAll).mockReturnValue([]);

    const res = await request(app).get("/api/actions/missing");
    expect(res.status).toBe(404);
  });

  it("scopes lookup to authenticated user", async () => {
    const action = makeAction({ id: "act-200", userId: "user-A" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).get("/api/actions/act-200");
    expect(res.status).toBe(200);
    expect(actionLogRepo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-A" }),
    );
  });
});

describe("POST /api/actions/:id/approve", () => {
  it("approves and immediately executes when manual execute is not required", async () => {
    const action = makeAction({ id: "act-001", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).post("/api/actions/act-001/approve");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    expect(res.body.executionStatus).toBe("succeeded");
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith(
      "act-001",
      "approved",
      expect.objectContaining({ errorJson: null, resultJson: null }),
    );
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith(
      "act-001",
      "executed",
      expect.objectContaining({ resultJson: expect.any(String), errorJson: null }),
    );
  });

  it("keeps lifecycle approved and marks failed execution when execute step errors", async () => {
    const action = makeAction({ id: "act-001", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    vi.mocked(actionLogRepo.updateStatus).mockImplementation((id, status) => {
      if (id === "act-001" && status === "executed") {
        throw new Error("executor down");
      }
    });

    const res = await request(app).post("/api/actions/act-001/approve");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.executionStatus).toBe("failed");
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith(
      "act-001",
      "approved",
      expect.objectContaining({ errorJson: expect.any(String), resultJson: null }),
    );
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

  it("supports manual execute required mode by skipping auto-execution on approve", async () => {
    const action = makeAction({ id: "act-001", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    app = createApp(true);

    const res = await request(app).post("/api/actions/act-001/approve");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.executionStatus).toBe("running");
    expect(actionLogRepo.updateStatus).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/actions/:id/reject", () => {
  it("rejects a proposed action", async () => {
    const action = makeAction({ id: "act-002", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).post("/api/actions/act-002/reject");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "act-002", status: "rejected", executionStatus: "not_started" });
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith("act-002", "rejected");
  });

  it("returns 409 for already approved action", async () => {
    const action = makeAction({ id: "act-002", status: "approved" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    const res = await request(app).post("/api/actions/act-002/reject");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/actions/:id/retry-execution", () => {
  it("retries an approved action and marks it executed on success", async () => {
    const action = makeAction({
      id: "act-003",
      status: "approved",
      errorJson: '{"message":"transient"}',
      resultJson: null,
    });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).post("/api/actions/act-003/retry-execution");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("executed");
    expect(res.body.executionStatus).toBe("succeeded");
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith(
      "act-003",
      "executed",
      expect.objectContaining({ resultJson: expect.any(String), errorJson: null }),
    );
  });

  it("keeps approved and returns failed executionStatus when retry execution fails", async () => {
    const action = makeAction({ id: "act-003", status: "approved" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);
    vi.mocked(actionLogRepo.updateStatus).mockImplementation((id, status) => {
      if (id === "act-003" && status === "executed") {
        throw new Error("retry failed");
      }
    });

    const res = await request(app).post("/api/actions/act-003/retry-execution");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.executionStatus).toBe("failed");
    expect(actionLogRepo.updateStatus).toHaveBeenCalledWith(
      "act-003",
      "approved",
      expect.objectContaining({ errorJson: expect.any(String), resultJson: null }),
    );
  });

  it("returns 404 for unknown action", async () => {
    vi.mocked(actionLogRepo.findAll).mockReturnValue([]);
    const res = await request(app).post("/api/actions/unknown/retry-execution");
    expect(res.status).toBe(404);
  });

  it("returns 409 when action is not approved", async () => {
    const action = makeAction({ id: "act-003", status: "proposed" });
    vi.mocked(actionLogRepo.findAll).mockReturnValue([action]);

    const res = await request(app).post("/api/actions/act-003/retry-execution");
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
