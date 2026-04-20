import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { createOutlookWebhookRouter, type OutlookWebhookDeps } from "./outlook-webhook.route.js";
import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-webhook-secret-key-for-hmac";

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockInboundItemRepo(
  overrides: Partial<InboundItemRepository> = {}
): InboundItemRepository {
  return {
    upsert: vi.fn().mockReturnValue(makeFakeItem()),
    findById: vi.fn().mockReturnValue(null),
    findBySourceAndExternalId: vi.fn().mockReturnValue(null),
    findUnclassified: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    markClassified: vi.fn(),
    incrementClassifyAttempts: vi.fn(),
    count: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

function makeFakeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "uuid-001",
    userId: null,
    source: "outlook",
    externalId: "AAMkAGI123",
    from: "boss@company.com",
    subject: "Q4 Review",
    bodyPreview: "Please review the Q4 numbers.",
    receivedAt: "2025-01-15T10:00:00Z",
    rawJson: "{}",
    threadId: "AAQkAGI456",
    labels: "[]",
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2025-01-15T10:00:00Z",
    updatedAt: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

const VALID_PAYLOAD = {
  id: "AAMkAGI123",
  from: "boss@company.com",
  subject: "Q4 Review",
  bodyPreview: "Please review the Q4 numbers.",
  receivedDateTime: "2025-01-15T10:00:00Z",
  conversationId: "AAQkAGI456",
  categories: ["CATEGORY_PROMOTIONS"],
};

function buildApp(deps: OutlookWebhookDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/webhooks/outlook", createOutlookWebhookRouter(deps));
  return app;
}

// ── Tests ────────────────────────────────────────────────────

describe("POST /api/webhooks/outlook", () => {
  let logger: Logger;
  let repo: InboundItemRepository;
  let app: express.Express;

  beforeEach(() => {
    logger = createMockLogger();
    repo = createMockInboundItemRepo();
    app = buildApp({
      inboundItemRepo: repo,
      webhookSecret: WEBHOOK_SECRET,
      logger,
    });
  });

  // ── Auth: Missing Signature ─────────────────────────────

  describe("signature validation", () => {
    it("returns 401 when X-Webhook-Signature header is missing", async () => {
      const res = await request(app)
        .post("/api/webhooks/outlook")
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing signature");
    });

    it("returns 401 when signature is invalid", async () => {
      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", "deadbeef".repeat(8))
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid signature");
    });

    it("returns 401 when signature is for a different body", async () => {
      const tampered = { ...VALID_PAYLOAD, subject: "Tampered!" };
      const body = JSON.stringify(VALID_PAYLOAD); // sign the original
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(JSON.stringify(tampered));

      expect(res.status).toBe(401);
    });
  });

  // ── Payload Validation ──────────────────────────────────

  describe("payload validation", () => {
    it("returns 400 for invalid payload (missing id)", async () => {
      const { id, ...noId } = VALID_PAYLOAD;
      const body = JSON.stringify(noId);
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid payload");
    });

    it("returns 400 for invalid payload (missing receivedDateTime)", async () => {
      const { receivedDateTime, ...noDate } = VALID_PAYLOAD;
      const body = JSON.stringify(noDate);
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(400);
    });
  });

  // ── Successful Ingestion ────────────────────────────────

  describe("successful ingestion", () => {
    it("returns 200 with item id when payload is valid and new", async () => {
      const body = JSON.stringify(VALID_PAYLOAD);
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
      expect(res.body.id).toBe("uuid-001");
      expect(res.body.externalId).toBe("AAMkAGI123");
    });

    it("calls inboundItemRepo.upsert with correct mapped data", async () => {
      const body = JSON.stringify(VALID_PAYLOAD);
      const sig = sign(body);

      await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(repo.upsert).toHaveBeenCalledOnce();
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "outlook",
          externalId: "AAMkAGI123",
          from: "boss@company.com",
          subject: "Q4 Review",
          bodyPreview: "Please review the Q4 numbers.",
          receivedAt: "2025-01-15T10:00:00Z",
          threadId: "AAQkAGI456",
          labels: JSON.stringify(["CATEGORY_PROMOTIONS"]),
          classifiedAt: null,
        })
      );
    });

    it("returns status 'updated' when item already exists", async () => {
      // Mock findBySourceAndExternalId to return existing item (not null)
      (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(
        makeFakeItem()
      );

      const body = JSON.stringify(VALID_PAYLOAD);
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("updated");
    });

    it("handles Graph-style from object", async () => {
      const payloadWithGraphFrom = {
        ...VALID_PAYLOAD,
        from: {
          emailAddress: {
            name: "Boss Name",
            address: "boss@company.com",
          },
        },
      };
      const body = JSON.stringify(payloadWithGraphFrom);
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ from: "boss@company.com" })
      );
    });

    it("handles missing optional fields with defaults", async () => {
      const minimalPayload = {
        id: "AAMkAGI999",
        from: "someone@test.com",
        receivedDateTime: "2025-06-01T08:00:00Z",
      };
      const body = JSON.stringify(minimalPayload);
      const sig = sign(body);

      (repo.upsert as ReturnType<typeof vi.fn>).mockReturnValue(
        makeFakeItem({ externalId: "AAMkAGI999" })
      );

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "(no subject)",
          bodyPreview: "",
          labels: "[]",
          threadId: null,
        })
      );
    });
  });

  // ── Idempotency ─────────────────────────────────────────

  describe("idempotency", () => {
    it("calling twice with same external_id does not create duplicates", async () => {
      const body = JSON.stringify(VALID_PAYLOAD);
      const sig = sign(body);
      const headers = {
        "X-Webhook-Signature": sig,
        "Content-Type": "application/json",
      };

      // First call — item is new
      (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);
      await request(app).post("/api/webhooks/outlook").set(headers).send(body);

      // Second call — item already exists
      (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        makeFakeItem()
      );
      const res2 = await request(app).post("/api/webhooks/outlook").set(headers).send(body);

      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe("updated");
      // upsert is called both times (ON CONFLICT DO UPDATE), but no duplicate rows
      expect(repo.upsert).toHaveBeenCalledTimes(2);
    });
  });

  // ── Error Handling ──────────────────────────────────────

  describe("error handling", () => {
    it("returns 500 when upsert throws", async () => {
      (repo.upsert as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB write failed");
      });

      const body = JSON.stringify(VALID_PAYLOAD);
      const sig = sign(body);

      const res = await request(app)
        .post("/api/webhooks/outlook")
        .set("X-Webhook-Signature", sig)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Internal server error");
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
