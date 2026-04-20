import { Router } from "express";
import type { DeadlineRepository, InboundItemRepository, Logger } from "@oneon/domain";
import type { DeadlineStatus } from "@oneon/domain";

export interface DeadlinesRouteDeps {
  deadlineRepo: DeadlineRepository;
  inboundItemRepo: InboundItemRepository;
  logger: Logger;
}

export function createDeadlinesRouter(deps: DeadlinesRouteDeps): Router {
  const router = Router();
  const { deadlineRepo, inboundItemRepo, logger } = deps;

  // ── GET / — List deadlines with filters ───────────────────
  router.get("/", (req, res) => {
    try {
      const userId = req.userId!;
      const status = (req.query.status as string) || undefined;
      const range = (req.query.range as string) || "30"; // days ahead

      const now = new Date();
      const from = now.toISOString();
      const to = new Date(now.getTime() + Number(range) * 24 * 60 * 60 * 1000).toISOString();

      const validStatuses: DeadlineStatus[] = ["open", "done", "dismissed"];
      const deadlineStatus = validStatuses.includes(status as DeadlineStatus)
        ? (status as DeadlineStatus)
        : undefined;

      const deadlines = deadlineRepo.findByDateRange(from, to, deadlineStatus, userId);
      const overdue = deadlineRepo.findOverdue(userId);

      // Enrich with item subject
      const enriched = [...overdue, ...deadlines].map((d) => {
        const item = inboundItemRepo.findById(d.inboundItemId);
        return {
          ...d,
          itemSubject: item?.subject ?? null,
          itemSource: item?.source ?? null,
        };
      });

      // Deduplicate (overdue may overlap with range)
      const seen = new Set<string>();
      const deduped = enriched.filter((d) => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });

      res.json({
        deadlines: deduped,
        counts: {
          total: deadlineRepo.count({ userId }),
          open: deadlineRepo.count({ status: "open", userId }),
          overdue: overdue.length,
        },
      });
    } catch (error) {
      logger.error("Failed to fetch deadlines", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
