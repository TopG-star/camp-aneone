import type {
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  TransactionRunner,
  LLMPort,
  Logger,
  NotificationPort,
  NotificationRepository,
} from "@oneon/domain";
import { personalActor } from "@oneon/domain";
import { type SkipRule } from "./process-unclassified-items.js";
import { checkApproachingDeadlines } from "./check-approaching-deadlines.js";
import { deriveInboxActionRequests } from "../actions/inbox-rules.js";
import type { ActionRequest, RequestOutcome } from "../actions/orchestrator/types.js";

// ── Daily Call Limiter ───────────────────────────────────────

export interface DailyCallCounter {
  date: string;
  count: number;
}

// ── Types ────────────────────────────────────────────────────

export interface RunProcessingCycleDeps {
  userId: string;
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
  deadlineRepo: DeadlineRepository;
  transactionRunner: TransactionRunner;
  llmPort: LLMPort;
  logger: Logger;
  classifierModel: string;
  promptVersion: string;
  maxAttempts: number;
  skipRules: SkipRule[];
  notificationPort?: NotificationPort | null;
  notificationRepo?: NotificationRepository | null;
  deadlineLeadDays?: number;
  /** Shared mutable counter — caller owns the object, cycle increments it. */
  dailyCallCounter?: DailyCallCounter;
  /** Max LLM classify calls per day. 0 = unlimited. */
  dailyCallLimit?: number;
  /** Every action goes through the registry and policy (spec §9.9). */
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  clock?: () => Date;
}

export interface RunProcessingCycleOptions {
  batchSize: number;
  maxDurationMs: number;
}

export interface CycleSummary {
  classification: {
    total: number;
    classified: number;
    skippedByRule: number;
    skippedMaxAttempts: number;
    skippedDailyLimit: number;
    failed: number;
  };
  actionsProposed: number;
  actionsAutoExecuted: number;
  actionErrors: number;
  notificationsSent: number;
  abortedEarly: boolean;
  durationMs: number;
}

// ── Use Case ─────────────────────────────────────────────────

/**
 * Runs a single processing cycle:
 *
 * 1. Classify unclassified items (delegates to processUnclassifiedItems)
 * 2. For each newly classified item, request actions from the inbox rules; the
 *    orchestrator validates, authorizes and executes them.
 *
 * Respects a maxDurationMs cap: if the cycle exceeds the budget,
 * it stops processing further items (abortedEarly = true).
 *
 * Never throws — all errors are caught, logged, and reflected in the summary.
 */
