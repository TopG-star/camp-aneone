import { closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import type { Logger } from "@oneon/domain";
import { createDatabase, latestMigrationVersion, runMigrations } from "./connection.js";
import type { ControlDb } from "./control/open-control-db.js";
import { tenantFilePath } from "./context-db-gate.js";

function migrateFile(path: string, tenantId?: string): void {
  const db = createDatabase(path);
  try {
    // A file that already says it belongs to another context must not be migrated under this registration.
    // (Files from before context_meta existed carry no identity yet; the gate verifies it on open.)
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_meta'").get() !== undefined;
    if (hasMeta) {
      const rows = db.prepare("SELECT kind, tenant_id FROM context_meta").all() as Array<{ kind: string; tenant_id: string | null }>;
      const expectedKind = tenantId === undefined ? "personal" : "tenant";
      if (rows.some((r) => r.kind !== expectedKind || r.tenant_id !== (tenantId ?? null))) throw new Error("context_meta identity mismatch");
    }
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
    // A tenant target is a registry file name, resolved through the same pattern check as the gate.
    const targets: Array<{ id: string; resolve: () => string; tenantId?: string; mustExist: boolean }> = [
      { id: "personal", resolve: () => deps.personalPath, mustExist: false },
    ];
    const rows = deps.control
      .prepare("SELECT id, tenant_id, file_name FROM tenant_registrations WHERE status = 'active' ORDER BY enrolled_at, id")
      .all() as Array<{ id: string; tenant_id: string; file_name: string }>;
    for (const row of rows) {
      targets.push({ id: row.id, tenantId: row.tenant_id, resolve: () => tenantFilePath(deps.tenantDir, row.file_name), mustExist: true });
    }

    for (const target of targets) {
      try {
        // Opening a missing path would create an empty database.
        const path = target.resolve();
        if (target.mustExist && !existsSync(path)) throw new Error("file missing");
        migrateFile(path, target.tenantId);
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
