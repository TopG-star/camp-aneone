import { z } from "zod";
import type { CalendarPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listCalendarEventsSchema = z.object({
  timeMin: z.string().describe("Start of time range (ISO-8601)"),
  timeMax: z.string().describe("End of time range (ISO-8601)"),
});

export type ListCalendarEventsInput = z.infer<typeof listCalendarEventsSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListCalendarEventsDeps {
  calendarPort: CalendarPort;
}

// ── Factory ──────────────────────────────────────────────────

export function createListCalendarEventsTool(
  deps: ListCalendarEventsDeps,
): ToolDefinition {
  return {
    name: "list_calendar_events",
    version: "1.0.0",
    description:
      "List Google Calendar events within a time range. Returns event titles, times, attendees, and locations.",
    inputSchema: listCalendarEventsSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as ListCalendarEventsInput;

      const events = await deps.calendarPort.listEvents(
        input.timeMin,
        input.timeMax,
      );

      const count = events.length;

      return {
        data: events,
        summary:
          count === 0
            ? "No calendar events found in the specified time range."
            : `Found ${count} calendar event${count === 1 ? "" : "s"} between ${input.timeMin.slice(0, 10)} and ${input.timeMax.slice(0, 10)}.`,
      };
    },
  };
}
