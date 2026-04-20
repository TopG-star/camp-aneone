import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  InboundItem,
  InboundItemRepository,
  Source,
} from "@oneon/domain";

export class SqliteInboundItemRepository implements InboundItemRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(
    item: Omit<InboundItem, "id" | "createdAt" | "updatedAt">
  ): InboundItem {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO inbound_items (id, source, external_id, "from", subject, body_preview, received_at, raw_json, thread_id, labels, classified_at, classify_attempts, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source, external_id) DO UPDATE SET
           "from"       = excluded."from",
           subject      = excluded.subject,
           body_preview = excluded.body_preview,
           raw_json     = excluded.raw_json,
           thread_id    = excluded.thread_id,
           labels       = excluded.labels,
           updated_at   = excluded.updated_at`
      )
      .run(
        id,
        item.source,
        item.externalId,
        item.from,
        item.subject,
        item.bodyPreview,
        item.receivedAt,
        item.rawJson,
        item.threadId,
        item.labels,
        item.classifiedAt,
        item.classifyAttempts,
        item.userId,
        now,
        now
      );

    return this.findBySourceAndExternalId(item.source, item.externalId)!;
  }

  findById(id: string): InboundItem | null {
    const row = this.db
      .prepare("SELECT * FROM inbound_items WHERE id = ?")
      .get(id) as RawInboundItem | undefined;
    return row ? mapRow(row) : null;
  }

  findBySourceAndExternalId(
    source: Source,
    externalId: string,
    userId?: string
  ): InboundItem | null {
    let sql = "SELECT * FROM inbound_items WHERE source = ? AND external_id = ?";
    const params: unknown[] = [source, externalId];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    const row = this.db.prepare(sql).get(...params) as RawInboundItem | undefined;
    return row ? mapRow(row) : null;
  }

  findUnclassified(limit: number, userId?: string): InboundItem[] {
    let sql = "SELECT * FROM inbound_items WHERE classified_at IS NULL";
    const params: unknown[] = [];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    sql += " ORDER BY received_at DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as RawInboundItem[];
    return rows.map(mapRow);
  }

  findAll(options: {
    source?: Source;
    since?: string;
    limit?: number;
    offset?: number;
    userId?: string;
  }): InboundItem[] {
    let sql = "SELECT * FROM inbound_items WHERE 1=1";
    const params: unknown[] = [];

    if (options.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options.source) {
      sql += " AND source = ?";
      params.push(options.source);
    }
    if (options.since) {
      sql += " AND received_at >= ?";
      params.push(options.since);
    }

    sql += " ORDER BY received_at DESC";

    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    if (options.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as RawInboundItem[];
    return rows.map(mapRow);
  }

  search(options: {
    query: string;
    source?: Source;
    limit?: number;
    userId?: string;
  }): InboundItem[] {
    const pattern = `%${options.query}%`;
    let sql =
      'SELECT * FROM inbound_items WHERE (subject LIKE ? OR body_preview LIKE ? OR "from" LIKE ?)';
    const params: unknown[] = [pattern, pattern, pattern];

    if (options.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options.source) {
      sql += " AND source = ?";
      params.push(options.source);
    }

    sql += " ORDER BY received_at DESC";

    const limit = options.limit ?? 20;
    sql += " LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RawInboundItem[];
    return rows.map(mapRow);
  }

  markClassified(id: string): void {
    this.db
      .prepare(
        'UPDATE inbound_items SET classified_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'), updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?'
      )
      .run(id);
  }

  incrementClassifyAttempts(id: string): void {
    this.db
      .prepare(
        'UPDATE inbound_items SET classify_attempts = classify_attempts + 1, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?'
      )
      .run(id);
  }

  count(options?: { source?: Source; since?: string; userId?: string }): number {
    let sql = "SELECT COUNT(*) as count FROM inbound_items WHERE 1=1";
    const params: unknown[] = [];

    if (options?.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options?.source) {
      sql += " AND source = ?";
      params.push(options.source);
    }
    if (options?.since) {
      sql += " AND received_at >= ?";
      params.push(options.since);
    }

    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawInboundItem {
  id: string;
  source: string;
  external_id: string;
  from: string;
  subject: string;
  body_preview: string;
  received_at: string;
  raw_json: string;
  thread_id: string | null;
  labels: string;
  classified_at: string | null;
  classify_attempts: number;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawInboundItem): InboundItem {
  return {
    id: row.id,
    userId: row.user_id,
    source: row.source as Source,
    externalId: row.external_id,
    from: row.from,
    subject: row.subject,
    bodyPreview: row.body_preview,
    receivedAt: row.received_at,
    rawJson: row.raw_json,
    threadId: row.thread_id,
    labels: row.labels,
    classifiedAt: row.classified_at,
    classifyAttempts: row.classify_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
