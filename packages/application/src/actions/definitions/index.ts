import type { AnyActionDefinition } from "../definition.js";
import { GMAIL_DEFINITIONS } from "./gmail.js";

export { GMAIL_DEFINITIONS } from "./gmail.js";
export { fromExternalError } from "./outcomes.js";

/** Every registered action type. Tasks 7 and 8 add the four with real executors. */
export function createActionDefinitions(): AnyActionDefinition[] {
  return [...GMAIL_DEFINITIONS];
}
