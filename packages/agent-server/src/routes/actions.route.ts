import { Router, type Response } from "express";
import { ActionViewQuerySchema, LEGACY_BANNER, STATUS_GROUPS } from "@oneon/contracts";
import {
  personalActor,
  type ActionConfigRepository,
  type ActionInstance,
  type ActionInstanceRepository,
  type LegacyActionRepository,
  type Logger,
} from "@oneon/domain";
import {
  ActionOperationError,
  clampPolicy,
  type ActionOrchestrator,
  type ActionRegistry,
  type RequestOutcome,
} from "@oneon/application";
import { toActionView } from "./action-views.js";

export interface ActionsRouteDeps {
  orchestrator: ActionOrchestrator;
  registry: ActionRegistry;
  instanceRepo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  legacyRepo: LegacyActionRepository;
  logger: Logger;
}

export function createActionsRouter(deps: ActionsRouteDeps): Router {
  const router = Router();

  const view = (userId: string, instance: ActionInstance) => {
    const def = deps.registry.get(instance.actionType);
    const stored = deps.configRepo.get(instance.scope, instance.ownerId, def.type);
    const { policy } = clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson: stored?.configJson ?? null,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });
    return toActionView(instance, {
      registry: deps.registry,
      events: deps.instanceRepo.listEvents(userId, instance.id),
      viewer: personalActor(userId),
      policy,
    });
  };

  const fail = (res: Response, error: unknown, context: Record<string, unknown>) => {
    if (error instanceof ActionOperationError) {
      const status = error.code === "not_found" ? 404 : error.code === "not_allowed" ? 403 : 409;
      res.status(status).json({ error: error.message });
      return;
    }
    deps.logger.error("Action request failed", { ...context, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Internal server error" });
  };

  router.get("/", (req, res) => {
    const parsed = ActionViewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
      return;
    }
    const userId = req.userId!;
    const { limit, offset, status, group } = parsed.data;
    const statuses = status ? [status] : group ? [...STATUS_GROUPS[group]] : undefined;
    try {
      const actions = deps.instanceRepo.list(userId, { statuses, limit, offset }).map((i) => view(userId, i));
      const total = deps.instanceRepo.count(userId, { statuses });
      res.json({ actions, pagination: { limit, offset, total, hasMore: offset + limit < total } });
    } catch (error) {
      fail(res, error, { route: "list" });
    }
  });

  router.get("/legacy", (req, res) => {
    const userId = req.userId!;
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    try {
      const rows = deps.legacyRepo.listForUser(userId, { limit, offset });
      const total = deps.legacyRepo.countForUser(userId);
      res.json({
        banner: LEGACY_BANNER,
        actions: rows.map((r) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(r.payloadJson) as Record<string, unknown>;
          } catch {
            payload = {};
          }
          return { id: r.id, actionType: r.actionType, status: r.status, payload, createdAt: r.createdAt };
        }),
        pagination: { limit, offset, total, hasMore: offset + limit < total },
      });
    } catch (error) {
      fail(res, error, { route: "legacy" });
    }
  });

  router.get("/:id", (req, res) => {
    const userId = req.userId!;
    try {
      const instance = deps.instanceRepo.findById(userId, req.params.id);
      if (!instance) {
        res.status(404).json({ error: "Action not found" });
        return;
      }
      res.json(view(userId, instance));
    } catch (error) {
      fail(res, error, { route: "get", actionId: req.params.id });
    }
  });

  router.get("/:id/events", (req, res) => {
    const userId = req.userId!;
    try {
      if (!deps.instanceRepo.findById(userId, req.params.id)) {
        res.status(404).json({ error: "Action not found" });
        return;
      }
      res.json({ events: deps.instanceRepo.listEvents(userId, req.params.id) });
    } catch (error) {
      fail(res, error, { route: "events", actionId: req.params.id });
    }
  });

  type Op = "approve" | "reject" | "cancel" | "undo";
  const run: Record<Op, (userId: string, id: string, body: { reason?: unknown }) => Promise<ActionInstance>> = {
    approve: (u, id) => deps.orchestrator.approve(personalActor(u), id),
    reject: (u, id, b) => deps.orchestrator.reject(personalActor(u), id, typeof b.reason === "string" ? b.reason : undefined),
    cancel: (u, id) => deps.orchestrator.cancel(personalActor(u), id),
    undo: (u, id) => deps.orchestrator.requestUndo(personalActor(u), id),
  };
  for (const op of Object.keys(run) as Op[]) {
    router.post(`/:id/${op}`, async (req, res) => {
      const userId = req.userId!;
      try {
        // Execution never depends on this request's connection (spec §10.2).
        const instance = await run[op](userId, req.params.id, req.body ?? {});
        res.json(view(userId, instance));
      } catch (error) {
        fail(res, error, { route: op, actionId: req.params.id });
      }
    });
  }

  router.post("/:id/retry", async (req, res) => {
    const userId = req.userId!;
    try {
      const outcome: RequestOutcome = await deps.orchestrator.retry(personalActor(userId), req.params.id);
      if (outcome.kind === "refused") {
        res.status(422).json({ error: "Retry refused", issues: outcome.issues });
        return;
      }
      res.json(view(userId, outcome.instance));
    } catch (error) {
      fail(res, error, { route: "retry", actionId: req.params.id });
    }
  });

  return router;
}
