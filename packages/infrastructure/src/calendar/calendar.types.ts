/**
 * Minimal type definitions for the Google Calendar API v3 responses.
 * Only the fields we actually consume are typed.
 * @see https://developers.google.com/calendar/api/v3/reference
 */

// ── events.list response ───────────────────────────────────

export interface GCalEventsListResponse {
  kind: "calendar#events";
  items?: GCalEventResource[];
  nextPageToken?: string;
  timeZone?: string;
}

// ── events.get / events.insert / events.patch ──────────────

export interface GCalEventResource {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: GCalDateTime;
  end: GCalDateTime;
  attendees?: GCalAttendee[];
  status?: string; // "confirmed" | "tentative" | "cancelled"
  htmlLink?: string;
  created?: string;
  updated?: string;
}

/**
 * Google Calendar events use EITHER `dateTime` (timed) or `date` (all-day).
 * Only one of the two is present per event.
 */
export interface GCalDateTime {
  /** ISO-8601 with timezone offset, e.g. "2026-04-18T10:00:00-05:00" */
  dateTime?: string;
  /** All-day date, e.g. "2026-04-18" */
  date?: string;
  /** IANA timezone, e.g. "America/New_York" */
  timeZone?: string;
}

export interface GCalAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string; // "needsAction" | "declined" | "tentative" | "accepted"
  self?: boolean;
}

// ── Request body for insert / patch ────────────────────────

export interface GCalEventWriteBody {
  summary?: string;
  description?: string | null;
  location?: string | null;
  start: GCalDateTime;
  end: GCalDateTime;
  attendees?: GCalAttendee[];
}

// ── Required Google OAuth scopes for Calendar ──────────────

export const GCAL_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;
