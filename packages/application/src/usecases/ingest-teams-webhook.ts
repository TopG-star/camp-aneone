import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

export interface TeamsWebhookPayload {
  id: string;
  from: string;
  subject: string;
  bodyPreview: string;
  createdDateTime: string;
  channelName: string | null;
  teamName: string | null;
}

export interface IngestTeamsWebhookResult {
  item: InboundItem;
  wasCreated: boolean;
}

export interface IngestTeamsWebhookDeps {
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
  /** Optional callback that resolves a userId for the ingested item. */
  resolveUserId?: () => string | null;
}

/**
 * Maps a validated Teams webhook payload to an InboundItem and upserts it.
 * Idempotent: calling twice with the same payload returns the same item.
 */
export function ingestTeamsWebhook(
  deps: IngestTeamsWebhookDeps,
  payload: TeamsWebhookPayload,
): IngestTeamsWebhookResult {
  const { inboundItemRepo, logger } = deps;

  const existing = inboundItemRepo.findBySourceAndExternalId("teams", payload.id);

  const labels: string[] = [];
  if (payload.teamName) labels.push(payload.teamName);
  if (payload.channelName) labels.push(payload.channelName);

  const userId = deps.resolveUserId?.() ?? null;

  const item = inboundItemRepo.upsert({
    userId,
    source: "teams",
    externalId: payload.id,
    from: payload.from,
    subject: payload.subject,
    bodyPreview: payload.bodyPreview,
    receivedAt: payload.createdDateTime,
    rawJson: JSON.stringify(payload),
    threadId: null,
    labels: JSON.stringify(labels),
    classifiedAt: null,
    classifyAttempts: 0,
  });

  logger.info("Teams webhook: item ingested", {
    id: item.id,
    externalId: item.externalId,
    from: item.from,
    wasCreated: !existing,
  });

  return { item, wasCreated: !existing };
}
