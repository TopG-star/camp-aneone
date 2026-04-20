import type {
  Classification,
  Deadline,
  InboundItem,
  ActionLogEntry,
  ActionLogRepository,
  Logger,
} from "@oneon/domain";
import type { ActionType, RiskLevel } from "@oneon/domain";

// ── Risk-Level Mapping ──────────────────────────────────────

export const ACTION_RISK_LEVELS: Record<ActionType, RiskLevel> = {
  classify: "auto",
  label: "auto",
  notify: "auto",
  create_reminder: "auto",
  draft_reply: "auto",
  archive: "approval_required",
  delete: "approval_required",
  send: "approval_required",
  forward: "approval_required",
};

// ── Types ───────────────────────────────────────────────────

export interface ProposedAction {
  actionType: ActionType;
  resourceId: string;
  riskLevel: RiskLevel;
  payloadJson: string;
}

export interface ProposeActionsDeps {
  actionLogRepo: ActionLogRepository;
  logger: Logger;
  userId: string;
}

export interface ProposeActionsResult {
  created: ActionLogEntry[];
  skippedDuplicates: number;
}

// ── Rules ───────────────────────────────────────────────────

export function deriveActions(
  classification: Classification,
  item: InboundItem,
  deadlines: Deadline[]
): ProposedAction[] {
  const actions: ProposedAction[] = [];
  const resourceId = item.id;

  // Rule 1: Notify if urgent or high-priority
  if (classification.category === "urgent" || classification.priority <= 2) {
    actions.push({
      actionType: "notify",
      resourceId,
      riskLevel: ACTION_RISK_LEVELS["notify"],
      payloadJson: JSON.stringify({
        reason: classification.category === "urgent" ? "urgent_category" : "high_priority",
        priority: classification.priority,
        summary: classification.summary,
      }),
    });
  }

  // Rule 2: Create reminder for each deadline (resourceId = deadline.id for per-deadline idempotency)
  for (const deadline of deadlines) {
    actions.push({
      actionType: "create_reminder",
      resourceId: deadline.id,
      riskLevel: ACTION_RISK_LEVELS["create_reminder"],
      payloadJson: JSON.stringify({
        deadlineId: deadline.id,
        inboundItemId: item.id,
        dueDate: deadline.dueDate,
        description: deadline.description,
        summary: classification.summary,
      }),
    });
  }

  // Rule 3: Draft reply if follow-up needed
  if (classification.followUpNeeded) {
    actions.push({
      actionType: "draft_reply",
      resourceId,
      riskLevel: ACTION_RISK_LEVELS["draft_reply"],
      payloadJson: JSON.stringify({
        reason: "follow_up_needed",
        summary: classification.summary,
        from: item.from,
      }),
    });
  }

  // Rule 4: Archive spam
  if (classification.category === "spam") {
    actions.push({
      actionType: "archive",
      resourceId,
      riskLevel: ACTION_RISK_LEVELS["archive"],
      payloadJson: JSON.stringify({
        reason: "spam_classification",
      }),
    });
  }

  // Rule 5: Label newsletters
  if (classification.category === "newsletter" && classification.priority >= 4) {
    actions.push({
      actionType: "label",
      resourceId,
      riskLevel: ACTION_RISK_LEVELS["label"],
      payloadJson: JSON.stringify({
        label: "newsletter",
        reason: "newsletter_low_priority",
      }),
    });
  }

  return actions;
}

// ── Use Case ────────────────────────────────────────────────

/**
 * Evaluates classification results and proposes actions via the rules engine.
 * Idempotent: skips actions that already exist for the same (resourceId, actionType).
 */
export function proposeActions(
  deps: ProposeActionsDeps,
  classification: Classification,
  item: InboundItem,
  deadlines: Deadline[]
): ProposeActionsResult {
  const { actionLogRepo, logger } = deps;

  const derivedActions = deriveActions(classification, item, deadlines);

  const created: ActionLogEntry[] = [];
  let skippedDuplicates = 0;

  for (const action of derivedActions) {
    // Idempotency check
    const existing = actionLogRepo.findByResourceAndType(
      action.resourceId,
      action.actionType as ActionType
    );
    if (existing) {
      skippedDuplicates++;
      continue;
    }

    const entry = actionLogRepo.create({
      userId: deps.userId,
      resourceId: action.resourceId,
      actionType: action.actionType,
      riskLevel: action.riskLevel,
      status: "proposed",
      payloadJson: action.payloadJson,
      resultJson: null,
      errorJson: null,
      rollbackJson: null,
    });

    created.push(entry);
  }

  logger.info("Actions proposed", {
    itemId: item.id,
    derived: derivedActions.length,
    created: created.length,
    skippedDuplicates,
  });

  return { created, skippedDuplicates };
}
