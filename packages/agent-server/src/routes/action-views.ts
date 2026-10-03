import { groupOf, type ActionView } from "@oneon/contracts";
import type { ActionEvent, ActionInstance, ActorContext, CheckResult } from "@oneon/domain";
import {
  allowedOperations,
  describeActionError,
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

const NOT_YET_RUN = new Set(["proposed", "validating", "awaiting_approval", "approved"]);

/** I3: only statements that are true for this instance, for this viewer. */
function undoText(
  instance: ActionInstance,
  def: ReturnType<ActionRegistry["get"]>,
  operations: readonly string[],
): string | null {
  const settled = instance.status === "completed" || instance.status === "partially_completed";
  // Before it runs, the approver is told whether it can be undone (spec §13.1).
  if (NOT_YET_RUN.has(instance.status)) return UNDO_TEXT[def.rollbackClass];
  if (def.rollbackClass === "irreversible") return settled ? UNDO_TEXT.irreversible : null;
  if (operations.includes("undo")) return UNDO_TEXT[def.rollbackClass];
  if (settled && (!def.undo || !instance.undo)) {
    const calendar = def.effects.writes.some((w) => w.startsWith("Google Calendar"));
    return `Oneon couldn't record how to undo this, so it can't be undone from here.${calendar ? " Change it in Google Calendar if you need to." : ""}`;
  }
  return null;
}

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

/** Verification records each attempt in last_heartbeat_at; entering verifying is the first. */
function lastChecked(instance: ActionInstance): string {
  const heartbeat = instance.lastHeartbeatAt;
  return heartbeat && Date.parse(heartbeat) > Date.parse(instance.updatedAt) ? heartbeat : instance.updatedAt;
}

export function toActionView(
  instance: ActionInstance,
  ctx: { registry: ActionRegistry; events: ActionEvent[]; viewer: ActorContext; policy: EffectivePolicy },
): ActionView {
  const def = ctx.registry.get(instance.actionType);
  const decision = instance.decision as unknown as PolicyDecision | null;
  const settled = instance.status === "completed" || instance.status === "partially_completed";
  const operations = allowedOperations(ctx.viewer, instance, {
    policy: ctx.policy,
    rollbackClass: def.rollbackClass,
    hasUndo: def.undo !== null && instance.undo !== null,
    executorAvailable: def.execute !== null,
  });
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
      text: undoText(instance, def, operations),
      warning: settled && def.undo && instance.resolved ? def.undo.warning(instance.resolved) : null,
    },
    // I5: raw messages (codes, Google bodies) stay in storage and logs; the owner sees plain text.
    error: instance.error
      ? { code: instance.error.code, stage: instance.error.stage, message: describeActionError(instance.error, instance.actionType) }
      : null,
    allowedOperations: operations,
    retryOf: instance.retryOf,
    attemptNumber: instance.attemptNumber,
    resourceRef: instance.resourceRef,
    lastCheckedAt: instance.status === "verifying" ? lastChecked(instance) : null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    timeline: ctx.events.map((e) => ({ seq: e.seq, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: e.actor, data: e.data, createdAt: e.createdAt })),
  };
}
