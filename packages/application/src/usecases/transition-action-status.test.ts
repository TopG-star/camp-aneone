import { describe, it, expect } from "vitest";
import {
  assertValidTransition,
  InvalidTransitionError,
} from "./transition-action-status.js";
import type { ActionStatus } from "@oneon/domain";

describe("assertValidTransition", () => {
  // ── Valid transitions ────────────────────────────────────

  const validTransitions: [ActionStatus, ActionStatus][] = [
    ["proposed", "approved"],
    ["proposed", "rejected"],
    ["approved", "executed"],
    ["executed", "rolled_back"],
  ];

  it.each(validTransitions)(
    "allows %s → %s",
    (from, to) => {
      expect(() => assertValidTransition(from, to)).not.toThrow();
    }
  );

  // ── Invalid transitions ──────────────────────────────────

  const invalidTransitions: [ActionStatus, ActionStatus][] = [
    // Can't skip steps
    ["proposed", "executed"],
    ["proposed", "rolled_back"],
    // Can't go backward
    ["approved", "proposed"],
    ["executed", "proposed"],
    ["executed", "approved"],
    ["rejected", "proposed"],
    ["rejected", "approved"],
    ["rejected", "executed"],
    ["rolled_back", "proposed"],
    ["rolled_back", "approved"],
    ["rolled_back", "executed"],
    // Can't self-transition
    ["proposed", "proposed"],
    ["approved", "approved"],
    ["executed", "executed"],
    ["rejected", "rejected"],
    ["rolled_back", "rolled_back"],
    // Terminal states can't transition
    ["rejected", "rolled_back"],
    ["rolled_back", "rejected"],
  ];

  it.each(invalidTransitions)(
    "rejects %s → %s",
    (from, to) => {
      expect(() => assertValidTransition(from, to)).toThrow(InvalidTransitionError);
    }
  );

  it("error includes from and to statuses", () => {
    try {
      assertValidTransition("rejected", "approved");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe("rejected");
      expect(err.to).toBe("approved");
      expect(err.message).toContain("rejected");
      expect(err.message).toContain("approved");
    }
  });
});
