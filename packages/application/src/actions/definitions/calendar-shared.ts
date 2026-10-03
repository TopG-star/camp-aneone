import { z } from "zod";
import type { CalendarEvent } from "@oneon/domain";

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** Review Focus 1: a time without an offset is refused so the AI retries with one. */
export const isoWithOffset = z.string().refine((s) => OFFSET.test(s) && !Number.isNaN(Date.parse(s)), {
  message: "Use an ISO-8601 date-time with a UTC offset, e.g. 2026-10-07T10:00:00+00:00",
});

/** Lowercased and de-duplicated, keeping first-seen order (Review Focus 5). */
export function normalizeAttendees(list: string[]): string[] {
  return [...new Set(list.map((a) => a.trim().toLowerCase()))];
}

/** Attendees other than the owner's own Google account (Review Focus 2). */
export function othersInvolved(attendees: string[], ownerEmail: string | null): string[] {
  const owner = ownerEmail?.toLowerCase() ?? null;
  return normalizeAttendees(attendees).filter((a) => a !== owner);
}

export function sameField(key: string, a: unknown, b: unknown): boolean {
  if (key === "start" || key === "end") return typeof a === "string" && typeof b === "string" && Date.parse(a) === Date.parse(b);
  if (key === "attendees") {
    const left = normalizeAttendees((a as string[] | undefined) ?? []).sort();
    const right = normalizeAttendees((b as string[] | undefined) ?? []).sort();
    return left.length === right.length && left.every((v, i) => v === right[i]);
  }
  return (a ?? null) === (b ?? null);
}

export function formatRange(start: string, end: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const s = new Date(start);
  const e = new Date(end);
  return `${day.format(s).replace(",", "")}, ${time.format(s)}–${time.format(e)} UTC`;
}

export function formatDateTime(iso: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const d = new Date(iso);
  return `${day.format(d).replace(",", "")}, ${time.format(d)} UTC`;
}

export const OTHERS_INVOLVED_METRIC = {
  others_involved: {
    label: "other people involved",
    exceededText: "Other people are involved, so this needs approval.",
  },
};

export type EventFields = Pick<CalendarEvent, "title" | "start" | "end" | "description" | "attendees" | "location">;
