import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Deadline,
  DeadlineRepository,
  DeadlineStatus,
} from "@oneon/domain";

export class SqliteDeadlineRepository implements DeadlineRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    deadline: Omit<Deadline, "id" | "createdAt" | "updatedAt">
  ): Deadline {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO deadlines (id, inbound_item_id, due_date, description, confidence, status, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        deadline.inboundItemId,
        deadline.dueDate,
        deadline.description,
        deadline.confidence,
        deadline.status,
        deadline.userId,
        now,
        now
      );

    return this.findById(id)!;
  }

  findByInboundItemId(inboundItemId: string): Deadline[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM deadlines WHERE inbound_item_id = ? ORDER BY due_date ASC"
      )
      .all(inboundItemId) as RawDeadline[];
    return rows.map(mapRow);
  }

  findByDateRange(
    from: string,
    to: string,
    status?: DeadlineStatus,
    userId?: string
  ): Deadline[] {
    let sql =
      "SELECT * FROM deadlines WHERE due_date >= ? AND due_date <= ?";
    const params: unknown[] = [from, to];

    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }

    sql += " ORDER BY due_date ASC";

    const rows = this.db.prepare(sql).all(...params) as RawDeadline[];
    return rows.map(mapRow);
  }

  findOverdue(userId?: string): Deadline[] {
    let sql = "SELECT * FROM deadlines WHERE status = 'open' AND due_date < strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const params: unknown[] = [];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    sql += " ORDER BY due_date ASC";
    const rows = this.db.prepare(sql).all(...params) as RawDeadline[];
    return rows.map(mapRow);
  }

  updateStatus(id: string, status: DeadlineStatus): void {
    this.db
      .prepare(
        "UPDATE deadlines SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      )
      .run(status, id);
  }

  count(options?: { status?: DeadlineStatus; userId?: string }): number {
    let sql = "SELECT COUNT(*) as count FROM deadlines WHERE 1=1";
    const params: unknown[] = [];

    if (options?.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options?.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }

    const row = this.db.prepare(sql).get(...params) as { count: number };
    return row.count;
  }

  private findById(id: string): Deadline | null {
    const row = this.db
      .prepare("SELECT * FROM deadlines WHERE id = ?")
      .get(id) as RawDeadline | undefined;
    return row ? mapRow(row) : null;
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawDeadline {
  id: string;
  inbound_item_id: string;
  due_date: string;
  description: string;
  confidence: number;
  status: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawDeadline): Deadline {
  return {
    id: row.id,
    userId: row.user_id,
    inboundItemId: row.inbound_item_id,
    dueDate: row.due_date,
    description: row.description,
    confidence: row.confidence,
    status: row.status as DeadlineStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
