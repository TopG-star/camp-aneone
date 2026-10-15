import {
  DelegationRevokedError,
  personalActor,
  tenantActor,
  type ActionInstance,
  type ActorContext,
  type ActorRef,
  type InstancePatch,
  type JsonObject,
  type MembershipLike,
  type LifecycleStatus,
} from "@oneon/domain";
import { TENANT_MAX_APPROVAL_AGE_HOURS, clampPolicy, type ClampResult, type EffectivePolicy, type PolicyDecision } from "../policy/index.js";
import type { AnyActionDefinition } from "../definition.js";
import { canonicalJson } from "../idempotency.js";
import type { OrchestratorDeps } from "./types.js";

export const SYSTEM: ActorRef = { kind: "system" };
export const POLICY: ActorRef = { kind: "policy" };
export const SWEEPER: ActorRef = { kind: "sweeper" };

/** Personal: the owner. Tenant: rebuilt from the membership as it is now, so a suspension or role change applies at once. */
export function actorForInstance(
  instance: ActionInstance,
  memberships: { activeFor(identityId: string, tenantId: string): MembershipLike | null },
): ActorContext {
  if (instance.scope === "personal") return personalActor(instance.userId);
  const membership = instance.tenantId ? memberships.activeFor(instance.userId, instance.tenantId) : null;
  if (!membership) throw new DelegationRevokedError();
  return tenantActor({
    identityId: instance.userId,
    tenantId: instance.tenantId!,
    role: membership.role,
    permissions: membership.permissions,
    locationIds: membership.locationIds,
  });
}

export function effectivePolicyFor(
  deps: OrchestratorDeps,
  scope: ActionInstance["scope"],
  ownerId: string,
  def: AnyActionDefinition,
): ClampResult {
  const stored = deps.configRepo.get(scope, ownerId, def.type);
  const result = clampPolicy({
    floor: def.floor,
    defaults: def.defaults,
    storedJson: stored?.configJson ?? null,
    declaredMetrics: Object.keys(def.thresholdMetrics),
    executorAvailable: def.execute !== null,
  });
  if (result.clamped.length > 0) {
    deps.logger.warn("Action config looser than its floor; using the floor", { actionType: def.type, ownerId, fields: result.clamped });
  }
  if (result.rejected) {
    deps.logger.warn("Action config rejected; using defaults", { actionType: def.type, ownerId, reason: result.rejected });
  }
  return result;
}

/**
 * Statuses an action does not leave on its own. Spec §7.1: a tenant action's grant dies here. (completed and partially_completed
 * can still be undone, but B-core has no tenant undo, and an undo would need a person present to approve a new grant anyway.)
 */
const ENDS_GRANT: ReadonlySet<LifecycleStatus> = new Set([
  "completed",
  "partially_completed",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "rolled_back",
  "rollback_failed",
]);

/**
 * Every status change goes through here (spec §8.3 invariant 2), so this is where "a tenant action's grant dies with it" is enforced:
 * whichever path ends the action (the orchestrator, a person, the sweeper), its grant is released after the transition is recorded.
 */
export function move(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  to: LifecycleStatus,
  actor: ActorRef,
  data: JsonObject = {},
  patch?: InstancePatch,
): ActionInstance {
  const next = deps.repo.appendTransition({ actionId: instance.id, expectedStatus: instance.status, toStatus: to, actor, data, patch });
  releaseIfEnded(deps, next);
  return next;
}

/** A tenant action that has reached a final status gives up its grant. Never throws. */
export function releaseIfEnded(deps: OrchestratorDeps, instance: ActionInstance): void {
  if (instance.scope !== "tenant" || !ENDS_GRANT.has(instance.status)) return;
  try {
    deps.delegation?.release(instance);
  } catch (error) {
    // The action is already over; a grant that could not be released is revoked by its own expiry at the latest.
    deps.logger.warn("Releasing an action's grant failed", { actionId: instance.id, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Spec §7.6: how long a tenant action's approval stays good; null for actions without a limit (personal). It is the shorter of the
 * limit in force when the approval was given (carried by the decision recorded with it, its policy; the grant was issued to expire
 * with it) and the current one: raising the configured limit cannot extend an approval that already exists, and lowering it takes
 * effect at once. A decision without a recorded limit falls back to the current policy.
 */
export function approvalAgeLimitHours(instance: Pick<ActionInstance, "scope" | "decision">, currentPolicy: EffectivePolicy): number | null {
  if (instance.scope !== "tenant") return null;
  const current = currentPolicy.maxApprovalAgeHours ?? TENANT_MAX_APPROVAL_AGE_HOURS;
  const recorded = (instance.decision as { policy?: { maxApprovalAgeHours?: number } } | null)?.policy?.maxApprovalAgeHours;
  return recorded === undefined ? current : Math.min(recorded, current);
}

/** A tenant actor's permissions carry this prefix (domain tenantActor); ImpressoRx knows them without it. */
const IMPRESSORX_PREFIX = "impressorx:";

/** The permissions of a policy that are ImpressoRx's, as ImpressoRx names them. Anything else is not for ImpressoRx to grant. */
export function impressorxScope(permissions: readonly string[]): string[] {
  return permissions.filter((p) => p.startsWith(IMPRESSORX_PREFIX)).map((p) => p.slice(IMPRESSORX_PREFIX.length));
}

export function decisionOf(instance: ActionInstance): PolicyDecision | null {
  return instance.decision as unknown as PolicyDecision | null;
}

export const HOUR = 3_600_000;

/** The approval window recorded with the decision, else the current effective policy's. */
export function expiryHoursOf(deps: OrchestratorDeps, instance: ActionInstance, def: AnyActionDefinition): number {
  return decisionOf(instance)?.policy?.expiryHours ?? effectivePolicyFor(deps, instance.scope, instance.ownerId, def).policy.expiryHours;
}

/** Spec §7.2: an approval request is expired once its window has passed since it started waiting. */
export function approvalExpired(deps: OrchestratorDeps, instance: ActionInstance, def: AnyActionDefinition, now: number): boolean {
  return now - Date.parse(instance.updatedAt) > expiryHoursOf(deps, instance, def) * HOUR;
}

export function consequencesDiffer(keys: readonly string[], approved: JsonObject | null, current: JsonObject): boolean {
  return keys.some((k) => canonicalJson(approved?.[k] ?? null) !== canonicalJson(current[k] ?? null));
}

export function describeInstance(def: AnyActionDefinition, instance: Pick<ActionInstance, "resolved" | "input">): string {
  if (!instance.resolved) return def.label;
  try {
    return def.describe(instance.resolved, instance.input);
  } catch {
    return def.label;
  }
}

export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function quietly(deps: OrchestratorDeps, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    deps.logger.error(`Failed to send ${what}`, { error: error instanceof Error ? error.message : String(error) });
  }
}
