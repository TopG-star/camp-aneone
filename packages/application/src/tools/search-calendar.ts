import { z } from "zod";
import type { CalendarPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const searchCalendarSchema = z.object({
  query: z.string().describe("Keyword to search for in event titles and descriptions"),
  timeMin: z
    .string()
    .optional()
    .default(() => new Date(Date.now() - THIRTY_DAYS_MS).toISOString()),
  timeMax: z
    .string()
    .optional()
    .default(() => new Date(Date.now() + THIRTY_DAYS_MS).toISOString()),
});

export type SearchCalendarInput = z.infer<typeof searchCalendarSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface SearchCalendarDeps {
  calendarPort: CalendarPort;
}

// ── Factory ──────────────────────────────────────────────────

export function createSearchCalendarTool(
  deps: SearchCalendarDeps,
): ToolDefinition {
  return {
    name: "search_calendar",
    version: "1.0.0",
    description:
      "Search Google Calendar events by keyword within an optional time range (defaults to ±30 days).",
    inputSchema: searchCalendarSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as SearchCalendarInput;

      const events = await deps.calendarPort.searchEvents(
        input.query,
        input.timeMin,
        input.timeMax,
      );

      const count = events.length;

      return {
        data: events,
        summary:
          count === 0
            ? `No calendar events found matching "${input.query}".`
            : `Found ${count} calendar event${count === 1 ? "" : "s"} matching "${input.query}".`,
      };
    },
  };
}
