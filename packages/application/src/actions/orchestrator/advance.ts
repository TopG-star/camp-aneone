import {
  ActionNotFoundError,
  TransitionConflictError,
  maxRisk,
  type ActionCapabilities,
  type ActionInstance,
  type ActorContext,
  type JsonObject,
} from "@oneon/domain";
import { decide, isStricter } from "../policy/index.js";
import type { AnyActionDefinition, ExecutionOutcome, PreconditionResult, Resolved } from "../definition.js";
import { fromExternalError } from "../definitions/outcomes.js";
import {
  POLICY,
  SYSTEM,
  actorForInstance,
  consequencesDiffer,
  decisionOf,
  effectivePolicyFor,
  move,
  quietly,
  withTimeout,
} from "./shared.js";
import type { OrchestratorDeps } from "./types.js";

export function createAdvance(deps: OrchestratorDeps) {
  return async function advance(ownerId: string, actionId: string): Promise<ActionInstance> {
    let instance = deps.repo.findById(ownerId, actionId);
    if (!instance) throw new ActionNotFoundError(actionId);
    const def = deps.registry.get(instance.actionType);
    const caps = deps.capabilities(instance.userId);
    const actor = actorForInstance(instance);

    for (let step = 0; step < 10; step++) {
      const before = instance.status;
      try {
        switch (instance.status) {
          case "proposed":
            instance = move(deps, instance, "validating", SYSTEM);
            break;
          case "validating":
            instance = await validate(deps, instance, def, caps, actor);
            break;
          case "approved":
            instance = await executeApproved(deps, instance, def, caps, actor);
            break;
          case "verifying":
            instance = await verify(deps, instance, def, caps);
            break;
          default:
            return instance;
        }
      } catch (error) {
        // Someone else (a person or the sweeper) moved the action first; their transition stands.
        if (error instanceof TransitionConflictError) return deps.repo.findById(ownerId, actionId)!;
        throw error;
      }
      if (instance.status === before) return instance;
    }
    return instance;
  };
}

function splitFailures(checks: PreconditionResult[]) {
  const failed = checks.filter((c) => !c.passed);
  return { obsolete: failed.find((c) => c.kind === "obsolete"), blocking: failed.find((c) => c.kind === "blocking") };
}

