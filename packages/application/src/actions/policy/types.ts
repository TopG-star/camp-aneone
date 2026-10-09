import type { RiskTier } from "@oneon/domain";

export const APPROVAL_MODES = ["auto", "above_threshold", "always"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface ApprovalPolicy {
  mode: ApprovalMode;
  /** metric → limit. Auto-run is allowed only while the metric ≤ limit (spec §6.1). */
  thresholds: Record<string, number>;
}

export interface PolicyFloor {
  risk: RiskTier;
  approval: ApprovalPolicy;
  requiredPermissions: string[];
  approverRoles: string[];
  expiryHours: number;
  /**
   * Spec §7.6: the longest an approval may wait before the action acts on it. Tenant-scope definitions get a floor of
   * TENANT_MAX_APPROVAL_AGE_HOURS from the registry; configuration may lower it, never raise it. Absent for personal actions.
   */
  maxApprovalAgeHours?: number;
}

/** The floor of `maxApprovalAgeHours` for every tenant-scope action (spec §7.6). */
export const TENANT_MAX_APPROVAL_AGE_HOURS = 24;

export interface EffectivePolicy extends PolicyFloor {
  enabled: boolean;
}

export type PolicyOutcome = "refuse" | "needs_approval" | "auto";

export interface PolicyReason {
  code: string;
  detail?: Record<string, unknown>;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reasons: PolicyReason[];
  approverRoles: string[];
  risk: RiskTier;
  policy: EffectivePolicy;
  decidedAt: string;
}

export interface ClampResult {
  policy: EffectivePolicy;
  clamped: string[];
  rejected: string | null;
}
