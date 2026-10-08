import { Router, type Request, type Response } from "express";
import { ActionViewQuerySchema, LEGACY_BANNER, OffsetPaginationQuerySchema, STATUS_GROUPS } from "@oneon/contracts";
import {
  type ActionInstance,
  type ActiveContext,
  type ActorContext,
  type ContextDb,
  type Logger,
} from "@oneon/domain";
import { ActionOperationError, clampPolicy, type RequestOutcome } from "@oneon/application";
import type { ActionsModule } from "../actions-wiring.js";
import { ownerOf } from "../context-wiring.js";
import { toActionView } from "./action-views.js";

const LEGACY_MAX_LIMIT = 100;
const MAX_REASON_LENGTH = 1000;

export interface ActionsRouteDeps {
  /** The module for the request's own handle; a tenant request never reaches the personal module. */
  actionsFor(db: ContextDb): ActionsModule;
  /** The acting person for the active context, or null when it can no longer act (then 403 context_unavailable). */
  actorFor(ctx: ActiveContext): ActorContext | null;
  logger: Logger;
}

export function createActionsRouter(deps: ActionsRouteDeps): Router {
  const router = Router();

  /** Everything a handler needs, resolved from the request's active context (set by resolveActiveContext). */
  const scoped = (req: Request) => {
    const ctx = req.activeContext!;
    const actions = deps.actionsFor(req.contextDb!);
    return { ctx, actions, actor: deps.actorFor(ctx), owner: ownerOf(ctx).ownerId };
  };

  const view = (s: ReturnType<typeof scoped>, instance: ActionInstance) => {
    const { registry, configRepo, instanceRepo } = s.actions;
    const def = registry.get(instance.actionType);
    const stored = configRepo.get(instance.scope, instance.ownerId, def.type);
    const { policy } = clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson: stored?.configJson ?? null,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });
    return toActionView(instance, {
      registry,
      events: instanceRepo.listEvents(s.owner, instance.id),
      viewer: s.actor!,
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

  // Only a request with an active context whose person can still act gets past here.
  router.use((req, res, next) => {
    if (!req.activeContext || !req.contextDb || !deps.actorFor(req.activeContext)) {
      res.status(403).json({ error: "context_unavailable" });
      return;
    }
    next();
  });

  router.get("/", (req, res) => {
    const parsed = ActionViewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
      return;
    }
    const s = scoped(req);
    const { limit, offset, status, group } = parsed.data;
    const statuses = status ? [status] : group ? [...STATUS_GROUPS[group]] : undefined;
    try {
      const actions = s.actions.instanceRepo
        .list(s.owner, { statuses, limit, offset })
        .filter((i) => {
          if (s.actions.registry.has(i.actionType)) return true;
          deps.logger.warn("Skipping action with unregistered type", { actionId: i.id, actionType: i.actionType });
          return false;
        })
        .map((i) => view(s, i));
      const total = s.actions.instanceRepo.count(s.owner, { statuses });
      res.json({ actions, pagination: { limit, offset, total, hasMore: offset + limit < total } });
    } catch (error) {
      fail(res, error, { route: "list" });
    }
  });

  router.get("/legacy", (req, res) => {
    const parsed = OffsetPaginationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
      return;
    }
    // The MVP1 log is personal data; a pharmacy context has none.
    if (req.activeContext!.kind !== "personal") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const s = scoped(req);
    const limit = Math.min(parsed.data.limit, LEGACY_MAX_LIMIT);
    const offset = parsed.data.offset;
    try {
      const legacyRepo = s.actions.legacyRepo;
      const rows = legacyRepo.listForUser(s.owner, { limit, offset });
      const total = legacyRepo.countForUser(s.owner);
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
    const s = scoped(req);
    try {
      const instance = s.actions.instanceRepo.findById(s.owner, req.params.id);
      if (!instance) {
        res.status(404).json({ error: "Action not found" });
        return;
      }
      res.json(view(s, instance));
    } catch (error) {
      fail(res, error, { route: "get", actionId: req.params.id });
    }
  });

  router.get("/:id/events", (req, res) => {
    const s = scoped(req);
    try {
      if (!s.actions.instanceRepo.findById(s.owner, req.params.id)) {
        res.status(404).json({ error: "Action not found" });
        return;
      }
      res.json({ events: s.actions.instanceRepo.listEvents(s.owner, req.params.id) });
    } catch (error) {
      fail(res, error, { route: "events", actionId: req.params.id });
    }
  });

  type Op = "approve" | "reject" | "cancel" | "undo";
  const run: Record<Op, (s: ReturnType<typeof scoped>, id: string, body: { reason?: unknown }) => Promise<ActionInstance>> = {
    approve: (s, id) => s.actions.orchestrator.approve(s.actor!, id),
    reject: (s, id, b) => s.actions.orchestrator.reject(s.actor!, id, typeof b.reason === "string" ? b.reason : undefined),
    cancel: (s, id) => s.actions.orchestrator.cancel(s.actor!, id),
    undo: (s, id) => s.actions.orchestrator.requestUndo(s.actor!, id),
  };
  for (const op of Object.keys(run) as Op[]) {
    router.post(`/:id/${op}`, async (req, res) => {
      const s = scoped(req);
      if (op === "reject" && typeof req.body?.reason === "string" && req.body.reason.length > MAX_REASON_LENGTH) {
        res.status(422).json({ error: `Reason must be ${MAX_REASON_LENGTH} characters or fewer.` });
        return;
      }
      try {
        // Execution never depends on this request's connection (spec §10.2).
        const instance = await run[op](s, req.params.id, req.body ?? {});
        res.json(view(s, instance));
      } catch (error) {
        fail(res, error, { route: op, actionId: req.params.id });
      }
    });
  }

  router.post("/:id/retry", async (req, res) => {
    const s = scoped(req);
    try {
      const outcome: RequestOutcome = await s.actions.orchestrator.retry(s.actor!, req.params.id);
      if (outcome.kind === "refused") {
        res.status(422).json({ error: "Retry refused", issues: outcome.issues });
        return;
      }
      res.json(view(s, outcome.instance));
    } catch (error) {
      fail(res, error, { route: "retry", actionId: req.params.id });
    }
  });

  return router;
}
