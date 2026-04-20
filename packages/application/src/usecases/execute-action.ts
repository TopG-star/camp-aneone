import type {
  ActionLogEntry,
  ActionLogRepository,
  Logger,
} from "@oneon/domain";
import { assertValidTransition } from "./transition-action-status.js";

// ── Types ───────────────────────────────────────────────────

export interface ExecuteActionDeps {
  actionLogRepo: ActionLogRepository;
  logger: Logger;
  /** Whether auto-risk actions should be executed immediately */
  featureAutoExecute: boolean;
}

export interface ExecuteActionResult {
  action: ActionLogEntry;
  outcome: "executed" | "awaiting_approval" | "skipped_feature_off";
}

// ── Use Case ────────────────────────────────────────────────

/**
 * Processes a proposed action entry:
 *
 * - If risk = "auto" AND FEATURE_AUTO_EXECUTE is on:
 *     transitions proposed → approved → executed
 * - If risk = "auto" AND FEATURE_AUTO_EXECUTE is off:
 *     leaves at proposed (skipped_feature_off)
 * - If risk = "approval_required":
 *     leaves at proposed (awaiting_approval)
 *
 * MVP1: "execution" is just a status transition — no real
 * side-effects (email send, calendar create, etc.) yet.
 */
export function executeAction(
  deps: ExecuteActionDeps,
  action: ActionLogEntry
): ExecuteActionResult {
  const { actionLogRepo, logger, featureAutoExecute } = deps;

  if (action.status !== "proposed") {
    logger.warn("executeAction called on non-proposed action, skipping", {
      actionId: action.id,
      currentStatus: action.status,
    });
    return { action, outcome: "skipped_feature_off" };
  }

  // Approval-required actions stay queued
  if (action.riskLevel === "approval_required") {
    logger.info("Action awaiting approval", {
      actionId: action.id,
      actionType: action.actionType,
      resourceId: action.resourceId,
    });
    return { action, outcome: "awaiting_approval" };
  }

  // Auto-risk but feature flag off
  if (!featureAutoExecute) {
    logger.info("Auto-execute disabled, action stays proposed", {
      actionId: action.id,
      actionType: action.actionType,
    });
    return { action, outcome: "skipped_feature_off" };
  }

  // Auto-risk + feature flag on → execute
  assertValidTransition("proposed", "approved");
  actionLogRepo.updateStatus(action.id, "approved");

  assertValidTransition("approved", "executed");
  const executedResult = JSON.stringify({ executedAt: new Date().toISOString(), mode: "auto" });
  actionLogRepo.updateStatus(action.id, "executed", {
    resultJson: executedResult,
  });

  logger.info("Action auto-executed", {
    actionId: action.id,
    actionType: action.actionType,
    resourceId: action.resourceId,
  });

  // Return a snapshot reflecting the final state
  return {
    action: {
      ...action,
      status: "executed",
      resultJson: executedResult,
    },
    outcome: "executed",
  };
}
