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
  Category,
  Priority,
} from "@oneon/domain";
import { classifyItem, type ClassifyItemResult } from "./classify-item.js";

// ── Skip Rules ──────────────────────────────────────────────

export interface SkipRule {
  /** Optional: only match items from this source (e.g. "outlook", "gmail") */
  source?: string;
  /** Regex pattern matched against the labels JSON string */
  labelPattern?: string;
  /** Regex pattern matched against the sender (from field) */
  senderPattern?: string;
  /** Category to assign when the rule matches */
  category: Category;
  /** Priority to assign when the rule matches */
  priority: Priority;
}

// ── Dependencies & Result ───────────────────────────────────

export interface ProcessUnclassifiedItemsDeps {
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
  deadlineRepo: DeadlineRepository;
  transactionRunner: TransactionRunner;
  llmPort: LLMPort;
  logger: Logger;
  classifierModel: string;
  promptVersion: string;
  /** Maximum classify attempts before an item is permanently skipped */
  maxAttempts: number;
  /** Skip rules applied before LLM classification */
  skipRules: SkipRule[];
}

export interface ProcessUnclassifiedItemsSummary {
  total: number;
  classified: number;
  skippedByRule: number;
  skippedMaxAttempts: number;
  failed: number;
  results: Array<{
    itemId: string;
    outcome: "classified" | "skip_rule" | "max_attempts" | "failed";
    classification?: Classification;
    deadlines?: Deadline[];
    error?: string;
  }>;
}

// ── Helpers ─────────────────────────────────────────────────

function matchesSkipRule(item: InboundItem, rule: SkipRule): boolean {
  if (rule.source && item.source !== rule.source) {
    return false;
  }
  const hasLabelMatch = rule.labelPattern
    ? new RegExp(rule.labelPattern).test(item.labels)
    : false;
  const hasSenderMatch = rule.senderPattern
    ? new RegExp(rule.senderPattern, "i").test(item.from)
    : false;
  // Must match at least one pattern
  return hasLabelMatch || hasSenderMatch;
}

function findMatchingSkipRule(
  item: InboundItem,
  rules: SkipRule[]
): SkipRule | undefined {
  return rules.find((rule) => matchesSkipRule(item, rule));
}

function applySkipRule(
  deps: {
    classificationRepo: ClassificationRepository;
    inboundItemRepo: InboundItemRepository;
    transactionRunner: TransactionRunner;
  },
  item: InboundItem,
  rule: SkipRule
): Classification {
  return deps.transactionRunner.run(() => {
    const matchedPattern = rule.senderPattern
      ? `sender pattern: ${rule.senderPattern}`
      : `label pattern: ${rule.labelPattern}`;
    const classification = deps.classificationRepo.create({
      inboundItemId: item.id,
      userId: null,
      category: rule.category,
      priority: rule.priority,
      summary: `Auto-classified by skip rule (${matchedPattern})`,
      actionItems: "[]",
      followUpNeeded: false,
      model: "skip_rules",
      promptVersion: "v1",
    });

    deps.inboundItemRepo.markClassified(item.id);

    return classification;
  });
}

// ── Main Use Case ───────────────────────────────────────────

/**
 * Fetches unclassified items and processes each one:
 *
 * 1. Skip items that have reached maxAttempts
 * 2. Apply skip rules (source-aware label patterns) — stored as
 *    classifications with model="skip_rules"
 * 3. Classify remaining items via LLM (classifyItem use case)
 *
 * Returns a detailed summary of outcomes.
 */
export async function processUnclassifiedItems(
  deps: ProcessUnclassifiedItemsDeps,
  batchSize: number
): Promise<ProcessUnclassifiedItemsSummary> {
  const {
    inboundItemRepo,
    classificationRepo,
    deadlineRepo,
    transactionRunner,
    llmPort,
    logger,
    classifierModel,
    promptVersion,
    maxAttempts,
    skipRules,
  } = deps;

  const items = inboundItemRepo.findUnclassified(batchSize);

  const summary: ProcessUnclassifiedItemsSummary = {
    total: items.length,
    classified: 0,
    skippedByRule: 0,
    skippedMaxAttempts: 0,
    failed: 0,
    results: [],
  };

  for (const item of items) {
    // 1. Skip items that have exceeded max attempts
    if (item.classifyAttempts >= maxAttempts) {
      summary.skippedMaxAttempts++;
      summary.results.push({
        itemId: item.id,
        outcome: "max_attempts",
      });
      logger.warn("Skipping item: max classify attempts reached", {
        itemId: item.id,
        attempts: item.classifyAttempts,
        maxAttempts,
      });
      continue;
    }

    // 2. Check skip rules
    const matchedRule = findMatchingSkipRule(item, skipRules);
    if (matchedRule) {
      try {
        const classification = applySkipRule(
          { classificationRepo, inboundItemRepo, transactionRunner },
          item,
          matchedRule
        );
        summary.skippedByRule++;
        summary.results.push({
          itemId: item.id,
          outcome: "skip_rule",
          classification,
          deadlines: [],
        });
        logger.info("Item auto-classified by skip rule", {
          itemId: item.id,
          category: matchedRule.category,
          pattern: matchedRule.labelPattern,
        });
        continue;
      } catch (error) {
        // If skip rule persistence fails, count as failure
        summary.failed++;
        summary.results.push({
          itemId: item.id,
          outcome: "failed",
          error: String(error),
        });
        logger.error("Skip rule persistence failed", {
          itemId: item.id,
          error: String(error),
        });
        continue;
      }
    }

    // 3. Classify via LLM
    try {
      const result: ClassifyItemResult = await classifyItem(
        {
          inboundItemRepo,
          classificationRepo,
          deadlineRepo,
          transactionRunner,
          llmPort,
          logger,
          classifierModel,
          promptVersion,
        },
        item
      );
      summary.classified++;
      summary.results.push({
        itemId: item.id,
        outcome: "classified",
        classification: result.classification,
        deadlines: result.deadlines,
      });
    } catch (error) {
      summary.failed++;
      summary.results.push({
        itemId: item.id,
        outcome: "failed",
        error: String(error),
      });
      // classifyItem already logged the error and incremented attempts
    }
  }

  logger.info("Classification batch complete", {
    total: summary.total,
    classified: summary.classified,
    skippedByRule: summary.skippedByRule,
    skippedMaxAttempts: summary.skippedMaxAttempts,
    failed: summary.failed,
  });

  return summary;
}
