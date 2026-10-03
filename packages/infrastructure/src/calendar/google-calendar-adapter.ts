import type {
  CalendarPort,
  CalendarEvent,
  CalendarReader,
  CalendarWriter,
  CalendarEventDraft,
  CalendarSendUpdates,
} from "@oneon/domain";
import { ExternalCallError } from "@oneon/domain";
import { GCalApiError, type GCalHttpClient } from "./gcal-http-client.js";
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
export class GoogleCalendarAdapter implements CalendarPort, CalendarReader, CalendarWriter {
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

  async getEvent(id: string): Promise<CalendarEvent | null> {
    const resource = await this.client.getEvent(this.calendarId, id).catch(mapReadError);
    if (!resource || resource.status === "cancelled") return null;
    return mapToDomain(resource);
  }

  async create(
    event: CalendarEventDraft,
    options: { eventId: string; sendUpdates: CalendarSendUpdates; signal?: AbortSignal },
  ): Promise<CalendarEvent> {
    const body = { ...mapToWriteBody(event), id: options.eventId };
    const created = await this.client
      .insertEvent(this.calendarId, body, { sendUpdates: options.sendUpdates, signal: options.signal })
      .catch((error: unknown) => mapWriteError(error, "create"));
    this.cache.invalidateByPrefix(this.cachePrefix);
    return mapToDomain(created);
  }

  async update(
    id: string,
    changes: Partial<CalendarEventDraft>,
    options: { ifMatch: string; sendUpdates: CalendarSendUpdates; signal?: AbortSignal },
  ): Promise<CalendarEvent> {
    const updated = await this.client
      .patchEvent(this.calendarId, id, mapToPartialWriteBody(changes), options)
      .catch((error: unknown) => mapWriteError(error, "update"));
    this.cache.invalidateByPrefix(this.cachePrefix);
    return mapToDomain(updated);
  }

  async remove(id: string, options: { ifMatch: string; sendUpdates: CalendarSendUpdates; signal?: AbortSignal }): Promise<void> {
    await this.client.deleteEvent(this.calendarId, id, options).catch((error: unknown) => mapWriteError(error, "remove"));
    this.cache.invalidateByPrefix(this.cachePrefix);
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
    etag: resource.etag ?? null,
    updated: resource.updated ?? null,
  };
}

// Spec §10.4. Reads surface unknown failures as-is; writes classify every failure.
function mapReadError(error: unknown): never {
  if (error instanceof ExternalCallError) throw error;
  if (error instanceof GCalApiError) {
    throw new ExternalCallError(error.status >= 500 || error.status === 429 ? "unknown" : "definite", "read_failed", error.message);
  }
  throw new ExternalCallError("unknown", "google_unreachable", error instanceof Error ? error.message : String(error));
}

function mapWriteError(error: unknown, op: "create" | "update" | "remove"): never {
  if (error instanceof ExternalCallError) throw error;
  if (error instanceof GCalApiError) {
    if (op === "create" && error.status === 409) throw new ExternalCallError("unknown", "already_exists", error.message);
    if (error.status === 412) throw new ExternalCallError("definite", "changed_since", error.message);
    if (error.status === 404 || error.status === 410) throw new ExternalCallError("definite", "not_found", error.message);
    if (error.status === 429 || error.status >= 500) throw new ExternalCallError("unknown", "google_unavailable", error.message);
    throw new ExternalCallError("definite", "rejected_by_google", error.message);
  }
  throw new ExternalCallError("unknown", "google_unreachable", error instanceof Error ? error.message : String(error));
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
