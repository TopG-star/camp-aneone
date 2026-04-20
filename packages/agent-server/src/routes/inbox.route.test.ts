import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type {
  InboundItem,
  Classification,
  Deadline,
  ActionLogEntry,
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  ActionLogRepository,
  Logger,
} from "@oneon/domain";
import { createInboxRouter, type InboxRouteDeps } from "./inbox.route.js";

// ── Helpers ──────────────────────────────────────────────────

function makeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "item-001",
    userId: null,
    source: "gmail",
    externalId: "ext-001",
    from: "boss@company.com",
    subject: "Q4 Review",
    bodyPreview: "Please review the Q4 numbers...",
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

function makeClassification(
  overrides: Partial<Classification> = {},
): Classification {
  return {
    id: "cls-001",
    userId: null,
    inboundItemId: "item-001",
    category: "urgent",
    priority: 1,
    summary: "Q4 numbers need review",
    actionItems: "[]",
    followUpNeeded: true,
    model: "claude-3-5-haiku",
    promptVersion: "v1",
    createdAt: "2026-04-18T09:01:00Z",
    ...overrides,
  };
}

function makeDeadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "dl-001",
    userId: null,
    inboundItemId: "item-001",
    dueDate: "2026-04-25T00:00:00Z",
    description: "Submit Q4 review",
    confidence: 0.85,
    status: "open",
    createdAt: "2026-04-18T09:01:00Z",
    updatedAt: "2026-04-18T09:01:00Z",
    ...overrides,
  };
}

function makeAction(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "act-001",
    userId: null,
    resourceId: "item-001",
    actionType: "draft_reply",
    riskLevel: "approval_required",
    status: "proposed",
    payloadJson: "{}",
    resultJson: null,
    errorJson: null,
    rollbackJson: null,
    createdAt: "2026-04-18T09:02:00Z",
    updatedAt: "2026-04-18T09:02:00Z",
    ...overrides,
  };
}

function createMockRepos() {
  return {
    inboundItemRepo: {
      upsert: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      findBySourceAndExternalId: vi.fn(),
      findUnclassified: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      search: vi.fn().mockReturnValue([]),
      markClassified: vi.fn(),
      incrementClassifyAttempts: vi.fn(),
      count: vi.fn().mockReturnValue(0),
    } satisfies InboundItemRepository,
    classificationRepo: {
      create: vi.fn(),
      findByInboundItemId: vi.fn().mockReturnValue(null),
      findAll: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    } satisfies ClassificationRepository,
    deadlineRepo: {
      create: vi.fn(),
      findByInboundItemId: vi.fn().mockReturnValue([]),
      findByDateRange: vi.fn().mockReturnValue([]),
      findOverdue: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      count: vi.fn().mockReturnValue(0),
    } satisfies DeadlineRepository,
    actionLogRepo: {
      create: vi.fn(),
      findByResourceAndType: vi.fn(),
      findByStatus: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
    } satisfies ActionLogRepository,
  };
}

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function buildApp(deps: InboxRouteDeps, userId = "user-A"): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = userId; next(); });
  app.use("/api/inbox", createInboxRouter(deps));
  return app;
}

// ── Tests ────────────────────────────────────────────────────

