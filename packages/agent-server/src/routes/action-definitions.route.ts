import { Router } from "express";
import { ActionConfigWriteSchema, type ActionDefinitionView } from "@oneon/contracts";
import type { ActiveContext, ContextDb, Logger } from "@oneon/domain";
import {
  approvalOptions,
  clampPolicy,
  validateConfigWrite,
  type AnyActionDefinition,
} from "@oneon/application";
import type { ActionsModule } from "../actions-wiring.js";
import { ownerOf } from "../context-wiring.js";

export interface ActionDefinitionsRouteDeps {
  /** The module for the request's own handle; a tenant request never reaches the personal module. */
  actionsFor(db: ContextDb): ActionsModule;
  logger: Logger;
}

export function createActionDefinitionsRouter(deps: ActionDefinitionsRouteDeps): Router {
  const router = Router();

  const clampStored = (def: AnyActionDefinition, storedJson: string | null) =>
    clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });

  /**
   * The base a PUT merges its fields into: the stored row minus anything the read-time clamp would
   * override, or nothing if the row is rejected outright. A stale value the user did not send must
   * never block a valid save (spec 6.2: the owner can always save a valid value).
   */
  const mergeBase = (def: AnyActionDefinition, storedJson: string | null): Record<string, unknown> => {
    if (storedJson === null) return {};
    const clamp = clampStored(def, storedJson);
    if (clamp.rejected) return {};
    const base = JSON.parse(storedJson) as Record<string, unknown>;
    for (const path of clamp.clamped) {
      const approval = base.approval as { thresholds?: Record<string, unknown> } | undefined;
      if (path === "approval.mode") delete base.approval;
      else if (path.startsWith("approval.thresholds.")) delete approval?.thresholds?.[path.slice("approval.thresholds.".length)];
      else delete base[path];
    }
    return base;
  };

  const toView = (actions: ActionsModule, ctx: ActiveContext, def: AnyActionDefinition): ActionDefinitionView => {
    const { scope, ownerId } = ownerOf(ctx);
    const userId = ctx.identityId;
    const stored = actions.configRepo.get(scope, ownerId, def.type);
    const clamp = clampStored(def, stored?.configJson ?? null);
    if (clamp.clamped.length > 0 || clamp.rejected) {
      deps.logger.warn("Stored action config clamped on read", {
        userId,
        actionType: def.type,
        clamped: clamp.clamped,
        rejected: clamp.rejected,
      });
    }
    const last = actions.configRepo.history(scope, ownerId, def.type, 1)[0];
    const labels = Object.fromEntries(Object.entries(def.thresholdMetrics).map(([k, m]) => [k, m.label]));
    return {
      type: def.type,
      label: def.label,
      description: def.description,
      available: def.execute !== null,
      unavailableReason: def.unavailableReason,
      rollbackClass: def.rollbackClass,
      risk: { floor: def.floor.risk, effective: clamp.policy.risk },
      approval: { mode: clamp.policy.approval.mode, options: approvalOptions(def.floor, labels) },
      expiryHours: clamp.policy.expiryHours,
      enabled: clamp.policy.enabled,
      disableWarning: def.disableWarning,
      flags: { clamped: clamp.clamped, rejected: clamp.rejected },
      lastChange: last ? { changedBy: last.changedBy, changedAt: last.changedAt } : null,
    };
  };

  router.use((req, res, next) => {
    if (!req.activeContext || !req.contextDb) {
      res.status(403).json({ error: "context_unavailable" });
      return;
    }
    next();
  });

  router.get("/", (req, res) => {
    try {
      const actions = deps.actionsFor(req.contextDb!);
      res.json({ definitions: actions.registry.list().map((d) => toView(actions, req.activeContext!, d)) });
    } catch (error) {
      deps.logger.error("Action definitions list failed", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/:type/config", (req, res) => {
    const ctx = req.activeContext!;
    const userId = ctx.identityId;
    const actions = deps.actionsFor(req.contextDb!);
    const { scope, ownerId } = ownerOf(ctx);
    if (!actions.registry.has(req.params.type)) {
      res.status(404).json({ error: "Unknown action type" });
      return;
    }
    const def = actions.registry.get(req.params.type);
    if (def.execute === null) {
      res.status(403).json({ error: "This action is not available yet." });
      return;
    }
    const body = ActionConfigWriteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(422).json({ errors: body.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })) });
      return;
    }

    try {
      const next = mergeBase(def, actions.configRepo.get(scope, ownerId, def.type)?.configJson ?? null);
      if (body.data.enabled !== undefined) next.enabled = body.data.enabled;
      if (body.data.approvalMode !== undefined) {
        next.approval =
          body.data.approvalMode === "above_threshold"
            ? { mode: "above_threshold", thresholds: def.floor.approval.thresholds }
            : { mode: body.data.approvalMode };
      }

      const validated = validateConfigWrite({ floor: def.floor, declaredMetrics: Object.keys(def.thresholdMetrics), body: next });
      if (!validated.ok) {
        res.status(422).json({ errors: validated.errors });
        return;
      }
      actions.configRepo.save({ scope, ownerId, actionType: def.type, configJson: validated.configJson, changedBy: userId });
      deps.logger.info("Action config changed", { userId, actionType: def.type, config: validated.configJson });
      res.json(toView(actions, ctx, def));
    } catch (error) {
      deps.logger.error("Action config write failed", { userId, actionType: def.type, error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
