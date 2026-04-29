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

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
    )
    .get(tableName);

  return row !== undefined;
}

function hasColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function migrationAlreadyAppliedInSchema(
  db: Database.Database,
  version: number,
): boolean {
  switch (version) {
    case 4:
      return hasTable(db, "conversations") && hasColumn(db, "conversations", "conversation_id");
    case 5:
      return hasTable(db, "users") && hasTable(db, "oauth_tokens");
    case 6:
      return (
        hasColumn(db, "inbound_items", "user_id") &&
        hasColumn(db, "classifications", "user_id") &&
        hasColumn(db, "deadlines", "user_id") &&
        hasColumn(db, "action_log", "user_id") &&
        hasColumn(db, "notifications", "user_id") &&
        hasColumn(db, "conversations", "user_id")
      );
    case 7:
      return (
        hasTable(db, "user_profiles") &&
        hasColumn(db, "user_profiles", "salutation_mode") &&
        hasColumn(db, "user_profiles", "communication_style") &&
        hasColumn(db, "user_profiles", "timezone")
      );
    case 8:
      return (
        hasTable(db, "bank_statements") &&
        hasColumn(db, "bank_statements", "user_id") &&
        hasColumn(db, "bank_statements", "external_id") &&
        hasColumn(db, "bank_statements", "status") &&
        hasColumn(db, "bank_statements", "detection_rule_version")
      );
    default:
      return false;
  }
}

function recordMigration(
  db: Database.Database,
  version: number,
  name: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)"
  ).run(version, name);
}

function canBackfillAfterError(
  db: Database.Database,
  version: number,
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error);

  if (migrationAlreadyAppliedInSchema(db, version)) {
    return true;
  }

  return version === 4 && /duplicate column name:\s*conversation_id/i.test(message);
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
    { version: 7, name: "user_profiles", file: "007_user_profiles.sql" },
    { version: 8, name: "bank_statement_intake", file: "008_bank_statement_intake.sql" },
  ];

  const migrationsDir = getMigrationsDir();

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    if (migrationAlreadyAppliedInSchema(db, migration.version)) {
      recordMigration(db, migration.version, migration.name);
      applied.add(migration.version);
      console.log(
        `[migration] Backfilled v${migration.version}: ${migration.name}`
      );
      continue;
    }

    const sql = readFileSync(join(migrationsDir, migration.file), "utf-8");

    try {
      db.transaction(() => {
        db.exec(sql);
        recordMigration(db, migration.version, migration.name);
      })();
    } catch (error) {
      if (!canBackfillAfterError(db, migration.version, error)) {
        throw error;
      }

      recordMigration(db, migration.version, migration.name);
      applied.add(migration.version);
      console.log(
        `[migration] Repaired v${migration.version}: ${migration.name}`
      );
      continue;
    }

    applied.add(migration.version);

    console.log(
      `[migration] Applied v${migration.version}: ${migration.name}`
    );
  }
}
