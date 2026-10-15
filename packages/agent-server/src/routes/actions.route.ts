import { Router, type Request, type Response } from "express";
import { ActionViewQuerySchema, LEGACY_BANNER, OffsetPaginationQuerySchema, STATUS_GROUPS } from "@oneon/contracts";
import {
  type ActionInstance,
  type ActiveContext,
  type ActorContext,
  type ContextDb,
  type Logger,
} from "@oneon/domain";
import { ActionOperationError, ApprovalCheckError, clampPolicy, type RequestOutcome } from "@oneon/application";
import { TenantRefusedError } from "@oneon/infrastructure";
import type { ActionsModule } from "../actions-wiring.js";
import { ownerOf } from "../context-wiring.js";
import { IMPRESSORX_UNREACHABLE, LAUNCH_REQUIRED, SUSPENDED } from "../middleware/active-context.js";
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
    // A pharmacy request carries the hand-off session its attended grant is bound to: the approval is checked through it, and the
    // action may run now with it (spec §9.2, §9.3).
    const session = ctx.kind === "tenant" && req.sessionId ? { sessionId: req.sessionId, identityId: ctx.identityId } : undefined;
    return { ctx, actions, actor: deps.actorFor(ctx), owner: ownerOf(ctx).ownerId, session };
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

  /** Runs the handler's awaited work holding the request's context open (see Request.holdContext). */
  const hold = <T>(req: Request, work: () => Promise<T>): Promise<T> => (req.holdContext ? req.holdContext(work) : work());

  const fail = (res: Response, error: unknown, context: Record<string, unknown>) => {
    if (error instanceof ActionOperationError) {
      const status = error.code === "not_found" ? 404 : error.code === "not_allowed" ? 403 : 409;
      res.status(status).json({ error: error.message });
      return;
    }
    // The context could not be held (the request's lease had ended): the middleware's answer for that case, and nothing ran.
    if (error instanceof TenantRefusedError) {
      res.status(403).json({ error: "context_unavailable" });
      return;
    }
    // Spec §9.3: the approval could not be checked with ImpressoRx, so nothing was recorded.
    if (error instanceof ApprovalCheckError) {
      if (error.reason === "impressorx_unreachable") res.status(503).json(IMPRESSORX_UNREACHABLE);
      else res.status(403).json(error.reason === "membership_suspended" ? SUSPENDED : LAUNCH_REQUIRED);
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
    approve: (s, id) => s.actions.orchestrator.approve(s.actor!, id, s.session),
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
        // Execution never depends on this request's connection (spec §10.2), nor does the handle it writes to: the handler holds the
        // context itself, because the request's own lease ends if the client disconnects.
        await hold(req, async () => {
          const instance = await run[op](s, req.params.id, req.body ?? {});
          res.json(view(s, instance));
        });
      } catch (error) {
        fail(res, error, { route: op, actionId: req.params.id });
      }
    });
  }

  router.post("/:id/retry", async (req, res) => {
    const s = scoped(req);
    try {
      await hold(req, async () => {
        const outcome: RequestOutcome = await s.actions.orchestrator.retry(s.actor!, req.params.id, s.session);
        if (outcome.kind === "refused") {
          res.status(422).json({ error: "Retry refused", issues: outcome.issues });
          return;
        }
        res.json(view(s, outcome.instance));
      });
    } catch (error) {
      fail(res, error, { route: "retry", actionId: req.params.id });
    }
  });

  return router;
}
