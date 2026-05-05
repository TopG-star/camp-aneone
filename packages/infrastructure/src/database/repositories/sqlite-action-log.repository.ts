import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ActionLogEntry,
  ActionLogRepository,
  ActionStatus,
  ActionType,
} from "@oneon/domain";

export class SqliteActionLogRepository implements ActionLogRepository {
  constructor(private readonly db: Database.Database) {}

  // Valid state transitions per ADR-006 (forward-only):
  // proposed → approved | rejected
  // approved → executed
  // executed → rolled_back
  private static readonly VALID_TRANSITIONS: Record<string, string[]> = {
    proposed: ["approved", "rejected"],
    approved: ["executed"],
    executed: ["rolled_back"],
    rejected: [],
    rolled_back: [],
  };

  create(
    entry: Omit<ActionLogEntry, "id" | "createdAt" | "updatedAt">
  ): ActionLogEntry {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO action_log (id, resource_id, action_type, risk_level, status, payload_json, result_json, error_json, rollback_json, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entry.resourceId,
        entry.actionType,
        entry.riskLevel,
        entry.status,
        entry.payloadJson,
        entry.resultJson,
        entry.errorJson,
        entry.rollbackJson,
        entry.userId,
        now,
        now
      );

    return this.findById(id)!;
  }

  findByResourceAndType(
    resourceId: string,
    actionType: ActionType,
    userId?: string
  ): ActionLogEntry | null {
    let sql = "SELECT * FROM action_log WHERE resource_id = ? AND action_type = ?";
    const params: unknown[] = [resourceId, actionType];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    sql += " ORDER BY created_at DESC LIMIT 1";
    const row = this.db.prepare(sql).get(...params) as RawActionLog | undefined;
    return row ? mapRow(row) : null;
  }

  findByStatus(status: ActionStatus, limit?: number, userId?: string): ActionLogEntry[] {
    let sql = "SELECT * FROM action_log WHERE status = ?";
    const params: unknown[] = [status];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    sql += " ORDER BY created_at DESC";
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as RawActionLog[];
    return rows.map(mapRow);
  }

  updateStatus(
    id: string,
    status: ActionStatus,
    data?: {
      resultJson?: string;
      errorJson?: string;
      rollbackJson?: string;
    }
  ): void {
    // Enforce state machine: fetch current status and validate transition
    const current = this.findById(id);
    if (!current) {
      throw new Error(`ActionLogEntry not found: ${id}`);
    }

    const allowed =
      SqliteActionLogRepository.VALID_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(status)) {
      throw new Error(
        `Invalid status transition: ${current.status} → ${status} (allowed: ${allowed.join(", ") || "none"})`
      );
    }

    const sets = ["status = ?", "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"];
    const params: unknown[] = [status];

    if (data?.resultJson !== undefined) {
      sets.push("result_json = ?");
      params.push(data.resultJson);
    }
    if (data?.errorJson !== undefined) {
      sets.push("error_json = ?");
      params.push(data.errorJson);
    }
    if (data?.rollbackJson !== undefined) {
      sets.push("rollback_json = ?");
      params.push(data.rollbackJson);
    }

    params.push(id);

    this.db
      .prepare(`UPDATE action_log SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
  }

  findAll(options: {
    status?: ActionStatus;
    actionType?: ActionType;
    limit?: number;
    offset?: number;
    userId?: string;
  }): ActionLogEntry[] {
    let sql = "SELECT * FROM action_log WHERE 1=1";
    const params: unknown[] = [];

    if (options.userId) {
      sql += " AND user_id = ?";
      params.push(options.userId);
    }
    if (options.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options.actionType) {
      sql += " AND action_type = ?";
      params.push(options.actionType);
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

    const rows = this.db.prepare(sql).all(...params) as RawActionLog[];
    return rows.map(mapRow);
  }

  count(options?: { status?: ActionStatus; userId?: string }): number {
    let sql = "SELECT COUNT(*) as count FROM action_log WHERE 1=1";
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

  private findById(id: string): ActionLogEntry | null {
    const row = this.db
      .prepare("SELECT * FROM action_log WHERE id = ?")
      .get(id) as RawActionLog | undefined;
    return row ? mapRow(row) : null;
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawActionLog {
  id: string;
  resource_id: string;
  action_type: string;
  risk_level: string;
  status: string;
  payload_json: string;
  result_json: string | null;
  error_json: string | null;
  rollback_json: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawActionLog): ActionLogEntry {
  return {
    id: row.id,
    userId: row.user_id,
    resourceId: row.resource_id,
    actionType: row.action_type,
    riskLevel: row.risk_level as "auto" | "approval_required",
    status: row.status as ActionLogEntry["status"],
    payloadJson: row.payload_json,
    resultJson: row.result_json,
    errorJson: row.error_json,
    rollbackJson: row.rollback_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
