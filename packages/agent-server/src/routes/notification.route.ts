import { Router, type Request, type Response } from "express";
import type { NotificationRepository, Logger } from "@oneon/domain";

export interface NotificationRouteDeps {
  notificationRepo: NotificationRepository;
  logger: Logger;
}

export function createNotificationRouter(deps: NotificationRouteDeps): Router {
  const router = Router();
  const { notificationRepo, logger } = deps;

  // GET /  — list notifications (unread by default, ?all=true for all)
  router.get("/", (req: Request, res: Response) => {
    try {
      const all = req.query.all === "true";
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
        200,
      );
      const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
      const userId = req.userId!;

      const notifications = all
        ? notificationRepo.findAll({ limit, offset, userId })
        : notificationRepo.findUnread(limit, userId);

      res.status(200).json({ notifications });
    } catch (error) {
      logger.error("Failed to list notifications", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /count — unread count
  router.get("/count", (req: Request, res: Response) => {
    try {
      const count = notificationRepo.countUnread(req.userId!);
      res.status(200).json({ count });
    } catch (error) {
      logger.error("Failed to count notifications", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /:id/read — mark single notification as read
  router.patch("/:id/read", (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id || typeof id !== "string") {
        res.status(400).json({ error: "id is required" });
        return;
      }
      const notification = notificationRepo.findById(id);
      if (!notification || notification.userId !== req.userId!) {
        res.status(404).json({ error: "Notification not found" });
        return;
      }
      notificationRepo.markRead(id);
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Failed to mark notification as read", {
        error: error instanceof Error ? error.message : String(error),
        id: req.params.id,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /mark-all-read — mark all notifications as read
  router.post("/mark-all-read", (req: Request, res: Response) => {
    try {
      notificationRepo.markAllRead(req.userId!);
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Failed to mark all notifications as read", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
