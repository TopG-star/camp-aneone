import type { AnyActionDefinition } from "../definition.js";
import { GMAIL_DEFINITIONS } from "./gmail.js";
import { notifyDefinition } from "./notify.js";
import { createReminderDefinition } from "./create-reminder.js";

export { GMAIL_DEFINITIONS } from "./gmail.js";
export { fromExternalError } from "./outcomes.js";
export { notifyDefinition } from "./notify.js";
export { createReminderDefinition } from "./create-reminder.js";

/** Every registered action type. Tasks 7 and 8 add the four with real executors. */
export function createActionDefinitions(): AnyActionDefinition[] {
  return [notifyDefinition, createReminderDefinition, ...GMAIL_DEFINITIONS];
}
