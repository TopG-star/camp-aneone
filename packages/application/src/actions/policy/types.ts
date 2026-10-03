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
}

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
