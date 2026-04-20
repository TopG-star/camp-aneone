import { Router, type Request, type Response } from "express";
import type { InboundItemRepository, Logger } from "@oneon/domain";
import {
  outlookPayloadSchema,
  extractSenderEmail,
  verifyHmacSignature,
} from "@oneon/infrastructure";
import { ingestOutlookWebhook } from "@oneon/application";

export interface OutlookWebhookDeps {
  inboundItemRepo: InboundItemRepository;
  webhookSecret: string;
  logger: Logger;
  resolveUserId?: () => string | null;
}

export function createOutlookWebhookRouter(deps: OutlookWebhookDeps): Router {
  const router = Router();
  const { inboundItemRepo, webhookSecret, logger, resolveUserId } = deps;

  router.post("/", (req: Request, res: Response) => {
    // ── 1. HMAC Signature Verification ────────────────────
    const signature = req.headers["x-webhook-signature"];
    if (typeof signature !== "string") {
      logger.warn("Outlook webhook: missing X-Webhook-Signature header");
      res.status(401).json({ error: "Missing signature" });
      return;
    }

    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (!verifyHmacSignature(rawBody, signature, webhookSecret)) {
      logger.warn("Outlook webhook: invalid HMAC signature");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // ── 2. Payload Validation ─────────────────────────────
    const parseResult = outlookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`
      );
      logger.warn("Outlook webhook: payload validation failed", { errors });
      res.status(400).json({ error: "Invalid payload", details: errors });
      return;
    }

    const payload = parseResult.data;

    // ── 3. Delegate to Use Case ───────────────────────────
    try {
      const senderEmail = extractSenderEmail(payload.from);

      const { item, wasCreated } = ingestOutlookWebhook(
        { inboundItemRepo, logger, resolveUserId },
        {
          id: payload.id,
          from: senderEmail,
          subject: payload.subject,
          bodyPreview: payload.bodyPreview,
          receivedDateTime: payload.receivedDateTime,
          conversationId: payload.conversationId ?? null,
          categories: payload.categories,
        }
      );

      res.status(200).json({
        status: wasCreated ? "created" : "updated",
        id: item.id,
        externalId: item.externalId,
      });
    } catch (error) {
      logger.error("Outlook webhook: upsert failed", {
        error: error instanceof Error ? error.message : String(error),
        externalId: payload.id,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
