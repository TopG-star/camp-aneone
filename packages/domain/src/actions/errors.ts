export class ActionNotFoundError extends Error {
  constructor(readonly actionId: string) {
    super(`Action not found: ${actionId}`);
    this.name = "ActionNotFoundError";
  }
}

/** The action's status changed since the caller read it (spec §8.3: double-click Approve gets 409). */
export class TransitionConflictError extends Error {
  constructor(readonly actionId: string, readonly expected: string, readonly actual: string) {
    super(`Action ${actionId} is ${actual}, expected ${expected}`);
    this.name = "TransitionConflictError";
  }
}

export class LifecycleTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Transition not allowed: ${from} → ${to}`);
    this.name = "LifecycleTransitionError";
  }
}

/**
 * Thrown by adapters that call external systems. `definite` guarantees nothing changed;
 * `unknown` means it may have (spec §10.4). Never retried by the HTTP retry helper.
 */
export class ExternalCallError extends Error {
  readonly retryable = false;

  constructor(readonly outcome: "definite" | "unknown", readonly code: string, message: string) {
    super(message);
    this.name = "ExternalCallError";
  }
}
