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
