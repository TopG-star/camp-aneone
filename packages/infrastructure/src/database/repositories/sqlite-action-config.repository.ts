import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { TenantMismatchError, type ContextDb } from "@oneon/domain";
import type {
  ActionConfigHistoryEntry,
  ActionConfigRecord,
  ActionConfigRepository,
  ActionScope,
} from "@oneon/domain";
import { rawDb } from "../context-db-gate.js";

interface ConfigRow {
  scope: ActionScope;
  owner_id: string;
  action_type: string;
  config_json: string;
  updated_by: string;
  updated_at: string;
}

interface HistoryRow {
  id: string;
  scope: ActionScope;
  owner_id: string;
  action_type: string;
  old_json: string | null;
  new_json: string;
  changed_by: string;
  changed_at: string;
}

const mapConfig = (r: ConfigRow): ActionConfigRecord => ({
  scope: r.scope,
  ownerId: r.owner_id,
  actionType: r.action_type,
  configJson: r.config_json,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export class SqliteActionConfigRepository implements ActionConfigRepository {
  private readonly db: Database.Database;
  private readonly context: ContextDb;

  constructor(
    context: ContextDb,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.context = context;
    this.db = rawDb(context);
  }

  /** These tables carry no tenant column: a tenant file holds only scope tenant with its own tenant id as owner, the personal file only scope personal. */
  private guard(scope: ActionScope, ownerId: string): void {
    const ok = this.context.kind === "tenant" ? scope === "tenant" && ownerId === this.context.tenantId : scope === "personal";
    if (!ok) throw new TenantMismatchError(this.context.kind === "tenant" ? this.context.tenantId : null, "action_definition_configs");
  }

  get(scope: ActionScope, ownerId: string, actionType: string): ActionConfigRecord | null {
    this.guard(scope, ownerId);
    const row = this.db
      .prepare("SELECT * FROM action_definition_configs WHERE scope = ? AND owner_id = ? AND action_type = ?")
      .get(scope, ownerId, actionType) as ConfigRow | undefined;
    return row ? mapConfig(row) : null;
  }

  list(scope: ActionScope, ownerId: string): ActionConfigRecord[] {
    this.guard(scope, ownerId);
    const rows = this.db
      .prepare("SELECT * FROM action_definition_configs WHERE scope = ? AND owner_id = ? ORDER BY action_type")
      .all(scope, ownerId) as ConfigRow[];
    return rows.map(mapConfig);
  }

  save(input: { scope: ActionScope; ownerId: string; actionType: string; configJson: string; changedBy: string }): ActionConfigRecord {
    this.guard(input.scope, input.ownerId);
    return this.db.transaction((): ActionConfigRecord => {
      const previous = this.get(input.scope, input.ownerId, input.actionType);
      const now = this.clock().toISOString();
      this.db
        .prepare(
          `INSERT INTO action_definition_configs (scope, owner_id, action_type, config_json, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, owner_id, action_type)
           DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(input.scope, input.ownerId, input.actionType, input.configJson, input.changedBy, now);
      this.db
        .prepare(
          `INSERT INTO action_definition_config_history (id, scope, owner_id, action_type, old_json, new_json, changed_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), input.scope, input.ownerId, input.actionType, previous?.configJson ?? null, input.configJson, input.changedBy, now);
      return this.get(input.scope, input.ownerId, input.actionType)!;
    })();
  }

  history(scope: ActionScope, ownerId: string, actionType: string, limit: number): ActionConfigHistoryEntry[] {
    this.guard(scope, ownerId);
    const rows = this.db
      .prepare(
        `SELECT * FROM action_definition_config_history
         WHERE scope = ? AND owner_id = ? AND action_type = ?
         ORDER BY changed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scope, ownerId, actionType, limit) as HistoryRow[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      ownerId: r.owner_id,
      actionType: r.action_type,
      oldJson: r.old_json,
      newJson: r.new_json,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }
}
