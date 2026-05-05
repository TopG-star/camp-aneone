import { Router } from "express";
import type { BackgroundLoop } from "../background-loop.js";
import type { ActionLogRepository, Logger } from "@oneon/domain";

// ── Types ────────────────────────────────────────────────────

export interface CycleRouteDeps {
  getBackgroundLoop: () => BackgroundLoop | null;
  actionLogRepo: ActionLogRepository;
  logger: Logger;
}

// ── Router ───────────────────────────────────────────────────

export function createCycleRouter(deps: CycleRouteDeps): Router {
  const router = Router();
  const { getBackgroundLoop, actionLogRepo, logger } = deps;

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

  // ── GET /errors — Recent cycle/action errors for drill-down ─
  router.get("/errors", (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: "User not authenticated" });
        return;
      }

      const limit = clampLimit(req.query.limit);
      const loop = getBackgroundLoop();

      const loopErrors = loop
        ? loop.getRecentErrors(limit * 3, userId).map((e) => ({
            id: e.id,
            occurredAt: e.occurredAt,
            component: e.component,
            stage: e.stage,
            scope: "global" as const,
            userId: e.userId,
            message: e.message,
            actionId: null,
          }))
        : [];

      const failedActionErrors = actionLogRepo
        .findAll({ status: "approved", userId, limit: limit * 5 })
        .filter((a) => !!a.errorJson)
        .map((a) => ({
          id: `action-${a.id}-${a.updatedAt}`,
          occurredAt: a.updatedAt,
          component: "actions",
          stage: "execute",
          scope: "action" as const,
          userId: a.userId,
          message: readErrorMessage(a.errorJson),
          actionId: a.id,
        }));

      const combined = [...failedActionErrors, ...loopErrors]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, limit);

      res.json({ errors: combined });
    } catch (error) {
      logger.error("Failed to fetch cycle errors", {
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

function clampLimit(rawLimit: unknown): number {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed)) return 25;
  return Math.min(100, Math.max(1, Math.trunc(parsed)));
}

function readErrorMessage(errorJson: string | null): string {
  if (!errorJson) return "Unknown action execution error";
  try {
    const parsed = JSON.parse(errorJson) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message;
    }
    return errorJson;
  } catch {
    return errorJson;
  }
}
