import { Router } from "express";
import type {
  InboundItemRepository,
  ClassificationRepository,
  DeadlineRepository,
  ActionLogRepository,
  Logger,
} from "@oneon/domain";
import { InboxQuerySchema } from "@oneon/contracts";

// ── Types ────────────────────────────────────────────────────

export interface InboxRouteDeps {
  inboundItemRepo: InboundItemRepository;
  classificationRepo: ClassificationRepository;
  deadlineRepo: DeadlineRepository;
  actionLogRepo: ActionLogRepository;
  logger: Logger;
}

// ── Router ───────────────────────────────────────────────────

export function createInboxRouter(deps: InboxRouteDeps): Router {
  const router = Router();
  const { inboundItemRepo, classificationRepo, deadlineRepo, actionLogRepo, logger } = deps;

  // ── GET / — Paginated inbox list ──────────────────────────
  router.get("/", (req, res) => {
    try {
      const parsed = InboxQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
        return;
      }

      const { limit, offset, source, category, maxPriority, since } = parsed.data;
      const userId = req.userId!;

      const items = inboundItemRepo.findAll({ source, since, limit, offset, userId });
      const total = inboundItemRepo.count({ source, since, userId });

      const enriched = items.map((item) => {
        const cls = classificationRepo.findByInboundItemId(item.id);

        // Apply category/priority filters (post-classification)
        if (category && cls?.category !== category) return null;
        if (maxPriority && (!cls || cls.priority > maxPriority)) return null;

        return {
          id: item.id,
          source: item.source,
          externalId: item.externalId,
          from: item.from,
          subject: item.subject,
          bodyPreview: item.bodyPreview,
          receivedAt: item.receivedAt,
          threadId: item.threadId,
          labels: item.labels,
          createdAt: item.createdAt,
          classification: cls
            ? {
                id: cls.id,
                category: cls.category,
                priority: cls.priority,
                summary: cls.summary,
                actionItems: cls.actionItems,
                followUpNeeded: cls.followUpNeeded,
              }
            : null,
        };
      }).filter(Boolean);

      res.json({
        items: enriched,
        pagination: {
          limit,
          offset,
          total,
          hasMore: offset + limit < total,
        },
      });
    } catch (error) {
      logger.error("Failed to fetch inbox", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /:id — Single item with full context ──────────────
  router.get("/:id", (req, res) => {
    try {
      const userId = req.userId!;
      const item = inboundItemRepo.findById(req.params.id);
      if (!item || item.userId !== userId) {
        res.status(404).json({ error: "Item not found" });
        return;
      }

      const cls = classificationRepo.findByInboundItemId(item.id);
      const deadlines = deadlineRepo.findByInboundItemId(item.id);

      // Find actions related to this item
      const allActions = actionLogRepo.findAll({ limit: 100, userId });
      const relatedActions = allActions.filter((a) => a.resourceId === item.id);

      res.json({
        id: item.id,
        source: item.source,
        externalId: item.externalId,
        from: item.from,
        subject: item.subject,
        bodyPreview: item.bodyPreview,
        receivedAt: item.receivedAt,
        threadId: item.threadId,
        labels: item.labels,
        createdAt: item.createdAt,
        classification: cls
          ? {
              id: cls.id,
              category: cls.category,
              priority: cls.priority,
              summary: cls.summary,
              actionItems: cls.actionItems,
              followUpNeeded: cls.followUpNeeded,
            }
          : null,
        deadlines: deadlines.map((d) => ({
          id: d.id,
          dueDate: d.dueDate,
          description: d.description,
          confidence: d.confidence,
          status: d.status,
        })),
        actions: relatedActions.map((a) => ({
          id: a.id,
          actionType: a.actionType,
          riskLevel: a.riskLevel,
          status: a.status,
          createdAt: a.createdAt,
        })),
      });
    } catch (error) {
      logger.error("Failed to fetch inbox item", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
