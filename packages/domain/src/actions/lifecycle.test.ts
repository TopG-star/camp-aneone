import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STATUSES,
  isAllowedTransition,
  isLifecycleStatus,
  type LifecycleStatus,
} from "./lifecycle.js";

// Spec §7.2, written out by hand so the test does not reuse the code's table.
const ALLOWED: Array<[LifecycleStatus, LifecycleStatus]> = [
  ["proposed", "validating"],
  ["proposed", "cancelled"],
  ["validating", "awaiting_approval"],
  ["validating", "approved"],
  ["validating", "rejected"],
  ["validating", "failed"],
  ["validating", "cancelled"],
  ["awaiting_approval", "approved"],
  ["awaiting_approval", "rejected"],
  ["awaiting_approval", "expired"],
  ["awaiting_approval", "cancelled"],
  ["approved", "executing"],
  ["approved", "failed"],
  ["approved", "cancelled"],
  ["executing", "verifying"],
  ["executing", "failed"],
  ["verifying", "completed"],
  ["verifying", "partially_completed"],
  ["verifying", "failed"],
  ["completed", "rolling_back"],
  ["partially_completed", "rolling_back"],
  ["rolling_back", "rolled_back"],
  ["rolling_back", "rollback_failed"],
];

describe("action lifecycle", () => {
  it("has exactly the 15 statuses from the spec", () => {
    expect([...LIFECYCLE_STATUSES].sort()).toEqual(
      [
        "approved", "awaiting_approval", "cancelled", "completed", "executing",
        "expired", "failed", "partially_completed", "proposed", "rejected",
        "rollback_failed", "rolled_back", "rolling_back", "validating", "verifying",
      ],
    );
  });

  it("allows the 23 transitions in §7.2 and refuses the other 202 ordered pairs", () => {
    let allowedCount = 0;
    for (const from of LIFECYCLE_STATUSES) {
      for (const to of LIFECYCLE_STATUSES) {
        const expected = ALLOWED.some(([f, t]) => f === from && t === to);
        if (expected) allowedCount++;
        expect(isAllowedTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
    expect(allowedCount).toBe(23);
  });

  it("recognises status strings", () => {
    expect(isLifecycleStatus("rolling_back")).toBe(true);
    expect(isLifecycleStatus("executed")).toBe(false);
  });
});
