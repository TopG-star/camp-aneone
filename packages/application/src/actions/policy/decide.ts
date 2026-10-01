import type { ActionScope, ActorContext, RiskTier } from "@oneon/domain";
import type { EffectivePolicy, PolicyDecision, PolicyOutcome, PolicyReason } from "./types.js";

export interface DecideInput {
  scope: ActionScope;
  executorAvailable: boolean;
  policy: EffectivePolicy;
  actor: ActorContext;
  metrics: Record<string, number>;
  risk: RiskTier;
  now: Date;
}

/** Spec §6.3. Pure and deterministic; time is passed in. */
export function decide(input: DecideInput): PolicyDecision {
  const make = (outcome: PolicyOutcome, reasons: PolicyReason[]): PolicyDecision => ({
    outcome,
    reasons,
    approverRoles: input.policy.approverRoles,
    risk: input.risk,
    policy: input.policy,
    decidedAt: input.now.toISOString(),
  });

  if (!input.executorAvailable) return make("refuse", [{ code: "executor_unavailable" }]);
  if (!input.policy.enabled) return make("refuse", [{ code: "disabled" }]);
  if (input.actor.scope !== input.scope) return make("refuse", [{ code: "scope_mismatch" }]);

  const missing = input.policy.requiredPermissions.filter((p) => !input.actor.permissions.includes(p));
  if (missing.length > 0) return make("refuse", [{ code: "missing_permission", detail: { missing } }]);

  const { mode, thresholds } = input.policy.approval;
  if (mode === "always") return make("needs_approval", [{ code: "mode_always" }]);
  if (mode === "above_threshold") {
    const reasons: PolicyReason[] = [];
    for (const [metric, limit] of Object.entries(thresholds)) {
      const value = input.metrics[metric];
      if (value === undefined) reasons.push({ code: "threshold_metric_missing", detail: { metric } });
      else if (value > limit) reasons.push({ code: "threshold_exceeded", detail: { metric, value, limit } });
    }
    if (reasons.length > 0) return make("needs_approval", reasons);
  }
  return make("auto", [{ code: "within_policy" }]);
}

const OUTCOME_RANK: Record<PolicyOutcome, number> = { auto: 0, needs_approval: 1, refuse: 2 };

export function isStricter(next: PolicyOutcome, recorded: PolicyOutcome): boolean {
  return OUTCOME_RANK[next] > OUTCOME_RANK[recorded];
}
