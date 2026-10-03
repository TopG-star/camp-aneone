import { describe, expect, it } from "vitest";
import {
  STAGGER_MAX_INDEX,
  STAGGER_STEP_MS,
  clampStaggerIndex,
  getMotionDelayClass,
  getStaggerDelayMs,
} from "./motion-utils";

describe("motion-utils", () => {
  it("clamps invalid or negative indexes to zero", () => {
    expect(clampStaggerIndex(-4)).toBe(0);
    expect(clampStaggerIndex(Number.NaN)).toBe(0);
    expect(clampStaggerIndex(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("floors decimal values and caps at max index", () => {
    expect(clampStaggerIndex(2.9)).toBe(2);
    expect(clampStaggerIndex(STAGGER_MAX_INDEX + 12)).toBe(STAGGER_MAX_INDEX);
  });

  it("computes delay from clamped index", () => {
    expect(getStaggerDelayMs(0)).toBe(0);
    expect(getStaggerDelayMs(3)).toBe(3 * STAGGER_STEP_MS);
    expect(getStaggerDelayMs(STAGGER_MAX_INDEX + 9)).toBe(
      STAGGER_MAX_INDEX * STAGGER_STEP_MS,
    );
  });

  it("returns class-based delay tokens", () => {
    expect(getMotionDelayClass(0)).toBe("motion-delay-0");
    expect(getMotionDelayClass(4)).toBe("motion-delay-4");
    expect(getMotionDelayClass(STAGGER_MAX_INDEX + 20)).toBe(
      `motion-delay-${STAGGER_MAX_INDEX}`,
    );
  });
});
