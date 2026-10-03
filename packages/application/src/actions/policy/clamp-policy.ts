import { z } from "zod";
import { RISK_TIERS, maxRisk } from "@oneon/domain";
import { APPROVAL_MODES, type ApprovalMode, type ClampResult, type EffectivePolicy, type PolicyFloor } from "./types.js";

const ConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    risk: z.enum(RISK_TIERS).optional(),
    approval: z
      .object({
        mode: z.enum(APPROVAL_MODES),
        thresholds: z.record(z.number().finite().nonnegative()).optional(),
      })
      .strict()
      .optional(),
    requiredPermissions: z.array(z.string().min(1)).optional(),
    approverRoles: z.array(z.string().min(1)).optional(),
    expiryHours: z.number().positive().optional(),
  })
  .strict();

type StoredConfig = z.infer<typeof ConfigSchema>;

const MODE_RANK: Record<ApprovalMode, number> = { auto: 0, above_threshold: 1, always: 2 };
const strictestMode = (a: ApprovalMode, b: ApprovalMode): ApprovalMode => (MODE_RANK[a] >= MODE_RANK[b] ? a : b);

export interface ClampInput {
  floor: PolicyFloor;
  defaults: EffectivePolicy;
  storedJson: string | null;
  declaredMetrics: readonly string[];
  executorAvailable: boolean;
}

