import type { ActionInstance, ActorContext } from "@oneon/domain";
import type { EffectivePolicy } from "./types.js";

export type ActionOperation = "approve" | "reject" | "cancel" | "undo" | "retry";

type Owned = Pick<ActionInstance, "scope" | "ownerId">;

function ownsScope(actor: ActorContext, instance: Owned): boolean {
  return instance.scope === "personal"
    ? actor.scope === "personal" && actor.userId === instance.ownerId
    : actor.scope === "tenant" && actor.tenantId === instance.ownerId;
}

export function canApprove(actor: ActorContext, instance: Owned, policy: EffectivePolicy): boolean {
  return ownsScope(actor, instance) && actor.roles.some((r) => policy.approverRoles.includes(r));
}

/** Cancel, undo and retry need the same authority as running the action. */
export function canAct(actor: ActorContext, instance: Owned, policy: EffectivePolicy): boolean {
  return ownsScope(actor, instance) && policy.requiredPermissions.every((p) => actor.permissions.includes(p));
}

const CANCELLABLE = new Set(["proposed", "validating", "awaiting_approval", "approved"]);

/** Spec §11.2. The UI draws only these buttons. */
export function allowedOperations(
  viewer: ActorContext,
  instance: Pick<ActionInstance, "scope" | "ownerId" | "status">,
  ctx: {
    policy: EffectivePolicy;
    rollbackClass: "reversible" | "conditional" | "irreversible";
    hasUndo: boolean;
    executorAvailable: boolean;
    legacy?: boolean;
  },
): ActionOperation[] {
  if (ctx.legacy) return [];
  const ops: ActionOperation[] = [];
  const acts = canAct(viewer, instance, ctx.policy);
  if (instance.status === "awaiting_approval" && canApprove(viewer, instance, ctx.policy)) ops.push("approve", "reject");
  if (CANCELLABLE.has(instance.status) && acts) ops.push("cancel");
  if (
    (instance.status === "completed" || instance.status === "partially_completed") &&
    ctx.rollbackClass !== "irreversible" &&
    ctx.hasUndo &&
    acts
  ) {
    ops.push("undo");
  }
  if ((instance.status === "failed" || instance.status === "expired") && ctx.executorAvailable && ctx.policy.enabled && acts) {
    ops.push("retry");
  }
  return ops;
}
