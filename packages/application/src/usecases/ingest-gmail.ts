import type {
  BankStatementRepository,
  InboundItemRepository,
  IngestionPort,
  Logger,
} from "@oneon/domain";

export interface BankStatementIntakeConfig {
  repository: BankStatementRepository;
  senderAllowlist: string[];
  subjectKeywords: string[];
  detectionRuleVersion: string;
}

export interface IngestGmailDeps {
  ingestionPort: IngestionPort;
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
  userId: string;
  bankStatementIntake?: BankStatementIntakeConfig;
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
  const {
    ingestionPort,
    inboundItemRepo,
    logger,
    userId,
    bankStatementIntake,
  } = deps;

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

      if (
        bankStatementIntake &&
        isBankStatementCandidate(item.from, item.subject, bankStatementIntake)
      ) {
        try {
          const existingStatement =
            bankStatementIntake.repository.findBySourceAndExternalId(
              item.source,
              item.externalId,
              userId,
            );

          const statement = bankStatementIntake.repository.upsert({
            userId,
            source: item.source,
            externalId: item.externalId,
            messageId: extractMessageId(item.externalId, item.rawJson),
            threadId: extractThreadId(item.threadId, item.rawJson),
            sender: item.from,
            senderDomain: extractSenderDomain(item.from),
            subject: item.subject,
            receivedAt: item.receivedAt,
            status: "discovered",
            detectionRuleVersion: bankStatementIntake.detectionRuleVersion,
          });

          if (existingStatement) {
            bankStatementIntake.repository.markSkippedDuplicate(
              existingStatement.id,
            );
          } else {
            bankStatementIntake.repository.markQueuedForParse(statement.id);
          }
        } catch (error) {
          logger.error("Gmail ingestion: bank statement intake failed", {
            externalId: item.externalId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

function isBankStatementCandidate(
  from: string,
  subject: string,
  config: BankStatementIntakeConfig,
): boolean {
  const senderDomain = extractSenderDomain(from);
  const allowlist = new Set(
    config.senderAllowlist.map((entry) => entry.trim().toLowerCase())
  );

  if (!senderDomain || !allowlist.has(senderDomain)) {
    return false;
  }

  const normalizedSubject = subject.toLowerCase();
  return config.subjectKeywords.some((keyword) =>
    normalizedSubject.includes(keyword.trim().toLowerCase())
  );
}

function extractSenderDomain(from: string): string {
  const emailMatch = from.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/i);
  return emailMatch ? emailMatch[1].toLowerCase() : "";
}

function extractMessageId(externalId: string, rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as { id?: string };
    return parsed.id ?? externalId;
  } catch {
    return externalId;
  }
}

function extractThreadId(
  defaultThreadId: string | null,
  rawJson: string,
): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { threadId?: string };
    return parsed.threadId ?? defaultThreadId;
  } catch {
    return defaultThreadId;
  }
}
