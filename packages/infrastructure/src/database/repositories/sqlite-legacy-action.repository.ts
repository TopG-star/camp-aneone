import type Database from "better-sqlite3";
import type { LegacyActionRepository, LegacyActionRow } from "@oneon/domain";

interface Row {
  id: string;
  user_id: string | null;
  resource_id: string;
  action_type: string;
  risk_level: string;
  status: string;
  payload_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

const map = (r: Row): LegacyActionRow => ({
  id: r.id,
  userId: r.user_id,
  resourceId: r.resource_id,
  actionType: r.action_type,
  riskLevel: r.risk_level,
  status: r.status,
  payloadJson: r.payload_json,
  resultJson: r.result_json,
  errorJson: r.error_json,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const NOT_IMPORTED = `FROM action_log_legacy l
  LEFT JOIN action_legacy_imports m ON m.legacy_id = l.id
  WHERE l.user_id = ? AND m.legacy_id IS NULL`;

export class SqliteLegacyActionRepository implements LegacyActionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  listForUser(userId: string, options: { limit: number; offset: number }): LegacyActionRow[] {
    const rows = this.db
      .prepare(`SELECT l.* ${NOT_IMPORTED} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`)
      .all(userId, options.limit, options.offset) as Row[];
    return rows.map(map);
  }

  countForUser(userId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n ${NOT_IMPORTED}`).get(userId) as { n: number }).n;
  }

  listUnimportedProposed(userId: string): LegacyActionRow[] {
    const rows = this.db
      .prepare(`SELECT l.* ${NOT_IMPORTED} AND l.status = 'proposed' ORDER BY l.created_at ASC`)
      .all(userId) as Row[];
    return rows.map(map);
  }

  recordImport(legacyId: string, actionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO action_legacy_imports (legacy_id, action_id, imported_at) VALUES (?, ?, ?)")
      .run(legacyId, actionId, this.clock().toISOString());
  }
}
