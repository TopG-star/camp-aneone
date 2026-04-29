import { Router, type Request, type Response } from "express";
import {
  listUserScopedPreferencesByPrefix,
  setUserScopedPreference,
  type PreferenceRepository,
  type Logger,
} from "@oneon/domain";

export interface NotificationPreferencesRouteDeps {
  preferenceRepo: PreferenceRepository;
  logger: Logger;
}

const NOTIFICATION_PREFIX = "notification.";

export function createNotificationPreferencesRouter(
  deps: NotificationPreferencesRouteDeps,
): Router {
  const router = Router();
  const { preferenceRepo, logger } = deps;

  // GET / — list all notification-related preferences
  router.get("/", (req: Request, res: Response) => {
    try {
      const notifPrefs = listUserScopedPreferencesByPrefix(
        preferenceRepo,
        req.userId!,
        NOTIFICATION_PREFIX,
      );
      res.status(200).json({ preferences: notifPrefs });
    } catch (error) {
      logger.error("Failed to list notification preferences", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT / — update notification preferences (merge)
  router.put("/", (req: Request, res: Response) => {
    try {
      const { preferences } = req.body;
      if (
        !preferences ||
        typeof preferences !== "object" ||
        Array.isArray(preferences)
      ) {
        res
          .status(400)
          .json({ error: "preferences must be a non-array object" });
        return;
      }

      for (const [key, value] of Object.entries(preferences)) {
        if (!key.startsWith(NOTIFICATION_PREFIX)) {
          res.status(400).json({
            error: `Key "${key}" must start with "${NOTIFICATION_PREFIX}"`,
          });
          return;
        }
        if (typeof value !== "string") {
          res.status(400).json({
            error: `Value for "${key}" must be a string`,
          });
          return;
        }
      }

      const userId = req.userId!;
      for (const [key, value] of Object.entries(
        preferences as Record<string, string>,
      )) {
        setUserScopedPreference(preferenceRepo, userId, key, value);
      }

      res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Failed to update notification preferences", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