/** Spec §6.2. Applied on every read; a looser stored value is clamped and flagged, never used. */
export function clampPolicy(input: ClampInput): ClampResult {
  const fallback = (rejected: string): ClampResult => ({
    policy: finalize(clampFields(input.floor, input.defaults).policy, input.executorAvailable),
    clamped: [],
    rejected,
  });

  if (input.storedJson === null) {
    const r = clampFields(input.floor, input.defaults);
    return { policy: finalize(r.policy, input.executorAvailable), clamped: r.clamped, rejected: null };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(input.storedJson);
  } catch {
    return fallback("unparseable");
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return fallback("invalid_shape");
  if (undeclaredMetric(parsed.data, input.declaredMetrics)) return fallback("undeclared_metric");

  const r = clampFields(input.floor, merge(input.defaults, parsed.data));
  if (r.policy.approverRoles.length === 0) return fallback("no_approver_roles");
  return { policy: finalize(r.policy, input.executorAvailable), clamped: r.clamped, rejected: null };
}

function undeclaredMetric(config: StoredConfig, declared: readonly string[]): boolean {
  return Object.keys(config.approval?.thresholds ?? {}).some((m) => !declared.includes(m));
}

function merge(defaults: EffectivePolicy, config: StoredConfig): EffectivePolicy {
  return {
    enabled: config.enabled ?? defaults.enabled,
    risk: config.risk ?? defaults.risk,
    approval: config.approval
      ? { mode: config.approval.mode, thresholds: config.approval.thresholds ?? {} }
      : defaults.approval,
    requiredPermissions: config.requiredPermissions ?? defaults.requiredPermissions,
    approverRoles: config.approverRoles ?? defaults.approverRoles,
    expiryHours: config.expiryHours ?? defaults.expiryHours,
  };
}

function clampFields(floor: PolicyFloor, p: EffectivePolicy): { policy: EffectivePolicy; clamped: string[] } {
  const clamped: string[] = [];

  const risk = maxRisk(p.risk, floor.risk);
  if (risk !== p.risk) clamped.push("risk");

  const mode = strictestMode(p.approval.mode, floor.approval.mode);
  if (mode !== p.approval.mode) clamped.push("approval.mode");

  const thresholds: Record<string, number> = {};
  if (mode === "above_threshold") {
    const own = p.approval.mode === "above_threshold" ? p.approval.thresholds : {};
    for (const metric of new Set([...Object.keys(floor.approval.thresholds), ...Object.keys(own)])) {
      const f = floor.approval.thresholds[metric];
      const c = own[metric];
      if (f !== undefined && c !== undefined && c > f) clamped.push(`approval.thresholds.${metric}`);
      thresholds[metric] = f === undefined ? c : c === undefined ? f : Math.min(c, f);
    }
  }

  const requiredPermissions = [...new Set([...p.requiredPermissions, ...floor.requiredPermissions])];
  if (requiredPermissions.length > p.requiredPermissions.length) clamped.push("requiredPermissions");

  const approverRoles = p.approverRoles.filter((r) => floor.approverRoles.includes(r));
  if (approverRoles.length < p.approverRoles.length) clamped.push("approverRoles");

  const expiryHours = Math.min(p.expiryHours, floor.expiryHours);
  if (expiryHours !== p.expiryHours) clamped.push("expiryHours");

  return {
    policy: { enabled: p.enabled, risk, approval: { mode, thresholds }, requiredPermissions, approverRoles, expiryHours },
    clamped,
  };
}

function finalize(policy: EffectivePolicy, executorAvailable: boolean): EffectivePolicy {
  return { ...policy, enabled: policy.enabled && executorAvailable };
}

/** Spec §10.8: new writes past the floor are refused (422), never stored. */
export function validateConfigWrite(input: {
  floor: PolicyFloor;
  declaredMetrics: readonly string[];
  body: unknown;
}): { ok: true; configJson: string } | { ok: false; errors: Array<{ field: string; message: string }> } {
  const parsed = ConfigSchema.safeParse(input.body);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })),
    };
  }
  const config = parsed.data;
  const { floor } = input;
  const errors: Array<{ field: string; message: string }> = [];

  if (config.risk && maxRisk(config.risk, floor.risk) !== config.risk) {
    errors.push({ field: "risk", message: `Risk ${config.risk} is below this action's minimum (${floor.risk}).` });
  }
  if (config.approval) {
    if (MODE_RANK[config.approval.mode] < MODE_RANK[floor.approval.mode]) {
      errors.push({
        field: "approval.mode",
        message: `Approval "${config.approval.mode}" is looser than this action allows ("${floor.approval.mode}").`,
      });
    }
    for (const [metric, limit] of Object.entries(config.approval.thresholds ?? {})) {
      if (!input.declaredMetrics.includes(metric)) {
        errors.push({ field: `approval.thresholds.${metric}`, message: `Unknown threshold "${metric}".` });
      } else if (floor.approval.thresholds[metric] !== undefined && limit > floor.approval.thresholds[metric]) {
        errors.push({
          field: `approval.thresholds.${metric}`,
          message: `Limit ${limit} is above this action's maximum (${floor.approval.thresholds[metric]}).`,
        });
      }
    }
  }
  if (config.requiredPermissions && floor.requiredPermissions.some((p) => !config.requiredPermissions!.includes(p))) {
    errors.push({ field: "requiredPermissions", message: "Required permissions cannot drop this action's minimum set." });
  }
  if (config.approverRoles) {
    if (config.approverRoles.length === 0 || config.approverRoles.some((r) => !floor.approverRoles.includes(r))) {
      errors.push({ field: "approverRoles", message: "Approvers must be a non-empty subset of the roles this action allows." });
    }
  }
  if (config.expiryHours !== undefined && config.expiryHours > floor.expiryHours) {
    errors.push({ field: "expiryHours", message: `Expiry cannot exceed ${floor.expiryHours} hours.` });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, configJson: JSON.stringify(config) };
}

/** Spec §13.2: options looser than the floor are not offered. */
export function approvalOptions(
  floor: PolicyFloor,
  metricLabels: Record<string, string>,
): Array<{ mode: ApprovalMode; label: string }> {
  const floorMetrics = Object.keys(floor.approval.thresholds);
  const options: Array<{ mode: ApprovalMode; label: string }> = [];
  if (floor.approval.mode === "auto") options.push({ mode: "auto", label: "Auto" });
  if (MODE_RANK[floor.approval.mode] <= 1 && floorMetrics.length > 0) {
    options.push({
      mode: "above_threshold",
      label: `Auto unless ${floorMetrics.map((m) => metricLabels[m] ?? m).join(" or ")}`,
    });
  }
  options.push({ mode: "always", label: "Always ask" });
  return options;
}
