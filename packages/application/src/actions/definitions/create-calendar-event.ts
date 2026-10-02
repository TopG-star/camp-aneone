import { z } from "zod";
import { maxRisk, type CalendarEventDraft } from "@oneon/domain";
import { chatKey } from "../idempotency.js";
import { DEFAULT_RECOVERY_THRESHOLD_MS, PERSONAL_APPROVERS, type ActionDefinition, type Resolved } from "../definition.js";
import { fromExternalError } from "./outcomes.js";
import { OTHERS_INVOLVED_METRIC, formatRange, isoWithOffset, normalizeAttendees, othersInvolved, sameField } from "./calendar-shared.js";

const inputSchema = z
  .object({
    title: z.string().min(1),
    start: isoWithOffset,
    end: isoWithOffset,
    description: z.string().nullable().default(null),
    attendees: z.array(z.string().email()).default([]),
    location: z.string().nullable().default(null),
  })
  .strict()
  .refine((v) => Date.parse(v.start) < Date.parse(v.end), { message: "start must be before end", path: ["end"] });

export type CreateCalendarEventInput = z.infer<typeof inputSchema>;
export interface CreateCalendarEventResolved extends Resolved {
  event: CalendarEventDraft & Record<string, unknown>;
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

export const createCalendarEventDefinition: ActionDefinition<CreateCalendarEventInput, CreateCalendarEventResolved> = {
  type: "create_calendar_event",
  version: "1",
  scope: "personal",
  label: "Create calendar event",
  description: "Create a Google Calendar event, inviting attendees if any.",
  inputSchema,
  effects: { reads: ["Google Calendar"], writes: ["Google Calendar event", "invitation emails"] },
  floor,
  defaults: { ...floor, enabled: true },
  thresholdMetrics: OTHERS_INVOLVED_METRIC,
  rollbackClass: "reversible",
  recoveryThresholdMs: DEFAULT_RECOVERY_THRESHOLD_MS,
  executionTimeoutMs: 15_000,
  disableWarning: null,
  unavailableReason: null,
  consequenceKeys: ["sendUpdates", "othersInvolved", "metrics"],
  idempotencyKey: (input, ctx) => (ctx.source === "chat" ? chatKey(ctx.turnId, input) : `rule:${ctx.resourceId}`),

  async preconditions({ readers }) {
    return [{ id: "calendar_connected", kind: "blocking", passed: readers.calendar !== null }];
  },

  async resolve({ input, readers }) {
    const attendees = normalizeAttendees(input.attendees);
    const others = othersInvolved(attendees, readers.identity.googleEmail);
    return {
      ok: true,
      resolved: {
        metrics: { others_involved: others.length },
        othersInvolved: others,
        sendUpdates: attendees.length > 0 ? "all" : "none",
        event: {
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: false,
          description: input.description,
          attendees,
          location: input.location,
        },
      },
    };
  },

  riskFor: (resolved, floorRisk) => (resolved.othersInvolved.length > 0 ? maxRisk("L2", floorRisk) : floorRisk),

  describe(resolved) {
    const base = `Create "${resolved.event.title}", ${formatRange(resolved.event.start, resolved.event.end)}`;
    return resolved.othersInvolved.length > 0
      ? `${base}, and invite ${resolved.othersInvolved.join(", ")}. Google will email the invitation.`
      : `${base}.`;
  },

  async execute({ resolved, writers, executorRequestId }) {
    if (!writers.calendar) return { kind: "definite_failure", code: "calendar_not_connected", message: "Google Calendar is not connected." };
    try {
      const event = await writers.calendar.create(resolved.event, { eventId: executorRequestId, sendUpdates: resolved.sendUpdates });
      return {
        kind: "succeeded",
        result: { eventId: event.id, etag: event.etag ?? null },
        undoData: { eventId: event.id, versionAfter: event.etag ?? null, sendUpdates: resolved.sendUpdates },
      };
    } catch (error) {
      return fromExternalError(error);
    }
  },

  async postconditions({ resolved, result, executorRequestId, readers }) {
    if (!readers.calendar) throw new Error("Google Calendar is not connected");
    const eventId = typeof result?.eventId === "string" ? result.eventId : executorRequestId;
    const event = await readers.calendar.getEvent(eventId);
    const field = (key: "title" | "start" | "end" | "attendees") => ({
      id: `${key}_match`,
      passed: !!event && sameField(key, event[key], resolved.event[key]),
      expected: resolved.event[key],
      actual: event?.[key] ?? null,
    });
    return {
      effectCheckId: "event_exists",
      checks: [
        { id: "event_exists", passed: event !== null, expected: eventId, actual: event?.id ?? null },
        field("title"),
        field("start"),
        field("end"),
        field("attendees"),
      ],
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
        await writers.calendar.remove(String(undo.eventId), {
          ifMatch: String(undo.versionAfter),
          sendUpdates: undo.sendUpdates === "all" ? "all" : "none",
        });
        return { kind: "succeeded", result: { removedEventId: undo.eventId }, undoData: null };
      } catch (error) {
        return fromExternalError(error);
      }
    },
    async verify({ undo, readers }) {
      if (!readers.calendar) throw new Error("Google Calendar is not connected");
      return [{ id: "event_deleted", passed: (await readers.calendar.getEvent(String(undo.eventId))) === null }];
    },
    warning: (resolved) =>
      resolved.othersInvolved.length > 0 ? `Google will email cancellations to ${resolved.othersInvolved.join(", ")}.` : null,
  },
};
