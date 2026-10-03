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
