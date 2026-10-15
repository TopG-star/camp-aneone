import {
  LifecycleTransitionError,
  TransitionConflictError,
  maxRisk,
  tenantActor,
  type ActionInstance,
  type ActorContext,
  type JsonObject,
} from "@oneon/domain";
import { canAct, canApprove, decide, type EffectivePolicy } from "../policy/index.js";
import type { AnyActionDefinition } from "../definition.js";
import {
  HOUR,
  POLICY,
  SYSTEM,
  approvalAgeLimitHours,
  approvalExpired,
  effectivePolicyFor,
  expiryHoursOf,
  impressorxScope,
  move,
  releaseIfEnded,
} from "./shared.js";
import {
  ActionOperationError,
  ApprovalCheckError,
  type ActionRequest,
  type OrchestratorDeps,
  type RequestOutcome,
  type RequestSession,
} from "./types.js";

const CANCELLABLE = new Set(["proposed", "validating", "awaiting_approval", "approved"]);

export function loadOwned(deps: OrchestratorDeps, actor: ActorContext, actionId: string) {
  const ownerId = actor.scope === "personal" ? actor.userId : actor.tenantId ?? "";
  const instance = deps.repo.findById(ownerId, actionId);
  if (!instance) throw new ActionOperationError("not_found", "Action not found");
  const def: AnyActionDefinition = deps.registry.get(instance.actionType);
  return { instance, def, ownerId, policy: effectivePolicyFor(deps, instance.scope, ownerId, def).policy };
}

export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TransitionConflictError || error instanceof LifecycleTransitionError) {
      throw new ActionOperationError("conflict", "This action has changed. Reload and try again.");
    }
    throw error;
  }
}

export function createDecisions(
  deps: OrchestratorDeps,
  advance: (ownerId: string, actionId: string, session?: RequestSession) => Promise<ActionInstance>,
  requestAction: (req: ActionRequest) => Promise<RequestOutcome>,
) {
  /**
   * Spec §9.3: the stored snapshot only offers and refuses early. A tenant approval is checked with ImpressoRx now, before anything is
   * recorded, and judged on what it says: the approver's live role must be one of the action's approverRoles.
   */
  async function liveApprover(actor: ActorContext, instance: ActionInstance, policy: EffectivePolicy, session: RequestSession | undefined): Promise<ActorContext> {
    const tenantId = instance.tenantId!;
    const live = deps.delegation ? await deps.delegation.liveApprover(session, tenantId) : ({ ok: false, refusal: "launch_required" } as const);
    if (!live.ok) throw new ApprovalCheckError(live.refusal);
    const approver = tenantActor({
      identityId: actor.userId,
      tenantId,
      role: live.membership.role,
      permissions: live.membership.permissions,
      locationIds: live.membership.locationIds,
    });
    if (!canApprove(approver, instance, policy)) throw new ActionOperationError("not_allowed", "You can't approve this action.");
    return approver;
  }

  async function approve(actor: ActorContext, actionId: string, session?: RequestSession): Promise<ActionInstance> {
    const { instance, def, ownerId, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "awaiting_approval") throw new ActionOperationError("conflict", `Cannot approve an action that is ${instance.status}.`);
    if (!canApprove(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't approve this action.");
    // M1: past the window the request is expired (spec §7.2), whether or not the sweeper has run yet.
    if (approvalExpired(deps, instance, def, deps.clock().getTime())) {
      return guard(() => move(deps, instance, "expired", SYSTEM, { expiryHours: expiryHoursOf(deps, instance, def), attemptedBy: actor.userId }));
    }
    const approver = instance.scope === "tenant" ? await liveApprover(actor, instance, policy, session) : actor;
    const resolved = instance.resolved ?? { metrics: {} };
    const decision = decide({
      scope: def.scope,
      executorAvailable: def.execute !== null,
      policy,
      actor: approver,
      metrics: (resolved as { metrics: Record<string, number> }).metrics,
      risk: maxRisk(def.riskFor(resolved, policy.risk), policy.risk),
      now: deps.clock(),
    });
    const recorded = decision as unknown as JsonObject;
    if (decision.outcome === "refuse") {
      return guard(() => move(deps, instance, "rejected", POLICY, { decision: recorded, attemptedBy: actor.userId }, { decision: recorded }));
    }
    const approved = guard(() =>
      move(deps, instance, "approved", { kind: "user", userId: actor.userId }, { decision: recorded }, { decision: recorded }),
    );
    // Spec §7.1: the approval is what lets the action run later without the person. If ImpressoRx refuses the grant (unattended access
    // is off), the approval stands and the action runs now, in this request, with the person's own session.
    const ageLimit = approvalAgeLimitHours(approved, policy);
    if (ageLimit !== null && session) {
      const approvedAt = deps.repo.approvedAt(approved.id) ?? approved.updatedAt;
      await deps.delegation?.issueActionGrant({
        instance: approved,
        session,
        scope: impressorxScope(policy.requiredPermissions),
        absoluteExpiresAt: new Date(Date.parse(approvedAt) + ageLimit * HOUR).toISOString(),
      });
      // The action may have ended while ImpressoRx was being asked (a cancel in another request): its release found no grant to
      // revoke then, and the one just stored must not outlive it (spec 7.1).
      const after = deps.repo.findById(ownerId, approved.id);
      if (after) releaseIfEnded(deps, after);
    }
    return advance(ownerId, approved.id, session);
  }

  async function reject(actor: ActorContext, actionId: string, reason?: string): Promise<ActionInstance> {
    const { instance, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "awaiting_approval") throw new ActionOperationError("conflict", `Cannot reject an action that is ${instance.status}.`);
    if (!canApprove(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't reject this action.");
    return guard(() => move(deps, instance, "rejected", { kind: "user", userId: actor.userId }, { reason: reason ?? null }));
  }

  async function cancel(actor: ActorContext, actionId: string, reason = "withdrawn_by_owner"): Promise<ActionInstance> {
    const { instance, policy } = loadOwned(deps, actor, actionId);
    if (!CANCELLABLE.has(instance.status)) throw new ActionOperationError("conflict", `Cannot cancel an action that is ${instance.status}.`);
    if (!canAct(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't cancel this action.");
    return guard(() => move(deps, instance, "cancelled", { kind: "user", userId: actor.userId }, { reason }));
  }

  async function retry(actor: ActorContext, actionId: string, session?: RequestSession): Promise<RequestOutcome> {
    const { instance, def, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "failed" && instance.status !== "expired") {
      throw new ActionOperationError("not_allowed", "Only failed or expired actions can be tried again.");
    }
    if (!def.execute || !policy.enabled || !canAct(actor, instance, policy)) {
      throw new ActionOperationError("not_allowed", "This action can't be tried again.");
    }
    return requestAction({
      type: instance.actionType,
      input: instance.input,
      actor,
      initiator: "user",
      keyContext: { source: "rule", resourceId: instance.resourceRef ?? instance.id },
      evidence: [
        ...instance.evidence,
        { kind: "retry_of", source: "oneon", asOf: deps.clock().toISOString(), data: { actionId: instance.id, previousError: instance.error } },
      ],
      resourceRef: instance.resourceRef,
      retryOf: { id: instance.id, attemptNumber: instance.attemptNumber, idempotencyKey: instance.idempotencyKey },
      session,
    });
  }

  return { approve, reject, cancel, retry };
}
