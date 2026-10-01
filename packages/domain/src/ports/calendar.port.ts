export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO-8601 dateTime for timed events; "YYYY-MM-DD" for all-day events. */
  start: string;
  /** ISO-8601 dateTime for timed events; "YYYY-MM-DD" (exclusive) for all-day events. */
  end: string;
  /** True when the event spans full calendar days (start/end are date-only strings). */
  allDay: boolean;
  description: string | null;
  attendees: string[];
  location: string | null;
  /** Google's version tag; present on events read through CalendarReader.getEvent. */
  etag?: string | null;
  /** Last-modified timestamp from Google. */
  updated?: string | null;
}

export interface CalendarPort {
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  createEvent(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent>;
  updateEvent(
    id: string,
    updates: Partial<Omit<CalendarEvent, "id">>
  ): Promise<CalendarEvent>;
  searchEvents(query: string, timeMin?: string, timeMax?: string): Promise<CalendarEvent[]>;
}

export type CalendarSendUpdates = "all" | "none";

/** An event as Oneon writes it; Google assigns etag and updated. */
export type CalendarEventDraft = Omit<CalendarEvent, "id" | "etag" | "updated">;

export interface CalendarReader {
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  searchEvents(query: string, timeMin?: string, timeMax?: string): Promise<CalendarEvent[]>;
  /** Returns null when the event does not exist or has been cancelled. */
  getEvent(id: string): Promise<CalendarEvent | null>;
}

/**
 * Only action executors receive a CalendarWriter (spec §5, enforced in Task 16).
 * Errors are ExternalCallError with a definite or unknown outcome.
 */
export interface CalendarWriter {
  create(
    event: CalendarEventDraft,
    options: { eventId: string; sendUpdates: CalendarSendUpdates },
  ): Promise<CalendarEvent>;
  update(
    id: string,
    changes: Partial<CalendarEventDraft>,
    options: { ifMatch: string; sendUpdates: CalendarSendUpdates },
  ): Promise<CalendarEvent>;
  remove(id: string, options: { ifMatch: string; sendUpdates: CalendarSendUpdates }): Promise<void>;
}
