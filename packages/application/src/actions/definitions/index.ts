import type { AnyActionDefinition } from "../definition.js";
import { GMAIL_DEFINITIONS } from "./gmail.js";
import { notifyDefinition } from "./notify.js";
import { createReminderDefinition } from "./create-reminder.js";
import { createCalendarEventDefinition } from "./create-calendar-event.js";
import { updateCalendarEventDefinition } from "./update-calendar-event.js";

export { GMAIL_DEFINITIONS } from "./gmail.js";
export { fromExternalError } from "./outcomes.js";
export { notifyDefinition } from "./notify.js";
export { createReminderDefinition } from "./create-reminder.js";
export { createCalendarEventDefinition } from "./create-calendar-event.js";
export { updateCalendarEventDefinition } from "./update-calendar-event.js";

/** Every registered action type. */
export function createActionDefinitions(): AnyActionDefinition[] {
  return [
    notifyDefinition,
    createReminderDefinition,
    createCalendarEventDefinition,
    updateCalendarEventDefinition,
    ...GMAIL_DEFINITIONS,
  ];
}
