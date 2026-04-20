import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve migrations dir: works both in src (tsx dev) and dist (compiled)
function getMigrationsDir(): string {
  // Check if we're running from dist/ or src/
  if (__dirname.includes("dist")) {
    // Compiled: __dirname = .../infrastructure/dist/database
    // Migrations are in .../infrastructure/src/database/migrations
    return join(__dirname, "..", "..", "src", "database", "migrations");
  }
  // Dev (tsx): __dirname = .../infrastructure/src/database
  return join(__dirname, "migrations");
}

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  // Enforce foreign key constraints
  db.pragma("foreign_keys = ON");
  // Improve write performance (data safe with WAL)
  db.pragma("synchronous = NORMAL");
  // Store temp tables in memory
  db.pragma("temp_store = MEMORY");
  // 64MB mmap for read performance
  db.pragma("mmap_size = 67108864");

  return db;
}

export function runMigrations(db: Database.Database): void {
  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version)
  );

  const migrations = [
    { version: 1, name: "initial_schema", file: "001_initial_schema.sql" },
    { version: 2, name: "add_thread_id_labels", file: "002_add_thread_id_labels.sql" },
    { version: 3, name: "add_classify_attempts", file: "003_add_classify_attempts.sql" },
    { version: 4, name: "add_conversation_id", file: "004_add_conversation_id.sql" },
    { version: 5, name: "users_and_oauth_tokens", file: "005_users_and_oauth_tokens.sql" },
    { version: 6, name: "add_user_id_to_core_tables", file: "006_add_user_id_to_core_tables.sql" },
  ];

  const migrationsDir = getMigrationsDir();

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    const sql = readFileSync(join(migrationsDir, migration.file), "utf-8");

    db.transaction(() => {
      db.exec(sql);
    })();

    console.log(
      `[migration] Applied v${migration.version}: ${migration.name}`
    );
  }
}
