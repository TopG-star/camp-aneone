import { Router } from "express";
import type { BackgroundLoop } from "../background-loop.js";
import type { Logger } from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export interface CycleRouteDeps {
  getBackgroundLoop: () => BackgroundLoop | null;
  logger: Logger;
}

// ── Router ───────────────────────────────────────────────────

export function createCycleRouter(deps: CycleRouteDeps): Router {
  const router = Router();
  const { getBackgroundLoop, logger } = deps;

  // ── GET /status — Current cycle status ────────────────────
  router.get("/status", (_req, res) => {
    try {
      const loop = getBackgroundLoop();
      if (!loop) {
        res.json({
          running: false,
          lastCycleAt: null,
          lastError: null,
          consecutiveErrors: 0,
          enabled: false,
        });
        return;
      }

      res.json({
        running: loop.isRunning(),
        lastCycleAt: loop.lastCycleAt,
        lastError: loop.lastError,
        consecutiveErrors: loop.errorCount,
        enabled: true,
      });
    } catch (error) {
      logger.error("Failed to fetch cycle status", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── POST /run-now — Trigger an immediate cycle for the current user ─
  router.post("/run-now", (req, res) => {
    try {
      const loop = getBackgroundLoop();
      if (!loop) {
        res.status(409).json({ triggered: false, reason: "Background loop not initialized" });
        return;
      }

      if (!loop.isRunning()) {
        res.status(409).json({ triggered: false, reason: "Background loop is not running" });
        return;
      }

      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ triggered: false, reason: "User not authenticated" });
        return;
      }

      const triggered = loop.triggerNow(userId);
      if (!triggered) {
        res.status(409).json({ triggered: false, reason: "A cycle is already in flight" });
        return;
      }

      logger.info("Manual cycle triggered via API", { userId });
      res.json({ triggered: true });
    } catch (error) {
      logger.error("Failed to trigger manual cycle", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
