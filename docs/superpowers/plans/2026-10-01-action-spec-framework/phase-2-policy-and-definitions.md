# Phase 2: Policy and definitions (Tasks 5–8)

Read first: spec §6 (policy and floor), §9 (definitions). Global constraints in [README.md](README.md) apply. All code in this phase lives in `packages/application/src/actions/` and is pure or talks only to the readers/writers it is given.

---

### Task 5: Policy functions

**Files:**
- Create: `packages/application/src/actions/policy/types.ts`
- Create: `packages/application/src/actions/policy/clamp-policy.ts`
- Create: `packages/application/src/actions/policy/decide.ts`
- Create: `packages/application/src/actions/policy/permissions.ts`
- Create: `packages/application/src/actions/policy/reasons.ts`
- Create: `packages/application/src/actions/policy/index.ts`
- Test: `packages/application/src/actions/policy/clamp-policy.test.ts`
- Test: `packages/application/src/actions/policy/decide.test.ts`
- Test: `packages/application/src/actions/policy/permissions.test.ts`

**Interfaces:**
- Consumes: `RiskTier`, `RISK_TIERS`, `maxRisk`, `ActorContext`, `ActionScope`, `ActionInstance`, `LifecycleStatus` (`@oneon/domain`).
- Produces:
  - `APPROVAL_MODES`, `type ApprovalMode`, `ApprovalPolicy { mode; thresholds: Record<string, number> }`, `PolicyFloor { risk; approval; requiredPermissions; approverRoles; expiryHours }`, `EffectivePolicy extends PolicyFloor { enabled }`, `type PolicyOutcome = "refuse" | "needs_approval" | "auto"`, `PolicyReason { code; detail? }`, `PolicyDecision { outcome; reasons; approverRoles; risk; policy; decidedAt }`, `ClampResult { policy; clamped: string[]; rejected: string | null }`
  - `clampPolicy(input: ClampInput): ClampResult` with `ClampInput { floor; defaults; storedJson: string | null; declaredMetrics: readonly string[]; executorAvailable: boolean }`
  - `validateConfigWrite(input: { floor; declaredMetrics; body: unknown }): { ok: true; configJson: string } | { ok: false; errors: Array<{ field: string; message: string }> }`
  - `approvalOptions(floor: PolicyFloor, metricLabels: Record<string, string>): Array<{ mode: ApprovalMode; label: string }>`
  - `decide(input: DecideInput): PolicyDecision` with `DecideInput { scope; executorAvailable; policy; actor; metrics: Record<string, number>; risk; now: Date }`
  - `isStricter(next: PolicyOutcome, recorded: PolicyOutcome): boolean`
  - `type ActionOperation = "approve" | "reject" | "cancel" | "undo" | "retry"`
  - `canApprove(actor, instance: Pick<ActionInstance, "scope" | "ownerId">, policy): boolean`
  - `canAct(actor, instance: Pick<ActionInstance, "scope" | "ownerId">, policy): boolean`
  - `allowedOperations(viewer, instance: Pick<ActionInstance, "scope" | "ownerId" | "status">, ctx: { policy: EffectivePolicy; rollbackClass: "reversible" | "conditional" | "irreversible"; hasUndo: boolean; executorAvailable: boolean; legacy?: boolean }): ActionOperation[]`
  - `describeReason(reason: PolicyReason, def: { label: string; unavailableReason: string | null; thresholdMetrics: Record<string, { label: string; exceededText: string }> }): string`

- [ ] **Step 1: Write the failing clamp tests**

`clamp-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { clampPolicy, validateConfigWrite, approvalOptions } from "./clamp-policy.js";
import type { EffectivePolicy, PolicyFloor } from "./types.js";

const FLOOR: PolicyFloor = {
  risk: "L1",
  approval: { mode: "above_threshold", thresholds: { others_involved: 0 } },
  requiredPermissions: ["calendar.write"],
  approverRoles: ["owner", "admin"],
  expiryHours: 24,
};
const DEFAULTS: EffectivePolicy = { ...FLOOR, approverRoles: ["owner"], enabled: true };
const base = { floor: FLOOR, defaults: DEFAULTS, declaredMetrics: ["others_involved"], executorAvailable: true };

describe("clampPolicy", () => {
  it("uses defaults when nothing is stored", () => {
    expect(clampPolicy({ ...base, storedJson: null })).toEqual({ policy: DEFAULTS, clamped: [], rejected: null });
  });

  it.each([
    ["risk below the floor is raised", { risk: "L0" }, "risk", (p: EffectivePolicy) => p.risk, "L1"],
    ["a looser approval mode is raised", { approval: { mode: "auto" } }, "approval.mode", (p: EffectivePolicy) => p.approval.mode, "above_threshold"],
    ["a looser threshold is lowered", { approval: { mode: "above_threshold", thresholds: { others_involved: 3 } } }, "approval.thresholds.others_involved", (p: EffectivePolicy) => p.approval.thresholds.others_involved, 0],
    ["missing floor permissions are added", { requiredPermissions: [] }, "requiredPermissions", (p: EffectivePolicy) => p.requiredPermissions, ["calendar.write"]],
    ["approver roles outside the floor are removed", { approverRoles: ["owner", "intern"] }, "approverRoles", (p: EffectivePolicy) => p.approverRoles, ["owner"]],
    ["a longer expiry is shortened", { expiryHours: 72 }, "expiryHours", (p: EffectivePolicy) => p.expiryHours, 24],
  ])("%s and flagged", (_name, stored, field, read, expected) => {
    const result = clampPolicy({ ...base, storedJson: JSON.stringify(stored) });
    expect(read(result.policy)).toEqual(expected);
    expect(result.clamped).toContain(field);
    expect(result.rejected).toBeNull();
  });

  it("accepts stricter values without flags", () => {
    const result = clampPolicy({ ...base, storedJson: JSON.stringify({ risk: "L3", approval: { mode: "always" }, expiryHours: 2 }) });
    expect(result.policy).toMatchObject({ risk: "L3", approval: { mode: "always", thresholds: {} }, expiryHours: 2 });
    expect(result.clamped).toEqual([]);
  });

  it.each([
    ["unparseable", "{not json", "unparseable"],
    ["invalid_shape", JSON.stringify({ risk: "L9" }), "invalid_shape"],
    ["undeclared metric", JSON.stringify({ approval: { mode: "above_threshold", thresholds: { attendees: 1 } } }), "undeclared_metric"],
    ["no approver left", JSON.stringify({ approverRoles: ["intern"] }), "no_approver_roles"],
  ])("rejects a %s row whole and falls back to defaults", (_name, storedJson, reason) => {
    const result = clampPolicy({ ...base, storedJson });
    expect(result.rejected).toBe(reason);
    expect(result.policy).toEqual(DEFAULTS);
  });

  it("is enabled only when config says so and the executor exists", () => {
    expect(clampPolicy({ ...base, storedJson: JSON.stringify({ enabled: false }) }).policy.enabled).toBe(false);
    expect(clampPolicy({ ...base, storedJson: null, executorAvailable: false }).policy.enabled).toBe(false);
  });
});

describe("validateConfigWrite", () => {
  it("refuses a looser value with a field error", () => {
    const result = validateConfigWrite({ floor: FLOOR, declaredMetrics: ["others_involved"], body: { approval: { mode: "auto" } } });
    expect(result).toEqual({
      ok: false,
      errors: [{ field: "approval.mode", message: 'Approval "auto" is looser than this action allows ("above_threshold").' }],
    });
  });

  it("accepts a stricter value", () => {
    const result = validateConfigWrite({ floor: FLOOR, declaredMetrics: ["others_involved"], body: { approval: { mode: "always" }, enabled: false } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.configJson)).toEqual({ approval: { mode: "always" }, enabled: false });
  });

  it("refuses unknown fields", () => {
    const result = validateConfigWrite({ floor: FLOOR, declaredMetrics: [], body: { approval: { mode: "always" }, autoRun: true } });
    expect(result.ok).toBe(false);
  });
});

describe("approvalOptions", () => {
  it("offers only modes at or above the floor", () => {
    expect(approvalOptions(FLOOR, { others_involved: "other people involved" })).toEqual([
      { mode: "above_threshold", label: "Auto unless other people involved" },
      { mode: "always", label: "Always ask" },
    ]);
    expect(approvalOptions({ ...FLOOR, approval: { mode: "auto", thresholds: {} } }, {})).toEqual([
      { mode: "auto", label: "Auto" },
      { mode: "always", label: "Always ask" },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/application && npx vitest run src/actions/policy`
Expected: FAIL, modules missing.

- [ ] **Step 3: Write `types.ts`**

```ts
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
```

- [ ] **Step 4: Write `clamp-policy.ts`**

```ts
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
```

- [ ] **Step 5: Write the failing decide and permission tests**

`decide.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { decide, isStricter } from "./decide.js";
import type { EffectivePolicy } from "./types.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const POLICY: EffectivePolicy = {
  enabled: true,
  risk: "L1",
  approval: { mode: "above_threshold", thresholds: { others_involved: 0 } },
  requiredPermissions: [],
  approverRoles: ["owner"],
  expiryHours: 24,
};
const input = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  scope: "personal" as const,
  executorAvailable: true,
  policy: POLICY,
  actor: personalActor("u1"),
  metrics: { others_involved: 0 },
  risk: "L1" as const,
  now: NOW,
  ...over,
});

describe("decide", () => {
  it.each([
    ["no executor", input({ executorAvailable: false }), "refuse", "executor_unavailable"],
    ["disabled", input({ policy: { ...POLICY, enabled: false } }), "refuse", "disabled"],
    ["scope mismatch", input({ scope: "tenant" }), "refuse", "scope_mismatch"],
    ["missing permission", input({ policy: { ...POLICY, requiredPermissions: ["inventory.transfer"] } }), "refuse", "missing_permission"],
    ["always ask", input({ policy: { ...POLICY, approval: { mode: "always", thresholds: {} } } }), "needs_approval", "mode_always"],
    ["threshold exceeded", input({ metrics: { others_involved: 2 } }), "needs_approval", "threshold_exceeded"],
    ["metric missing", input({ metrics: {} }), "needs_approval", "threshold_metric_missing"],
    ["within policy", input(), "auto", "within_policy"],
  ])("%s → %s", (_name, args, outcome, code) => {
    const decision = decide(args);
    expect(decision.outcome).toBe(outcome);
    expect(decision.reasons[0].code).toBe(code);
    expect(decision.decidedAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("records the exceeded metric", () => {
    expect(decide(input({ metrics: { others_involved: 2 } })).reasons[0].detail).toEqual({ metric: "others_involved", value: 2, limit: 0 });
  });
});

describe("isStricter", () => {
  it("orders refuse > needs_approval > auto", () => {
    expect(isStricter("needs_approval", "auto")).toBe(true);
    expect(isStricter("refuse", "needs_approval")).toBe(true);
    expect(isStricter("needs_approval", "needs_approval")).toBe(false);
    expect(isStricter("auto", "needs_approval")).toBe(false);
  });
});
```

`permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { allowedOperations, canApprove } from "./permissions.js";
import { describeReason } from "./reasons.js";
import type { EffectivePolicy } from "./types.js";

const POLICY: EffectivePolicy = {
  enabled: true, risk: "L1", approval: { mode: "auto", thresholds: {} },
  requiredPermissions: [], approverRoles: ["owner"], expiryHours: 24,
};
const ctx = { policy: POLICY, rollbackClass: "reversible" as const, hasUndo: true, executorAvailable: true };
const own = (status: string) => ({ scope: "personal" as const, ownerId: "u1", status: status as never });

describe("allowedOperations", () => {
  it.each([
    ["awaiting_approval", ["approve", "reject", "cancel"]],
    ["proposed", ["cancel"]],
    ["approved", ["cancel"]],
    ["completed", ["undo"]],
    ["partially_completed", ["undo"]],
    ["failed", ["retry"]],
    ["expired", ["retry"]],
    ["rejected", []],
    ["rolled_back", []],
    ["executing", []],
  ])("%s → %j", (status, expected) => {
    expect(allowedOperations(personalActor("u1"), own(status), ctx)).toEqual(expected);
  });

  it("gives another user nothing", () => {
    expect(allowedOperations(personalActor("u2"), own("awaiting_approval"), ctx)).toEqual([]);
  });

  it("offers no undo for irreversible actions and no retry when unavailable", () => {
    expect(allowedOperations(personalActor("u1"), own("completed"), { ...ctx, rollbackClass: "irreversible" })).toEqual([]);
    expect(allowedOperations(personalActor("u1"), own("failed"), { ...ctx, executorAvailable: false })).toEqual([]);
  });

  it("gives legacy rows nothing", () => {
    expect(allowedOperations(personalActor("u1"), own("awaiting_approval"), { ...ctx, legacy: true })).toEqual([]);
  });

  it("lets only the owner approve personal actions", () => {
    expect(canApprove(personalActor("u1"), own("awaiting_approval"), POLICY)).toBe(true);
    expect(canApprove(personalActor("u2"), own("awaiting_approval"), POLICY)).toBe(false);
  });
});

describe("describeReason", () => {
  const def = {
    label: "Create calendar event",
    unavailableReason: null,
    thresholdMetrics: { others_involved: { label: "other people involved", exceededText: "Other people are involved, so this needs approval." } },
  };
  it.each([
    [{ code: "threshold_exceeded", detail: { metric: "others_involved", value: 1, limit: 0 } }, "Other people are involved, so this needs approval."],
    [{ code: "mode_always" }, "Create calendar event is set to always ask before running."],
    [{ code: "disabled" }, "This action is turned off in Settings → Actions."],
    [{ code: "within_policy" }, "Allowed to run automatically."],
  ])("%j", (reason, text) => {
    expect(describeReason(reason, def)).toBe(text);
  });

  it("explains unavailable actions with their reason", () => {
    expect(describeReason({ code: "executor_unavailable" }, { ...def, unavailableReason: "needs Gmail modify access (gmail.modify)" })).toBe(
      "Oneon can't do this yet: needs Gmail modify access (gmail.modify)",
    );
  });
});
```

- [ ] **Step 6: Write `decide.ts`, `permissions.ts`, `reasons.ts`, `index.ts`**

`decide.ts`:

```ts
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
```

`permissions.ts`:

```ts
import type { ActionInstance, ActorContext } from "@oneon/domain";
import type { EffectivePolicy } from "./types.js";

export type ActionOperation = "approve" | "reject" | "cancel" | "undo" | "retry";

type Owned = Pick<ActionInstance, "scope" | "ownerId">;

function ownsScope(actor: ActorContext, instance: Owned): boolean {
  return instance.scope === "personal"
    ? actor.scope === "personal" && actor.userId === instance.ownerId
    : actor.scope === "tenant" && actor.tenantId === instance.ownerId;
}

export function canApprove(actor: ActorContext, instance: Owned, policy: EffectivePolicy): boolean {
  return ownsScope(actor, instance) && actor.roles.some((r) => policy.approverRoles.includes(r));
}

/** Cancel, undo and retry need the same authority as running the action. */
export function canAct(actor: ActorContext, instance: Owned, policy: EffectivePolicy): boolean {
  return ownsScope(actor, instance) && policy.requiredPermissions.every((p) => actor.permissions.includes(p));
}

const CANCELLABLE = new Set(["proposed", "validating", "awaiting_approval", "approved"]);

/** Spec §11.2. The UI draws only these buttons. */
export function allowedOperations(
  viewer: ActorContext,
  instance: Pick<ActionInstance, "scope" | "ownerId" | "status">,
  ctx: {
    policy: EffectivePolicy;
    rollbackClass: "reversible" | "conditional" | "irreversible";
    hasUndo: boolean;
    executorAvailable: boolean;
    legacy?: boolean;
  },
): ActionOperation[] {
  if (ctx.legacy) return [];
  const ops: ActionOperation[] = [];
  const acts = canAct(viewer, instance, ctx.policy);
  if (instance.status === "awaiting_approval" && canApprove(viewer, instance, ctx.policy)) ops.push("approve", "reject");
  if (CANCELLABLE.has(instance.status) && acts) ops.push("cancel");
  if (
    (instance.status === "completed" || instance.status === "partially_completed") &&
    ctx.rollbackClass !== "irreversible" &&
    ctx.hasUndo &&
    acts
  ) {
    ops.push("undo");
  }
  if ((instance.status === "failed" || instance.status === "expired") && ctx.executorAvailable && ctx.policy.enabled && acts) {
    ops.push("retry");
  }
  return ops;
}
```

`reasons.ts`:

```ts
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
```

`index.ts`:

```ts
export * from "./types.js";
export * from "./clamp-policy.js";
export * from "./decide.js";
export * from "./permissions.js";
export * from "./reasons.js";
```

- [ ] **Step 7: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions/policy`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/actions/policy
git commit -m "feat(actions): add policy floor clamping and decision functions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Definition contract, registry, idempotency and the six unavailable definitions

**Files:**
- Create: `packages/application/src/actions/definition.ts`
- Create: `packages/application/src/actions/registry.ts`
- Create: `packages/application/src/actions/idempotency.ts`
- Create: `packages/application/src/actions/definitions/outcomes.ts`
- Create: `packages/application/src/actions/definitions/unavailable.ts`
- Create: `packages/application/src/actions/definitions/gmail.ts`
- Create: `packages/application/src/actions/definitions/index.ts`
- Create: `packages/application/src/actions/index.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/actions/registry.test.ts`
- Test: `packages/application/src/actions/idempotency.test.ts`
- Test: `packages/application/src/actions/definitions/contract.test.ts`

**Interfaces:**
- Consumes: Task 5 policy types; domain types.
- Produces:
  - `ActionDefinition<I, R>`, `AnyActionDefinition`, `Resolved`, `ResolveResult`, `PreconditionResult`, `UndoCheck`, `CheckContext`, `ExecuteContext`, `VerifyContext`, `UndoContext`, `ExecutionOutcome`, `Verification`, `UndoSpec`, `KeyContext`, `ThresholdMetric`, `RollbackClass`, `DEFAULT_RECOVERY_THRESHOLD_MS`, `PERSONAL_APPROVERS`
  - `createActionRegistry(defs): ActionRegistry` (`get`, `has`, `list`), `ActionTypeNotFoundError`
  - `canonicalJson`, `emailKey`, `deadlineKey`, `chatKey`, `retryKey`
  - `fromExternalError(error: unknown): ExecutionOutcome`
  - `GMAIL_DEFINITIONS: AnyActionDefinition[]` (archive, label, draft_reply, delete, send, forward)
  - `createActionDefinitions(): AnyActionDefinition[]` (grows in Tasks 7–8)

- [ ] **Step 1: Write the failing tests**

`idempotency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canonicalJson, chatKey, retryKey, emailKey, deadlineKey } from "./idempotency.js";

describe("idempotency keys", () => {
  it("canonicalises key order and nesting", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("gives identical inputs the same chat key regardless of key order", () => {
    expect(chatKey("msg-1", { title: "x", start: "s" })).toBe(chatKey("msg-1", { start: "s", title: "x" }));
    expect(chatKey("msg-1", { title: "x" })).toMatch(/^chat:msg-1:[0-9a-f]{64}$/);
    expect(chatKey("msg-2", { title: "x" })).not.toBe(chatKey("msg-1", { title: "x" }));
  });

  it("derives retry keys from the root key", () => {
    expect(retryKey("email:i1", 1)).toBe("email:i1:retry:1");
    expect(retryKey("email:i1:retry:1", 2)).toBe("email:i1:retry:2");
  });

  it("builds source keys", () => {
    expect(emailKey("i1")).toBe("email:i1");
    expect(deadlineKey("d1")).toBe("deadline:d1");
  });
});
```

`registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createActionRegistry, ActionTypeNotFoundError } from "./registry.js";
import { GMAIL_DEFINITIONS } from "./definitions/gmail.js";

describe("action registry", () => {
  it("returns registered definitions and refuses anything else", () => {
    const registry = createActionRegistry(GMAIL_DEFINITIONS);
    expect(registry.get("archive").type).toBe("archive");
    expect(registry.has("create_purchase_order")).toBe(false);
    expect(() => registry.get("create_purchase_order")).toThrow(ActionTypeNotFoundError);
  });

  it("refuses duplicate registration", () => {
    expect(() => createActionRegistry([...GMAIL_DEFINITIONS, GMAIL_DEFINITIONS[0]])).toThrow('Action type "archive" is already registered');
  });
});
```

`definitions/contract.test.ts` — the shared contract every definition must meet. Later tasks add a sample per new definition:

```ts
import { describe, it, expect } from "vitest";
import { createActionDefinitions } from "./index.js";
import { clampPolicy } from "../policy/index.js";

