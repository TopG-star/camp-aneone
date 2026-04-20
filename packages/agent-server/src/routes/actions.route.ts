import { Router } from "express";
import type {
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
}

// ── Router ───────────────────────────────────────────────────

export function createActionsRouter(deps: ActionsRouteDeps): Router {
  const router = Router();
  const { actionLogRepo, inboundItemRepo, logger } = deps;

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
        return {
          id: a.id,
          resourceId: a.resourceId,
          actionType: a.actionType,
          riskLevel: a.riskLevel,
          status: a.status,
          payloadJson: a.payloadJson,
          resultJson: a.resultJson,
          errorJson: a.errorJson,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          itemSubject: item?.subject ?? null,
        };
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

      actionLogRepo.updateStatus(action.id, "approved");
      logger.info("Action approved", { actionId: action.id });
      res.json({ id: action.id, status: "approved" });
    } catch (error) {
      logger.error("Failed to approve action", { error: error instanceof Error ? error.message : String(error) });
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
      res.json({ id: action.id, status: "rejected" });
    } catch (error) {
      logger.error("Failed to reject action", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
