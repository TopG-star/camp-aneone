import { Router, type Request, type Response } from "express";
import type {
  Logger,
  PushSubscriptionRepository,
} from "@oneon/domain";

export interface PushSubscriptionsRouteDeps {
  pushSubscriptionRepo: PushSubscriptionRepository;
  logger: Logger;
  vapidPublicKey: string | null;
}

interface PushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export function createPushSubscriptionsRouter(
  deps: PushSubscriptionsRouteDeps,
): Router {
  const router = Router();
  const { pushSubscriptionRepo, logger, vapidPublicKey } = deps;

  router.get("/public-key", (_req: Request, res: Response) => {
    if (!vapidPublicKey) {
      res.status(404).json({ error: "Push notifications are not configured" });
      return;
    }

    res.status(200).json({ publicKey: vapidPublicKey });
  });

  router.post("/subscriptions", (req: Request, res: Response) => {
    try {
      const parsed = parseSubscriptionInput(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const userId = req.userId!;

      pushSubscriptionRepo.upsert({
        endpoint: parsed.value.endpoint,
        keysJson: JSON.stringify(parsed.value.keys),
        userId,
      });

      res.status(201).json({ success: true });
    } catch (error) {
      logger.error("Failed to register push subscription", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/subscriptions", (req: Request, res: Response) => {
    try {
      const endpoint =
        typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";

      if (!endpoint) {
        res.status(400).json({ error: "endpoint is required" });
        return;
      }

      pushSubscriptionRepo.deleteByEndpoint(endpoint, req.userId!);
      res.status(200).json({ success: true });
    } catch (error) {
      logger.error("Failed to delete push subscription", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}

function parseSubscriptionInput(
  value: unknown,
): { ok: true; value: PushSubscriptionInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "request body must be an object" };
  }

  const endpoint =
    typeof (value as { endpoint?: unknown }).endpoint === "string"
      ? (value as { endpoint: string }).endpoint.trim()
      : "";

  const keysRaw = (value as { keys?: unknown }).keys;
  if (!endpoint) {
    return { ok: false, error: "endpoint is required" };
  }

  if (!keysRaw || typeof keysRaw !== "object" || Array.isArray(keysRaw)) {
    return { ok: false, error: "keys object is required" };
  }

  const p256dh =
    typeof (keysRaw as { p256dh?: unknown }).p256dh === "string"
      ? (keysRaw as { p256dh: string }).p256dh.trim()
      : "";

  const auth =
    typeof (keysRaw as { auth?: unknown }).auth === "string"
      ? (keysRaw as { auth: string }).auth.trim()
      : "";

  if (!p256dh || !auth) {
    return { ok: false, error: "keys.p256dh and keys.auth are required" };
  }

  return {
    ok: true,
    value: {
      endpoint,
      keys: { p256dh, auth },
    },
  };
}
