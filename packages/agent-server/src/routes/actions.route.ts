import { Router } from "express";
import type {
  ActionLogEntry,
  ActionLogRepository,
  InboundItemRepository,
  Logger,
} from "@oneon/domain";
import { ActionsQuerySchema } from "@oneon/contracts";

// ── Types ────────────────────────────────────────────────────

export interface ActionsRouteDeps {
  actionLogRepo: ActionLogRepository;
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
  manualExecuteRequired?: boolean;
}

type ActionExecutionStatus =
  | "not_started"
  | "running"
  | "succeeded"
  | "failed";

// ── Router ───────────────────────────────────────────────────

export function createActionsRouter(deps: ActionsRouteDeps): Router {
  const router = Router();
  const {
    actionLogRepo,
    inboundItemRepo,
    logger,
    manualExecuteRequired = false,
  } = deps;

  // ── GET / — Paginated action list ─────────────────────────
  router.get("/", (req, res) => {
    try {
      const parsed = ActionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
        return;
      }

      const { limit, offset, status } = parsed.data;
      const userId = req.userId!;

      const actions = actionLogRepo.findAll({ status, limit, offset, userId });
      const total = actionLogRepo.count({ status, userId });

      const enriched = actions.map((a) => {
        const item = inboundItemRepo.findById(a.resourceId);
        return toActionResponse(a, {
          itemFrom: item?.from ?? null,
          itemSource: item?.source ?? null,
          itemSubject: item?.subject ?? null,
        });
      });

      res.json({
        actions: enriched,
        pagination: {
          limit,
          offset,
          total,
          hasMore: offset + limit < total,
        },
      });
    } catch (error) {
      logger.error("Failed to fetch actions", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /:id — Single action detail for deep-link fallback ─
  router.get("/:id", (req, res) => {
    try {
      const userId = req.userId!;
      const actions = actionLogRepo.findAll({ limit: 1000, userId });
      const action = actions.find((a) => a.id === req.params.id);
      if (!action) {
        res.status(404).json({ error: "Action not found" });
        return;
      }

      const item = inboundItemRepo.findById(action.resourceId);
      res.json(toActionResponse(action, {
        itemFrom: item?.from ?? null,
        itemSource: item?.source ?? null,
        itemSubject: item?.subject ?? null,
      }));
    } catch (error) {
      logger.error("Failed to fetch action", {
        actionId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /:id/approve ─────────────────────────────────────
  router.post("/:id/approve", (req, res) => {
    try {
      const userId = req.userId!;
      const actions = actionLogRepo.findAll({ limit: 1000, userId });
      const action = actions.find((a) => a.id === req.params.id);
      if (!action) {
        res.status(404).json({ error: "Action not found" });
        return;
      }

      if (action.status !== "proposed") {
        res.status(409).json({
          error: `Cannot approve action in "${action.status}" status`,
        });
        return;
      }

      actionLogRepo.updateStatus(action.id, "approved", { errorJson: null, resultJson: null });
      logger.info("Action approved", { actionId: action.id });

      if (manualExecuteRequired) {
        res.json({
          id: action.id,
          status: "approved",
          executionStatus: "running",
        });
        return;
      }

      const execution = executeApprovedAction(actionLogRepo, logger, action.id, "approve");
      res.json({
        id: action.id,
        status: execution.status,
        executionStatus: execution.executionStatus,
        resultJson: execution.resultJson,
        errorJson: execution.errorJson,
      });
    } catch (error) {
      logger.error("Failed to approve action", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /:id/retry-execution ───────────────────────────
  router.post("/:id/retry-execution", (req, res) => {
    try {
      const userId = req.userId!;
      const actions = actionLogRepo.findAll({ limit: 1000, userId });
      const action = actions.find((a) => a.id === req.params.id);
      if (!action) {
        res.status(404).json({ error: "Action not found" });
        return;
      }

      if (action.status !== "approved") {
        res.status(409).json({
          error: `Cannot retry execution for action in "${action.status}" status`,
        });
        return;
      }

      const execution = executeApprovedAction(actionLogRepo, logger, action.id, "retry");
      res.json({
        id: action.id,
        status: execution.status,
        executionStatus: execution.executionStatus,
        resultJson: execution.resultJson,
        errorJson: execution.errorJson,
      });
    } catch (error) {
      logger.error("Failed to retry action execution", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /:id/reject ──────────────────────────────────────
  router.post("/:id/reject", (req, res) => {
    try {
      const userId = req.userId!;
      const actions = actionLogRepo.findAll({ limit: 1000, userId });
      const action = actions.find((a) => a.id === req.params.id);
      if (!action) {
        res.status(404).json({ error: "Action not found" });
        return;
      }

      if (action.status !== "proposed") {
        res.status(409).json({
          error: `Cannot reject action in "${action.status}" status`,
        });
        return;
      }

      actionLogRepo.updateStatus(action.id, "rejected");
      logger.info("Action rejected", { actionId: action.id });
      res.json({ id: action.id, status: "rejected", executionStatus: "not_started" });
    } catch (error) {
      logger.error("Failed to reject action", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function deriveExecutionStatus(action: Pick<ActionLogEntry, "status" | "resultJson" | "errorJson">): ActionExecutionStatus {
  if (action.status === "executed") return "succeeded";

  if (action.status === "approved") {
    if (action.errorJson) return "failed";
    if (action.resultJson) return "succeeded";
    return "running";
  }

  return "not_started";
}

function toActionResponse(
  action: ActionLogEntry,
  item: {
    itemFrom: string | null;
    itemSource: string | null;
    itemSubject: string | null;
  },
) {
  return {
    id: action.id,
    resourceId: action.resourceId,
    actionType: action.actionType,
    riskLevel: action.riskLevel,
    status: action.status,
    executionStatus: deriveExecutionStatus(action),
    payloadJson: action.payloadJson,
    resultJson: action.resultJson,
    errorJson: action.errorJson,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    itemFrom: item.itemFrom,
    itemSource: item.itemSource,
    itemSubject: item.itemSubject,
  };
}

function executeApprovedAction(
  actionLogRepo: ActionLogRepository,
  logger: Logger,
  actionId: string,
  reason: "approve" | "retry",
): {
  status: "approved" | "executed";
  executionStatus: "failed" | "succeeded";
  resultJson: string | null;
  errorJson: string | null;
} {
  try {
    const resultJson = JSON.stringify({
      executedAt: new Date().toISOString(),
      mode: "manual",
      reason,
    });

    actionLogRepo.updateStatus(actionId, "executed", {
      resultJson,
      errorJson: null,
    });

    logger.info("Action executed from actions route", { actionId, reason });

    return {
      status: "executed",
      executionStatus: "succeeded",
      resultJson,
      errorJson: null,
    };
  } catch (error) {
    const errorJson = JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      attemptedAt: new Date().toISOString(),
      reason,
    });

    actionLogRepo.updateStatus(actionId, "approved", {
      errorJson,
      resultJson: null,
    });

    logger.error("Action execution failed after approval", {
      actionId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      status: "approved",
      executionStatus: "failed",
      resultJson: null,
      errorJson,
    };
  }
}
