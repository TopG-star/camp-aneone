import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

export interface OutlookWebhookPayload {
  id: string;
  from: string;
  subject: string;
  bodyPreview: string;
  receivedDateTime: string;
  conversationId: string | null;
  categories: string[];
}

export interface IngestOutlookWebhookResult {
  item: InboundItem;
  wasCreated: boolean;
}

export interface IngestOutlookWebhookDeps {
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
  /** Optional callback that resolves a userId for the ingested item. */
  resolveUserId?: () => string | null;
}

/**
 * Pure use case: maps a validated Outlook webhook payload to an InboundItem
 * and upserts it. Returns the upserted item and whether it was newly created.
 *
 * - Idempotent: calling twice with the same payload returns the same item
 * - Append-only: existing items get updated fields, never deleted
 */
export function ingestOutlookWebhook(
  deps: IngestOutlookWebhookDeps,
  payload: OutlookWebhookPayload
): IngestOutlookWebhookResult {
  const { inboundItemRepo, logger } = deps;

  // Check if this item already exists (for wasCreated flag)
  const existing = inboundItemRepo.findBySourceAndExternalId(
    "outlook",
    payload.id
  );

  const userId = deps.resolveUserId?.() ?? null;

  const item = inboundItemRepo.upsert({
    userId,
    source: "outlook",
    externalId: payload.id,
    from: payload.from,
    subject: payload.subject,
    bodyPreview: payload.bodyPreview,
    receivedAt: payload.receivedDateTime,
    rawJson: JSON.stringify(payload),
    threadId: payload.conversationId,
    labels: JSON.stringify(payload.categories),
    classifiedAt: null,
    classifyAttempts: 0,
  });

  logger.info("Outlook webhook: item ingested", {
    id: item.id,
    externalId: item.externalId,
    from: item.from,
    subject: item.subject,
    wasCreated: existing === null,
  });

  return {
    item,
    wasCreated: existing === null,
  };
}
