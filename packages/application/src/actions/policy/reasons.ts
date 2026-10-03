import type { PolicyReason } from "./types.js";

export function describeReason(
  reason: PolicyReason,
  def: { label: string; unavailableReason: string | null; thresholdMetrics: Record<string, { label: string; exceededText: string }> },
): string {
  switch (reason.code) {
    case "executor_unavailable":
      return `Oneon can't do this yet: ${def.unavailableReason ?? "no executor is available"}`;
    case "disabled":
      return "This action is turned off in Settings → Actions.";
    case "scope_mismatch":
      return "This action can't run in this context.";
    case "missing_permission":
      return "You don't have permission for this action.";
    case "mode_always":
      return `${def.label} is set to always ask before running.`;
    case "threshold_exceeded": {
      const metric = String(reason.detail?.metric ?? "");
      return def.thresholdMetrics[metric]?.exceededText ?? `${metric} is over its automatic limit, so this needs approval.`;
    }
    case "threshold_metric_missing":
      return "Oneon couldn't measure this action's risk, so it needs approval.";
    case "within_policy":
      return "Allowed to run automatically.";
    default:
      return reason.code;
  }
}
