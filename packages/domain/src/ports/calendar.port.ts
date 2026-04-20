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
