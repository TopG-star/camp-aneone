import type { InboundItem, PreferenceRepository, Logger } from "@oneon/domain";
import type { IngestionPort } from "@oneon/domain";
import type { GmailHttpClient } from "./gmail-http-client.js";
import type { GmailMessageResource, GmailSkipConfig, ParsedGmailMessage } from "./gmail.types.js";
import { GMAIL_SKIP_LABELS } from "./gmail.types.js";

const SYNC_STATE_PREFIX = "gmail:lastSyncEpoch";

type InboundItemCreate = Omit<InboundItem, "id" | "createdAt" | "updatedAt" | "classifiedAt">;

export interface GmailPollingAdapterConfig {
  client: GmailHttpClient;
  preferenceRepo: PreferenceRepository;
  logger: Logger;
  skipConfig: GmailSkipConfig;
  maxResults: number;
}

/**
 * Implements IngestionPort by polling the Gmail API for new inbox messages.
 *
 * Features:
 * - In-memory seen-ID set to avoid re-fetching within a session (FR-010)
 * - Persistent sync state via PreferenceRepository (`after:` epoch bounding)
 * - Configurable label filtering for promo/social (FR-009)
 * - Requests only metadata headers + snippet for cost control
 */
export class GmailPollingAdapter implements IngestionPort {
  private readonly client: GmailHttpClient;
  private readonly preferenceRepo: PreferenceRepository;
  private readonly logger: Logger;
  private readonly skipConfig: GmailSkipConfig;
  private readonly maxResults: number;
  private readonly seenIds = new Set<string>();

  constructor(config: GmailPollingAdapterConfig) {
    this.client = config.client;
    this.preferenceRepo = config.preferenceRepo;
    this.logger = config.logger;
    this.skipConfig = config.skipConfig;
    this.maxResults = config.maxResults;
  }

  async fetchNew(userId: string): Promise<InboundItemCreate[]> {
    // ── 1. Build query with sync bound ──────────────────────
    const syncStateKey = `${SYNC_STATE_PREFIX}:${userId}`;
    const lastSyncEpoch = this.preferenceRepo.get(syncStateKey);
    const q = lastSyncEpoch ? `after:${lastSyncEpoch}` : undefined;

    // ── 2. List message IDs ─────────────────────────────────
    const listing = await this.client.listMessageIds({
      maxResults: this.maxResults,
      labelIds: ["INBOX"],
      q,
    });

    const messageRefs = listing.messages ?? [];
    if (messageRefs.length === 0) {
      return [];
    }

    // ── 3. Filter out seen IDs (in-memory dedup) ────────────
    const unseenRefs = messageRefs.filter((ref) => !this.seenIds.has(ref.id));
    if (unseenRefs.length === 0) {
      return [];
    }

    // ── 4. Fetch metadata for each unseen message ───────────
    const results: InboundItemCreate[] = [];
    let maxEpochMs = 0;

    for (const ref of unseenRefs) {
      let message: GmailMessageResource;
      try {
        message = await this.client.getMessage(ref.id);
      } catch (error) {
        this.logger.warn("Gmail: message fetch failed", {
          id: ref.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Mark as seen regardless of filter outcome
      this.seenIds.add(ref.id);

      // ── 5. Label filtering (FR-009) ─────────────────────
      if (this.shouldSkip(message)) {
        this.logger.debug("Gmail: message skipped (label filter)", {
          id: message.id,
          labelIds: message.labelIds,
        });
        continue;
      }

      // ── 6. Parse and map to InboundItem shape ───────────
      const parsed = this.parseMessage(message);
      results.push({
        source: "gmail",
        externalId: parsed.id,
        from: parsed.from,
        subject: parsed.subject,
        bodyPreview: parsed.snippet,
        receivedAt: parsed.receivedAt,
        rawJson: JSON.stringify(message),
        threadId: parsed.threadId,
        labels: JSON.stringify(parsed.labelIds),
        classifyAttempts: 0,
        userId,
      });

      // Track latest epoch for sync state
      const epochMs = Number(message.internalDate);
      if (epochMs > maxEpochMs) {
        maxEpochMs = epochMs;
      }
    }

    // ── 7. Persist sync state ─────────────────────────────
    // Gmail's `after:` is EXCLUSIVE (returns messages AFTER the epoch).
    // Subtract 1 second so same-second messages are re-fetched on next poll.
    // The in-memory seen-ID set deduplicates them within a session.
    if (maxEpochMs > 0) {
      const epochSeconds = Math.floor(maxEpochMs / 1000) - 1;
      this.preferenceRepo.set(syncStateKey, String(epochSeconds));
    }

    return results;
  }

  private shouldSkip(message: GmailMessageResource): boolean {
    const labels = message.labelIds ?? [];

    if (
      this.skipConfig.skipPromotions &&
      labels.includes(GMAIL_SKIP_LABELS.CATEGORY_PROMOTIONS)
    ) {
      return true;
    }

    if (
      this.skipConfig.skipSocial &&
      labels.includes(GMAIL_SKIP_LABELS.CATEGORY_SOCIAL)
    ) {
      return true;
    }

    return false;
  }

  private parseMessage(message: GmailMessageResource): ParsedGmailMessage {
    const headers = message.payload?.headers ?? [];

    const fromHeader = headers.find((h) => h.name === "From");
    const toHeader = headers.find((h) => h.name === "To");
    const subjectHeader = headers.find((h) => h.name === "Subject");
    const messageIdHeader = headers.find((h) => h.name === "Message-Id");

    const epochMs = Number(message.internalDate);
    const receivedAt = new Date(epochMs).toISOString();

    return {
      id: message.id,
      threadId: message.threadId,
      from: fromHeader?.value ?? "",
      to: toHeader?.value ?? "",
      subject: subjectHeader?.value ?? "(no subject)",
      snippet: message.snippet ?? "",
      receivedAt,
      messageId: messageIdHeader?.value ?? "",
      labelIds: message.labelIds ?? [],
    };
  }
}
