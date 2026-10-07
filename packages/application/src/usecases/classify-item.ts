import type {
  InboundItem,
  Classification,
  Deadline,
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  TransactionRunner,
  Logger,
} from "@oneon/domain";
import type { ModelGateway } from "../ai-boundary/gateway.js";
import type { DenyReason } from "../ai-boundary/decide.js";
import type { ClassificationOutput } from "../ai-boundary/purposes/schemas.js";
import { emailClassificationRequest } from "../ai-boundary/requests/email.js";

export interface ClassifyItemDeps {
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
  deadlineRepo: DeadlineRepository;
  transactionRunner: TransactionRunner;
  modelGateway: ModelGateway;
  logger: Logger;
  /** Model name to record, e.g. "claude-3-5-haiku-20241022" */
  classifierModel: string;
  /** Prompt version identifier, e.g. "v1" */
  promptVersion: string;
}

/**
 * Deny reasons tied to the item's own content. Retrying cannot change them, so each counts a classify attempt and
 * maxAttempts eventually skips the item. Other reasons (provider_unavailable, invalid_context, unknown_purpose) are
 * global and count none.
 */
export const ITEM_SPECIFIC_DENY_REASONS: readonly DenyReason[] = ["secret_present", "required_part_withheld", "masked_value_present"];

/**
 * The AI data policy does not allow this call (spec §10.3). The item stays unclassified; `reason` tells the caller
 * why, and an attempt was counted only for an item-specific reason.
 */
export class ClassificationPausedError extends Error {
  constructor(readonly reason: DenyReason) {
    super(`Email classification paused by AI data policy: ${reason}`);
    this.name = "ClassificationPausedError";
  }
}

export interface ClassifyItemResult {
  classification: Classification;
  deadlines: Deadline[];
}

/**
 * Classifies a single InboundItem via the model gateway and persists the results
 * (classification + deadlines + markClassified) in a single transaction.
 *
 * Throws ClassificationPausedError when the gateway denies the call, counting an attempt only for an
 * item-specific reason. On LLM or persistence failure, increments classifyAttempts so the item
 * can be retried later up to a configured maximum.
 */
export async function classifyItem(
  deps: ClassifyItemDeps,
  item: InboundItem
): Promise<ClassifyItemResult> {
  const {
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    transactionRunner,
    modelGateway,
    logger,
    classifierModel,
    promptVersion,
  } = deps;

  let llmResult: ClassificationOutput;
  try {
    const result = await modelGateway
      .beginTurn({ kind: "personal", identityId: item.userId ?? "" }, { channel: "background" })
      .call(emailClassificationRequest(item));
    if (result.kind === "denied") {
      logger.info("Email classification denied by AI data policy", { itemId: item.id, reason: result.reason });
      if (ITEM_SPECIFIC_DENY_REASONS.includes(result.reason)) inboundItemRepo.incrementClassifyAttempts(item.id);
      throw new ClassificationPausedError(result.reason);
    }
    if (result.kind !== "answered") throw new Error(`Classification ${result.kind}: ${result.kind === "blocked" ? result.reason : result.message}`);
    llmResult = result.json as ClassificationOutput;
  } catch (error) {
    if (error instanceof ClassificationPausedError) throw error;
    inboundItemRepo.incrementClassifyAttempts(item.id);
    logger.error("LLM classification failed, attempts incremented", {
      itemId: item.id,
      error: String(error),
    });
    throw error;
  }

  try {
    const { classification, deadlines } = transactionRunner.run(() => {
      const classification = classificationRepo.create({
        userId: null,
        inboundItemId: item.id,
        category: llmResult.category,
        priority: llmResult.priority,
        summary: llmResult.summary,
        actionItems: JSON.stringify(llmResult.actionItems),
        followUpNeeded: llmResult.followUpNeeded,
        model: classifierModel,
        promptVersion,
      });

      const deadlines: Deadline[] = llmResult.deadlines.map((d) =>
        deadlineRepo.create({
          userId: null,
          inboundItemId: item.id,
          dueDate: d.dueDate,
          description: d.description,
          confidence: d.confidence,
          status: "open",
        })
      );

      inboundItemRepo.markClassified(item.id);

      return { classification, deadlines };
    });

    logger.info("Item classified", {
      itemId: item.id,
      category: classification.category,
      priority: classification.priority,
      deadlineCount: deadlines.length,
    });

    return { classification, deadlines };
  } catch (error) {
    inboundItemRepo.incrementClassifyAttempts(item.id);
    logger.error("Classification persistence failed, attempts incremented", {
      itemId: item.id,
      error: String(error),
    });
    throw error;
  }
}
