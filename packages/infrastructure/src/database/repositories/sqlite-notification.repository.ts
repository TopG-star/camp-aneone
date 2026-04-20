import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Notification, NotificationRepository } from "@oneon/domain";

export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    notification: Omit<Notification, "id" | "createdAt">
  ): Notification {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO notifications (id, event_type, title, body, deep_link, read, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        notification.eventType,
        notification.title,
        notification.body,
        notification.deepLink,
        notification.read ? 1 : 0,
        notification.userId
      );

    return this.findById(id)!;
  }

  findUnread(limit?: number, userId?: string): Notification[] {
    let sql = "SELECT * FROM notifications WHERE read = 0";
    const params: unknown[] = [];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    sql += " ORDER BY created_at DESC";
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as RawNotification[];
    return rows.map(mapRow);
  }

  markRead(id: string): void {
    this.db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
  }

  markAllRead(userId?: string): void {
    if (userId) {
      this.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0 AND user_id = ?").run(userId);
    } else {
      this.db.prepare("UPDATE notifications SET read = 1 WHERE read = 0").run();
    }
  }

  findAll(options: { limit?: number; offset?: number; userId?: string }): Notification[] {
    let sql = "SELECT * FROM notifications WHERE 1=1";
    const params: unknown[] = [];

    if (options.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }

    sql += " ORDER BY created_at DESC";

    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as RawNotification[];
    return rows.map(mapRow);
  }

  countUnread(userId?: string): number {
    if (userId) {
      const row = this.db
        .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0 AND user_id = ?")
        .get(userId) as { count: number };
      return row.count;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0")
      .get() as { count: number };
    return row.count;
  }

  findById(id: string): Notification | null {
    const row = this.db
      .prepare("SELECT * FROM notifications WHERE id = ?")
      .get(id) as RawNotification | undefined;
    return row ? mapRow(row) : null;
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawNotification {
  id: string;
  event_type: string;
  title: string;
  body: string;
  deep_link: string | null;
  read: number;
  user_id: string | null;
  created_at: string;
}

function mapRow(row: RawNotification): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    eventType: row.event_type,
    title: row.title,
    body: row.body,
    deepLink: row.deep_link,
    read: row.read === 1,
    createdAt: row.created_at,
  };
}
