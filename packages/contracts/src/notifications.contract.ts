import { z } from "zod";

// ── GET /api/notifications ───────────────────────────────────

export const NotificationsQuerySchema = z.object({
  all: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type NotificationsQuery = z.infer<typeof NotificationsQuerySchema>;

// ── Notification Item ────────────────────────────────────────

export const NotificationItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  read: z.boolean(),
  createdAt: z.string(),
  metadata: z.string().nullable(),
});

export type NotificationItem = z.infer<typeof NotificationItemSchema>;

// ── Notifications List Response ──────────────────────────────

export const NotificationsListResponseSchema = z.object({
  notifications: z.array(NotificationItemSchema),
});

export type NotificationsListResponse = z.infer<typeof NotificationsListResponseSchema>;

// ── GET /api/notifications/count ─────────────────────────────

export const NotificationCountResponseSchema = z.object({
  count: z.number(),
});

export type NotificationCountResponse = z.infer<typeof NotificationCountResponseSchema>;
