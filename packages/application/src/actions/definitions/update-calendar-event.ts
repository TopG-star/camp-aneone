import { z } from "zod";
import { maxRisk, type CalendarEventDraft } from "@oneon/domain";
import { chatKey } from "../idempotency.js";
import { DEFAULT_RECOVERY_THRESHOLD_MS, PERSONAL_APPROVERS, type ActionDefinition, type Resolved } from "../definition.js";
import { fromExternalError } from "./outcomes.js";
import { OTHERS_INVOLVED_METRIC, formatDateTime, isoWithOffset, normalizeAttendees, othersInvolved, sameField } from "./calendar-shared.js";

const FIELDS = ["title", "start", "end", "description", "attendees", "location"] as const;
type Field = (typeof FIELDS)[number];
const NOTIFYING: readonly Field[] = ["start", "end", "location", "attendees"];

const inputSchema = z
  .object({
    eventId: z.string().min(1),
    title: z.string().min(1).optional(),
    start: isoWithOffset.optional(),
    end: isoWithOffset.optional(),
    description: z.string().nullable().optional(),
    attendees: z.array(z.string().email()).optional(),
    location: z.string().nullable().optional(),
  })
  .strict()
  .refine((v) => FIELDS.some((f) => v[f] !== undefined), { message: "Provide at least one field to change" });

export type UpdateCalendarEventInput = z.infer<typeof inputSchema>;
export interface UpdateCalendarEventResolved extends Resolved {
  changes: Partial<CalendarEventDraft> & Record<string, unknown>;
  previous: Partial<CalendarEventDraft> & Record<string, unknown>;
  versionBefore: string | null;
  eventTitle: string;
  othersInvolved: string[];
  sendUpdates: "all" | "none";
}

const floor = {
  risk: "L1" as const,
  approval: { mode: "above_threshold" as const, thresholds: { others_involved: 0 } },
  requiredPermissions: [],
  approverRoles: PERSONAL_APPROVERS,
  expiryHours: 24,
};

