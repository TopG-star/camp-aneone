import type { ActionStatus } from "@oneon/domain";

// ── Valid Transitions ───────────────────────────────────────

const VALID_TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  proposed: ["approved", "rejected"],
  approved: ["executed"],
  executed: ["rolled_back"],
  rejected: [],
  rolled_back: [],
};

// ── Error ───────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ActionStatus,
    public readonly to: ActionStatus
  ) {
    super(`Invalid status transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

// ── Guard ───────────────────────────────────────────────────

/**
 * Validates that a status transition is allowed per the forward-only
 * action lifecycle: Proposed → Approved → Executed | Rejected | RolledBack.
 *
 * Throws InvalidTransitionError if the transition is not permitted.
 */
export function assertValidTransition(
  from: ActionStatus,
  to: ActionStatus
): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
