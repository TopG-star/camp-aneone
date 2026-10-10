import { Router, type Request, type Response } from "express";
import { TenantAiLimitWriteSchema, type TenantAiLimitView } from "@oneon/contracts";
import type { Logger } from "@oneon/domain";
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  classRank,
  providerLimit,
  type ProviderEntry,
  type ProviderId,
  type ProviderOverride,
} from "@oneon/application";
import type { MembershipRepository, TenantAiLimitRepository, TenantLimitClass } from "@oneon/infrastructure";
import { IMPRESSORX_UNREACHABLE, LAUNCH_REQUIRED, SUSPENDED, type SnapshotRefresher } from "../middleware/active-context.js";

/** The ImpressoRx permission code (raw, as the snapshot carries it) that lets a person manage Oneon for their pharmacy. */
const MANAGE_ONEON = "settings.oneon";

export interface TenantSettingsRouteDeps {
  limits: Pick<TenantAiLimitRepository, "current" | "history" | "change">;
  memberships: Pick<MembershipRepository, "findById">;
  /** The live ImpressoRx check: it applies the snapshot to the membership and classifies a refusal the same way a context refresh does. */
  snapshots: Pick<SnapshotRefresher, "checkLive">;
  /** The provider registry; the platform's own unless a test brings its own. */
  registry?: Record<ProviderId, ProviderEntry>;
  configuredProviders: ProviderId[];
  overrides: Map<ProviderId, ProviderOverride>;
  clock?: () => Date;
  logger: Logger;
}

type TenantContext = Extract<NonNullable<Request["activeContext"]>, { kind: "tenant" }>;

/**
 * The pharmacy's AI data limit (spec 9.4). Mount behind the context chain (session, requireUser, resolveActiveContext): the pharmacy
 * is the active context's registration and nothing in the request names one.
 */
export function createTenantSettingsRouter(deps: TenantSettingsRouteDeps): Router {
  const router = Router();
  const registry = deps.registry ?? PROVIDER_REGISTRY;
  const clock = deps.clock ?? (() => new Date());

  router.use((req, res, next) => {
    if (req.activeContext?.kind !== "tenant") {
      res.status(403).json({ error: "tenant_context_required" });
      return;
    }
    next();
  });

  const view = (ctx: TenantContext, canChange: boolean): TenantAiLimitView => ({
    current: deps.limits.current(ctx.registrationId),
    history: deps.limits.history(ctx.registrationId).map((v) => ({ id: v.id, maxClass: v.maxClass, at: v.createdAt, byYou: v.setBy === ctx.identityId })),
    canChange,
  });

  /**
   * The providers that allow a raise to `maxClass` (spec 9.4): configured, with a tenant limit (after the platform's overrides) that
   * reaches the class. A raise to D2 also needs the provider to be reviewed and to hold a signed DPA for pharmacy data, and the
   * evidence then carries both. Null when no provider allows it.
   */
  function raiseEvidence(maxClass: TenantLimitClass): Record<string, unknown> | null {
    const needsReview = classRank(maxClass) >= classRank("D2");
    const providers = PROVIDER_IDS.flatMap((id) => {
      const entry = registry[id];
      const ceiling = providerLimit(entry, "tenant", deps.overrides.get(id));
      if (!deps.configuredProviders.includes(id) || ceiling === "suspended" || ceiling === "unknown" || classRank(ceiling) < classRank(maxClass)) return [];
      if (!needsReview) return [{ id, tenantCeiling: ceiling }];
      if (entry.review !== "reviewed" || !entry.tenantDpa) return [];
      return [{ id, tenantCeiling: ceiling, review: entry.review, tenantDpa: entry.tenantDpa }];
    });
    return providers.length > 0 ? { requested: maxClass, providers } : null;
  }

  const refuseLive = (res: Response, reason: "membership_suspended" | "launch_required" | "impressorx_unreachable") => {
    if (reason === "impressorx_unreachable") res.status(503).json(IMPRESSORX_UNREACHABLE);
    else res.status(403).json(reason === "membership_suspended" ? SUSPENDED : LAUNCH_REQUIRED);
  };

  router.get("/ai-limit", (req, res) => {
    const ctx = req.activeContext as TenantContext;
    try {
      // Whether to show the control comes from the cached snapshot; the change itself is checked live.
      const canChange = deps.memberships.findById(ctx.membershipId)?.permissions.includes(MANAGE_ONEON) ?? false;
      res.json(view(ctx, canChange));
    } catch (error) {
      deps.logger.error("Failed to read the pharmacy AI limit", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/ai-limit", async (req, res) => {
    const ctx = req.activeContext as TenantContext;
    const parsed = TenantAiLimitWriteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const { maxClass } = parsed.data;
    if (maxClass === "D3" || maxClass === "D4") {
      res.status(400).json({ error: "class_not_allowed" });
      return;
    }
    try {
      const membership = deps.memberships.findById(ctx.membershipId);
      if (!membership) {
        res.status(403).json({ error: "context_unavailable" });
        return;
      }
      // Always live, whatever the cached snapshot says: a refusal, or ImpressoRx being out of reach, changes nothing.
      const live = await deps.snapshots.checkLive({ sessionId: req.sessionId, membership });
      if (!live.ok) {
        refuseLive(res, live.reason);
        return;
      }
      if (!live.membership.permissions.includes(MANAGE_ONEON)) {
        res.status(403).json({ error: "permission_required" });
        return;
      }
      const liveCheckRef = JSON.stringify({ tokenVersion: live.tokenVersion, checkedAt: clock().toISOString() });
      // Lowering or keeping the class is always written. A raise is decided against the newest row, inside the write.
      const change = deps.limits.change({ registrationId: ctx.registrationId, maxClass, setBy: ctx.identityId, liveCheckRef }, () => raiseEvidence(maxClass));
      if (!change.ok) {
        res.status(409).json({ error: "prerequisites_missing" });
        return;
      }
      res.json(view(ctx, true));
    } catch (error) {
      deps.logger.error("Failed to change the pharmacy AI limit", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