// A valid input per definition. Tasks 7 and 8 add entries.
const SAMPLES: Record<string, Record<string, unknown>> = {
  archive: { inboundItemId: "i1", reason: "spam_classification" },
  label: { inboundItemId: "i1", label: "newsletter", reason: "newsletter_low_priority" },
  draft_reply: { inboundItemId: "i1", reason: "follow_up_needed", summary: "s", from: "a@x.com" },
  delete: { inboundItemId: "i1", reason: "user_request" },
  send: { inboundItemId: "i1", to: ["a@x.com"], subject: "Re: hi", body: "Thanks" },
  forward: { inboundItemId: "i1", to: ["a@x.com"] },
};

const IDENTITY_KEYS = ["tenantId", "tenant", "ownerId", "userId"];

describe.each(createActionDefinitions().map((d) => [d.type, d] as const))("definition %s", (type, def) => {
  it("has a sample", () => {
    expect(SAMPLES[type], `add a sample for ${type}`).toBeDefined();
  });

  it("accepts its sample and rejects unknown keys (strict schema)", () => {
    expect(def.inputSchema.safeParse(SAMPLES[type]).success).toBe(true);
    expect(def.inputSchema.safeParse({ ...SAMPLES[type], unexpected: true }).success).toBe(false);
  });

  it("does not accept identity keys from input", () => {
    for (const key of IDENTITY_KEYS) {
      expect(def.inputSchema.safeParse({ ...SAMPLES[type], [key]: "x" }).success, key).toBe(false);
    }
  });

  it("has defaults that already satisfy its floor", () => {
    const result = clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson: null,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });
    expect(result.clamped).toEqual([]);
  });

  it("is unavailable exactly when it has no executor", () => {
    expect(def.execute === null).toBe(def.unavailableReason !== null);
  });
});

