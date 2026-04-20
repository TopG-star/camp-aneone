import type Database from "better-sqlite3";
import type { User, UserRepository } from "@oneon/domain";

export class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Database.Database) {}

  findById(id: string): User | null {
    const row = this.db
      .prepare("SELECT id, email, created_at FROM users WHERE id = ?")
      .get(id) as RawUser | undefined;
    return row ? mapRow(row) : null;
  }

  findByEmail(email: string): User | null {
    const row = this.db
      .prepare("SELECT id, email, created_at FROM users WHERE email = ?")
      .get(email) as RawUser | undefined;
    return row ? mapRow(row) : null;
  }

  upsert(user: { id: string; email: string }): User {
    this.db
      .prepare(
        `INSERT INTO users (id, email, created_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (id) DO UPDATE SET email = excluded.email`,
      )
      .run(user.id, user.email);

    return this.findById(user.id)!;
  }

  list(): User[] {
    const rows = this.db
      .prepare("SELECT id, email, created_at FROM users ORDER BY created_at")
      .all() as RawUser[];
    return rows.map(mapRow);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }
}

// ── Internal ─────────────────────────────────────────────────

interface RawUser {
  id: string;
  email: string;
  created_at: string;
}

function mapRow(row: RawUser): User {
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
  };
}
