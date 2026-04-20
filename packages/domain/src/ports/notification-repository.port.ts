import type { Notification } from "../entities.js";

export interface NotificationRepository {
  create(notification: Omit<Notification, "id" | "createdAt">): Notification;
  findById(id: string): Notification | null;
  findUnread(limit?: number, userId?: string): Notification[];
  markRead(id: string): void;
  markAllRead(userId?: string): void;
  findAll(options: { limit?: number; offset?: number; userId?: string }): Notification[];
  countUnread(userId?: string): number;
}
