import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@oneon/domain";
import { createDatabase, latestMigrationVersion, runMigrations } from "./connection.js";
import type { ControlDb } from "./control/open-control-db.js";

function migrateFile(path: string): void {
  const db = createDatabase(path);
  try {
    runMigrations(db);
    // Keep an existing identity row's recorded version in step with the file.
    db.prepare("UPDATE context_meta SET schema_version = ?").run(latestMigrationVersion());
  } finally {
    db.close();
  }
}

export function migrateAll(deps: {
  control: ControlDb;
  personalPath: string;
  tenantDir: string;
  lockPath: string;
  logger: Logger;
}): { migrated: string[]; failed: Array<{ registrationId: string; error: string }> } {
  // 'wx' fails when the lock exists: only one migration run at a time.
  const lockFd = openSync(deps.lockPath, "wx");
  const migrated: string[] = [];
  const failed: Array<{ registrationId: string; error: string }> = [];
  try {
    const targets: Array<{ id: string; path: string; mustExist: boolean }> = [
      { id: "personal", path: deps.personalPath, mustExist: false },
    ];
    const rows = deps.control
      .prepare("SELECT id, file_name FROM tenant_registrations WHERE status = 'active' ORDER BY enrolled_at, id")
      .all() as Array<{ id: string; file_name: string }>;
    for (const row of rows) {
      targets.push({ id: row.id, path: join(deps.tenantDir, row.file_name), mustExist: true });
    }

    for (const target of targets) {
      try {
        // Opening a missing path would create an empty database.
        if (target.mustExist && !existsSync(target.path)) throw new Error("file missing");
        migrateFile(target.path);
        migrated.push(target.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ registrationId: target.id, error: message });
        deps.logger.error("context migration failed", { registrationId: target.id, error: message });
      }
    }
  } finally {
    closeSync(lockFd);
    unlinkSync(deps.lockPath);
  }
  return { migrated, failed };
}