async function validate(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  def: AnyActionDefinition,
  caps: ActionCapabilities,
  actor: ActorContext,
): Promise<ActionInstance> {
  const ctx = { input: instance.input, actor, readers: caps.readers, now: deps.clock() };
  let checks: PreconditionResult[];
  try {
    checks = await def.preconditions(ctx);
  } catch (error) {
    deps.logger.warn("Preconditions could not be evaluated; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  const { obsolete, blocking } = splitFailures(checks);
  if (obsolete) {
    return move(deps, instance, "cancelled", SYSTEM, { checks, reason: obsolete.id }, {
      error: { code: obsolete.id, message: `No longer applicable: ${obsolete.id}`, stage: "validation" },
    });
  }
  if (blocking) {
    return move(deps, instance, "failed", SYSTEM, { checks }, {
      error: { code: blocking.id, message: `Precondition not met: ${blocking.id}`, stage: "validation" },
    });
  }

  let resolved;
  try {
    resolved = await def.resolve(ctx);
  } catch (error) {
    deps.logger.warn("Resolve could not read current state; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  if (!resolved.ok) return move(deps, instance, "failed", SYSTEM, { checks }, { error: resolved.error });

  const { policy } = effectivePolicyFor(deps, instance.scope, instance.ownerId, def);
  const risk = maxRisk(def.riskFor(resolved.resolved, policy.risk), policy.risk);
  const decision = decide({
    scope: def.scope,
    executorAvailable: def.execute !== null,
    policy,
    actor,
    metrics: resolved.resolved.metrics,
    risk,
    now: deps.clock(),
  });
  const patch = { resolved: resolved.resolved, decision: decision as unknown as JsonObject };
  const data = { checks, decision } as unknown as JsonObject;

  if (decision.outcome === "refuse") return move(deps, instance, "rejected", POLICY, data, patch);
  if (decision.outcome === "needs_approval") {
    const waiting = move(deps, instance, "awaiting_approval", POLICY, data, patch);
    await quietly(deps, "approval notification", () =>
      deps.notifier.awaitingApproval(waiting, def.describe(resolved.resolved, instance.input)),
    );
    return waiting;
  }
  return move(deps, instance, "approved", POLICY, data, patch);
}

async function executeApproved(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  def: AnyActionDefinition,
  caps: ActionCapabilities,
  actor: ActorContext,
): Promise<ActionInstance> {
  const now = deps.clock();
  const ctx = { input: instance.input, actor, readers: caps.readers, now };

  let checks: PreconditionResult[];
  try {
    checks = await def.preconditions(ctx);
  } catch (error) {
    deps.logger.warn("Re-check could not be evaluated; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  const { obsolete, blocking } = splitFailures(checks);
  if (obsolete) {
    return move(deps, instance, "cancelled", SYSTEM, { checks, reason: obsolete.id }, {
      error: { code: obsolete.id, message: `No longer applicable: ${obsolete.id}`, stage: "recheck" },
    });
  }
  if (blocking) {
    return move(deps, instance, "failed", SYSTEM, { checks }, {
      error: { code: blocking.id, message: `Precondition not met: ${blocking.id}`, stage: "recheck" },
    });
  }

  let current;
  try {
    current = await def.resolve(ctx);
  } catch (error) {
    deps.logger.warn("Re-check could not read current state; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  if (!current.ok) return move(deps, instance, "failed", SYSTEM, { checks }, { error: { ...current.error, stage: "recheck" } });

  const approved = instance.resolved as Resolved;
  if (consequencesDiffer(def.consequenceKeys, approved, current.resolved)) {
    return move(deps, instance, "failed", SYSTEM, { checks, approved, current: current.resolved } as unknown as JsonObject, {
      error: { code: "changed_since_approval", message: "What this action would do changed after it was approved.", stage: "recheck" },
    });
  }

  const { policy } = effectivePolicyFor(deps, instance.scope, instance.ownerId, def);
  const decision = decide({
    scope: def.scope,
    executorAvailable: def.execute !== null,
    policy,
    actor,
    metrics: current.resolved.metrics,
    risk: maxRisk(def.riskFor(current.resolved, policy.risk), policy.risk),
    now,
  });
  const recorded = decisionOf(instance)?.outcome ?? "auto";
  if (isStricter(decision.outcome, recorded) || !def.execute) {
    const refused = decision.outcome === "refuse" || !def.execute;
    return move(deps, instance, "failed", SYSTEM, { decision } as unknown as JsonObject, {
      error: {
        code: refused ? "policy_refused_now" : "approval_required_now",
        message: refused ? "Policy no longer allows this action." : "This action now needs approval.",
        stage: "recheck",
      },
    });
  }

  const executorRequestId = instance.id.replace(/-/g, "");
  const executing = move(deps, instance, "executing", SYSTEM, { checks } as unknown as JsonObject, {
    executionStartedAt: now.toISOString(),
    executorRequestId,
  });

  // The definition's timeout is the only deadline for the write (spec §10.2, §10.4): it aborts the
  // in-flight request. An aborted request may still have been applied, so the outcome is unknown.
  const abort = new AbortController();
  let outcome: ExecutionOutcome;
  try {
    outcome = await withTimeout(
      def.execute({
        instanceId: executing.id,
        input: executing.input,
        resolved: approved,
        actor,
        executorRequestId,
        writers: caps.writers,
        signal: abort.signal,
        heartbeat: () => deps.repo.recordHeartbeat(executing.id, deps.clock().toISOString()),
        now,
      }),
      def.executionTimeoutMs,
      () => {
        abort.abort();
        return { kind: "unknown", code: "timeout", message: `No response within ${def.executionTimeoutMs} ms` };
      },
    );
  } catch (error) {
    outcome = fromExternalError(error);
  }

  if (outcome.kind === "succeeded") {
    return move(deps, executing, "verifying", SYSTEM, { outcome: "succeeded" }, { result: outcome.result, undo: outcome.undoData, error: null });
  }
  if (outcome.kind === "unknown") {
    return move(deps, executing, "verifying", SYSTEM, { outcome: "unknown", code: outcome.code }, {
      error: { code: outcome.code, message: outcome.message, stage: "execution" },
    });
  }
  return move(deps, executing, "failed", SYSTEM, { outcome: "definite_failure", code: outcome.code }, {
    error: { code: outcome.code, message: outcome.message, stage: "execution" },
  });
}

async function verify(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  def: AnyActionDefinition,
  caps: ActionCapabilities,
): Promise<ActionInstance> {
  if (!def.postconditions) {
    return move(deps, instance, "failed", SYSTEM, {}, { error: { code: "no_verification", message: "This action cannot be verified.", stage: "verification" } });
  }
  let verification;
  try {
    verification = await def.postconditions({
      input: instance.input,
      resolved: instance.resolved,
      result: instance.result,
      executorRequestId: instance.executorRequestId ?? instance.id.replace(/-/g, ""),
      readers: caps.readers,
    });
  } catch (error) {
    deps.logger.warn("Verification could not read the outcome; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  const { checks, effectCheckId, undoData } = verification;
  const effect = checks.find((c) => c.id === effectCheckId);
  const data = { checks } as unknown as JsonObject;
  if (!effect?.passed) {
    // After an unknown outcome the write may still land (a request Google accepted just as it was
    // aborted). "failed" means no effect, so wait until the recovery threshold has passed; the
    // sweeper re-verifies stuck `verifying` actions (spec §7.2, §7.4).
    if (instance.error?.stage === "execution") {
      const startedAt = Date.parse(instance.executionStartedAt ?? instance.updatedAt);
      if (deps.clock().getTime() < startedAt + def.recoveryThresholdMs) {
        deps.logger.info("Effect not visible yet after an unknown outcome; will check again", { actionId: instance.id });
        return instance;
      }
    }
    return move(deps, instance, "failed", SYSTEM, data, {
      error: { code: "effect_absent", message: "The change was not found after execution.", stage: "verification" },
    });
  }
  // After an unknown outcome the executor recorded no undo data; take it from the verification read.
  const undo = instance.undo === null && undoData ? { undo: undoData } : {};
  if (checks.every((c) => c.passed)) return move(deps, instance, "completed", SYSTEM, data, { error: null, ...undo });
  const failedIds = checks.filter((c) => !c.passed).map((c) => c.id).join(", ");
  return move(deps, instance, "partially_completed", SYSTEM, data, {
    error: { code: "checks_failed", message: `Some checks failed: ${failedIds}`, stage: "verification" },
    ...undo,
  });
}
