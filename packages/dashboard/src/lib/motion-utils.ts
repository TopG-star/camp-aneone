export const STAGGER_STEP_MS = 70;
export const STAGGER_MAX_INDEX = 10;

export function clampStaggerIndex(index: number): number {
  if (!Number.isFinite(index) || index < 0) {
    return 0;
  }

  return Math.min(Math.floor(index), STAGGER_MAX_INDEX);
}

export function getStaggerDelayMs(index: number): number {
  return clampStaggerIndex(index) * STAGGER_STEP_MS;
}

export function getMotionDelayClass(index: number): string {
  return `motion-delay-${clampStaggerIndex(index)}`;
}
