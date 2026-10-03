import type { Deadline, Notification } from "../entities.js";
import type { CalendarReader, CalendarWriter } from "../ports/calendar.port.js";
import type { NotificationWriter } from "../ports/notification.port.js";

export type SuppressionReason = "quiet_hours" | "type_disabled";

/** Read-only access handed to preconditions, resolve and verification. */
export interface ActionReaders {
  calendar: CalendarReader | null;
  deadlines: { findById(id: string): Deadline | null };
  notifications: {
    isSuppressed(userId: string, eventType: string, now: Date): SuppressionReason | null;
    findById(id: string): Notification | null;
  };
  identity: { googleEmail: string | null };
  links: { inboundItem(id: string): string };
}

/** Write access; only executors receive it. */
export interface ActionWriters {
  calendar: CalendarWriter | null;
  notifications: NotificationWriter | null;
}

export interface ActionCapabilities {
  readers: ActionReaders;
  writers: ActionWriters;
}