describe("Gmail definitions", () => {
  it.each([
    ["archive", "needs Gmail modify access (gmail.modify)", "L1", "auto", "reversible"],
    ["label", "needs Gmail modify access (gmail.modify)", "L1", "auto", "reversible"],
    ["draft_reply", "needs Gmail compose access (gmail.compose)", "L1", "auto", "reversible"],
    ["delete", "needs Gmail modify access (gmail.modify)", "L3", "always", "irreversible"],
    ["send", "needs Gmail send access (gmail.send)", "L3", "always", "irreversible"],
    ["forward", "needs Gmail send access (gmail.send)", "L3", "always", "irreversible"],
  ])("%s: %s, floor %s / %s, %s", (type, reason, risk, mode, rollback) => {
    const def = createActionDefinitions().find((d) => d.type === type)!;
    expect(def).toMatchObject({ unavailableReason: reason, rollbackClass: rollback, execute: null });
    expect(def.floor.risk).toBe(risk);
    expect(def.floor.approval.mode).toBe(mode);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/application && npx vitest run src/actions/registry.test.ts src/actions/idempotency.test.ts src/actions/definitions`
Expected: FAIL, modules missing.

- [ ] **Step 3: Write `definition.ts`**

```ts
import type { z } from "zod";
import type {
  ActionError,
  ActionReaders,
  ActionScope,
  ActionWriters,
  ActorContext,
  CheckResult,
  JsonObject,
  RiskTier,
} from "@oneon/domain";
import type { EffectivePolicy, PolicyFloor } from "./policy/types.js";

export type RollbackClass = "reversible" | "conditional" | "irreversible";

export interface PreconditionResult extends CheckResult {
  kind: "blocking" | "obsolete";
}

/** An undo precondition; `failureCode` becomes the rollback_failed reason (e.g. changed_since). */
export interface UndoCheck extends CheckResult {
  failureCode: string;
}

/** Output of resolve: everything derived from current state that changes consequences (spec §9.2). */
export interface Resolved extends JsonObject {
  metrics: Record<string, number>;
}

export type ResolveResult<R> = { ok: true; resolved: R } | { ok: false; error: ActionError };

export interface CheckContext<I> {
  input: I;
  actor: ActorContext;
  readers: ActionReaders;
  now: Date;
}

export interface ExecuteContext<I, R> {
  instanceId: string;
  input: I;
  resolved: R;
  actor: ActorContext;
  executorRequestId: string;
  writers: ActionWriters;
  heartbeat: () => void;
  now: Date;
}

export type ExecutionOutcome =
  | { kind: "succeeded"; result: JsonObject; undoData: JsonObject | null }
  | { kind: "definite_failure"; code: string; message: string }
  | { kind: "unknown"; code: string; message: string };

export interface VerifyContext<I, R> {
  input: I;
  resolved: R;
  result: JsonObject | null;
  executorRequestId: string;
  readers: ActionReaders;
}

export interface Verification {
  checks: CheckResult[];
  /** The check that decides whether the effect exists at all. */
  effectCheckId: string;
}

export interface UndoContext<I, R> {
  input: I;
  resolved: R;
  result: JsonObject | null;
  undo: JsonObject;
  readers: ActionReaders;
  writers: ActionWriters;
}

export interface UndoSpec<I, R> {
  preconditions(ctx: UndoContext<I, R>): Promise<UndoCheck[]>;
  execute(ctx: UndoContext<I, R>): Promise<ExecutionOutcome>;
  verify(ctx: UndoContext<I, R>): Promise<CheckResult[]>;
  /** Shown in the undo confirmation, e.g. who Google will email. */
  warning(resolved: R): string | null;
}

export type KeyContext = { source: "rule"; resourceId: string } | { source: "chat"; turnId: string };

export interface ThresholdMetric {
  label: string;
  exceededText: string;
}

export interface ActionDefinition<I extends JsonObject = JsonObject, R extends Resolved = Resolved> {
  type: string;
  version: string;
  scope: ActionScope;
  label: string;
  description: string;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  effects: { reads: string[]; writes: string[] };
  floor: PolicyFloor;
  defaults: EffectivePolicy;
  thresholdMetrics: Record<string, ThresholdMetric>;
  rollbackClass: RollbackClass;
  recoveryThresholdMs: number;
  executionTimeoutMs: number;
  disableWarning: string | null;
  unavailableReason: string | null;
  /** Resolved fields compared at execution; any difference fails with changed_since_approval. */
  consequenceKeys: readonly string[];
  idempotencyKey(input: I, ctx: KeyContext): string;
  preconditions(ctx: CheckContext<I>): Promise<PreconditionResult[]>;
  resolve(ctx: CheckContext<I>): Promise<ResolveResult<R>>;
  riskFor(resolved: R, floorRisk: RiskTier): RiskTier;
  describe(resolved: R, input: I): string;
  execute: ((ctx: ExecuteContext<I, R>) => Promise<ExecutionOutcome>) | null;
  postconditions: ((ctx: VerifyContext<I, R>) => Promise<Verification>) | null;
  undo: UndoSpec<I, R> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any, any>;

export const DEFAULT_RECOVERY_THRESHOLD_MS = 5 * 60 * 1000;
export const PERSONAL_APPROVERS = ["owner"];
```

- [ ] **Step 4: Write `registry.ts` and `idempotency.ts`**

```ts
// registry.ts
import type { AnyActionDefinition } from "./definition.js";

export class ActionTypeNotFoundError extends Error {
  constructor(readonly actionType: string) {
    super(`Action type "${actionType}" is not registered`);
    this.name = "ActionTypeNotFoundError";
  }
}

export interface ActionRegistry {
  get(type: string): AnyActionDefinition;
  has(type: string): boolean;
  list(): AnyActionDefinition[];
}

/** Spec §4.2 R1: an action type exists only if it is registered here. */
export function createActionRegistry(definitions: AnyActionDefinition[]): ActionRegistry {
  const byType = new Map<string, AnyActionDefinition>();
  for (const def of definitions) {
    if (byType.has(def.type)) throw new Error(`Action type "${def.type}" is already registered`);
    byType.set(def.type, def);
  }
  return {
    get(type) {
      const def = byType.get(type);
      if (!def) throw new ActionTypeNotFoundError(type);
      return def;
    },
    has: (type) => byType.has(type),
    list: () => [...byType.values()],
  };
}
```

```ts
// idempotency.ts
import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export const emailKey = (inboundItemId: string): string => `email:${inboundItemId}`;
export const deadlineKey = (deadlineId: string): string => `deadline:${deadlineId}`;

export function chatKey(turnId: string, input: unknown): string {
  return `chat:${turnId}:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

export function retryKey(originalKey: string, retryNumber: number): string {
  return `${originalKey.replace(/:retry:\d+$/, "")}:retry:${retryNumber}`;
}
```

- [ ] **Step 5: Write `outcomes.ts`, `unavailable.ts`, `gmail.ts`, `definitions/index.ts`**

```ts
// definitions/outcomes.ts
import { ExternalCallError } from "@oneon/domain";
import type { ExecutionOutcome } from "../definition.js";

/** Spec §10.4: unexpected exceptions count as unknown, so the safe default is to verify. */
export function fromExternalError(error: unknown): ExecutionOutcome {
  if (error instanceof ExternalCallError) {
    return error.outcome === "definite"
      ? { kind: "definite_failure", code: error.code, message: error.message }
      : { kind: "unknown", code: error.code, message: error.message };
  }
  return { kind: "unknown", code: "unexpected_error", message: error instanceof Error ? error.message : String(error) };
}
```

```ts
// definitions/unavailable.ts
import type { z } from "zod";
import type { JsonObject, RiskTier } from "@oneon/domain";
import { chatKey, emailKey } from "../idempotency.js";
import {
  DEFAULT_RECOVERY_THRESHOLD_MS,
  PERSONAL_APPROVERS,
  type ActionDefinition,
  type Resolved,
  type RollbackClass,
} from "../definition.js";
import type { ApprovalMode } from "../policy/types.js";

/** Spec §9.8: registered so floors are in force, refused by policy until Gmail access exists. */
export function unavailableDefinition<I extends JsonObject & { inboundItemId: string }>(spec: {
  type: string;
  label: string;
  description: string;
  reason: string;
  riskFloor: RiskTier;
  approvalFloor: ApprovalMode;
  rollbackClass: RollbackClass;
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  describe: (input: I) => string;
}): ActionDefinition<I, Resolved> {
  const floor = {
    risk: spec.riskFloor,
    approval: { mode: spec.approvalFloor, thresholds: {} },
    requiredPermissions: [],
    approverRoles: PERSONAL_APPROVERS,
    expiryHours: 168,
  };
  return {
    type: spec.type,
    version: "1",
    scope: "personal",
    label: spec.label,
    description: spec.description,
    inputSchema: spec.inputSchema,
    effects: { reads: ["Gmail message"], writes: ["Gmail mailbox"] },
    floor,
    defaults: { ...floor, enabled: true },
    thresholdMetrics: {},
    rollbackClass: spec.rollbackClass,
    recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
    executionTimeoutMs: 10_000,
    disableWarning: null,
    unavailableReason: spec.reason,
    consequenceKeys: [],
    idempotencyKey: (input, ctx) => (ctx.source === "rule" ? emailKey(input.inboundItemId) : chatKey(ctx.turnId, input)),
    preconditions: async () => [],
    resolve: async () => ({ ok: true, resolved: { metrics: {} } }),
    riskFor: (_resolved, floorRisk) => floorRisk,
    describe: (_resolved, input) => spec.describe(input),
    execute: null,
    postconditions: null,
    undo: null,
  };
}
```

```ts
// definitions/gmail.ts
import { z } from "zod";
import type { AnyActionDefinition } from "../definition.js";
import { unavailableDefinition } from "./unavailable.js";

const MODIFY = "needs Gmail modify access (gmail.modify)";
const COMPOSE = "needs Gmail compose access (gmail.compose)";
const SEND = "needs Gmail send access (gmail.send)";
const item = z.string().min(1);

export const GMAIL_DEFINITIONS: AnyActionDefinition[] = [
  unavailableDefinition({
    type: "archive", label: "Archive email", description: "Archive this email in Gmail.",
    reason: MODIFY, riskFloor: "L1", approvalFloor: "auto", rollbackClass: "reversible",
    inputSchema: z.object({ inboundItemId: item, reason: z.string() }).strict(),
    describe: () => "Archive this email in Gmail.",
  }),
  unavailableDefinition({
    type: "label", label: "Label email", description: "Apply a Gmail label to this email.",
    reason: MODIFY, riskFloor: "L1", approvalFloor: "auto", rollbackClass: "reversible",
    inputSchema: z.object({ inboundItemId: item, label: z.string().min(1), reason: z.string() }).strict(),
    describe: (input) => `Label this email "${input.label}" in Gmail.`,
  }),
  unavailableDefinition({
    type: "draft_reply", label: "Draft reply", description: "Create a Gmail draft replying to this email.",
    reason: COMPOSE, riskFloor: "L1", approvalFloor: "auto", rollbackClass: "reversible",
    inputSchema: z.object({ inboundItemId: item, reason: z.string(), summary: z.string(), from: z.string() }).strict(),
    describe: (input) => `Draft a reply to ${input.from} in Gmail.`,
  }),
  unavailableDefinition({
    type: "delete", label: "Delete email", description: "Delete this email in Gmail.",
    reason: MODIFY, riskFloor: "L3", approvalFloor: "always", rollbackClass: "irreversible",
    inputSchema: z.object({ inboundItemId: item, reason: z.string() }).strict(),
    describe: () => "Delete this email in Gmail.",
  }),
  unavailableDefinition({
    type: "send", label: "Send email", description: "Send an email reply from Gmail.",
    reason: SEND, riskFloor: "L3", approvalFloor: "always", rollbackClass: "irreversible",
    inputSchema: z
      .object({ inboundItemId: item, to: z.array(z.string().email()).min(1), subject: z.string().min(1), body: z.string().min(1) })
      .strict(),
    describe: (input) => `Send "${input.subject}" to ${input.to.join(", ")}.`,
  }),
  unavailableDefinition({
    type: "forward", label: "Forward email", description: "Forward this email from Gmail.",
    reason: SEND, riskFloor: "L3", approvalFloor: "always", rollbackClass: "irreversible",
    inputSchema: z.object({ inboundItemId: item, to: z.array(z.string().email()).min(1), note: z.string().optional() }).strict(),
    describe: (input) => `Forward this email to ${input.to.join(", ")}.`,
  }),
];
```

```ts
// definitions/index.ts
import type { AnyActionDefinition } from "../definition.js";
import { GMAIL_DEFINITIONS } from "./gmail.js";

export { GMAIL_DEFINITIONS } from "./gmail.js";
export { fromExternalError } from "./outcomes.js";

/** Every registered action type. Tasks 7 and 8 add the four with real executors. */
export function createActionDefinitions(): AnyActionDefinition[] {
  return [...GMAIL_DEFINITIONS];
}
```

```ts
// actions/index.ts
export * from "./definition.js";
export * from "./registry.js";
export * from "./idempotency.js";
export * from "./policy/index.js";
export * from "./definitions/index.js";
```

Add to `packages/application/src/index.ts`:

```ts
export * from "./actions/index.js";
```

- [ ] **Step 6: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green. If `export *` reports a name clash with existing usecase exports, rename the new export (never the existing one) and note it in the commit message.

- [ ] **Step 7: Commit**

```bash
git add packages/application/src/actions packages/application/src/index.ts
git commit -m "feat(actions): add definition contract, registry and Gmail definitions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `notify` and `create_reminder`

Spec §9.7 columns 1–2 and §9.9.

**Files:**
- Create: `packages/application/src/actions/definitions/notify.ts`
- Create: `packages/application/src/actions/definitions/create-reminder.ts`
- Create: `packages/application/src/actions/__tests__/fakes.ts` (test support: fake readers/writers)
- Modify: `packages/application/src/actions/definitions/index.ts`
- Modify: `packages/application/src/actions/definitions/contract.test.ts` (samples)
- Test: `packages/application/src/actions/definitions/notify.test.ts`
- Test: `packages/application/src/actions/definitions/create-reminder.test.ts`

**Interfaces:**
- Consumes: Task 6 contract; `ActionReaders`, `ActionWriters`, `CalendarEvent`, `Deadline`, `NotificationEventType`.
- Produces: `notifyDefinition`, `createReminderDefinition`; test helpers `fakeReaders(overrides?)`, `fakeWriters(overrides?)`, `fakeCalendar()` (an in-memory reader+writer with `events: Map<string, CalendarEvent>`).

- [ ] **Step 1: Write the test fakes**

`packages/application/src/actions/__tests__/fakes.ts`:

```ts
import { ExternalCallError } from "@oneon/domain";
import type {
  ActionReaders,
  ActionWriters,
  CalendarEvent,
  CalendarEventDraft,
  CalendarReader,
  CalendarWriter,
  Deadline,
  Notification,
} from "@oneon/domain";

/** In-memory calendar with Google-like versioning: every write bumps the etag. */
export function fakeCalendar(ownerEmail = "owner@test.com") {
  const events = new Map<string, CalendarEvent>();
  let version = 1;
  const stamp = (e: Omit<CalendarEvent, "etag" | "updated">): CalendarEvent => ({
    ...e,
    etag: `"v${version++}"`,
    updated: "2026-10-01T12:00:00.000Z",
  });
  const reader: CalendarReader = {
    listEvents: async () => [...events.values()],
    searchEvents: async () => [...events.values()],
    getEvent: async (id) => events.get(id) ?? null,
  };
  const writer: CalendarWriter = {
    async create(event: CalendarEventDraft, options) {
      if (events.has(options.eventId)) throw new ExternalCallError("unknown", "already_exists", "exists");
      const created = stamp({ ...event, id: options.eventId });
      events.set(created.id, created);
      return created;
    },
    async update(id, changes, options) {
      const current = events.get(id);
      if (!current) throw new ExternalCallError("definite", "not_found", "missing");
      if (current.etag !== options.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      const updated = stamp({ ...current, ...changes, id });
      events.set(id, updated);
      return updated;
    },
    async remove(id, options) {
      const current = events.get(id);
      if (!current) throw new ExternalCallError("definite", "not_found", "missing");
      if (current.etag !== options.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      events.delete(id);
    },
  };
  /** Simulates someone else editing the event in Google Calendar. */
  const editElsewhere = (id: string, changes: Partial<CalendarEvent>) => {
    const current = events.get(id)!;
    events.set(id, stamp({ ...current, ...changes }));
  };
  return { events, reader, writer, editElsewhere, ownerEmail };
}

export function fakeReaders(overrides: Partial<ActionReaders> = {}): ActionReaders {
  return {
    calendar: null,
    deadlines: { findById: () => null },
    notifications: { isSuppressed: () => null, findById: () => null },
    identity: { googleEmail: "owner@test.com" },
    links: { inboundItem: (id) => `https://oneon.test/items/${id}` },
    ...overrides,
  };
}

export function fakeWriters(overrides: Partial<ActionWriters> = {}): ActionWriters {
  return { calendar: null, notifications: null, ...overrides };
}

export function deadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "d1",
    userId: "u1",
    inboundItemId: "i1",
    dueDate: "2026-10-07T17:00:00Z",
    description: "Submit Q4 report",
    confidence: 0.9,
    status: "open",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

export function notification(id: string): Notification {
  return {
    id, userId: "u1", eventType: "urgent_item", title: "t", body: "b",
    deepLink: null, read: false, createdAt: "2026-10-01T00:00:00Z",
  };
}
```

- [ ] **Step 2: Write the failing definition tests**

`notify.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { personalActor } from "@oneon/domain";
import { notifyDefinition as def } from "./notify.js";
import { fakeReaders, fakeWriters, notification } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const input = { inboundItemId: "i1", title: "Urgent: Q4 review", body: "Boss needs numbers", deepLink: "/items/i1" };
const actor = personalActor("u1");

describe("notify", () => {
  it("is obsolete during quiet hours", async () => {
    const readers = fakeReaders({ notifications: { isSuppressed: () => "quiet_hours", findById: () => null } });
    expect(await def.preconditions({ input, actor, readers, now: NOW })).toEqual([
      { id: "not_suppressed", kind: "obsolete", passed: false, expected: "deliverable", actual: "quiet_hours" },
    ]);
  });

  it("delivers and returns the notification id", async () => {
    const deliver = vi.fn().mockResolvedValue({ status: "delivered", notificationId: "n-1" });
    const outcome = await def.execute!({
      instanceId: "a1", input, resolved: { metrics: {}, eventType: "urgent_item" }, actor,
      executorRequestId: "a1", writers: fakeWriters({ notifications: { deliver } }), heartbeat: () => {}, now: NOW,
    });
    expect(outcome).toEqual({ kind: "succeeded", result: { notificationId: "n-1" }, undoData: null });
    expect(deliver).toHaveBeenCalledWith({ eventType: "urgent_item", title: input.title, body: input.body, deepLink: "/items/i1", userId: "u1" });
  });

  it("reports suppression at send time as a definite failure", async () => {
    const deliver = vi.fn().mockResolvedValue({ status: "suppressed", reason: "quiet_hours" });
    const outcome = await def.execute!({
      instanceId: "a1", input, resolved: { metrics: {}, eventType: "urgent_item" }, actor,
      executorRequestId: "a1", writers: fakeWriters({ notifications: { deliver } }), heartbeat: () => {}, now: NOW,
    });
    expect(outcome).toEqual({ kind: "definite_failure", code: "suppressed_quiet_hours", message: "Not sent: quiet hours began" });
  });

  it("verifies the notification exists", async () => {
    const readers = fakeReaders({ notifications: { isSuppressed: () => null, findById: (id) => (id === "n-1" ? notification("n-1") : null) } });
    const ok = await def.postconditions!({ input, resolved: { metrics: {}, eventType: "urgent_item" }, result: { notificationId: "n-1" }, executorRequestId: "a1", readers });
    expect(ok).toEqual({ effectCheckId: "notification_exists", checks: [{ id: "notification_exists", passed: true, expected: "n-1", actual: "n-1" }] });
    const missing = await def.postconditions!({ input, resolved: { metrics: {}, eventType: "urgent_item" }, result: null, executorRequestId: "a1", readers });
    expect(missing.checks[0].passed).toBe(false);
  });

  it("is irreversible, auto by default, and warns when disabled", () => {
    expect(def.rollbackClass).toBe("irreversible");
    expect(def.undo).toBeNull();
    expect(def.defaults.approval.mode).toBe("auto");
    expect(def.disableWarning).toBe("Turning this off stops urgent-email notifications.");
    expect(def.idempotencyKey(input, { source: "rule", resourceId: "i1" })).toBe("email:i1");
  });
});
```

`create-reminder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { createReminderDefinition as def } from "./create-reminder.js";
import { deadline, fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const input = { deadlineId: "d1", inboundItemId: "i1" };
const actor = personalActor("u1");

function setup(d = deadline()) {
  const cal = fakeCalendar();
  const readers = fakeReaders({ calendar: cal.reader, deadlines: { findById: (id) => (id === d.id ? d : null) } });
  const writers = fakeWriters({ calendar: cal.writer });
  return { cal, readers, writers };
}

describe("create_reminder preconditions", () => {
  it("passes for an open future deadline with a connected calendar", async () => {
    const { readers } = setup();
    const checks = await def.preconditions({ input, actor, readers, now: NOW });
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  it.each([
    ["deadline done", deadline({ status: "done" }), "deadline_open", "obsolete"],
    ["due date passed", deadline({ dueDate: "2026-09-30T23:00:00Z" }), "due_date_not_passed", "obsolete"],
  ])("%s → %s (%s)", async (_n, d, id, kind) => {
    const { readers } = setup(d);
    const failed = (await def.preconditions({ input, actor, readers, now: NOW })).find((c) => !c.passed);
    expect(failed).toMatchObject({ id, kind });
  });

  it("is obsolete when the deadline is gone and blocked without a calendar", async () => {
    const readers = fakeReaders();
    const checks = await def.preconditions({ input, actor, readers, now: NOW });
    expect(checks.filter((c) => !c.passed).map((c) => [c.id, c.kind])).toEqual([
      ["deadline_exists", "obsolete"],
      ["calendar_connected", "blocking"],
    ]);
  });
});

describe("create_reminder resolve, execute, verify, undo", () => {
  it("builds an all-day event on the deadline's own date", async () => {
    const { readers } = setup(deadline({ dueDate: "2026-10-07T23:30:00-05:00" }));
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r).toEqual({
      ok: true,
      resolved: {
        metrics: { others_involved: 0 },
        sendUpdates: "none",
        event: {
          title: "Due: Submit Q4 report", start: "2026-10-07", end: "2026-10-08", allDay: true,
          description: "From Oneon: https://oneon.test/items/i1", attendees: [], location: null,
        },
      },
    });
    if (r.ok) expect(def.describe(r.resolved, input)).toBe('Add an all-day reminder "Due: Submit Q4 report" on 7 Oct 2026 to your calendar.');
  });

  it("creates with the request id, verifies, and undoes when unchanged", async () => {
    const { cal, readers, writers } = setup();
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error("resolve failed");
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    expect(outcome).toEqual({ kind: "succeeded", result: { eventId: "req1", etag: '"v1"' }, undoData: { eventId: "req1", versionAfter: '"v1"' } });

    const v = await def.postconditions!({ input, resolved: r.resolved, result: { eventId: "req1" }, executorRequestId: "req1", readers });
    expect(v.checks.every((c) => c.passed)).toBe(true);

    const undoCtx = { input, resolved: r.resolved, result: { eventId: "req1" }, undo: { eventId: "req1", versionAfter: '"v1"' }, readers, writers };
    expect((await def.undo!.preconditions(undoCtx)).every((c) => c.passed)).toBe(true);
    expect((await def.undo!.execute(undoCtx)).kind).toBe("succeeded");
    expect(await def.undo!.verify(undoCtx)).toEqual([{ id: "event_deleted", passed: true }]);
    expect(cal.events.size).toBe(0);
  });

  it("verifies by request id when the create outcome was unknown", async () => {
    const { cal, readers, writers } = setup();
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    await cal.writer.create(r.resolved.event, { eventId: "req1", sendUpdates: "none" });
    const v = await def.postconditions!({ input, resolved: r.resolved, result: null, executorRequestId: "req1", readers });
    expect(v.checks.find((c) => c.id === v.effectCheckId)!.passed).toBe(true);
    void writers;
  });

  it("refuses undo when the event changed since", async () => {
    const { cal, readers, writers } = setup();
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    cal.editElsewhere("req1", { description: "my notes" });
    const checks = await def.undo!.preconditions({ input, resolved: r.resolved, result: { eventId: "req1" }, undo: { eventId: "req1", versionAfter: '"v1"' }, readers, writers });
    expect(checks.find((c) => !c.passed)).toMatchObject({ id: "unchanged_since", failureCode: "changed_since" });
  });

  it("defaults to approval with an auto floor", () => {
    expect(def.floor.approval.mode).toBe("auto");
    expect(def.defaults.approval.mode).toBe("always");
    expect(def.idempotencyKey(input, { source: "rule", resourceId: "i1" })).toBe("deadline:d1");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd packages/application && npx vitest run src/actions/definitions`
Expected: FAIL, modules missing.

- [ ] **Step 4: Write `notify.ts`**

```ts
import { z } from "zod";
import { NotificationEventType } from "@oneon/domain";
import { emailKey } from "../idempotency.js";
import { DEFAULT_RECOVERY_THRESHOLD_MS, PERSONAL_APPROVERS, type ActionDefinition, type Resolved } from "../definition.js";

const inputSchema = z
  .object({
    inboundItemId: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    deepLink: z.string().min(1),
  })
  .strict();

export type NotifyInput = z.infer<typeof inputSchema>;
export interface NotifyResolved extends Resolved {
  eventType: "urgent_item";
}

const floor = {
  risk: "L1" as const,
  approval: { mode: "auto" as const, thresholds: {} },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 168,
};

export const notifyDefinition: ActionDefinition<NotifyInput, NotifyResolved> = {
  type: "notify",
  version: "1",
  scope: "personal",
  label: "Notify me",
  description: "Send an in-app notification about an urgent email.",
  inputSchema,
  effects: { reads: ["notification preferences"], writes: ["in-app notification", "web push"] },
  floor,
  defaults: { ...floor, enabled: true },
  thresholdMetrics: {},
  rollbackClass: "irreversible",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 10_000,
  disableWarning: "Turning this off stops urgent-email notifications.",
  unavailableReason: null,
  consequenceKeys: [],
  idempotencyKey: (input) => emailKey(input.inboundItemId),

  async preconditions({ actor, readers, now }) {
    const reason = readers.notifications.isSuppressed(actor.userId, NotificationEventType.UrgentItem, now);
    return [{ id: "not_suppressed", kind: "obsolete", passed: reason === null, expected: "deliverable", actual: reason ?? "deliverable" }];
  },

  async resolve() {
    return { ok: true, resolved: { metrics: {}, eventType: "urgent_item" } };
  },

  riskFor: (_resolved, floorRisk) => floorRisk,
  describe: (_resolved, input) => `Notify you: "${input.title}".`,

  async execute({ input, actor, writers }) {
    if (!writers.notifications) {
      return { kind: "definite_failure", code: "notifications_unavailable", message: "Notifications are not configured." };
    }
    const sent = await writers.notifications.deliver({
      eventType: NotificationEventType.UrgentItem,
      title: input.title,
      body: input.body,
      deepLink: input.deepLink,
      userId: actor.userId,
    });
    if (sent.status === "suppressed") {
      return {
        kind: "definite_failure",
        code: `suppressed_${sent.reason}`,
        message: sent.reason === "quiet_hours" ? "Not sent: quiet hours began" : "Not sent: notification type turned off",
      };
    }
    return { kind: "succeeded", result: { notificationId: sent.notificationId }, undoData: null };
  },

  async postconditions({ result, readers }) {
    const id = typeof result?.notificationId === "string" ? result.notificationId : null;
    const exists = id !== null && readers.notifications.findById(id) !== null;
    return {
      effectCheckId: "notification_exists",
      checks: [{ id: "notification_exists", passed: exists, expected: id, actual: exists ? id : null }],
    };
  },

  undo: null,
};
```

- [ ] **Step 5: Write `create-reminder.ts`**

```ts
import { z } from "zod";
import type { CalendarEventDraft } from "@oneon/domain";
import { deadlineKey } from "../idempotency.js";
import {
  DEFAULT_RECOVERY_THRESHOLD_MS,
  PERSONAL_APPROVERS,
  type ActionDefinition,
  type PreconditionResult,
  type Resolved,
} from "../definition.js";
import { fromExternalError } from "./outcomes.js";

const inputSchema = z.object({ deadlineId: z.string().min(1), inboundItemId: z.string().min(1) }).strict();

export type CreateReminderInput = z.infer<typeof inputSchema>;
export interface CreateReminderResolved extends Resolved {
  event: CalendarEventDraft & Record<string, unknown>;
  sendUpdates: "none";
}

/** The deadline's own calendar date as written (no UTC conversion). */
const dayOf = (iso: string): string => iso.slice(0, 10);
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const formatDay = (day: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );

const floor = {
  risk: "L1" as const,
  approval: { mode: "auto" as const, thresholds: {} },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 168,
};

export const createReminderDefinition: ActionDefinition<CreateReminderInput, CreateReminderResolved> = {
  type: "create_reminder",
  version: "1",
  scope: "personal",
  label: "Create reminder",
  description: "Add an all-day calendar reminder on a deadline's due date.",
  inputSchema,
  effects: { reads: ["deadline", "Google Calendar"], writes: ["Google Calendar event"] },
  floor,
  // Default asks first so a new user's calendar does not fill up unannounced (spec §9.7).
  defaults: { ...floor, approval: { mode: "always", thresholds: {} }, enabled: true },
  thresholdMetrics: {},
  rollbackClass: "reversible",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 15_000,
  disableWarning: null,
  unavailableReason: null,
  consequenceKeys: ["sendUpdates", "metrics"],
  idempotencyKey: (input) => deadlineKey(input.deadlineId),

  async preconditions({ input, readers, now }) {
    const d = readers.deadlines.findById(input.deadlineId);
    const today = now.toISOString().slice(0, 10);
    const checks: PreconditionResult[] = [{ id: "deadline_exists", kind: "obsolete", passed: d !== null }];
    if (d) {
      checks.push(
        { id: "deadline_open", kind: "obsolete", passed: d.status === "open", expected: "open", actual: d.status },
        {
          id: "due_date_not_passed",
          kind: "obsolete",
          passed: dayOf(d.dueDate) >= today,
          expected: `on or after ${today}`,
          actual: dayOf(d.dueDate),
        },
      );
    }
    checks.push({ id: "calendar_connected", kind: "blocking", passed: readers.calendar !== null });
    return checks;
  },

  async resolve({ input, readers }) {
    const d = readers.deadlines.findById(input.deadlineId);
    if (!d) return { ok: false, error: { code: "deadline_missing", message: "The deadline no longer exists.", stage: "validation" } };
    const start = dayOf(d.dueDate);
    return {
      ok: true,
      resolved: {
        metrics: { others_involved: 0 },
        sendUpdates: "none",
        event: {
          title: `Due: ${d.description}`,
          start,
          end: nextDay(start),
          allDay: true,
          description: `From Oneon: ${readers.links.inboundItem(input.inboundItemId)}`,
          attendees: [],
          location: null,
        },
      },
    };
  },

  riskFor: (_resolved, floorRisk) => floorRisk,
  describe: (resolved) => `Add an all-day reminder "${resolved.event.title}" on ${formatDay(resolved.event.start)} to your calendar.`,

  async execute({ resolved, writers, executorRequestId }) {
    if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
    try {
      const event = await writers.calendar.create(resolved.event, { eventId: executorRequestId, sendUpdates: "none" });
      return {
        kind: "succeeded",
        result: { eventId: event.id, etag: event.etag ?? null },
        undoData: { eventId: event.id, versionAfter: event.etag ?? null },
      };
    } catch (error) {
      return fromExternalError(error);
    }
  },

  async postconditions({ resolved, result, executorRequestId, readers }) {
    if (!readers.calendar) throw new Error("Google Calendar is not connected");
    const eventId = typeof result?.eventId === "string" ? result.eventId : executorRequestId;
    const event = await readers.calendar.getEvent(eventId);
    return {
      effectCheckId: "event_exists",
      checks: [
        { id: "event_exists", passed: event !== null, expected: eventId, actual: event?.id ?? null },
        { id: "all_day_on_due_date", passed: !!event && event.allDay && event.start === resolved.event.start, expected: resolved.event.start, actual: event?.start ?? null },
        { id: "title_matches", passed: event?.title === resolved.event.title, expected: resolved.event.title, actual: event?.title ?? null },
      ],
    };
  },

  undo: {
    async preconditions({ undo, readers }) {
      const event = readers.calendar ? await readers.calendar.getEvent(String(undo.eventId)) : null;
      return [
        { id: "event_still_exists", failureCode: "not_found", passed: event !== null },
        { id: "unchanged_since", failureCode: "changed_since", passed: !!event && event.etag === undo.versionAfter, expected: undo.versionAfter, actual: event?.etag ?? null },
      ];
    },
    async execute({ undo, writers }) {
      if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
      try {
        await writers.calendar.remove(String(undo.eventId), { ifMatch: String(undo.versionAfter), sendUpdates: "none" });
        return { kind: "succeeded", result: { removedEventId: undo.eventId }, undoData: null };
      } catch (error) {
        return fromExternalError(error);
      }
    },
    async verify({ undo, readers }) {
      if (!readers.calendar) throw new Error("Google Calendar is not connected");
      return [{ id: "event_deleted", passed: (await readers.calendar.getEvent(String(undo.eventId))) === null }];
    },
    warning: () => null,
  },
};
```

- [ ] **Step 6: Register them and add samples**

In `definitions/index.ts`:

```ts
import { notifyDefinition } from "./notify.js";
import { createReminderDefinition } from "./create-reminder.js";

export { notifyDefinition } from "./notify.js";
export { createReminderDefinition } from "./create-reminder.js";

export function createActionDefinitions(): AnyActionDefinition[] {
  return [notifyDefinition, createReminderDefinition, ...GMAIL_DEFINITIONS];
}
```

Add to `SAMPLES` in `contract.test.ts`:

```ts
  notify: { inboundItemId: "i1", title: "Urgent: Q4", body: "s", deepLink: "/items/i1" },
  create_reminder: { deadlineId: "d1", inboundItemId: "i1" },
```

- [ ] **Step 7: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/actions
git commit -m "feat(actions): add notify and create_reminder definitions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `create_calendar_event` and `update_calendar_event`

Spec §9.7 columns 3–4, plus Review Focus 1, 2 and 5.

**Files:**
- Create: `packages/application/src/actions/definitions/calendar-shared.ts`
- Create: `packages/application/src/actions/definitions/create-calendar-event.ts`
- Create: `packages/application/src/actions/definitions/update-calendar-event.ts`
- Modify: `packages/application/src/actions/definitions/index.ts`, `contract.test.ts`
- Test: `packages/application/src/actions/definitions/create-calendar-event.test.ts`
- Test: `packages/application/src/actions/definitions/update-calendar-event.test.ts`

**Interfaces:**
- Consumes: Task 6 contract, Task 7 fakes.
- Produces: `createCalendarEventDefinition`, `updateCalendarEventDefinition`; from `calendar-shared.ts`: `isoWithOffset` (zod schema), `normalizeAttendees(list: string[]): string[]`, `othersInvolved(attendees: string[], ownerEmail: string | null): string[]`, `sameField(key, a, b): boolean`, `formatRange(start, end): string`, `formatDateTime(iso): string`, `OTHERS_INVOLVED_METRIC`.

- [ ] **Step 1: Write the failing tests**

`create-calendar-event.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { createCalendarEventDefinition as def } from "./create-calendar-event.js";
import { fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const actor = personalActor("u1");
const base = { title: "Call with Ama", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00" };

function setup(ownerEmail: string | null = "owner@test.com") {
  const cal = fakeCalendar();
  return { cal, readers: fakeReaders({ calendar: cal.reader, identity: { googleEmail: ownerEmail } }), writers: fakeWriters({ calendar: cal.writer }) };
}

async function resolve(input: Record<string, unknown>, ownerEmail?: string | null) {
  const { readers } = setup(ownerEmail);
  const parsed = def.inputSchema.parse(input);
  const r = await def.resolve({ input: parsed, actor, readers, now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return { parsed, resolved: r.resolved };
}

describe("create_calendar_event input", () => {
  it("refuses a time without a UTC offset (Review Focus 1)", () => {
    const result = def.inputSchema.safeParse({ ...base, start: "2026-10-07T10:00:00" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe("Use an ISO-8601 date-time with a UTC offset, e.g. 2026-10-07T10:00:00+00:00");
  });

  it("refuses an end before the start", () => {
    expect(def.inputSchema.safeParse({ ...base, end: "2026-10-07T09:00:00+00:00" }).success).toBe(false);
  });
});

describe("create_calendar_event resolve", () => {
  it("runs automatically with nobody else involved", async () => {
    const { resolved } = await resolve(base);
    expect(resolved).toMatchObject({ metrics: { others_involved: 0 }, othersInvolved: [], sendUpdates: "none" });
    expect(def.riskFor(resolved, "L1")).toBe("L1");
    expect(def.describe(resolved, def.inputSchema.parse(base))).toBe('Create "Call with Ama", Wed 7 Oct 2026, 10:00–10:30 UTC.');
  });

  it("counts other people, raises risk and says Google will email them", async () => {
    const input = { ...base, attendees: ["ama@example.com"] };
    const { parsed, resolved } = await resolve(input);
    expect(resolved).toMatchObject({ metrics: { others_involved: 1 }, othersInvolved: ["ama@example.com"], sendUpdates: "all" });
    expect(def.riskFor(resolved, "L1")).toBe("L2");
    expect(def.describe(resolved, parsed)).toBe(
      'Create "Call with Ama", Wed 7 Oct 2026, 10:00–10:30 UTC, and invite ama@example.com. Google will email the invitation.',
    );
  });

  it("does not count the owner's own address in any casing (Review Focus 2)", async () => {
    const { resolved } = await resolve({ ...base, attendees: ["Owner@Test.com"] }, "owner@test.com");
    expect(resolved.metrics.others_involved).toBe(0);
  });

  it("de-duplicates attendees case-insensitively (Review Focus 5)", async () => {
    const { resolved } = await resolve({ ...base, attendees: ["a@x.com", "A@x.com"] });
    expect(resolved.event.attendees).toEqual(["a@x.com"]);
    expect(resolved.metrics.others_involved).toBe(1);
  });
});

describe("create_calendar_event execute, verify, undo", () => {
  it("creates, verifies, warns about cancellations and undoes", async () => {
    const { cal, readers, writers } = setup();
    const parsed = def.inputSchema.parse({ ...base, attendees: ["ama@example.com"] });
    const r = await def.resolve({ input: parsed, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    const outcome = await def.execute!({ instanceId: "a1", input: parsed, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    expect(outcome.kind).toBe("succeeded");
    const v = await def.postconditions!({ input: parsed, resolved: r.resolved, result: { eventId: "req1" }, executorRequestId: "req1", readers });
    expect(v.checks.every((c) => c.passed)).toBe(true);
    expect(def.undo!.warning(r.resolved)).toBe("Google will email cancellations to ama@example.com.");
    if (outcome.kind !== "succeeded") throw new Error();
    const ctx = { input: parsed, resolved: r.resolved, result: outcome.result, undo: outcome.undoData!, readers, writers };
    expect((await def.undo!.execute(ctx)).kind).toBe("succeeded");
    expect(cal.events.size).toBe(0);
  });

  it("reports a wrong attendee list as a partial result", async () => {
    const { cal, readers, writers } = setup();
    const parsed = def.inputSchema.parse({ ...base, attendees: ["ama@example.com"] });
    const r = await def.resolve({ input: parsed, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    await def.execute!({ instanceId: "a1", input: parsed, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    cal.editElsewhere("req1", { attendees: [] });
    const v = await def.postconditions!({ input: parsed, resolved: r.resolved, result: { eventId: "req1" }, executorRequestId: "req1", readers });
    expect(v.checks.find((c) => c.id === v.effectCheckId)!.passed).toBe(true);
    expect(v.checks.find((c) => c.id === "attendees_match")!.passed).toBe(false);
  });
});
```

`update-calendar-event.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { updateCalendarEventDefinition as def } from "./update-calendar-event.js";
import { fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const actor = personalActor("u1");

async function setup(attendees: string[] = []) {
  const cal = fakeCalendar();
  await cal.writer.create(
    { title: "Focus", start: "2026-10-07T09:00:00+00:00", end: "2026-10-07T11:00:00+00:00", allDay: false, description: null, attendees, location: null },
    { eventId: "ev1", sendUpdates: "none" },
  );
  return { cal, readers: fakeReaders({ calendar: cal.reader }), writers: fakeWriters({ calendar: cal.writer }) };
}

describe("update_calendar_event", () => {
  it("requires at least one change", () => {
    expect(def.inputSchema.safeParse({ eventId: "ev1" }).success).toBe(false);
  });

  it("is blocked when the event does not exist", async () => {
    const { readers } = await setup();
    const checks = await def.preconditions({ input: def.inputSchema.parse({ eventId: "nope", title: "x" }), actor, readers, now: NOW });
    expect(checks.find((c) => !c.passed)).toMatchObject({ id: "event_exists", kind: "blocking" });
  });

  it("counts people added to a solo event (attendee gap)", async () => {
    const { readers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", attendees: ["ama@example.com"] });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r.ok && r.resolved).toMatchObject({ metrics: { others_involved: 1 }, sendUpdates: "all" });
  });

  it("emails nobody for a title change on an event with attendees", async () => {
    const { readers } = await setup(["ama@example.com"]);
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r.ok && r.resolved).toMatchObject({ metrics: { others_involved: 1 }, sendUpdates: "none", previous: { title: "Focus" } });
  });

  it("emails attendees for a time change", async () => {
    const { readers } = await setup(["ama@example.com"]);
    const input = def.inputSchema.parse({ eventId: "ev1", start: "2026-10-07T10:00:00+00:00" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r.ok && r.resolved.sendUpdates).toBe("all");
  });

  it("updates with If-Match, verifies, and restores on undo", async () => {
    const { cal, readers, writers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    if (outcome.kind !== "succeeded") throw new Error(outcome.kind);
    expect((await def.postconditions!({ input, resolved: r.resolved, result: outcome.result, executorRequestId: "req1", readers })).checks.every((c) => c.passed)).toBe(true);
    const ctx = { input, resolved: r.resolved, result: outcome.result, undo: outcome.undoData!, readers, writers };
    expect((await def.undo!.preconditions(ctx)).every((c) => c.passed)).toBe(true);
    expect((await def.undo!.execute(ctx)).kind).toBe("succeeded");
    expect(cal.events.get("ev1")!.title).toBe("Focus");
    expect((await def.undo!.verify(ctx)).every((c) => c.passed)).toBe(true);
  });

  it("fails definitely when the event changed after approval", async () => {
    const { cal, readers, writers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    cal.editElsewhere("ev1", { location: "Room 2" });
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    expect(outcome).toMatchObject({ kind: "definite_failure", code: "changed_since" });
  });

  it("refuses undo when someone edited after Oneon", async () => {
    const { cal, readers, writers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    if (outcome.kind !== "succeeded") throw new Error();
    cal.editElsewhere("ev1", { title: "Edited by me" });
    const checks = await def.undo!.preconditions({ input, resolved: r.resolved, result: outcome.result, undo: outcome.undoData!, readers, writers });
    expect(checks.find((c) => !c.passed)).toMatchObject({ failureCode: "changed_since" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/application && npx vitest run src/actions/definitions`
Expected: FAIL, modules missing.

- [ ] **Step 3: Write `calendar-shared.ts`**

```ts
import { z } from "zod";
import type { CalendarEvent } from "@oneon/domain";

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** Review Focus 1: a time without an offset is refused so the AI retries with one. */
export const isoWithOffset = z.string().refine((s) => OFFSET.test(s) && !Number.isNaN(Date.parse(s)), {
  message: "Use an ISO-8601 date-time with a UTC offset, e.g. 2026-10-07T10:00:00+00:00",
});

/** Lowercased and de-duplicated, keeping first-seen order (Review Focus 5). */
export function normalizeAttendees(list: string[]): string[] {
  return [...new Set(list.map((a) => a.trim().toLowerCase()))];
}

/** Attendees other than the owner's own Google account (Review Focus 2). */
export function othersInvolved(attendees: string[], ownerEmail: string | null): string[] {
  const owner = ownerEmail?.toLowerCase() ?? null;
  return normalizeAttendees(attendees).filter((a) => a !== owner);
}

export function sameField(key: string, a: unknown, b: unknown): boolean {
  if (key === "start" || key === "end") return typeof a === "string" && typeof b === "string" && Date.parse(a) === Date.parse(b);
  if (key === "attendees") {
    const left = normalizeAttendees((a as string[] | undefined) ?? []).sort();
    const right = normalizeAttendees((b as string[] | undefined) ?? []).sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  return (a ?? null) === (b ?? null);
}

export function formatRange(start: string, end: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const s = new Date(start);
  const e = new Date(end);
  return `${day.format(s).replace(",", "")}, ${time.format(s)}–${time.format(e)} UTC`;
}

export function formatDateTime(iso: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const d = new Date(iso);
  return `${day.format(d).replace(",", "")}, ${time.format(d)} UTC`;
}

export const OTHERS_INVOLVED_METRIC = {
  others_involved: {
    label: "other people involved",
    exceededText: "Other people are involved, so this needs approval.",
  },
};

export type EventFields = Pick<CalendarEvent, "title" | "start" | "end" | "description" | "attendees" | "location">;
```

(`Intl` formats `Wed 7 Oct 2026` as `Wed, 7 Oct 2026` in en-GB; the `.replace(",", "")` removes that first comma. If the runtime's ICU output differs, adjust `formatRange` — not the test — so the sentence reads `Wed 7 Oct 2026, 10:00–10:30 UTC`.)

- [ ] **Step 4: Write `create-calendar-event.ts`**

```ts
import { z } from "zod";
import { maxRisk, type CalendarEventDraft } from "@oneon/domain";
import { chatKey } from "../idempotency.js";
import { DEFAULT_RECOVERY_THRESHOLD_MS, PERSONAL_APPROVERS, type ActionDefinition, type Resolved } from "../definition.js";
import { fromExternalError } from "./outcomes.js";
import { OTHERS_INVOLVED_METRIC, formatRange, isoWithOffset, normalizeAttendees, othersInvolved, sameField } from "./calendar-shared.js";

const inputSchema = z
  .object({
    title: z.string().min(1),
    start: isoWithOffset,
    end: isoWithOffset,
    description: z.string().nullable().default(null),
    attendees: z.array(z.string().email()).default([]),
    location: z.string().nullable().default(null),
  })
  .strict()
  .refine((v) => Date.parse(v.start) < Date.parse(v.end), { message: "start must be before end", path: ["end"] });

export type CreateCalendarEventInput = z.infer<typeof inputSchema>;
export interface CreateCalendarEventResolved extends Resolved {
  event: CalendarEventDraft & Record<string, unknown>;
  othersInvolved: string[];
  sendUpdates: "all" | "none";
}

const floor = {
  risk: "L1" as const,
  approval: { mode: "above_threshold" as const, thresholds: { others_involved: 0 } },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 24,
};

export const createCalendarEventDefinition: ActionDefinition<CreateCalendarEventInput, CreateCalendarEventResolved> = {
  type: "create_calendar_event",
  version: "1",
  scope: "personal",
  label: "Create calendar event",
  description: "Create a Google Calendar event, inviting attendees if any.",
  inputSchema,
  effects: { reads: ["Google Calendar"], writes: ["Google Calendar event", "invitation emails"] },
  floor,
  defaults: { ...floor, enabled: true },
  thresholdMetrics: OTHERS_INVOLVED_METRIC,
  rollbackClass: "reversible",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 15_000,
  disableWarning: null,
  unavailableReason: null,
  consequenceKeys: ["sendUpdates", "othersInvolved", "metrics"],
  idempotencyKey: (input, ctx) => (ctx.source === "chat" ? chatKey(ctx.turnId, input) : `rule:${ctx.resourceId}`),

  async preconditions({ readers }) {
    return [{ id: "calendar_connected", kind: "blocking", passed: readers.calendar !== null }];
  },

  async resolve({ input, readers }) {
    const attendees = normalizeAttendees(input.attendees);
    const others = othersInvolved(attendees, readers.identity.googleEmail);
    return {
      ok: true,
      resolved: {
        metrics: { others_involved: others.length },
        othersInvolved: others,
        sendUpdates: attendees.length > 0 ? "all" : "none",
        event: {
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: false,
          description: input.description,
          attendees,
          location: input.location,
        },
      },
    };
  },

  riskFor: (resolved, floorRisk) => (resolved.othersInvolved.length > 0 ? maxRisk("L2", floorRisk) : floorRisk),

  describe(resolved) {
    const base = `Create "${resolved.event.title}", ${formatRange(resolved.event.start, resolved.event.end)}`;
    return resolved.othersInvolved.length > 0
      ? `${base}, and invite ${resolved.othersInvolved.join(", ")}. Google will email the invitation.`
      : `${base}.`;
  },

  async execute({ resolved, writers, executorRequestId }) {
    if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
    try {
      const event = await writers.calendar.create(resolved.event, { eventId: executorRequestId, sendUpdates: resolved.sendUpdates });
      return {
        kind: "succeeded",
        result: { eventId: event.id, etag: event.etag ?? null },
        undoData: { eventId: event.id, versionAfter: event.etag ?? null, sendUpdates: resolved.sendUpdates },
      };
    } catch (error) {
      return fromExternalError(error);
    }
  },

  async postconditions({ resolved, result, executorRequestId, readers }) {
    if (!readers.calendar) throw new Error("Google Calendar is not connected");
    const eventId = typeof result?.eventId === "string" ? result.eventId : executorRequestId;
    const event = await readers.calendar.getEvent(eventId);
    const field = (key: "title" | "start" | "end" | "attendees") => ({
      id: `${key}_matches`,
      passed: !!event && sameField(key, event[key], resolved.event[key]),
      expected: resolved.event[key],
      actual: event?.[key] ?? null,
    });
    return {
      effectCheckId: "event_exists",
      checks: [
        { id: "event_exists", passed: event !== null, expected: eventId, actual: event?.id ?? null },
        field("title"),
        field("start"),
        field("end"),
        field("attendees"),
      ],
    };
  },

  undo: {
    async preconditions({ undo, readers }) {
      const event = readers.calendar ? await readers.calendar.getEvent(String(undo.eventId)) : null;
      return [
        { id: "event_still_exists", failureCode: "not_found", passed: event !== null },
        { id: "unchanged_since", failureCode: "changed_since", passed: !!event && event.etag === undo.versionAfter, expected: undo.versionAfter, actual: event?.etag ?? null },
      ];
    },
    async execute({ undo, writers }) {
      if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
      try {
        await writers.calendar.remove(String(undo.eventId), {
          ifMatch: String(undo.versionAfter),
          sendUpdates: undo.sendUpdates === "all" ? "all" : "none",
        });
        return { kind: "succeeded", result: { removedEventId: undo.eventId }, undoData: null };
      } catch (error) {
        return fromExternalError(error);
      }
    },
    async verify({ undo, readers }) {
      if (!readers.calendar) throw new Error("Google Calendar is not connected");
      return [{ id: "event_deleted", passed: (await readers.calendar.getEvent(String(undo.eventId))) === null }];
    },
    warning: (resolved) =>
      resolved.othersInvolved.length > 0 ? `Google will email cancellations to ${resolved.othersInvolved.join(", ")}.` : null,
  },
};
```

- [ ] **Step 5: Write `update-calendar-event.ts`**

```ts
import { z } from "zod";
import { maxRisk, type CalendarEventDraft } from "@oneon/domain";
import { chatKey } from "../idempotency.js";
import { DEFAULT_RECOVERY_THRESHOLD_MS, PERSONAL_APPROVERS, type ActionDefinition, type Resolved } from "../definition.js";
import { fromExternalError } from "./outcomes.js";
import { OTHERS_INVOLVED_METRIC, formatDateTime, isoWithOffset, normalizeAttendees, othersInvolved, sameField } from "./calendar-shared.js";

const FIELDS = ["title", "start", "end", "description", "attendees", "location"] as const;
type Field = (typeof FIELDS)[number];
const NOTIFYING: readonly Field[] = ["start", "end", "location", "attendees"];

const inputSchema = z
  .object({
    eventId: z.string().min(1),
    title: z.string().min(1).optional(),
    start: isoWithOffset.optional(),
    end: isoWithOffset.optional(),
    description: z.string().nullable().optional(),
    attendees: z.array(z.string().email()).optional(),
    location: z.string().nullable().optional(),
  })
  .strict()
  .refine((v) => FIELDS.some((f) => v[f] !== undefined), { message: "Provide at least one field to change" });

export type UpdateCalendarEventInput = z.infer<typeof inputSchema>;
export interface UpdateCalendarEventResolved extends Resolved {
  changes: Partial<CalendarEventDraft> & Record<string, unknown>;
  previous: Partial<CalendarEventDraft> & Record<string, unknown>;
  versionBefore: string | null;
  eventTitle: string;
  othersInvolved: string[];
  sendUpdates: "all" | "none";
}

const floor = {
  risk: "L1" as const,
  approval: { mode: "above_threshold" as const, thresholds: { others_involved: 0 } },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 24,
};

export const updateCalendarEventDefinition: ActionDefinition<UpdateCalendarEventInput, UpdateCalendarEventResolved> = {
  type: "update_calendar_event",
  version: "1",
  scope: "personal",
  label: "Update calendar event",
  description: "Change an existing Google Calendar event.",
  inputSchema,
  effects: { reads: ["Google Calendar event"], writes: ["Google Calendar event", "update emails"] },
  floor,
  defaults: { ...floor, enabled: true },
  thresholdMetrics: OTHERS_INVOLVED_METRIC,
  rollbackClass: "conditional",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 15_000,
  disableWarning: null,
  unavailableReason: null,
  consequenceKeys: ["sendUpdates", "othersInvolved", "metrics", "previous"],
  idempotencyKey: (input, ctx) => (ctx.source === "chat" ? chatKey(ctx.turnId, input) : `rule:${ctx.resourceId}`),

  async preconditions({ input, readers }) {
    if (!readers.calendar) return [{ id: "calendar_connected", kind: "blocking", passed: false }];
    const event = await readers.calendar.getEvent(input.eventId);
    return [
      { id: "calendar_connected", kind: "blocking", passed: true },
      { id: "event_exists", kind: "blocking", passed: event !== null, expected: input.eventId, actual: event?.id ?? null },
    ];
  },

  async resolve({ input, readers }) {
    const current = readers.calendar ? await readers.calendar.getEvent(input.eventId) : null;
    if (!current) return { ok: false, error: { code: "event_not_found", message: "The calendar event no longer exists.", stage: "validation" } };

    const changes: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (input[f] === undefined) continue;
      changes[f] = f === "attendees" ? normalizeAttendees(input.attendees!) : input[f];
      previous[f] = current[f];
    }
    const start = (changes.start as string | undefined) ?? current.start;
    const end = (changes.end as string | undefined) ?? current.end;
    if (Date.parse(start) >= Date.parse(end)) {
      return { ok: false, error: { code: "invalid_time_range", message: "The change would put the end before the start.", stage: "validation" } };
    }

    const before = normalizeAttendees(current.attendees);
    const after = (changes.attendees as string[] | undefined) ?? before;
    const others = othersInvolved([...before, ...after], readers.identity.googleEmail);
    const notifies = NOTIFYING.some((f) => f in changes && !sameField(f, changes[f], current[f]));
    return {
      ok: true,
      resolved: {
        metrics: { others_involved: others.length },
        othersInvolved: others,
        sendUpdates: (before.length > 0 || after.length > 0) && notifies ? "all" : "none",
        changes,
        previous,
        versionBefore: current.etag ?? null,
        eventTitle: current.title,
      },
    };
  },

  riskFor: (resolved, floorRisk) => (resolved.othersInvolved.length > 0 ? maxRisk("L2", floorRisk) : floorRisk),

  describe(resolved) {
    const parts = Object.entries(resolved.changes).map(([k, v]) => {
      if (k === "start" || k === "end") return `${k} to ${formatDateTime(String(v))}`;
      if (k === "attendees") return `attendees to ${(v as string[]).join(", ") || "nobody"}`;
      return `${k} to "${v ?? ""}"`;
    });
    const base = `Change "${resolved.eventTitle}": ${parts.join("; ")}.`;
    return resolved.sendUpdates === "all"
      ? `${base} Google will email the update to ${resolved.othersInvolved.join(", ")}.`
      : base;
  },

  async execute({ input, resolved, writers }) {
    if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
    if (!resolved.versionBefore) return { kind: "definite_failure", code: "missing_version", message: "Google did not report the event's version." };
    try {
      const event = await writers.calendar.update(input.eventId, resolved.changes, {
        ifMatch: resolved.versionBefore,
        sendUpdates: resolved.sendUpdates,
      });
      return {
        kind: "succeeded",
        result: { eventId: event.id, etag: event.etag ?? null },
        undoData: {
          eventId: event.id,
          previous: resolved.previous,
          versionBefore: resolved.versionBefore,
          versionAfter: event.etag ?? null,
          sendUpdates: resolved.sendUpdates,
        },
      };
    } catch (error) {
      return fromExternalError(error);
    }
  },

  async postconditions({ input, resolved, readers }) {
    if (!readers.calendar) throw new Error("Google Calendar is not connected");
    const event = await readers.calendar.getEvent(input.eventId);
    return {
      effectCheckId: "event_exists",
      checks: [
        { id: "event_exists", passed: event !== null, expected: input.eventId, actual: event?.id ?? null },
        ...Object.entries(resolved.changes).map(([k, v]) => ({
          id: `${k}_matches`,
          passed: !!event && sameField(k, event[k as Field], v),
          expected: v,
          actual: event ? event[k as Field] : null,
        })),
      ],
    };
  },

  undo: {
    async preconditions({ undo, readers }) {
      const event = readers.calendar ? await readers.calendar.getEvent(String(undo.eventId)) : null;
      return [
        { id: "event_still_exists", failureCode: "not_found", passed: event !== null },
        { id: "unchanged_since", failureCode: "changed_since", passed: !!event && event.etag === undo.versionAfter, expected: undo.versionAfter, actual: event?.etag ?? null },
      ];
    },
    async execute({ undo, writers }) {
      if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
      try {
        await writers.calendar.update(String(undo.eventId), undo.previous as Partial<CalendarEventDraft>, {
          ifMatch: String(undo.versionAfter),
          sendUpdates: undo.sendUpdates === "all" ? "all" : "none",
        });
        return { kind: "succeeded", result: { restoredEventId: undo.eventId }, undoData: null };
      } catch (error) {
        return fromExternalError(error);
      }
    },
    async verify({ undo, readers }) {
      if (!readers.calendar) throw new Error("Google Calendar is not connected");
      const event = await readers.calendar.getEvent(String(undo.eventId));
      return Object.entries(undo.previous as Record<string, unknown>).map(([k, v]) => ({
        id: `${k}_restored`,
        passed: !!event && sameField(k, event[k as Field], v),
        expected: v,
        actual: event ? event[k as Field] : null,
      }));
    },
    warning: (resolved) =>
      resolved.sendUpdates === "all" ? `Google will email the change back to ${resolved.othersInvolved.join(", ")}.` : null,
  },
};
```

- [ ] **Step 6: Register them and add samples**

In `definitions/index.ts`, import and export both, and make the registry list:

```ts
export function createActionDefinitions(): AnyActionDefinition[] {
  return [
    notifyDefinition,
    createReminderDefinition,
    createCalendarEventDefinition,
    updateCalendarEventDefinition,
    ...GMAIL_DEFINITIONS,
  ];
}
```

Add to `SAMPLES`:

```ts
  create_calendar_event: { title: "Call", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00" },
  update_calendar_event: { eventId: "ev1", title: "Deep work" },
```

Add one assertion to `contract.test.ts` pinning the registry size:

```ts
it("registers exactly the 10 definitions in spec §9", () => {
  expect(createActionDefinitions().map((d) => d.type).sort()).toEqual(
    ["archive", "create_calendar_event", "create_reminder", "delete", "draft_reply", "forward", "label", "notify", "send", "update_calendar_event"],
  );
});
```

- [ ] **Step 7: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/actions
git commit -m "feat(actions): add calendar event create and update definitions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
