import { IN_PROGRESS_STATUSES, TransitionConflictError, type ActionInstance } from "@oneon/domain";
import type { AnyActionDefinition } from "../definition.js";
import { SWEEPER, SYSTEM, decisionOf, effectivePolicyFor, move } from "./shared.js";
import type { OrchestratorDeps } from "./types.js";

const HOUR = 3_600_000;

export function createSweeper(
  deps: OrchestratorDeps,
  advance: (ownerId: string, actionId: string) => Promise<ActionInstance>,
  continueUndo: (instance: ActionInstance) => Promise<ActionInstance>,
) {
  const expiryHoursOf = (instance: ActionInstance, def: AnyActionDefinition) =>
    decisionOf(instance)?.policy?.expiryHours ?? effectivePolicyFor(deps, instance.scope, instance.ownerId, def).policy.expiryHours;

  async function recover(instance: ActionInstance, def: AnyActionDefinition, now: number): Promise<void> {
    switch (instance.status) {
      case "proposed":
      case "validating":
      case "verifying":
        await advance(instance.ownerId, instance.id);
        return;
      case "approved":
        if (now - Date.parse(instance.updatedAt) > expiryHoursOf(instance, def) * HOUR) {
          move(deps, instance, "cancelled", SWEEPER, { reason: "stale_approval" });
          return;
        }
        await advance(instance.ownerId, instance.id);
        return;
      case "executing":
        // Never re-run the executor; verification decides (spec §7.4).
        move(deps, instance, "verifying", SWEEPER, { reason: "recovered_after_interruption" });
        await advance(instance.ownerId, instance.id);
        return;
      case "rolling_back":
        await continueUndo(instance);
        return;
      default:
        return;
    }
  }

  async function sweep(ownerId: string): Promise<{ recovered: number }> {
    const now = deps.clock().getTime();
    let recovered = 0;
    for (const instance of deps.repo.list(ownerId, { statuses: IN_PROGRESS_STATUSES, limit: 500 })) {
      if (!deps.registry.has(instance.actionType)) continue;
      const def = deps.registry.get(instance.actionType);
      const lastActivity = Math.max(Date.parse(instance.updatedAt), instance.lastHeartbeatAt ? Date.parse(instance.lastHeartbeatAt) : 0);
      if (now - lastActivity < def.recoveryThresholdMs) continue;
      try {
        await recover(instance, def, now);
        recovered++;
      } catch (error) {
        if (error instanceof TransitionConflictError) continue; // someone else moved it first
        deps.logger.error("Action recovery failed", { actionId: instance.id, status: instance.status, error: String(error) });
      }
    }
    return { recovered };
  }

  async function expireStale(ownerId: string): Promise<number> {
    const now = deps.clock().getTime();
    let expired = 0;
    for (const instance of deps.repo.list(ownerId, { statuses: ["awaiting_approval"], limit: 500 })) {
      if (!deps.registry.has(instance.actionType)) continue;
      const hours = expiryHoursOf(instance, deps.registry.get(instance.actionType));
      if (now - Date.parse(instance.updatedAt) <= hours * HOUR) continue;
      try {
        move(deps, instance, "expired", SYSTEM, { expiryHours: hours });
        expired++;
      } catch (error) {
        if (!(error instanceof TransitionConflictError)) throw error;
      }
    }
    return expired;
  }

  return { sweep, expireStale };
}