export const updateCalendarEventDefinition: ActionDefinition<UpdateCalendarEventInput, UpdateCalendarEventResolved> = {
  type: "update_calendar_event",
  version: "1",
  scope: "personal",
  label: "Update calendar event",
  description: "Change an existing Google Calendar event.",
  inputSchema,
  effects: { reads: ["Google Calendar event"], writes: ["Google Calendar event", "update emails"] },
  floor,
  defaults: { ...floor, enabled: true },
  thresholdMetrics: OTHERS_INVOLVED_METRIC,
  rollbackClass: "conditional",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 15_000,
  disableWarning: null,
  unavailableReason: null,
  consequenceKeys: ["sendUpdates", "othersInvolved", "metrics", "previous"],
  idempotencyKey: (input, ctx) => (ctx.source === "chat" ? chatKey(ctx.turnId, input) : `rule:${ctx.resourceId}`),

  async preconditions({ input, readers }) {
    if (!readers.calendar) return [{ id: "calendar_connected", kind: "blocking", passed: false }];
    const event = await readers.calendar.getEvent(input.eventId);
    return [
      { id: "calendar_connected", kind: "blocking", passed: true },
      { id: "event_exists", kind: "blocking", passed: event !== null, expected: input.eventId, actual: event?.id ?? null },
    ];
  },

  async resolve({ input, readers }) {
    const current = readers.calendar ? await readers.calendar.getEvent(input.eventId) : null;
    if (!current) return { ok: false, error: { code: "event_not_found", message: "The calendar event no longer exists.", stage: "validation" } };

    const changes: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (input[f] === undefined) continue;
      changes[f] = f === "attendees" ? normalizeAttendees(input.attendees!) : input[f];
      previous[f] = current[f];
    }
    // M2: an all-day event's previous dates are date-only and must be written back as dates on undo.
    if ("start" in changes || "end" in changes) previous.allDay = current.allDay;
    const start = (changes.start as string | undefined) ?? current.start;
    const end = (changes.end as string | undefined) ?? current.end;
    if (Date.parse(start) >= Date.parse(end)) {
      return { ok: false, error: { code: "invalid_time_range", message: "The change would put the end before the start.", stage: "validation" } };
    }

    const before = normalizeAttendees(current.attendees);
    const after = (changes.attendees as string[] | undefined) ?? before;
    const others = othersInvolved([...before, ...after], readers.identity.googleEmail);
    const notifies = NOTIFYING.some((f) => f in changes && !sameField(f, changes[f], current[f]));
    return {
      ok: true,
      resolved: {
        metrics: { others_involved: others.length },
        othersInvolved: others,
        sendUpdates: (before.length > 0 || after.length > 0) && notifies ? "all" : "none",
        changes,
        previous,
        versionBefore: current.etag ?? null,
        eventTitle: current.title,
      },
    };
  },

  riskFor: (resolved, floorRisk) => (resolved.othersInvolved.length > 0 ? maxRisk("L2", floorRisk) : floorRisk),

  describe(resolved) {
    const parts = Object.entries(resolved.changes).map(([k, v]) => {
      if (k === "start" || k === "end") return `${k} to ${formatDateTime(String(v))}`;
      if (k === "attendees") return `attendees to ${(v as string[]).join(", ") || "nobody"}`;
      return `${k} to "${v ?? ""}"`;
    });
    const base = `Change "${resolved.eventTitle}": ${parts.join("; ")}.`;
    return resolved.sendUpdates === "all" && resolved.othersInvolved.length > 0
      ? `${base} Google will email the update to ${resolved.othersInvolved.join(", ")}.`
      : base;
  },

  async execute({ input, resolved, writers, signal }) {
    if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
    if (!resolved.versionBefore) return { kind: "definite_failure", code: "missing_version", message: "Google did not report the event's version." };
    try {
      const event = await writers.calendar.update(input.eventId, resolved.changes, {
        ifMatch: resolved.versionBefore,
        sendUpdates: resolved.sendUpdates,
        signal,
      });
      return {
        kind: "succeeded",
        result: { eventId: event.id, etag: event.etag ?? null },
        undoData: {
          eventId: event.id,
          previous: resolved.previous,
          versionBefore: resolved.versionBefore,
          versionAfter: event.etag ?? null,
          sendUpdates: resolved.sendUpdates,
        },
      };
    } catch (error) {
      return fromExternalError(error);
    }
  },

  async postconditions({ input, resolved, readers }) {
    if (!readers.calendar) throw new Error("Google Calendar is not connected");
    const event = await readers.calendar.getEvent(input.eventId);
    const fieldChecks = Object.entries(resolved.changes).map(([k, v]) => ({
      id: `${k}_match`,
      passed: !!event && sameField(k, event[k as Field], v),
      expected: v,
      actual: event ? event[k as Field] : null,
    }));
    // Spec §9.7: the effect is "changed fields match". The event existed before, so its
    // existence says nothing about whether the change landed.
    const applied = event !== null && fieldChecks.every((c) => c.passed);
    return {
      effectCheckId: "changes_applied",
      checks: [
        { id: "event_exists", passed: event !== null, expected: input.eventId, actual: event?.id ?? null },
        ...fieldChecks,
        { id: "changes_applied", passed: applied },
      ],
      undoData:
        applied && event!.etag
          ? {
              eventId: input.eventId,
              previous: resolved.previous,
              versionBefore: resolved.versionBefore,
              versionAfter: event!.etag,
              sendUpdates: resolved.sendUpdates,
            }
          : null,
    };
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
        await writers.calendar.update(String(undo.eventId), undo.previous as Partial<CalendarEventDraft>, {
          ifMatch: String(undo.versionAfter),
          sendUpdates: undo.sendUpdates === "all" ? "all" : "none",
        });
        return { kind: "succeeded", result: { restoredEventId: undo.eventId }, undoData: null };
      } catch (error) {
        return fromExternalError(error);
      }
    },
    async verify({ undo, readers }) {
      if (!readers.calendar) throw new Error("Google Calendar is not connected");
      const event = await readers.calendar.getEvent(String(undo.eventId));
      return Object.entries(undo.previous as Record<string, unknown>).map(([k, v]) => ({
        id: `${k}_restored`,
        passed: !!event && sameField(k, event[k as Field], v),
        expected: v,
        actual: event ? event[k as Field] : null,
      }));
    },
    warning: (resolved) =>
      resolved.sendUpdates === "all" && resolved.othersInvolved.length > 0
        ? `Google will email the change back to ${resolved.othersInvolved.join(", ")}.`
        : null,
  },
};