export async function runProcessingCycle(
  deps: RunProcessingCycleDeps,
  options: RunProcessingCycleOptions
): Promise<CycleSummary> {
  const startTime = Date.now();
  const { logger } = deps;

  const summary: CycleSummary = {
    classification: {
      total: 0,
      classified: 0,
      skippedByRule: 0,
      skippedMaxAttempts: 0,
      skippedDailyLimit: 0,
      failed: 0,
    },
    actionsProposed: 0,
    actionsAutoExecuted: 0,
    actionErrors: 0,
    notificationsSent: 0,
    abortedEarly: false,
    durationMs: 0,
  };

  // ── Step 1: Classify ──────────────────────────────────────

  // We need to pass maxDurationMs-aware processing. processUnclassifiedItems
  // doesn't support early abort, so we chunk at that level. We'll fetch the
  // batch and pass the batch through, but check time budget before
  // proposing actions for each result.

  // Check if we even have time budget
  if (isOverBudget(startTime, options.maxDurationMs)) {
    summary.abortedEarly = true;
    summary.durationMs = Date.now() - startTime;
    return summary;
  }

  // We need a sub-batch approach: fetch items, process one at a time
  // so we can respect the time budget between items.
  const items = deps.inboundItemRepo.findUnclassified(options.batchSize, deps.userId);

  // Process items one at a time, checking time budget between each
  for (const item of items) {
    if (isOverBudget(startTime, options.maxDurationMs)) {
      summary.abortedEarly = true;
      break;
    }

    summary.classification.total++;

    // Check max attempts
    if (item.classifyAttempts >= deps.maxAttempts) {
      summary.classification.skippedMaxAttempts++;
      logger.warn("Skipping item: max classify attempts reached", {
        itemId: item.id,
        attempts: item.classifyAttempts,
      });
      continue;
    }

    // Check skip rules
    const matchedRule = deps.skipRules.find((rule) => {
      if (rule.source && item.source !== rule.source) return false;
      const hasLabelMatch = rule.labelPattern
        ? new RegExp(rule.labelPattern).test(item.labels)
        : false;
      const hasSenderMatch = rule.senderPattern
        ? new RegExp(rule.senderPattern, "i").test(item.from)
        : false;
      return hasLabelMatch || hasSenderMatch;
    });

    if (matchedRule) {
      try {
        const matchedPattern = matchedRule.senderPattern
          ? `sender pattern: ${matchedRule.senderPattern}`
          : `label pattern: ${matchedRule.labelPattern}`;
        deps.transactionRunner.run(() => {
          deps.classificationRepo.create({
            userId: deps.userId,
            inboundItemId: item.id,
            category: matchedRule.category,
            priority: matchedRule.priority,
            summary: `Auto-classified by skip rule (${matchedPattern})`,
            actionItems: "[]",
            followUpNeeded: false,
            model: "skip_rules",
            promptVersion: "v1",
          });
          deps.inboundItemRepo.markClassified(item.id);
        });
        summary.classification.skippedByRule++;
      } catch (error) {
        summary.classification.failed++;
        logger.error("Skip rule persistence failed", {
          itemId: item.id,
          error: String(error),
        });
      }
      continue;
    }

    // Check daily LLM call limit
    if (deps.dailyCallCounter && deps.dailyCallLimit && deps.dailyCallLimit > 0) {
      const today = new Date().toISOString().slice(0, 10);
      if (deps.dailyCallCounter.date !== today) {
        deps.dailyCallCounter.date = today;
        deps.dailyCallCounter.count = 0;
      }
      if (deps.dailyCallCounter.count >= deps.dailyCallLimit) {
        summary.classification.skippedDailyLimit++;
        logger.warn("Skipping item: daily LLM call limit reached", {
          itemId: item.id,
          limit: deps.dailyCallLimit,
          count: deps.dailyCallCounter.count,
        });
        continue;
      }
    }

    // LLM classification
    try {
      const classifyResult = await deps.llmPort.classify({
        from: item.from,
        subject: item.subject,
        bodyPreview: item.bodyPreview,
        source: item.source,
      });

      // Increment daily counter after successful LLM call
      if (deps.dailyCallCounter) {
        deps.dailyCallCounter.count++;
      }

      const classification = deps.transactionRunner.run(() => {
        const cls = deps.classificationRepo.create({
          userId: deps.userId,
          inboundItemId: item.id,
          category: classifyResult.category,
          priority: classifyResult.priority,
          summary: classifyResult.summary,
          actionItems: JSON.stringify(classifyResult.actionItems),
          followUpNeeded: classifyResult.followUpNeeded,
          model: deps.classifierModel,
          promptVersion: deps.promptVersion,
        });

        for (const dl of classifyResult.deadlines) {
          deps.deadlineRepo.create({
            userId: deps.userId,
            inboundItemId: item.id,
            dueDate: dl.dueDate,
            description: dl.description,
            confidence: dl.confidence,
            status: "open",
          });
        }

        deps.inboundItemRepo.markClassified(item.id);
        return cls;
      });

      summary.classification.classified++;

      // ── Step 2: Request actions; notify is the only urgent-notification path ──
      // The item is already marked classified, so nothing retries a skipped request: one failing
      // request must not stop the item's other requests (I4).
      let requests: ReturnType<typeof deriveInboxActionRequests> = [];
      try {
        const deadlines = deps.deadlineRepo.findByInboundItemId(item.id);
        const now = (deps.clock ?? (() => new Date()))();
        requests = deriveInboxActionRequests({ classification, item, deadlines, now });
      } catch (error) {
        summary.actionErrors++;
        logger.error("Action requests could not be derived", {
          itemId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const request of requests) {
        try {
          const outcome = await deps.requestAction({ ...request, actor: personalActor(deps.userId) });
          if (outcome.kind === "refused") {
            summary.actionErrors++;
            logger.warn("Action request refused", { itemId: item.id, type: request.type, reason: outcome.reason, issues: outcome.issues });
            continue;
          }
          if (outcome.kind !== "created") continue;
          summary.actionsProposed++;
          if (outcome.instance.status === "completed") {
            summary.actionsAutoExecuted++;
            if (request.type === "notify") summary.notificationsSent++;
          }
        } catch (error) {
          summary.actionErrors++;
          logger.error("Action request failed", {
            itemId: item.id,
            type: request.type,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      summary.classification.failed++;
      deps.inboundItemRepo.incrementClassifyAttempts(item.id);
      logger.error("LLM classification failed", {
        itemId: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Step 4: Check approaching deadlines ──
  if (deps.notificationPort && deps.notificationRepo) {
    try {
      const deadlineResult = await checkApproachingDeadlines(
        {
          deadlineRepo: deps.deadlineRepo,
          notificationPort: deps.notificationPort,
          notificationRepo: deps.notificationRepo,
          logger,
          userId: deps.userId,
        },
        { leadDays: deps.deadlineLeadDays ?? 2 },
      );
      summary.notificationsSent += deadlineResult.notified;
    } catch (error) {
      logger.error("Deadline notification check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  summary.durationMs = Date.now() - startTime;

  logger.info("Processing cycle complete", {
    ...summary.classification,
    actionsProposed: summary.actionsProposed,
    actionsAutoExecuted: summary.actionsAutoExecuted,
    actionErrors: summary.actionErrors,
    notificationsSent: summary.notificationsSent,
    abortedEarly: summary.abortedEarly,
    durationMs: summary.durationMs,
  });

  return summary;
}

// ── Helpers ──────────────────────────────────────────────────

function isOverBudget(startTime: number, maxDurationMs: number): boolean {
  return Date.now() - startTime >= maxDurationMs;
}
