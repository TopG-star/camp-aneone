import { z } from "zod";
import type { GitHubPort } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listGitHubNotificationsSchema = z.object({
  all: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, include read notifications. Defaults to unread only."),
  participating: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, only show notifications where the user is directly participating."),
  userId: z.string().trim().min(1).optional(),
});

export type ListGitHubNotificationsInput = z.infer<
  typeof listGitHubNotificationsSchema
>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListGitHubNotificationsDeps {
  githubPort?: GitHubPort;
  resolveGitHubPort?: (userId: string) => GitHubPort | null;
}

// ── Factory ──────────────────────────────────────────────────

export function createListGitHubNotificationsTool(
  deps: ListGitHubNotificationsDeps,
): ToolDefinition {
  return {
    name: "list_github_notifications",
    version: "1.0.0",
    description:
      "List GitHub notifications. By default returns unread notifications only. Set 'all' to true for all notifications.",
    inputSchema: listGitHubNotificationsSchema,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const input = validatedInput as ListGitHubNotificationsInput;

      const githubPort = input.userId && deps.resolveGitHubPort
        ? deps.resolveGitHubPort(input.userId)
        : deps.githubPort ?? null;

      if (!githubPort) {
        return {
          data: [],
          summary: "GitHub integration is not configured for this user.",
        };
      }

      const notifications = await githubPort.listNotifications({
        all: input.all,
        participating: input.participating,
      });

      const count = notifications.length;

      return {
        data: notifications,
        summary:
          count === 0
            ? "No GitHub notifications found."
            : `Found ${count} GitHub notification${count === 1 ? "" : "s"}.`,
      };
    },
  };
}
