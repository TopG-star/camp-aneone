import type {
  InboundItemRepository,
  IngestionPort,
  Logger,
} from "@oneon/domain";

export interface IngestGmailDeps {
  ingestionPort: IngestionPort;
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
  userId: string;
}

export interface IngestGmailResult {
  ingested: number;
  duplicates: number;
  errors: number;
}

/**
 * Use case: poll Gmail via the IngestionPort adapter, upsert each
 * fetched message into InboundItemRepository.
 *
 * - Adapter handles: label filtering, seen-ID dedup, sync state
 * - This use case handles: upsert, duplicate counting, error isolation
 * - Existing classification pipeline picks up unclassified items automatically
 */
export async function ingestGmail(
  deps: IngestGmailDeps
): Promise<IngestGmailResult> {
  const { ingestionPort, inboundItemRepo, logger, userId } = deps;

  // Let adapter errors propagate — caller decides retry strategy
  const items = await ingestionPort.fetchNew(userId);

  let ingested = 0;
  let duplicates = 0;
  let errors = 0;

  for (const item of items) {
    // Check if this item already exists (for duplicate counting)
    const existing = inboundItemRepo.findBySourceAndExternalId(
      item.source,
      item.externalId
    );

    try {
      inboundItemRepo.upsert({ ...item, classifiedAt: null });

      if (existing) {
        duplicates++;
      } else {
        ingested++;
      }
    } catch (error) {
      errors++;
      logger.error("Gmail ingestion: upsert failed", {
        externalId: item.externalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("Gmail ingestion complete", { ingested, duplicates, errors });

  return { ingested, duplicates, errors };
}
