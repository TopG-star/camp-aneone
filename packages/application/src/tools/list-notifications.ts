import { z } from "zod";
import type { NotificationRepository } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";

// ── Input Schema ─────────────────────────────────────────────

export const listNotificationsSchema = z.object({
  all: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include read notifications. Default: false (unread only)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(20),
});

export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;

// ── Deps ─────────────────────────────────────────────────────

export interface ListNotificationsDeps {
  notificationRepo: NotificationRepository;
}

// ── Factory ──────────────────────────────────────────────────

export function createListNotificationsTool(
  deps: ListNotificationsDeps,
): ToolDefinition {
  const { notificationRepo } = deps;

  return {
    name: "list_notifications",
    version: "1.0.0",
    description:
      "List notifications. By default returns only unread notifications. Set all=true to include read ones.",
    inputSchema: listNotificationsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as ListNotificationsInput;

      const notifications = input.all
        ? notificationRepo.findAll({ limit: input.limit })
        : notificationRepo.findUnread(input.limit);

      const unreadCount = notificationRepo.countUnread();
      const count = notifications.length;

      return {
        data: { notifications, unreadCount },
        summary:
          count === 0
            ? `No ${input.all ? "" : "unread "}notifications.`
            : `Found ${count} notification${count === 1 ? "" : "s"} (${unreadCount} unread total).`,
      };
    },
  };
}
