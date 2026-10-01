// Spec §7.1–7.2. Statuses are stored lowercase; an `executing` action has had its executor called.

export const LIFECYCLE_STATUSES = [
  "proposed",
  "validating",
  "awaiting_approval",
  "approved",
  "executing",
  "verifying",
  "completed",
  "partially_completed",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
  proposed: ["validating", "cancelled"],
  validating: ["awaiting_approval", "approved", "rejected", "failed", "cancelled"],
  awaiting_approval: ["approved", "rejected", "expired", "cancelled"],
  approved: ["executing", "failed", "cancelled"],
  executing: ["verifying", "failed"],
  verifying: ["completed", "partially_completed", "failed"],
  completed: ["rolling_back"],
  partially_completed: ["rolling_back"],
  rejected: [],
  expired: [],
  cancelled: [],
  failed: [],
  rolling_back: ["rolled_back", "rollback_failed"],
  rolled_back: [],
  rollback_failed: [],
};

export const IN_PROGRESS_STATUSES: readonly LifecycleStatus[] = [
  "proposed",
  "validating",
  "approved",
  "executing",
  "verifying",
  "rolling_back",
];

export function isAllowedTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isLifecycleStatus(value: string): value is LifecycleStatus {
  return (LIFECYCLE_STATUSES as readonly string[]).includes(value);
}
