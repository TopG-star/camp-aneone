import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, hasPendingMigrations, runMigrations } from "../connection.js";
import { backupDatabase, preMigrationFolder, type PreMigrationBackup } from "../backup.js";

export type ControlDb = Database.Database & { readonly __control: unique symbol };

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same convention as the personal migrations: SQL files are read from src, also when running from dist.
function getControlMigrationsDir(): string {
  if (__dirname.includes("dist")) {
    return join(__dirname, "..", "..", "..", "src", "database", "control-migrations");
  }
  return join(__dirname, "..", "control-migrations");
}

export function openControlDb(path: string): ControlDb {
  const db = createDatabase(path);
  runMigrations(db, getControlMigrationsDir());
  return db as ControlDb;
}

/**
 * Startup variant of `openControlDb`: when the file already exists and a migration is pending, it is backed up (sealed) first, and a
 * failed backup stops startup with the file as it was. With no backup key the migration only goes ahead while no tenant registration
 * exists; once one does, the key is required.
 */
export async function openControlDbForStartup(path: string, backup: PreMigrationBackup | null): Promise<ControlDb> {
  const existed = existsSync(path);
  const db = createDatabase(path);
  try {
    const dir = getControlMigrationsDir();
    if (existed && hasPendingMigrations(db, dir)) {
      if (backup) {
        try {
          await backupDatabase(db, { dir: preMigrationFolder(backup.outDir, backup.now()), name: "control", keyB64: backup.keyB64, scratchDir: backup.scratchDir });
        } catch (error) {
          throw new Error(
            `Cannot migrate the control database: its backup before the migration failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      } else if (hasRegistrations(db)) {
        throw new Error("BACKUP_ENCRYPTION_KEY is required once a tenant registration exists; the control database was not migrated");
      }
    }
    runMigrations(db, dir);
    return db as ControlDb;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** True when any tenant registration exists, whatever its status. The table may not exist in a file this old. */
export function hasRegistrations(db: Database.Database): boolean {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tenant_registrations'").get() !== undefined;
  return hasTable && db.prepare("SELECT 1 FROM tenant_registrations LIMIT 1").get() !== undefined;
}
