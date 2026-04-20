import type { CalendarPort, CalendarEvent } from "@oneon/domain";
import type { GCalHttpClient } from "./gcal-http-client.js";
import type { GCalEventResource, GCalEventWriteBody } from "./calendar.types.js";
import type { TTLCache } from "../cache/ttl-cache.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface GoogleCalendarAdapterConfig {
  client: GCalHttpClient;
  calendarId: string;
  cache: TTLCache<CalendarEvent[]>;
  cacheTtlMs: number;
}

/**
 * Implements CalendarPort via Google Calendar API v3.
 *
 * Features:
 * - Parameterized calendarId (not hardcoded to "primary")
 * - TTL cache on read operations (listEvents, searchEvents)
 * - Calendar-level cache invalidation on writes
 * - All-day events preserve date-only representation (no UTC midnight mapping)
 */
export class GoogleCalendarAdapter implements CalendarPort {
  private readonly client: GCalHttpClient;
  private readonly calendarId: string;
  private readonly cache: TTLCache<CalendarEvent[]>;
  private readonly cacheTtlMs: number;
  private readonly cachePrefix: string;

  constructor(config: GoogleCalendarAdapterConfig) {
    this.client = config.client;
    this.calendarId = config.calendarId;
    this.cache = config.cache;
    this.cacheTtlMs = config.cacheTtlMs;
    this.cachePrefix = `cal:${this.calendarId}:`;
  }

  async listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const cacheKey = `${this.cachePrefix}list:${timeMin}|${timeMax}`;

    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const response = await this.client.listEvents(this.calendarId, {
          timeMin,
          timeMax,
        });
        return (response.items ?? []).map(mapToDomain);
      },
      this.cacheTtlMs,
    );
  }

  async createEvent(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    const body = mapToWriteBody(event);
    const created = await this.client.insertEvent(this.calendarId, body);
    this.cache.invalidateByPrefix(this.cachePrefix);
    return mapToDomain(created);
  }

  async updateEvent(
    id: string,
    updates: Partial<Omit<CalendarEvent, "id">>,
  ): Promise<CalendarEvent> {
    const body = mapToPartialWriteBody(updates);
    const updated = await this.client.patchEvent(this.calendarId, id, body);
    this.cache.invalidateByPrefix(this.cachePrefix);
    return mapToDomain(updated);
  }

  async searchEvents(
    query: string,
    timeMin?: string,
    timeMax?: string,
  ): Promise<CalendarEvent[]> {
    const now = Date.now();
    const effectiveMin = timeMin ?? new Date(now - THIRTY_DAYS_MS).toISOString();
    const effectiveMax = timeMax ?? new Date(now + THIRTY_DAYS_MS).toISOString();

    const cacheKey = `${this.cachePrefix}search:${query}|${effectiveMin}|${effectiveMax}`;

    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const response = await this.client.listEvents(this.calendarId, {
          timeMin: effectiveMin,
          timeMax: effectiveMax,
          q: query,
        });
        return (response.items ?? []).map(mapToDomain);
      },
      this.cacheTtlMs,
    );
  }
}

// ── Mapping helpers (module-private) ─────────────────────────

function mapToDomain(resource: GCalEventResource): CalendarEvent {
  const allDay = !!resource.start.date;

  return {
    id: resource.id,
    title: resource.summary ?? "(no title)",
    start: allDay ? resource.start.date! : (resource.start.dateTime ?? ""),
    end: allDay ? resource.end.date! : (resource.end.dateTime ?? ""),
    allDay,
    description: resource.description ?? null,
    attendees: (resource.attendees ?? []).map((a) => a.email),
    location: resource.location ?? null,
  };
}

function mapToWriteBody(event: Omit<CalendarEvent, "id">): GCalEventWriteBody {
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: event.allDay ? { date: event.start } : { dateTime: event.start },
    end: event.allDay ? { date: event.end } : { dateTime: event.end },
    attendees: event.attendees.map((email) => ({ email })),
  };
}

function mapToPartialWriteBody(
  updates: Partial<Omit<CalendarEvent, "id">>,
): Partial<GCalEventWriteBody> {
  const body: Partial<GCalEventWriteBody> = {};

  if (updates.title !== undefined) body.summary = updates.title;
  if (updates.description !== undefined) body.description = updates.description;
  if (updates.location !== undefined) body.location = updates.location;
  if (updates.start !== undefined) {
    body.start = updates.allDay ? { date: updates.start } : { dateTime: updates.start };
  }
  if (updates.end !== undefined) {
    body.end = updates.allDay ? { date: updates.end } : { dateTime: updates.end };
  }
  if (updates.attendees !== undefined) {
    body.attendees = updates.attendees.map((email) => ({ email }));
  }

  return body;
}
