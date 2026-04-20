import { z } from "zod";
import type { TeamsPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const searchTeamsMessagesSchema = z.object({
  query: z.string().describe("Search query for Teams messages"),
  channelName: z.string().optional().describe("Filter by channel name"),
  since: z.string().optional().describe("Only return messages after this ISO-8601 date"),
});

export type SearchTeamsMessagesInput = z.infer<typeof searchTeamsMessagesSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface SearchTeamsMessagesDeps {
  teamsPort: TeamsPort;
}

// ── Factory ──────────────────────────────────────────────────

export function createSearchTeamsMessagesTool(
  deps: SearchTeamsMessagesDeps,
): ToolDefinition {
  return {
    name: "search_teams_messages",
    version: "1.0.0",
    description:
      "Search Microsoft Teams messages by keyword, optionally filtered by channel name and date range.",
    inputSchema: searchTeamsMessagesSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as SearchTeamsMessagesInput;

      const messages = await deps.teamsPort.searchMessages(input.query, {
        channelName: input.channelName,
        since: input.since,
      });

      return {
        data: messages,
        summary: messages.length === 0
          ? `No Teams messages found for "${input.query}".`
          : `Found ${messages.length} Teams message(s) matching "${input.query}".`,
      };
    },
  };
}
