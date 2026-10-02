import { ExternalCallError } from "@oneon/domain";
import type {
  ActionReaders,
  ActionWriters,
  CalendarEvent,
  CalendarEventDraft,
  CalendarReader,
  CalendarWriter,
  Deadline,
  Notification,
} from "@oneon/domain";

/** In-memory calendar with Google-like versioning: every write bumps the etag. */
export function fakeCalendar(ownerEmail = "owner@test.com") {
  const events = new Map<string, CalendarEvent>();
  let version = 1;
  const stamp = (e: Omit<CalendarEvent, "etag" | "updated">): CalendarEvent => ({
    ...e,
    etag: `"v${version++}"`,
    updated: "2026-10-01T12:00:00.000Z",
  });
  const reader: CalendarReader = {
    listEvents: async () => [...events.values()],
    searchEvents: async () => [...events.values()],
    getEvent: async (id) => events.get(id) ?? null,
  };
  const writer: CalendarWriter = {
    async create(event: CalendarEventDraft, options) {
      if (events.has(options.eventId)) throw new ExternalCallError("unknown", "already_exists", "exists");
      const created = stamp({ ...event, id: options.eventId });
      events.set(created.id, created);
      return created;
    },
    async update(id, changes, options) {
      const current = events.get(id);
      if (!current) throw new ExternalCallError("definite", "not_found", "missing");
      if (current.etag !== options.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      // Like the adapter: a start/end written without allDay: true is a dateTime, so the event becomes timed.
      const timing = changes.start !== undefined || changes.end !== undefined ? { allDay: changes.allDay ?? false } : {};
      const updated = stamp({ ...current, ...changes, ...timing, id });
      events.set(id, updated);
      return updated;
    },
    async remove(id, options) {
      const current = events.get(id);
      if (!current) throw new ExternalCallError("definite", "not_found", "missing");
      if (current.etag !== options.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      events.delete(id);
    },
  };
  /** Simulates someone else editing the event in Google Calendar. */
  const editElsewhere = (id: string, changes: Partial<CalendarEvent>) => {
    const current = events.get(id)!;
    events.set(id, stamp({ ...current, ...changes }));
  };
  return { events, reader, writer, editElsewhere, ownerEmail };
}

export function fakeReaders(overrides: Partial<ActionReaders> = {}): ActionReaders {
  return {
    calendar: null,
    deadlines: { findById: () => null },
    notifications: { isSuppressed: () => null, findById: () => null },
    identity: { googleEmail: "owner@test.com" },
    links: { inboundItem: (id) => `https://oneon.test/items/${id}` },
    ...overrides,
  };
}

export function fakeWriters(overrides: Partial<ActionWriters> = {}): ActionWriters {
  return { calendar: null, notifications: null, ...overrides };
}

export function deadline(overrides: Partial<Deadline> = {}): Deadline {
  return {
    id: "d1",
    userId: "u1",
    inboundItemId: "i1",
    dueDate: "2026-10-07T17:00:00Z",
    description: "Submit Q4 report",
    confidence: 0.9,
    status: "open",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

export function notification(id: string): Notification {
  return {
    id, userId: "u1", eventType: "urgent_item", title: "t", body: "b",
    deepLink: null, read: false, createdAt: "2026-10-01T00:00:00Z",
  };
}
