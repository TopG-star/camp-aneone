import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import {
  createTeamsWebhookRouter,
  type TeamsWebhookDeps,
} from "./teams-webhook.route.js";
import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

const WEBHOOK_SECRET = "test-teams-webhook-secret";

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

function makeFakeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "teams-item-001",
    userId: "user-A",
    source: "teams",
    externalId: "teams-msg-001",
    from: "alex@example.com",
    subject: "Release sync",
    bodyPreview: "Please review release blockers",
    receivedAt: "2026-05-05T10:00:00Z",
    rawJson: "{}",
    threadId: null,
    labels: '["Engineering","General"]',
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2026-05-05T10:00:00Z",
    updatedAt: "2026-05-05T10:00:00Z",
    ...overrides,
  };
}

function createMockInboundItemRepo(
  overrides: Partial<InboundItemRepository> = {},
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

const VALID_PAYLOAD = {
  id: "teams-msg-001",
  from: "alex@example.com",
  subject: "Release sync",
  bodyPreview: "Please review release blockers",
  createdDateTime: "2026-05-05T10:00:00Z",
  channelName: "General",
  teamName: "Engineering",
};

function buildApp(deps: TeamsWebhookDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/webhooks/teams", createTeamsWebhookRouter(deps));
  return app;
}

describe("POST /api/webhooks/teams", () => {
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
      resolveUserId: () => "user-A",
    });
  });

  describe("signature validation", () => {
    it("returns 401 when signature header is missing", async () => {
      const res = await request(app)
        .post("/api/webhooks/teams")
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing signature");
    });

    it("returns 401 when signature is invalid", async () => {
      const res = await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", "deadbeef".repeat(8))
        .send(VALID_PAYLOAD);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid signature");
    });
  });

  describe("payload validation", () => {
    it("returns 400 when required field is missing", async () => {
      const { id, ...payloadWithoutId } = VALID_PAYLOAD;
      const body = JSON.stringify(payloadWithoutId);
      const signature = sign(body);

      const res = await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid payload");
    });

    it("defaults missing bodyPreview to empty string", async () => {
      const { bodyPreview, ...payloadWithoutBodyPreview } = VALID_PAYLOAD;
      const body = JSON.stringify(payloadWithoutBodyPreview);
      const signature = sign(body);

      const res = await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyPreview: "",
        }),
      );
    });
  });

  describe("successful ingestion", () => {
    it("returns created for new item", async () => {
      const body = JSON.stringify(VALID_PAYLOAD);
      const signature = sign(body);

      const res = await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
      expect(res.body.id).toBe("teams-item-001");
      expect(res.body.externalId).toBe("teams-msg-001");
    });

    it("maps payload to inbound upsert fields", async () => {
      const body = JSON.stringify(VALID_PAYLOAD);
      const signature = sign(body);

      await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-A",
          source: "teams",
          externalId: "teams-msg-001",
          from: "alex@example.com",
          subject: "Release sync",
          bodyPreview: "Please review release blockers",
          receivedAt: "2026-05-05T10:00:00Z",
          threadId: null,
          labels: JSON.stringify(["Engineering", "General"]),
          classifiedAt: null,
          classifyAttempts: 0,
        }),
      );
    });

    it("returns updated when item already exists", async () => {
      (repo.findBySourceAndExternalId as ReturnType<typeof vi.fn>).mockReturnValue(
        makeFakeItem(),
      );

      const body = JSON.stringify(VALID_PAYLOAD);
      const signature = sign(body);

      const res = await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("updated");
    });

    it("stores empty labels when team/channel are missing", async () => {
      const payload = {
        ...VALID_PAYLOAD,
        channelName: null,
        teamName: null,
      };
      const body = JSON.stringify(payload);
      const signature = sign(body);

      await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: "[]",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 when repository upsert throws", async () => {
      (repo.upsert as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB write failed");
      });

      const body = JSON.stringify(VALID_PAYLOAD);
      const signature = sign(body);

      const res = await request(app)
        .post("/api/webhooks/teams")
        .set("X-Webhook-Signature", signature)
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Internal server error");
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
