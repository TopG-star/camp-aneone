import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Logger } from "@oneon/domain";
import { createDatabase, hasPendingMigrations, latestMigrationVersion, runMigrations } from "./connection.js";
import { backupDatabase, preMigrationFolder, type PreMigrationBackup } from "./backup.js";
import type { ControlDb } from "./control/open-control-db.js";
import { rawDb, tenantFilePath, type ContextDbGate } from "./context-db-gate.js";

type BackupTarget = { folder: string; keyB64: string; scratchDir: string };

async function migrateFile(path: string, name: string, tenantId: string | undefined, backup: BackupTarget | undefined): Promise<void> {
  // A file that does not exist yet has nothing to lose: createDatabase makes it.
  const existed = existsSync(path);
  const db = createDatabase(path);
  try {
    await migrateOpenFile(db, name, tenantId, existed ? backup : undefined);
  } finally {
    db.close();
  }
}

/** The per-file rule, at startup and on Resume: the identity check, a sealed copy when a migration is pending, then the migration. */
async function migrateOpenFile(db: Database.Database, name: string, tenantId: string | undefined, backup: BackupTarget | undefined): Promise<void> {
  // A file that already says it belongs to another context must not be migrated under this registration.
  // (Files from before context_meta existed carry no identity yet; the gate verifies it on open.)
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_meta'").get() !== undefined;
  if (hasMeta) {
    const rows = db.prepare("SELECT kind, tenant_id FROM context_meta").all() as Array<{ kind: string; tenant_id: string | null }>;
    const expectedKind = tenantId === undefined ? "personal" : "tenant";
    if (rows.some((r) => r.kind !== expectedKind || r.tenant_id !== (tenantId ?? null))) throw new Error("context_meta identity mismatch");
  }
  // A file is only migrated once its backup is safe: when the backup fails, the error stops this file and leaves it as it was.
  if (backup && hasPendingMigrations(db)) {
    try {
      await backupDatabase(db, { dir: backup.folder, name, keyB64: backup.keyB64, scratchDir: backup.scratchDir });
    } catch (error) {
      throw new Error(`pre-migration backup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  runMigrations(db);
  // Keep an existing identity row's recorded version in step with the file.
  db.prepare("UPDATE context_meta SET schema_version = ?").run(latestMigrationVersion());
}

/**
 * Migrates one pharmacy's file, active or suspended, by the same rule as startup: a sealed copy first when a migration is pending (a
 * failed copy throws and leaves the file as it was). Resume and re-enrolment run it before a pharmacy is served again (review I3,
 * owner decision D5). The file is opened through the gate's maintenance lease, which also opens a file that is behind.
 */
export async function migrateTenantFile(
  deps: { gate: Pick<ContextDbGate, "leaseForMaintenance">; backup?: PreMigrationBackup },
  registration: { id: string; tenantId: string; fileName: string },
): Promise<void> {
  const backup = deps.backup && { folder: preMigrationFolder(deps.backup.outDir, deps.backup.now()), keyB64: deps.backup.keyB64, scratchDir: deps.backup.scratchDir };
  const lease = deps.gate.leaseForMaintenance(registration.id, { allowSchemaBehind: true });
  try {
    await migrateOpenFile(rawDb(lease.db), registration.fileName.replace(/\.db$/, ""), registration.tenantId, backup);
  } finally {
    lease.release();
  }
}

export async function migrateAll(deps: {
  control: ControlDb;
  personalPath: string;
  tenantDir: string;
  logger: Logger;
  /** When given, a file with a migration pending is backed up (sealed) before it is migrated. */
  backup?: PreMigrationBackup;
}): Promise<{ migrated: string[]; failed: Array<{ registrationId: string; error: string }> }> {
  const migrated: string[] = [];
  const failed: Array<{ registrationId: string; error: string }> = [];
  // A tenant target is a registry file name, resolved through the same pattern check as the gate.
  const targets: Array<{ id: string; name: string; resolve: () => string; tenantId?: string; mustExist: boolean }> = [
    { id: "personal", name: "personal", resolve: () => deps.personalPath, mustExist: false },
  ];
  const rows = deps.control
    .prepare("SELECT id, tenant_id, file_name FROM tenant_registrations WHERE status = 'active' ORDER BY enrolled_at, id")
    .all() as Array<{ id: string; tenant_id: string; file_name: string }>;
  for (const row of rows) {
    targets.push({ id: row.id, name: row.file_name.replace(/.db$/, ""), tenantId: row.tenant_id, resolve: () => tenantFilePath(deps.tenantDir, row.file_name), mustExist: true });
  }

  const backup = deps.backup && { folder: preMigrationFolder(deps.backup.outDir, deps.backup.now()), keyB64: deps.backup.keyB64, scratchDir: deps.backup.scratchDir };
  for (const target of targets) {
    try {
      // Opening a missing path would create an empty database.
      const path = target.resolve();
      if (target.mustExist && !existsSync(path)) throw new Error("file missing");
      await migrateFile(path, target.name, target.tenantId, backup);
      migrated.push(target.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ registrationId: target.id, error: message });
      deps.logger.error("context migration failed", { registrationId: target.id, error: message });
    }
  }
  return { migrated, failed };
}
