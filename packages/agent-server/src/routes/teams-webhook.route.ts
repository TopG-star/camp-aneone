import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { InboundItemRepository, Logger } from "@oneon/domain";
import { verifyHmacSignature } from "@oneon/infrastructure";
import { ingestTeamsWebhook } from "@oneon/application";

// ── Payload Schema ───────────────────────────────────────────

export const teamsPayloadSchema = z.object({
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  bodyPreview: z.string().default(""),
  createdDateTime: z.string(),
  channelName: z.string().nullable().default(null),
  teamName: z.string().nullable().default(null),
});

// ── Route ────────────────────────────────────────────────────

export interface TeamsWebhookDeps {
  inboundItemRepo: InboundItemRepository;
  webhookSecret: string;
  logger: Logger;
  resolveUserId?: () => string | null;
}

export function createTeamsWebhookRouter(deps: TeamsWebhookDeps): Router {
  const router = Router();
  const { inboundItemRepo, webhookSecret, logger, resolveUserId } = deps;

  router.post("/", (req: Request, res: Response) => {
    // ── 1. HMAC Signature Verification ────────────────────
    const signature = req.headers["x-webhook-signature"];
    if (typeof signature !== "string") {
      logger.warn("Teams webhook: missing X-Webhook-Signature header");
      res.status(401).json({ error: "Missing signature" });
      return;
    }

    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (!verifyHmacSignature(rawBody, signature, webhookSecret)) {
      logger.warn("Teams webhook: invalid HMAC signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // ── 2. Payload Validation ─────────────────────────────
    const parseResult = teamsPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      );
      logger.warn("Teams webhook: payload validation failed", { errors });
      res.status(400).json({ error: "Invalid payload", details: errors });
      return;
    }

    const payload = parseResult.data;

    // ── 3. Delegate to Use Case ───────────────────────────
    try {
      const { item, wasCreated } = ingestTeamsWebhook(
        { inboundItemRepo, logger, resolveUserId },
        {
          id: payload.id,
          from: payload.from,
          subject: payload.subject,
          bodyPreview: payload.bodyPreview,
          createdDateTime: payload.createdDateTime,
          channelName: payload.channelName,
          teamName: payload.teamName,
        },
      );

      res.status(200).json({
        status: wasCreated ? "created" : "updated",
        id: item.id,
        externalId: item.externalId,
      });
    } catch (error) {
      logger.error("Teams webhook: upsert failed", {
        error: error instanceof Error ? error.message : String(error),
        externalId: payload.id,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
