import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  PushSubscription,
  PushSubscriptionRepository,
} from "@oneon/domain";

export class SqlitePushSubscriptionRepository
  implements PushSubscriptionRepository
{
  constructor(private readonly db: Database.Database) {}

  upsert(
    subscription: Omit<PushSubscription, "id" | "createdAt">,
  ): PushSubscription {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, keys_json, user_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           keys_json = excluded.keys_json,
           user_id = excluded.user_id`,
      )
      .run(
        id,
        subscription.endpoint,
        subscription.keysJson,
        subscription.userId,
        now,
      );

    return this.findByEndpoint(subscription.endpoint)!;
  }

  findByUserId(userId: string): PushSubscription[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(userId) as RawPushSubscription[];

    return rows.map(mapRow);
  }

  findAll(): PushSubscription[] {
    const rows = this.db
      .prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC")
      .all() as RawPushSubscription[];

    return rows.map(mapRow);
  }

  deleteByEndpoint(endpoint: string, userId?: string): void {
    if (userId) {
      this.db
        .prepare(
          "DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?",
        )
        .run(endpoint, userId);
      return;
    }

    this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .run(endpoint);
  }

  private findByEndpoint(endpoint: string): PushSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(endpoint) as RawPushSubscription | undefined;

    return row ? mapRow(row) : null;
  }
}

interface RawPushSubscription {
  id: string;
  user_id: string | null;
  endpoint: string;
  keys_json: string;
  created_at: string;
}

function mapRow(row: RawPushSubscription): PushSubscription {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    keysJson: row.keys_json,
    createdAt: row.created_at,
  };
}
