import { z } from "zod";
import type { CalendarEventDraft } from "@oneon/domain";
import { deadlineKey } from "../idempotency.js";
import {
  DEFAULT_RECOVERY_THRESHOLD_MS,
  PERSONAL_APPROVERS,
  type ActionDefinition,
  type PreconditionResult,
  type Resolved,
} from "../definition.js";
import { fromExternalError } from "./outcomes.js";

const inputSchema = z.object({ deadlineId: z.string().min(1), inboundItemId: z.string().min(1) }).strict();

export type CreateReminderInput = z.infer<typeof inputSchema>;
export interface CreateReminderResolved extends Resolved {
  event: CalendarEventDraft & Record<string, unknown>;
  sendUpdates: "none";
}

/** The deadline's own calendar date as written (no UTC conversion). */
const dayOf = (iso: string): string => iso.slice(0, 10);
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const formatDay = (day: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00Z`),
  );

const floor = {
  risk: "L1" as const,
  approval: { mode: "auto" as const, thresholds: {} },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 168,
};

export const createReminderDefinition: ActionDefinition<CreateReminderInput, CreateReminderResolved> = {
  type: "create_reminder",
  version: "1",
  scope: "personal",
  label: "Create reminder",
  description: "Add an all-day calendar reminder on a deadline's due date.",
  inputSchema,
  effects: { reads: ["deadline", "Google Calendar"], writes: ["Google Calendar event"] },
  floor,
  // Default asks first so a new user's calendar does not fill up unannounced (spec §9.7).
  defaults: { ...floor, approval: { mode: "always", thresholds: {} }, enabled: true },
  thresholdMetrics: {},
  rollbackClass: "reversible",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 15_000,
  disableWarning: null,
  unavailableReason: null,
  consequenceKeys: ["sendUpdates", "metrics"],
  idempotencyKey: (input) => deadlineKey(input.deadlineId),

  async preconditions({ input, readers, now }) {
    const d = readers.deadlines.findById(input.deadlineId);
    const today = now.toISOString().slice(0, 10);
    const checks: PreconditionResult[] = [{ id: "deadline_exists", kind: "obsolete", passed: d !== null }];
    if (d) {
      checks.push(
        { id: "deadline_open", kind: "obsolete", passed: d.status === "open", expected: "open", actual: d.status },
        {
          id: "due_date_not_passed",
          kind: "obsolete",
          passed: dayOf(d.dueDate) >= today,
          expected: `on or after ${today}`,
          actual: dayOf(d.dueDate),
        },
      );
    }
    checks.push({ id: "calendar_connected", kind: "blocking", passed: readers.calendar !== null });
    return checks;
  },

  async resolve({ input, readers }) {
    const d = readers.deadlines.findById(input.deadlineId);
    if (!d) return { ok: false, error: { code: "deadline_missing", message: "The deadline no longer exists.", stage: "validation" } };
    const start = dayOf(d.dueDate);
    return {
      ok: true,
      resolved: {
        metrics: { others_involved: 0 },
        sendUpdates: "none",
        event: {
          title: `Due: ${d.description}`,
          start,
          end: nextDay(start),
          allDay: true,
          description: `From Oneon: ${readers.links.inboundItem(input.inboundItemId)}`,
          attendees: [],
          location: null,
        },
      },
    };
  },

  riskFor: (_resolved, floorRisk) => floorRisk,
  describe: (resolved) => `Add an all-day reminder "${resolved.event.title}" on ${formatDay(resolved.event.start)} to your calendar.`,

  async execute({ resolved, writers, executorRequestId, signal }) {
    if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
    try {
      const event = await writers.calendar.create(resolved.event, { eventId: executorRequestId, sendUpdates: "none", signal });
      return {
        kind: "succeeded",
        result: { eventId: event.id, etag: event.etag ?? null },
        undoData: { eventId: event.id, versionAfter: event.etag ?? null },
      };
    } catch (error) {
      return fromExternalError(error);
    }
  },

  async postconditions({ resolved, result, executorRequestId, readers }) {
    if (!readers.calendar) throw new Error("Google Calendar is not connected");
    const eventId = typeof result?.eventId === "string" ? result.eventId : executorRequestId;
    const event = await readers.calendar.getEvent(eventId);
    const checks = [
      { id: "event_exists", passed: event !== null, expected: eventId, actual: event?.id ?? null },
      { id: "all_day_on_due_date", passed: !!event && event.allDay && event.start === resolved.event.start, expected: resolved.event.start, actual: event?.start ?? null },
      { id: "title_matches", passed: event?.title === resolved.event.title, expected: resolved.event.title, actual: event?.title ?? null },
    ];
    // Only when every field Oneon wrote still matches is the current version ours to undo.
    const ours =
      !!event?.etag &&
      checks.every((c) => c.passed) &&
      (event.description ?? null) === (resolved.event.description ?? null) &&
      (event.location ?? null) === (resolved.event.location ?? null);
    return { effectCheckId: "event_exists", checks, undoData: ours ? { eventId, versionAfter: event!.etag! } : null };
  },

  undo: {
    async preconditions({ undo, readers }) {
      const event = readers.calendar ? await readers.calendar.getEvent(String(undo.eventId)) : null;
      return [
        { id: "event_still_exists", failureCode: "not_found", passed: event !== null },
        { id: "unchanged_since", failureCode: "changed_since", passed: !!event && event.etag === undo.versionAfter, expected: undo.versionAfter, actual: event?.etag ?? null },
      ];
    },
    async execute({ undo, writers }) {
      if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
      try {
        await writers.calendar.remove(String(undo.eventId), { ifMatch: String(undo.versionAfter), sendUpdates: "none" });
        return { kind: "succeeded", result: { removedEventId: undo.eventId }, undoData: null };
      } catch (error) {
        return fromExternalError(error);
      }
    },
    async verify({ undo, readers }) {
      if (!readers.calendar) throw new Error("Google Calendar is not connected");
      return [{ id: "event_deleted", passed: (await readers.calendar.getEvent(String(undo.eventId))) === null }];
    },
    warning: () => null,
  },
};
