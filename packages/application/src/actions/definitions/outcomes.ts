import { DelegationRevokedError, DelegationUnreachableError, ExternalCallError } from "@oneon/domain";
import type { ExecutionOutcome } from "../definition.js";

/** Spec §10.4: unexpected exceptions count as unknown, so the safe default is to verify. */
export function fromExternalError(error: unknown): ExecutionOutcome {
  if (error instanceof ExternalCallError) {
    return error.outcome === "definite"
      ? { kind: "definite_failure", code: error.code, message: error.message }
      : { kind: "unknown", code: error.code, message: error.message };
  }
  // A call ImpressoRx refused with a 401 applied nothing: the person's access has ended (spec §7.7).
  if (error instanceof DelegationRevokedError) {
    return { kind: "definite_failure", code: error.code, message: "The person's access to this pharmacy has ended." };
  }
  // The call may or may not have reached ImpressoRx before the connection failed, so what happened has to be checked.
  if (error instanceof DelegationUnreachableError) {
    return { kind: "unknown", code: error.code, message: "ImpressoRx could not be reached while the action ran." };
  }
  return { kind: "unknown", code: "unexpected_error", message: error instanceof Error ? error.message : String(error) };
}
