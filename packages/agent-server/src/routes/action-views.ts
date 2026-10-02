import { groupOf, type ActionView } from "@oneon/contracts";
import type { ActionEvent, ActionInstance, ActorContext, CheckResult } from "@oneon/domain";
import {
  allowedOperations,
  describeInstance,
  describeReason,
  type ActionRegistry,
  type EffectivePolicy,
  type PolicyDecision,
} from "@oneon/application";

const RULE_LABELS: Record<string, string> = {
  "inbox.urgent_notify": "Inbox rule · urgent notify",
  "inbox.deadline_reminder": "Inbox rule · deadline reminder",
  "inbox.spam_archive": "Inbox rule · spam cleanup",
  "inbox.newsletter_label": "Inbox rule · newsletter label",
  "inbox.follow_up_draft": "Inbox rule · follow-up draft",
};

const UNDO_TEXT = {
  reversible: "Can be undone",
  conditional: "Can be undone if nobody has changed it since",
  irreversible: "This action cannot be automatically reversed.",
} as const;

function originOf(instance: ActionInstance): ActionView["origin"] {
  if (instance.initiator.startsWith("rule:")) {
    const id = instance.initiator.slice(5);
    return { kind: "rule", label: RULE_LABELS[id] ?? `Inbox rule · ${id}`, excerpt: null };
  }
  if (instance.initiator.startsWith("schedule:")) return { kind: "schedule", label: "Scheduled", excerpt: null };
  const chat = instance.evidence.find((e) => e.kind === "chat_turn");
  return chat
    ? { kind: "chat", label: "Requested in chat", excerpt: typeof chat.data.excerpt === "string" ? chat.data.excerpt : null }
    : { kind: "user", label: "Requested by you", excerpt: null };
}

function latestChecks(events: ActionEvent[]): CheckResult[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const checks = events[i].data.checks;
    if (Array.isArray(checks)) return checks as CheckResult[];
  }
  return [];
}

export function toActionView(
  instance: ActionInstance,
  ctx: { registry: ActionRegistry; events: ActionEvent[]; viewer: ActorContext; policy: EffectivePolicy },
): ActionView {
  const def = ctx.registry.get(instance.actionType);
  const decision = instance.decision as unknown as PolicyDecision | null;
  const settled = instance.status === "completed" || instance.status === "partially_completed";
  return {
    id: instance.id,
    actionType: instance.actionType,
    label: def.label,
    status: instance.status,
    group: groupOf(instance.status),
    risk: decision?.risk ?? def.floor.risk,
    origin: originOf(instance),
    description: describeInstance(def, instance),
    evidence: instance.evidence,
    decision: decision ? { outcome: decision.outcome, reasons: decision.reasons.map((r) => ({ code: r.code, text: describeReason(r, def) })) } : null,
    checks: latestChecks(ctx.events),
    undo: {
      rollbackClass: def.rollbackClass,
      text: UNDO_TEXT[def.rollbackClass],
      warning: settled && def.undo && instance.resolved ? def.undo.warning(instance.resolved) : null,
    },
    error: instance.error,
    allowedOperations: allowedOperations(ctx.viewer, instance, {
      policy: ctx.policy,
      rollbackClass: def.rollbackClass,
      hasUndo: def.undo !== null && instance.undo !== null,
      executorAvailable: def.execute !== null,
    }),
    retryOf: instance.retryOf,
    attemptNumber: instance.attemptNumber,
    resourceRef: instance.resourceRef,
    verifyingSince: instance.status === "verifying" ? instance.updatedAt : null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    timeline: ctx.events.map((e) => ({ seq: e.seq, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: e.actor, data: e.data, createdAt: e.createdAt })),
  };
}
