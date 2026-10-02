import type { ActionInstance, ActorContext, CheckResult, JsonObject } from "@oneon/domain";
import { canAct } from "../policy/index.js";
import type { AnyActionDefinition, ExecutionOutcome, UndoContext } from "../definition.js";
import { fromExternalError } from "../definitions/outcomes.js";
import { guard, loadOwned } from "./decisions.js";
import { SYSTEM, describeInstance, move, quietly, withTimeout } from "./shared.js";
import { ActionOperationError, type OrchestratorDeps } from "./types.js";

export function createUndo(deps: OrchestratorDeps) {
  const reload = (instance: ActionInstance) => deps.repo.findById(instance.ownerId, instance.id)!;

  async function fail(instance: ActionInstance, def: AnyActionDefinition, code: string, message: string, data: JsonObject) {
    deps.logger.warn("Undo did not finish", { actionId: instance.id, code, message });
    const failed = move(deps, reload(instance), "rollback_failed", SYSTEM, data, { error: { code, message, stage: "undo" } });
    await quietly(deps, "rollback failure notification", () =>
      deps.notifier.rollbackFailed(failed, `Undo of: ${describeInstance(def, failed)}`),
    );
    return failed;
  }

  /** Spec §10.6 and §7.4. Never retried automatically. */
  async function continueUndo(instance: ActionInstance): Promise<ActionInstance> {
    const def = deps.registry.get(instance.actionType);
    if (!def.undo || !instance.undo) return fail(instance, def, "nothing_to_undo", "Nothing was recorded to undo this action.", {});
    const caps = deps.capabilities(instance.userId);
    const ctx: UndoContext<unknown, never> = {
      input: instance.input,
      resolved: instance.resolved as never,
      result: instance.result,
      undo: instance.undo,
      readers: caps.readers,
      writers: caps.writers,
    };
    const wasStarted = instance.undoStartedAt !== null;

    if (!wasStarted) {
      let checks;
      try {
        checks = await def.undo.preconditions(ctx);
      } catch (error) {
        deps.logger.warn("Undo preconditions could not be read; the sweeper will retry", { actionId: instance.id, error: String(error) });
        return instance;
      }
      const refused = checks.find((c) => !c.passed);
      if (refused) {
        return fail(instance, def, refused.failureCode, `Undo refused: ${refused.failureCode}`, { checks } as unknown as JsonObject);
      }
      deps.repo.markUndoStarted(instance.id, deps.clock().toISOString());
      let outcome: ExecutionOutcome;
      try {
        outcome = await withTimeout(def.undo.execute(ctx), def.executionTimeoutMs, () => ({
          kind: "unknown",
          code: "timeout",
          message: `No response within ${def.executionTimeoutMs} ms`,
        }));
      } catch (error) {
        outcome = fromExternalError(error);
      }
      if (outcome.kind === "definite_failure") return fail(instance, def, outcome.code, outcome.message, { outcome: outcome.kind });
      if (outcome.kind === "unknown") {
        deps.logger.warn("Undo outcome unknown; the sweeper will verify", { actionId: instance.id, code: outcome.code });
        return reload(instance);
      }
    }

    let checks: CheckResult[];
    try {
      checks = await def.undo.verify(ctx);
    } catch (error) {
      deps.logger.warn("Undo verification could not read the outcome; the sweeper will retry", { actionId: instance.id, error: String(error) });
      return reload(instance);
    }
    if (checks.every((c) => c.passed)) {
      return move(deps, reload(instance), "rolled_back", SYSTEM, { checks } as unknown as JsonObject, { error: null });
    }
    return wasStarted
      ? fail(instance, def, "interrupted", "The undo was interrupted and could not be confirmed.", { checks } as unknown as JsonObject)
      : fail(instance, def, "undo_unverified", "The undo could not be confirmed.", { checks } as unknown as JsonObject);
  }

  async function requestUndo(actor: ActorContext, actionId: string): Promise<ActionInstance> {
    const { instance, def, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "completed" && instance.status !== "partially_completed") {
      throw new ActionOperationError("conflict", `Cannot undo an action that is ${instance.status}.`);
    }
    if (def.rollbackClass === "irreversible" || !def.undo) {
      throw new ActionOperationError("not_allowed", "This action cannot be automatically reversed.");
    }
    if (!canAct(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't undo this action.");
    if (!instance.undo) throw new ActionOperationError("not_allowed", "Nothing was recorded to undo this action.");
    const rolling = guard(() => move(deps, instance, "rolling_back", { kind: "user", userId: actor.userId }, { requestedBy: actor.userId }));
    return continueUndo(rolling);
  }

  return { requestUndo, continueUndo };
}