describe("Inbox routes", () => {
  let repos: ReturnType<typeof createMockRepos>;
  let logger: Logger;
  let app: express.Express;

  beforeEach(() => {
    repos = createMockRepos();
    logger = createMockLogger();
    app = buildApp({ ...repos, logger });
  });

  // ── GET /api/inbox ─────────────────────────────────────────

  describe("GET /api/inbox", () => {
    it("returns empty list when no items", async () => {
      const res = await request(app).get("/api/inbox").expect(200);

      expect(res.body.items).toEqual([]);
      expect(res.body.pagination).toEqual({
        limit: 25,
        offset: 0,
        total: 0,
        hasMore: false,
      });
    });

    it("returns enriched items with classification data", async () => {
      const item = makeItem();
      const cls = makeClassification();
      vi.mocked(repos.inboundItemRepo.findAll).mockReturnValue([item]);
      vi.mocked(repos.inboundItemRepo.count).mockReturnValue(1);
      vi.mocked(repos.classificationRepo.findByInboundItemId).mockReturnValue(cls);

      const res = await request(app).get("/api/inbox").expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe("item-001");
      expect(res.body.items[0].classification.category).toBe("urgent");
      expect(res.body.items[0].classification.priority).toBe(1);
    });

    it("respects limit and offset query params", async () => {
      vi.mocked(repos.inboundItemRepo.findAll).mockReturnValue([]);
      vi.mocked(repos.inboundItemRepo.count).mockReturnValue(50);

      const res = await request(app)
        .get("/api/inbox?limit=10&offset=20")
        .expect(200);

      expect(repos.inboundItemRepo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20, userId: "user-A" }),
      );
      expect(res.body.pagination).toEqual({
        limit: 10,
        offset: 20,
        total: 50,
        hasMore: true,
      });
    });

    it("filters by source", async () => {
      await request(app).get("/api/inbox?source=github").expect(200);

      expect(repos.inboundItemRepo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ source: "github", userId: "user-A" }),
      );
    });

    it("filters by category (post-classification)", async () => {
      const item = makeItem();
      const cls = makeClassification({ category: "work" });
      vi.mocked(repos.inboundItemRepo.findAll).mockReturnValue([item]);
      vi.mocked(repos.inboundItemRepo.count).mockReturnValue(1);
      vi.mocked(repos.classificationRepo.findByInboundItemId).mockReturnValue(cls);

      const res = await request(app)
        .get("/api/inbox?category=urgent")
        .expect(200);

      // Item has category "work" but filter is "urgent" → filtered out
      expect(res.body.items).toHaveLength(0);
    });

    it("filters by maxPriority", async () => {
      const item = makeItem();
      const cls = makeClassification({ priority: 4 });
      vi.mocked(repos.inboundItemRepo.findAll).mockReturnValue([item]);
      vi.mocked(repos.inboundItemRepo.count).mockReturnValue(1);
      vi.mocked(repos.classificationRepo.findByInboundItemId).mockReturnValue(cls);

      const res = await request(app)
        .get("/api/inbox?maxPriority=2")
        .expect(200);

      // Item has priority 4, maxPriority filter is 2 → filtered out
      expect(res.body.items).toHaveLength(0);
    });

    it("returns items without classification (classification: null)", async () => {
      const item = makeItem({ classifiedAt: null });
      vi.mocked(repos.inboundItemRepo.findAll).mockReturnValue([item]);
      vi.mocked(repos.inboundItemRepo.count).mockReturnValue(1);
      vi.mocked(repos.classificationRepo.findByInboundItemId).mockReturnValue(null);

      const res = await request(app).get("/api/inbox").expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].classification).toBeNull();
    });

    it("rejects invalid limit value", async () => {
      await request(app).get("/api/inbox?limit=999").expect(400);
    });
  });

  // ── GET /api/inbox/:id ─────────────────────────────────────

  describe("GET /api/inbox/:id", () => {
    it("returns 404 for non-existent item", async () => {
      const res = await request(app)
        .get("/api/inbox/nonexistent")
        .expect(404);

      expect(res.body.error).toBe("Item not found");
    });

    it("returns 404 when item belongs to another user", async () => {
      const item = makeItem({ userId: "user-B" });
      vi.mocked(repos.inboundItemRepo.findById).mockReturnValue(item);

      const res = await request(app)
        .get("/api/inbox/item-001")
        .expect(404);

      expect(res.body.error).toBe("Item not found");
    });

    it("returns enriched item with deadlines and actions", async () => {
      const item = makeItem({ userId: "user-A" });
      const cls = makeClassification();
      const deadline = makeDeadline();
      const action = makeAction();

      vi.mocked(repos.inboundItemRepo.findById).mockReturnValue(item);
      vi.mocked(repos.classificationRepo.findByInboundItemId).mockReturnValue(cls);
      vi.mocked(repos.deadlineRepo.findByInboundItemId).mockReturnValue([deadline]);
      vi.mocked(repos.actionLogRepo.findAll).mockReturnValue([action]);

      const res = await request(app)
        .get("/api/inbox/item-001")
        .expect(200);

      expect(res.body.id).toBe("item-001");
      expect(res.body.classification.category).toBe("urgent");
      expect(res.body.deadlines).toHaveLength(1);
      expect(res.body.deadlines[0].dueDate).toBe("2026-04-25T00:00:00Z");
      expect(res.body.actions).toHaveLength(1);
      expect(res.body.actions[0].actionType).toBe("draft_reply");
    });

    it("returns item with no classification", async () => {
      const item = makeItem({ classifiedAt: null, userId: "user-A" });
      vi.mocked(repos.inboundItemRepo.findById).mockReturnValue(item);
      vi.mocked(repos.classificationRepo.findByInboundItemId).mockReturnValue(null);
      vi.mocked(repos.deadlineRepo.findByInboundItemId).mockReturnValue([]);
      vi.mocked(repos.actionLogRepo.findAll).mockReturnValue([]);

      const res = await request(app)
        .get("/api/inbox/item-001")
        .expect(200);

      expect(res.body.classification).toBeNull();
      expect(res.body.deadlines).toEqual([]);
      expect(res.body.actions).toEqual([]);
    });
  });

  // ── A/B Isolation ──────────────────────────────────────────

  describe("User isolation", () => {
    it("GET / only returns items for the authenticated user", async () => {
      const itemA = makeItem({ id: "a1", userId: "user-A" });
      vi.mocked(repos.inboundItemRepo.findAll).mockReturnValue([itemA]);
      vi.mocked(repos.inboundItemRepo.count).mockReturnValue(1);

      const res = await request(app).get("/api/inbox").expect(200);

      expect(repos.inboundItemRepo.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-A" }),
      );
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].id).toBe("a1");
    });

    it("GET /:id denies access to another user's item", async () => {
      const item = makeItem({ id: "b1", userId: "user-B" });
      vi.mocked(repos.inboundItemRepo.findById).mockReturnValue(item);

      await request(app).get("/api/inbox/b1").expect(404);
    });
  });
});
