import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@oneon/domain";
import {
  acquireStorageLock,
  hasRegistrations,
  migrateAll,
  openControlDbForStartup,
  restoreTestTmpDir,
  sweepBackupLeftovers,
  type PreMigrationBackup,
} from "@oneon/infrastructure";
import type { Env } from "./config/env.js";

export type StorageEnv = Pick<Env, "DATABASE_PATH" | "CONTROL_DATABASE_PATH" | "TENANT_DATA_DIR" | "BACKUP_DIR" | "BACKUP_ENCRYPTION_KEY">;

/**
 * Runs before the container opens anything: migrates control.db, the personal file and every tenant file (spec 8.6), backing each
 * one up first when a migration is pending (spec 8.7).
 *
 * - A file whose backup fails is not migrated. A tenant is then refused service by the gate (tenant_schema_behind) and logged at
 *   error level while the others are served; a control or personal failure stops startup here.
 * - With no BACKUP_ENCRYPTION_KEY backups are skipped, with a warning, but only while no tenant registration exists: the schema
 *   cannot know that, so it is checked here, and startup refuses once one does.
 */
export async function prepareStorage(env: StorageEnv, logger: Logger): Promise<void> {
  if (env.CONTROL_DATABASE_PATH === ":memory:" || env.DATABASE_PATH === ":memory:") return;

  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
  mkdirSync(dirname(env.CONTROL_DATABASE_PATH), { recursive: true });

  // An OS file lock held for the whole preparation, control.db's open and migration included. The kernel releases it when the
  // process dies, so a lock file left by a crash never blocks the restart.
  const release = acquireStorageLock(join(dirname(env.CONTROL_DATABASE_PATH), "storage.lock"));
  try {
    const swept = sweepBackupLeftovers({ backupDir: env.BACKUP_DIR, scratchRoots: [tmpdir(), restoreTestTmpDir()] });
    if (swept.length > 0) logger.warn("Removed leftovers of an interrupted backup", { count: swept.length });
    await prepareLocked(env, logger);
  } finally {
    release();
  }
}

async function prepareLocked(env: StorageEnv, logger: Logger): Promise<void> {
  const keyB64 = env.BACKUP_ENCRYPTION_KEY;
  const backup: PreMigrationBackup | null = keyB64 ? { outDir: env.BACKUP_DIR, keyB64, now: () => new Date() } : null;

  const control = await openControlDbForStartup(env.CONTROL_DATABASE_PATH, backup);
  try {
    if (!backup) {
      if (hasRegistrations(control)) {
        throw new Error("BACKUP_ENCRYPTION_KEY is required once a tenant registration exists. Generate with: openssl rand -base64 32");
      }
      logger.warn("BACKUP_ENCRYPTION_KEY is not set: backups are disabled. It is required as soon as the first pharmacy is enrolled.");
    }

    const result = await migrateAll({
      control,
      personalPath: env.DATABASE_PATH,
      tenantDir: env.TENANT_DATA_DIR,
      logger,
      backup: backup ?? undefined,
    });

    // A tenant that failed was logged by migrateAll and is refused service by the gate; the personal file is not optional.
    const personal = result.failed.find((f) => f.registrationId === "personal");
    if (personal) throw new Error(`The personal database was not migrated, so the server cannot start: ${personal.error}`);
  } finally {
    control.close();
  }
}
