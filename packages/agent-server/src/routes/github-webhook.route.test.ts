import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import {
  createGitHubWebhookRouter,
  type GitHubWebhookDeps,
} from "./github-webhook.route.js";
import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-github-webhook-secret";

function signPayload(body: string): string {
  return (
    "sha256=" +
    createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")
  );
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

function makeFakeItem(overrides: Partial<InboundItem> = {}): InboundItem {
  return {
    id: "uuid-gh-001",
    userId: null,
    source: "github",
    externalId: "pr:octocat/hello-world#42",
    from: "octocat",
    subject: "[octocat/hello-world] PR #42: Fix README typo",
    bodyPreview: "Fixed a small typo in the README.",
    receivedAt: "2025-01-20T14:30:00Z",
    rawJson: "{}",
    threadId: "octocat/hello-world#42",
    labels: '["pull_request","opened"]',
    classifiedAt: null,
    classifyAttempts: 0,
    createdAt: "2025-01-20T14:30:00Z",
    updatedAt: "2025-01-20T14:30:00Z",
    ...overrides,
  };
}

// ── Valid Payloads ───────────────────────────────────────────

const VALID_PR_PAYLOAD = {
  action: "opened",
  number: 42,
  pull_request: {
    id: 1001,
    number: 42,
    title: "Fix README typo",
    state: "open",
    user: { login: "octocat" },
    html_url: "https://github.com/octocat/hello-world/pull/42",
    body: "Fixed a small typo in the README.",
    created_at: "2025-01-20T14:00:00Z",
    updated_at: "2025-01-20T14:30:00Z",
  },
  repository: { full_name: "octocat/hello-world" },
  sender: { login: "octocat" },
};

const VALID_ISSUE_PAYLOAD = {
  action: "opened",
  issue: {
    id: 2001,
    number: 10,
    title: "Bug: login fails",
    state: "open",
    user: { login: "contributor" },
    html_url: "https://github.com/octocat/hello-world/issues/10",
    body: "Login fails with error 500.",
    created_at: "2025-01-20T15:00:00Z",
    updated_at: "2025-01-20T15:05:00Z",
  },
  repository: { full_name: "octocat/hello-world" },
  sender: { login: "contributor" },
};

function buildApp(deps: GitHubWebhookDeps): express.Express {
  const app = express();
  // Mirror the production setup: express.json with verify callback to capture raw body
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api/webhooks/github", createGitHubWebhookRouter(deps));
  return app;
}

function sendSigned(
  app: express.Express,
  payload: object,
  options: {
    eventType?: string;
    signature?: string;
    skipSignature?: boolean;
    skipEvent?: boolean;
  } = {},
): request.Test {
  const body = JSON.stringify(payload);
  const sig = options.signature ?? signPayload(body);

  let req = request(app)
    .post("/api/webhooks/github")
    .set("Content-Type", "application/json");

  if (!options.skipSignature) {
    req = req.set("X-Hub-Signature-256", sig);
  }
  if (!options.skipEvent) {
    req = req.set("X-GitHub-Event", options.eventType ?? "pull_request");
  }

  return req.send(body);
}

// ── Tests ────────────────────────────────────────────────────

describe("POST /api/webhooks/github", () => {
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

  // ── Signature Verification ──────────────────────────────

  describe("signature verification", () => {
    it("returns 401 when X-Hub-Signature-256 header is missing", async () => {
      const res = await sendSigned(app, VALID_PR_PAYLOAD, {
        skipSignature: true,
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing signature");
    });

    it("returns 401 when HMAC signature is invalid", async () => {
      const res = await sendSigned(app, VALID_PR_PAYLOAD, {
        signature: "sha256=" + "a".repeat(64),
      });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Invalid signature");
    });

    it("verifies signature against raw body bytes, not re-serialized JSON", async () => {
      // Payload with whitespace that would be lost by JSON.stringify round-trip
      const rawBody = '{"action":  "opened",  "number": 42, "pull_request": {"id": 1001, "number": 42, "title": "Fix README typo", "state": "open", "user": {"login": "octocat"}, "html_url": "https://github.com/octocat/hello-world/pull/42", "body": "Fixed a small typo in the README.", "created_at": "2025-01-20T14:00:00Z", "updated_at": "2025-01-20T14:30:00Z"}, "repository": {"full_name": "octocat/hello-world"}, "sender": {"login": "octocat"}}';
      const sig = signPayload(rawBody);

      const res = await request(app)
        .post("/api/webhooks/github")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", sig)
        .set("X-GitHub-Event", "pull_request")
        .send(rawBody);

      // Signature was computed against the raw bytes (with extra whitespace),
      // and the verify callback captures those exact bytes — so it should pass
      expect(res.status).toBe(200);
    });

    it("strips sha256= prefix before verifying", async () => {
      const body = JSON.stringify(VALID_PR_PAYLOAD);
      const hexOnly = createHmac("sha256", WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      // Send with sha256= prefix — should still verify
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", `sha256=${hexOnly}`)
        .set("X-GitHub-Event", "pull_request")
        .send(body);

      expect(res.status).toBe(200);
    });
  });

  // ── Event Routing ───────────────────────────────────────

  describe("event routing", () => {
    it("returns 400 when X-GitHub-Event header is missing", async () => {
      const res = await sendSigned(app, VALID_PR_PAYLOAD, {
        skipEvent: true,
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing X-GitHub-Event header");
    });

    it("responds to ping event with 200 pong", async () => {
      const res = await sendSigned(app, { zen: "Keep it logically awesome." }, {
        eventType: "ping",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("pong");
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it("returns 200 with ignored status for unsupported event types", async () => {
      const res = await sendSigned(app, VALID_PR_PAYLOAD, {
        eventType: "push",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ignored");
      expect(res.body.eventType).toBe("push");
    });
  });

  // ── Pull Request Events ─────────────────────────────────

  describe("pull_request events", () => {
    it("returns 200 and creates item for valid opened PR", async () => {
      const res = await sendSigned(app, VALID_PR_PAYLOAD, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
      expect(res.body.id).toBe("uuid-gh-001");
      expect(res.body.externalId).toBe("pr:octocat/hello-world#42");
    });

    it("calls inboundItemRepo.upsert with correct mapped data for PR", async () => {
      await sendSigned(app, VALID_PR_PAYLOAD, {
        eventType: "pull_request",
      });

      expect(repo.upsert).toHaveBeenCalledOnce();
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "github",
          externalId: "pr:octocat/hello-world#42",
          from: "octocat",
          subject: "[octocat/hello-world] PR #42: Fix README typo",
        }),
      );
    });

    it("accepts synchronize action", async () => {
      const payload = { ...VALID_PR_PAYLOAD, action: "synchronize" };
      const res = await sendSigned(app, payload, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
    });

    it("accepts ready_for_review action", async () => {
      const payload = { ...VALID_PR_PAYLOAD, action: "ready_for_review" };
      const res = await sendSigned(app, payload, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
    });

    it("accepts reopened action", async () => {
      const payload = { ...VALID_PR_PAYLOAD, action: "reopened" };
      const res = await sendSigned(app, payload, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
    });

    it("ignores closed PR action with 200", async () => {
      const payload = { ...VALID_PR_PAYLOAD, action: "closed" };
      const res = await sendSigned(app, payload, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ignored");
      expect(res.body.action).toBe("closed");
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid PR payload (missing pull_request)", async () => {
      const { pull_request, ...incomplete } = VALID_PR_PAYLOAD;
      const res = await sendSigned(app, incomplete, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid payload");
    });
  });

  // ── Issue Events ────────────────────────────────────────

  describe("issues events", () => {
    it("returns 200 and creates item for valid opened issue", async () => {
      const res = await sendSigned(app, VALID_ISSUE_PAYLOAD, {
        eventType: "issues",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("created");
      expect(res.body.id).toBe("uuid-gh-001");
    });

    it("calls inboundItemRepo.upsert with correct mapped data for issue", async () => {
      await sendSigned(app, VALID_ISSUE_PAYLOAD, {
        eventType: "issues",
      });

      expect(repo.upsert).toHaveBeenCalledOnce();
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "github",
          externalId: "issue:octocat/hello-world#10",
          from: "contributor",
          subject: "[octocat/hello-world] Issue #10: Bug: login fails",
        }),
      );
    });

    it("ignores closed issue action with 200", async () => {
      const payload = { ...VALID_ISSUE_PAYLOAD, action: "closed" };
      const res = await sendSigned(app, payload, {
        eventType: "issues",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ignored");
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid issue payload (missing issue)", async () => {
      const { issue, ...incomplete } = VALID_ISSUE_PAYLOAD;
      const res = await sendSigned(app, incomplete, {
        eventType: "issues",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid payload");
    });
  });

  // ── Idempotency ─────────────────────────────────────────

  describe("idempotency", () => {
    it("returns updated status when item already exists", async () => {
      repo.findBySourceAndExternalId = vi
        .fn()
        .mockReturnValue(makeFakeItem());

      const res = await sendSigned(app, VALID_PR_PAYLOAD, {
        eventType: "pull_request",
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("updated");
    });
  });
});
