import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Logger } from "@oneon/domain";
import { openBuffer, sealBuffer } from "../crypto/envelope.js";
import type { ContextDbGate } from "./context-db-gate.js";
import { rawDb } from "./context-db-gate.js";
import type { ControlDb } from "./control/open-control-db.js";
import { TenantRegistrationRepository } from "./control/tenant-registration-repository.js";

export interface BackupResult {
  file: string;
  /** "control", "personal" or a tenant id. */
  context: "control" | "personal" | string;
}

export interface RestoreTestResult {
  ok: boolean;
  integrity: string;
  contextMeta: { kind: string; tenant_id: string | null } | null;
}

/** Where and how to back a file up before a migration changes it. */
export interface PreMigrationBackup {
  outDir: string;
  keyB64: string;
  now: () => Date;
}

export class BackupIncompleteError extends Error {
  constructor(
    public readonly completed: BackupResult[],
    public readonly failed: Array<{ context: string; error: string }>,
  ) {
    super(`Backup incomplete; failed: ${failed.map((f) => `${f.context} (${f.error})`).join(", ")}`);
    this.name = "BackupIncompleteError";
  }
}

const EXTENSION = ".db.enc";

/** The UTC date, the name of a day's backup folder. */
export function backupDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The folder for the backups taken just before a migration run: `<outDir>/pre-migration/<yyyy-mm-ddThh-mm-ssZ>`. */
export function preMigrationFolder(outDir: string, now: Date): string {
  return join(outDir, "pre-migration", now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-"));
}

/**
 * The associated data a backup is sealed under: its folder name and file name. A sealed file therefore only opens where it was
 * written (its own day or run, its own context), so a file copied over another one, or moved to another day, is refused.
 */
function backupAad(file: string): string {
  return `${basename(dirname(file))}/${basename(file)}`;
}

/**
 * Copies one open database with SQLite's online backup API (consistent while other connections write), seals the copy and writes it
 * to `<dir>/<name>.db.enc`. The plaintext copy lives only in a private temp folder outside `dir` and is removed in `finally`.
 */
export async function backupDatabase(db: Database.Database, target: { dir: string; name: string; keyB64: string }): Promise<string> {
  const file = join(target.dir, `${target.name}${EXTENSION}`);
  const scratch = mkdtempSync(join(tmpdir(), "oneon-backup-")); // 0700 where the OS has modes
  const partial = `${file}.part`;
  try {
    const copy = join(scratch, "copy.db");
    await db.backup(copy);
    const sealed = sealBuffer(readFileSync(copy), target.keyB64, backupAad(file));
    mkdirSync(target.dir, { recursive: true });
    // Written beside its final name and renamed, so a crash never leaves a short file under a real name.
    writeFileSync(partial, sealed, { mode: 0o600 });
    renameSync(partial, file);
    return file;
  } finally {
    rmSync(partial, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Backs up control, personal and every active tenant into `<outDir>/<yyyy-mm-dd>/`. Every file is tried; any failure is thrown at the end. */
export async function backupAll(deps: {
  gate: ContextDbGate;
  control: ControlDb;
  outDir: string;
  keyB64: string;
  now: () => Date;
  logger?: Logger;
}): Promise<BackupResult[]> {
  const dir = join(deps.outDir, backupDay(deps.now()));
  const completed: BackupResult[] = [];
  const failed: Array<{ context: string; error: string }> = [];

  // Handles come from the gate (and the control handle): tenant files are never opened any other way.
  const jobs: Array<{ context: string; name: string; db: () => Database.Database }> = [
    { context: "control", name: "control", db: () => deps.control },
    { context: "personal", name: "personal", db: () => rawDb(deps.gate.openPersonal()) },
  ];
  for (const reg of new TenantRegistrationRepository(deps.control).listActive()) {
    jobs.push({ context: reg.tenantId, name: reg.fileName.replace(/\.db$/, ""), db: () => rawDb(deps.gate.openTenant(reg.id)) });
  }

  for (const job of jobs) {
    try {
      const db = job.db();
      completed.push({ file: await backupDatabase(db, { dir, name: job.name, keyB64: deps.keyB64 }), context: job.context });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ context: job.context, error: message });
      deps.logger?.error("backup failed", { context: job.context, error: message });
    }
  }
  if (failed.length > 0) throw new BackupIncompleteError(completed, failed);
  return completed;
}

/** Decrypts a backup file to its database bytes. Throws when the key is wrong or the file is not where (and what) it was written. */
export function decryptBackup(file: string, keyB64: string): Buffer {
  return openBuffer(readFileSync(file), keyB64, backupAad(file));
}

/**
 * Restores a backup into a private temp folder under `tmpDir`, checks `PRAGMA integrity_check`, reads `context_meta`, and deletes the
 * copy. A backup that cannot be decrypted or opened is reported as not ok, not thrown.
 */
export async function restoreTest(deps: { file: string; keyB64: string; tmpDir: string }): Promise<RestoreTestResult> {
  mkdirSync(deps.tmpDir, { recursive: true });
  const scratch = mkdtempSync(join(deps.tmpDir, "oneon-restore-"));
  try {
    let plaintext: Buffer;
    try {
      plaintext = decryptBackup(deps.file, deps.keyB64);
    } catch {
      return { ok: false, integrity: "decryption failed", contextMeta: null };
    }
    const restored = join(scratch, "restored.db");
    writeFileSync(restored, plaintext, { mode: 0o600 });
    // The one place besides the gate and connection.ts that constructs a Database: it opens only this decrypted temp copy.
    let db: Database.Database;
    try {
      db = new Database(restored);
    } catch (error) {
      return { ok: false, integrity: `not a database: ${error instanceof Error ? error.message : String(error)}`, contextMeta: null };
    }
    try {
      const integrity = String(db.pragma("integrity_check", { simple: true }));
      const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_meta'").get() !== undefined;
      const contextMeta = hasMeta
        ? ((db.prepare("SELECT kind, tenant_id FROM context_meta LIMIT 1").get() as { kind: string; tenant_id: string | null } | undefined) ?? null)
        : null;
      return { ok: integrity === "ok", integrity, contextMeta };
    } catch (error) {
      return { ok: false, integrity: `not a database: ${error instanceof Error ? error.message : String(error)}`, contextMeta: null };
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
