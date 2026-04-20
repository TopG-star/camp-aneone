import type { InboundItem, InboundItemRepository, Logger } from "@oneon/domain";

export interface GitHubWebhookPayload {
  eventType: "pull_request" | "issues";
  action: string;
  externalId: string;
  number: number;
  title: string;
  body: string | null;
  sender: string;
  repo: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface IngestGitHubWebhookResult {
  item: InboundItem;
  wasCreated: boolean;
}

export interface IngestGitHubWebhookDeps {
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
  /** Optional callback that resolves a userId for the ingested item. */
  resolveUserId?: () => string | null;
}

/**
 * Pure use case: maps a validated GitHub webhook payload to an InboundItem
 * and upserts it. Returns the upserted item and whether it was newly created.
 *
 * - Idempotent: calling twice with the same payload returns the same item
 * - The externalId encodes event type + number + repo for uniqueness
 */
export function ingestGitHubWebhook(
  deps: IngestGitHubWebhookDeps,
  payload: GitHubWebhookPayload,
): IngestGitHubWebhookResult {
  const { inboundItemRepo, logger } = deps;

  const existing = inboundItemRepo.findBySourceAndExternalId(
    "github",
    payload.externalId,
  );

  const subject = `[${payload.repo}] ${payload.eventType === "pull_request" ? "PR" : "Issue"} #${payload.number}: ${payload.title}`;

  const userId = deps.resolveUserId?.() ?? null;

  const item = inboundItemRepo.upsert({
    userId,
    source: "github",
    externalId: payload.externalId,
    from: payload.sender,
    subject,
    bodyPreview: payload.body?.slice(0, 500) ?? "",
    receivedAt: payload.updatedAt,
    rawJson: JSON.stringify(payload),
    threadId: `${payload.repo}#${payload.number}`,
    labels: JSON.stringify([payload.eventType, payload.action]),
    classifiedAt: null,
    classifyAttempts: 0,
  });

  logger.info("GitHub webhook: item ingested", {
    id: item.id,
    externalId: item.externalId,
    eventType: payload.eventType,
    action: payload.action,
    repo: payload.repo,
    number: payload.number,
    wasCreated: existing === null,
  });

  return {
    item,
    wasCreated: existing === null,
  };
}
