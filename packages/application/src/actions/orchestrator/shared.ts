import {
  personalActor,
  type ActionInstance,
  type ActorContext,
  type ActorRef,
  type InstancePatch,
  type JsonObject,
  type LifecycleStatus,
} from "@oneon/domain";
import { clampPolicy, type ClampResult, type PolicyDecision } from "../policy/index.js";
import type { AnyActionDefinition } from "../definition.js";
import { canonicalJson } from "../idempotency.js";
import type { OrchestratorDeps } from "./types.js";

export const SYSTEM: ActorRef = { kind: "system" };
export const POLICY: ActorRef = { kind: "policy" };
export const SWEEPER: ActorRef = { kind: "sweeper" };

export function actorForInstance(instance: ActionInstance): ActorContext {
  if (instance.scope === "personal") return personalActor(instance.userId);
  throw new Error("Tenant-scope actions are not supported until sub-project B");
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

export function move(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  to: LifecycleStatus,
  actor: ActorRef,
  data: JsonObject = {},
  patch?: InstancePatch,
): ActionInstance {
  return deps.repo.appendTransition({ actionId: instance.id, expectedStatus: instance.status, toStatus: to, actor, data, patch });
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
