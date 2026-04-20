import { Router } from "express";
import type {
  ClassificationRepository,
  InboundItemRepository,
  DeadlineRepository,
  ActionLogRepository,
  NotificationRepository,
  CalendarPort,
  Logger,
} from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export interface TodayRouteDeps {
  classificationRepo: ClassificationRepository;
  inboundItemRepo: InboundItemRepository;
  deadlineRepo: DeadlineRepository;
  actionLogRepo: ActionLogRepository;
  notificationRepo: NotificationRepository;
  calendarPort?: CalendarPort | null;
  logger: Logger;
}

// ── Router ───────────────────────────────────────────────────

export function createTodayRouter(deps: TodayRouteDeps): Router {
  const router = Router();
  const {
    classificationRepo,
    inboundItemRepo,
    deadlineRepo,
    actionLogRepo,
    notificationRepo,
    calendarPort,
    logger,
  } = deps;

  // ── GET / — Aggregated "today" dashboard data ─────────────
  router.get("/", async (req, res) => {
    try {
      const userId = req.userId!;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);

      // Start of today (UTC) and 7 days ahead for deadlines
      const todayStart = `${dateStr}T00:00:00.000Z`;
      const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const weekAheadStr = weekAhead.toISOString();

      // Calendar events (today only)
      let calendarStatus: "connected" | "unavailable" = "unavailable";
      let calendarEvents: unknown[] = [];
      if (calendarPort) {
        try {
          const endOfDay = `${dateStr}T23:59:59.999Z`;
          calendarEvents = await calendarPort.listEvents(todayStart, endOfDay);
          calendarStatus = "connected";
        } catch (err) {
          logger.warn("Calendar unavailable for today view", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Urgent items: priority ≤ 2 from recent classifications
      const recentItems = inboundItemRepo.findAll({ limit: 200, since: todayStart, userId });
      const urgentItems: Array<{
        id: string;
        subject: string;
        source: string;
        priority: number;
        category: string;
      }> = [];
      for (const item of recentItems) {
        const classification = classificationRepo.findByInboundItemId(item.id);
        if (classification && classification.priority <= 2) {
          urgentItems.push({
            id: item.id,
            subject: item.subject,
            source: item.source,
            priority: classification.priority,
            category: classification.category,
          });
        }
      }

      // Deadlines in next 7 days
      const deadlines = deadlineRepo.findByDateRange(todayStart, weekAheadStr, "open", userId);

      // Pending actions
      const pendingActions = actionLogRepo.findByStatus("proposed", 10, userId);
      const pendingCount = actionLogRepo.count({ status: "proposed", userId });

      // Counts
      const unreadNotifications = notificationRepo.countUnread(userId);
      const totalInbox = inboundItemRepo.count({ userId });

      res.json({
        date: dateStr,
        briefingSummary: null, // LLM summary deferred — data-only for now
        calendar: {
          status: calendarStatus,
          events: calendarEvents,
        },
        urgentItems,
        deadlines,
        pendingActions: {
          count: pendingCount,
          items: pendingActions,
        },
        counts: {
          unreadNotifications,
          totalInbox,
          pendingActions: pendingCount,
        },
      });
    } catch (error) {
      logger.error("Failed to build today view", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
