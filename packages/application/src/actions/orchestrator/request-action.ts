import type { ActionInstance, ActorRef } from "@oneon/domain";
import { retryKey } from "../idempotency.js";
import type { ActionRequest, OrchestratorDeps, RequestOutcome } from "./types.js";

export function createRequestAction(
  deps: OrchestratorDeps,
  advance: (ownerId: string, actionId: string) => Promise<ActionInstance>,
) {
  return async function requestAction(req: ActionRequest): Promise<RequestOutcome> {
    if (!deps.registry.has(req.type)) {
      deps.logger.warn("Refused an unregistered action type", { type: req.type, initiator: req.initiator });
      return { kind: "refused", reason: "unknown_type", issues: [`"${req.type}" is not an action Oneon can take.`] };
    }
    const def = deps.registry.get(req.type);
    if (def.scope !== req.actor.scope) {
      return { kind: "refused", reason: "scope_mismatch", issues: [`${req.type} is a ${def.scope} action.`] };
    }
    const parsed = def.inputSchema.safeParse(req.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
      deps.logger.warn("Refused invalid action input", { type: req.type, initiator: req.initiator, issues });
      return { kind: "refused", reason: "invalid_input", issues };
    }

    const ownerId = req.actor.scope === "personal" ? req.actor.userId : req.actor.tenantId!;
    const idempotencyKey = req.retryOf
      ? retryKey(req.retryOf.idempotencyKey, req.retryOf.attemptNumber)
      : def.idempotencyKey(parsed.data, req.keyContext);
    const actor: ActorRef = req.initiator === "user" ? { kind: "user", userId: req.actor.userId } : { kind: "system" };

    const { instance, created } = deps.repo.create(
      {
        id: deps.newId(),
        scope: def.scope,
        ownerId,
        userId: req.actor.userId,
        tenantId: req.actor.tenantId,
        locationIds: req.actor.scope === "personal" ? [] : req.actor.locationIds,
        actionType: def.type,
        definitionVersion: def.version,
        initiator: req.initiator,
        initiatorUserId: req.initiator === "user" ? req.actor.userId : null,
        input: parsed.data,
        evidence: req.evidence,
        idempotencyKey,
        retryOf: req.retryOf?.id ?? null,
        attemptNumber: req.retryOf ? req.retryOf.attemptNumber + 1 : 1,
        resourceRef: req.resourceRef,
      },
      actor,
      { initiator: req.initiator },
    );
    if (!created) return { kind: "duplicate", instance };
    return { kind: "created", instance: await advance(ownerId, instance.id) };
  };
}
