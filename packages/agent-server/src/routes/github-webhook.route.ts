import { Router, type Request, type Response } from "express";
import type { InboundItemRepository, Logger } from "@oneon/domain";
import {
  githubPRPayloadSchema,
  githubIssuePayloadSchema,
  verifyHmacSignature,
  ACCEPTED_PR_ACTIONS,
  ACCEPTED_ISSUE_ACTIONS,
} from "@oneon/infrastructure";
import { ingestGitHubWebhook } from "@oneon/application";

export interface GitHubWebhookDeps {
  inboundItemRepo: InboundItemRepository;
  webhookSecret: string;
  logger: Logger;
  resolveUserId?: () => string | null;
}

/**
 * GitHub webhook route.
 *
 * Expects the global `express.json({ verify })` middleware to attach `req.rawBody`
 * as a Buffer for HMAC signature verification against exact bytes.
 */
export function createGitHubWebhookRouter(deps: GitHubWebhookDeps): Router {
  const router = Router();
  const { inboundItemRepo, webhookSecret, logger, resolveUserId } = deps;

  router.post("/", (req: Request, res: Response) => {
    // ── 1. HMAC Signature Verification (raw body bytes) ───
    const signatureHeader = req.headers["x-hub-signature-256"];
    if (typeof signatureHeader !== "string") {
      logger.warn("GitHub webhook: missing X-Hub-Signature-256 header");
      res.status(401).json({ error: "Missing signature" });
      return;
    }

    // GitHub sends "sha256=<hex>"; strip the prefix for our verifier
    const signature = signatureHeader.startsWith("sha256=")
      ? signatureHeader.slice(7)
      : signatureHeader;

    // rawBody is attached by express.json({ verify }) in index.ts
    const rawBody: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      logger.warn("GitHub webhook: no raw body available for HMAC verification");
      res.status(400).json({ error: "Missing body" });
      return;
    }

    if (!verifyHmacSignature(rawBody, signature, webhookSecret)) {
      logger.warn("GitHub webhook: invalid HMAC signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // ── 2. Route by X-GitHub-Event header ─────────────────
    const eventType = req.headers["x-github-event"];
    if (typeof eventType !== "string") {
      logger.warn("GitHub webhook: missing X-GitHub-Event header");
      res.status(400).json({ error: "Missing X-GitHub-Event header" });
      return;
    }

    try {
      if (eventType === "ping") {
        logger.info("GitHub webhook: ping received");
        res.status(200).json({ status: "pong" });
        return;
      }
      if (eventType === "pull_request") {
        return handlePullRequest(req.body, inboundItemRepo, logger, res, resolveUserId);
      }
      if (eventType === "issues") {
        return handleIssue(req.body, inboundItemRepo, logger, res, resolveUserId);
      }

      // Unsupported event type — acknowledge receipt
      logger.debug("GitHub webhook: ignoring unsupported event", { eventType });
      res.status(200).json({ status: "ignored", eventType });
    } catch (error) {
      logger.error("GitHub webhook: processing failed", {
        error: error instanceof Error ? error.message : String(error),
        eventType,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

// ── Event Handlers ───────────────────────────────────────────

function handlePullRequest(
  payload: unknown,
  inboundItemRepo: InboundItemRepository,
  logger: Logger,
  res: Response,
  resolveUserId?: () => string | null,
): void {
  const parseResult = githubPRPayloadSchema.safeParse(payload);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    logger.warn("GitHub webhook: PR payload validation failed", { errors });
    res.status(400).json({ error: "Invalid payload", details: errors });
    return;
  }

  const data = parseResult.data;

  // Only process accepted actions
  if (
    !(ACCEPTED_PR_ACTIONS as readonly string[]).includes(data.action)
  ) {
    logger.debug("GitHub webhook: ignoring PR action", { action: data.action });
    res.status(200).json({ status: "ignored", action: data.action });
    return;
  }

  const pr = data.pull_request;
  const { item, wasCreated } = ingestGitHubWebhook(
    { inboundItemRepo, logger, resolveUserId },
    {
      eventType: "pull_request",
      action: data.action,
      externalId: `pr:${data.repository.full_name}#${pr.number}`,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      sender: data.sender.login,
      repo: data.repository.full_name,
      url: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    },
  );

  res.status(200).json({
    status: wasCreated ? "created" : "updated",
    id: item.id,
    externalId: item.externalId,
  });
}

function handleIssue(
  payload: unknown,
  inboundItemRepo: InboundItemRepository,
  logger: Logger,
  res: Response,
  resolveUserId?: () => string | null,
): void {
  const parseResult = githubIssuePayloadSchema.safeParse(payload);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    logger.warn("GitHub webhook: issue payload validation failed", { errors });
    res.status(400).json({ error: "Invalid payload", details: errors });
    return;
  }

  const data = parseResult.data;

  if (
    !(ACCEPTED_ISSUE_ACTIONS as readonly string[]).includes(data.action)
  ) {
    logger.debug("GitHub webhook: ignoring issue action", { action: data.action });
    res.status(200).json({ status: "ignored", action: data.action });
    return;
  }

  const issue = data.issue;
  const { item, wasCreated } = ingestGitHubWebhook(
    { inboundItemRepo, logger, resolveUserId },
    {
      eventType: "issues",
      action: data.action,
      externalId: `issue:${data.repository.full_name}#${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      sender: data.sender.login,
      repo: data.repository.full_name,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    },
  );

  res.status(200).json({
    status: wasCreated ? "created" : "updated",
    id: item.id,
    externalId: item.externalId,
  });
}
