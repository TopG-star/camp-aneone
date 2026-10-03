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
