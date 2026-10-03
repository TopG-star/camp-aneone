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
