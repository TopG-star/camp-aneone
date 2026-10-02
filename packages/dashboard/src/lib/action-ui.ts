import type { ActionView, ChatActionRef, StatusGroup } from "@oneon/contracts";

export type ActionFilter = StatusGroup | "all" | "legacy";
type BadgeVariant = "warning" | "info" | "success" | "error" | "default";

export const GROUP_FILTERS: Array<{ key: ActionFilter; label: string }> = [
  { key: "needs_you", label: "Needs you" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
  { key: "problem", label: "Problem" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
  { key: "legacy", label: "Legacy (MVP1)" },
];

/** Spec §13.1: the group sets the colour. */
export const GROUP_BADGE: Record<StatusGroup, BadgeVariant> = {
  needs_you: "warning",
  in_progress: "info",
  done: "success",
  problem: "error",
  closed: "default",
};

const STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed",
  validating: "Checking",
  awaiting_approval: "Needs approval",
  approved: "Approved",
  executing: "Running",
  verifying: "Confirming",
  completed: "Completed",
  partially_completed: "Partly done",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Cancelled",
  failed: "Failed",
  rolling_back: "Undoing",
  rolled_back: "Undone",
  rollback_failed: "Undo failed",
};

export const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

export function actionsQuery(filter: ActionFilter, offset: number, limit: number): string | null {
  if (filter === "legacy") return null;
  const parts = [`limit=${limit}`, `offset=${offset}`];
  if (filter !== "all") parts.push(`group=${filter}`);
  return parts.join("&");
}

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function evidenceSummary(item: ActionView["evidence"][number]): { title: string; lines: string[] } {
  const d = item.data;
  switch (item.kind) {
    case "email":
      return { title: "Email", lines: [`From ${str(d.from)}`, str(d.subject)].filter(Boolean) };
    case "classification":
      return { title: "Classification", lines: [`${str(d.category)}, priority ${str(d.priority)}`, str(d.summary), `Model: ${str(d.model)}`].filter(Boolean) };
    case "deadline":
      return {
        title: "Deadline",
        lines: [str(d.description), `Due ${str(d.dueDate).slice(0, 10)}`, `Confidence ${Math.round(Number(d.confidence ?? 0) * 100)}%`],
      };
    case "chat_turn":
      return { title: "Chat", lines: [d.excerpt ? `"${str(d.excerpt)}"` : "(no excerpt)", `Model: ${str(d.model)}`] };
    case "rule": {
      const values = Object.entries((d.values as Record<string, unknown>) ?? {}).map(([k, v]) => `${k} = ${str(v)}`);
      return { title: "Rule", lines: [`${str(d.ruleId)}: ${str(d.condition)}`, ...values] };
    }
    case "legacy_action":
      return { title: "MVP1 proposal", lines: [`Created ${str(d.createdAt).slice(0, 10)}`] };
    case "retry_of":
      return { title: "Retry of", lines: [str(d.actionId)] };
    default:
      return { title: item.kind, lines: [JSON.stringify(d)] };
  }
}

export function actorLabel(actor: { kind: string }): string {
  return { user: "You", policy: "Oneon policy", system: "Oneon", sweeper: "Recovery" }[actor.kind] ?? actor.kind;
}

export function operationLabel(op: string): string {
  return { approve: "Approve", reject: "Reject", cancel: "Cancel", undo: "Undo", retry: "Try again" }[op] ?? op;
}

const CHIP_TEXT: Record<string, string> = { awaiting_approval: "Waiting for approval", completed: "Done" };

export function chatChip(ref: ChatActionRef): { href: string; text: string } {
  return { href: `/actions#action-${ref.id}`, text: `${CHIP_TEXT[ref.status] ?? statusLabel(ref.status)} · Open` };
}

export function verifyingNote(view: Pick<ActionView, "verifyingSince">): string | null {
  if (!view.verifyingSince) return null;
  const at = new Date(view.verifyingSince).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `Couldn't confirm yet; Oneon will check again automatically (last checked ${at}).`;
}
