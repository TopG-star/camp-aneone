import { z } from "zod";
import type { CalendarPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const createCalendarEventSchema = z.object({
  title: z.string().describe("Event title"),
  start: z.string().describe("Event start time (ISO-8601)"),
  end: z.string().describe("Event end time (ISO-8601)"),
  description: z.string().nullable().optional().default(null),
  attendees: z.array(z.string().email()).optional().default([]),
  location: z.string().nullable().optional().default(null),
});

export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface CreateCalendarEventDeps {
  calendarPort: CalendarPort;
}

// ── Factory ──────────────────────────────────────────────────

export function createCreateCalendarEventTool(
  deps: CreateCalendarEventDeps,
): ToolDefinition {
  return {
    name: "create_calendar_event",
    version: "1.0.0",
    description:
      "Create a new Google Calendar event with title, start/end times, optional description, attendees, and location.",
    inputSchema: createCalendarEventSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as CreateCalendarEventInput;

      const created = await deps.calendarPort.createEvent({
        title: input.title,
        start: input.start,
        end: input.end,
        allDay: false,
        description: input.description,
        attendees: input.attendees,
        location: input.location,
      });

      return {
        data: created,
        summary: `Created calendar event "${created.title}" (${created.start.slice(0, 16)}).`,
      };
    },
  };
}
