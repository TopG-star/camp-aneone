import type {
  InboundItem,
  Classification,
  Deadline,
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  TransactionRunner,
  LLMPort,
  Logger,
} from "@oneon/domain";

export interface ClassifyItemDeps {
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
  deadlineRepo: DeadlineRepository;
  transactionRunner: TransactionRunner;
  llmPort: LLMPort;
  logger: Logger;
  /** Model name to record, e.g. "claude-3-5-haiku-20241022" */
  classifierModel: string;
  /** Prompt version identifier, e.g. "v1" */
  promptVersion: string;
}

export interface ClassifyItemResult {
  classification: Classification;
  deadlines: Deadline[];
}

/**
 * Classifies a single InboundItem via the LLM and persists the results
 * (classification + deadlines + markClassified) in a single transaction.
 *
 * On LLM or persistence failure, increments classifyAttempts so the item
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
    llmPort,
    logger,
    classifierModel,
    promptVersion,
  } = deps;

  let llmResult;
  try {
    llmResult = await llmPort.classify({
      from: item.from,
      subject: item.subject,
      bodyPreview: item.bodyPreview,
      source: item.source,
    });
  } catch (error) {
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
