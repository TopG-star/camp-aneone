import type Database from "better-sqlite3";
import type { Preference, PreferenceRepository } from "@oneon/domain";

export class SqlitePreferenceRepository implements PreferenceRepository {
  constructor(private readonly db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM preferences WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): Preference {
    this.db
      .prepare(
        `INSERT INTO preferences (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value);

    const row = this.db
      .prepare("SELECT * FROM preferences WHERE key = ?")
      .get(key) as RawPreference;
    return mapRow(row);
  }

  getAll(): Preference[] {
    const rows = this.db
      .prepare("SELECT * FROM preferences ORDER BY key")
      .all() as RawPreference[];
    return rows.map(mapRow);
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM preferences WHERE key = ?").run(key);
  }
}

// ── Internal row mapping ─────────────────────────────────────

interface RawPreference {
  key: string;
  value: string;
  updated_at: string;
}

function mapRow(row: RawPreference): Preference {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  };
}
