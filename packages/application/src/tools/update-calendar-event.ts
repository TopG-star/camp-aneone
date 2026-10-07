import { z } from "zod";
import type { CalendarPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const updateCalendarEventSchema = z.object({
  id: z.string().describe("The event ID to update"),
  title: z.string().optional().describe("New event title"),
  start: z.string().optional().describe("New start time (ISO-8601)"),
  end: z.string().optional().describe("New end time (ISO-8601)"),
  description: z.string().nullable().optional().describe("New description"),
  attendees: z.array(z.string().email()).optional().describe("Updated attendee list"),
  location: z.string().nullable().optional().describe("New location"),
  userId: z.string().trim().min(1).optional(),
});

export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface UpdateCalendarEventDeps {
  calendarPort?: CalendarPort;
  resolveCalendarPort?: (userId: string) => CalendarPort | null;
}

// ── Factory ──────────────────────────────────────────────────

export function createUpdateCalendarEventTool(
  deps: UpdateCalendarEventDeps,
): ToolDefinition {
  return {
    name: "update_calendar_event",
    version: "1.0.0",
    description:
      "Update an existing Google Calendar event. Provide the event ID and any fields to change (title, start, end, description, attendees, location).",
    inputSchema: updateCalendarEventSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as UpdateCalendarEventInput;
      const { id, ...updates } = input;

      const calendarPort = input.userId && deps.resolveCalendarPort
        ? deps.resolveCalendarPort(input.userId)
        : deps.calendarPort ?? null;

      if (!calendarPort) {
        return {
          data: null,
          summary: "Calendar integration is not configured for this user.",
        };
      }

      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) filtered[key] = value;
      }

      const updated = await calendarPort.updateEvent(
        id,
        filtered as Partial<Omit<import("@oneon/domain").CalendarEvent, "id">>,
      );

      return {
        data: updated,
        summary: `Updated calendar event "${updated.title}" (${updated.start.slice(0, 16)}).`,
      };
    },
  };
}
