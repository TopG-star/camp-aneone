import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** Why a restore that decrypted and passed integrity_check is still not ok (restoreTestOwned only). */
  reason?: string;
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
/** Prefixes of the private folders this module creates, so a startup sweep removes only its own leftovers. */
const BACKUP_SCRATCH_PREFIX = "oneon-backup-";
const RESTORE_SCRATCH_PREFIX = "oneon-restore-";
const PARTIAL_SUFFIX = ".partial";

/** Where the restore test's scratch folders go. */
export function restoreTestTmpDir(): string {
  return join(tmpdir(), "oneon-restore-test");
}

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
export async function backupDatabase(
  db: Database.Database,
  /** `sealAsDir` is the folder the file will finally live in, when it is written elsewhere first and renamed (it is sealed for that place). */
  target: { dir: string; name: string; keyB64: string; sealAsDir?: string },
): Promise<string> {
  const file = join(target.dir, `${target.name}${EXTENSION}`);
  const aad = backupAad(join(target.sealAsDir ?? target.dir, `${target.name}${EXTENSION}`));
  const scratch = mkdtempSync(join(tmpdir(), BACKUP_SCRATCH_PREFIX)); // 0700 where the OS has modes
  const partial = `${file}.part`;
  try {
    const copy = join(scratch, "copy.db");
    await db.backup(copy);
    const sealed = sealBuffer(readFileSync(copy), target.keyB64, aad);
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

/**
 * Backs up control, personal and every active tenant into `<outDir>/<yyyy-mm-dd>/`. The files are written into
 * `<yyyy-mm-dd>.partial/` and that folder is renamed only when every file succeeded, so a day folder always means a complete day:
 * after a failure (or a crash) no day folder exists and the next run starts the day again. Every file is tried; any failure is
 * thrown at the end. Files are sealed for their final folder, not the partial one.
 */
export async function backupAll(deps: {
  gate: ContextDbGate;
  control: ControlDb;
  outDir: string;
  keyB64: string;
  now: () => Date;
  logger?: Logger;
}): Promise<BackupResult[]> {
  const finalDir = join(deps.outDir, backupDay(deps.now()));
  const dir = `${finalDir}${PARTIAL_SUFFIX}`;
  if (existsSync(finalDir)) throw new Error(`${finalDir} already exists; a day is backed up once`);
  rmSync(dir, { recursive: true, force: true }); // a crashed run's leftovers
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
      completed.push({ file: await backupDatabase(db, { dir, name: job.name, keyB64: deps.keyB64, sealAsDir: finalDir }), context: job.context });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ context: job.context, error: message });
      deps.logger?.error("backup failed", { context: job.context, error: message });
    }
  }
  if (failed.length > 0) throw new BackupIncompleteError(completed, failed);
  renameSync(dir, finalDir);
  return completed.map((c) => ({ ...c, file: join(finalDir, basename(c.file)) }));
}

/**
 * Decrypts a backup file to its database bytes. Throws when the key is wrong or the file is not where (and what) it was written.
 * `as` (`<folder>/<file>`, e.g. `2026-10-10/personal.db.enc`) supplies the original location of a file that was renamed or moved.
 */
export function decryptBackup(file: string, keyB64: string, as?: string): Buffer {
  return openBuffer(readFileSync(file), keyB64, as ?? backupAad(file));
}

/**
 * Restores a backup into a private temp folder under `tmpDir`, checks `PRAGMA integrity_check`, reads `context_meta`, and deletes the
 * copy. A backup that cannot be decrypted or opened is reported as not ok, not thrown.
 */
export async function restoreTest(deps: { file: string; keyB64: string; tmpDir: string }): Promise<RestoreTestResult> {
  mkdirSync(deps.tmpDir, { recursive: true });
  const scratch = mkdtempSync(join(deps.tmpDir, RESTORE_SCRATCH_PREFIX));
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

/**
 * `restoreTest` plus the check that the file belongs where its name says (spec 8.7): the registration whose tenant file id is the
 * file's name must exist, and `context_meta` must say kind "tenant" with that registration's tenant id. Anything else is not ok,
 * with the reason in `reason`.
 */
export async function restoreTestOwned(deps: { file: string; keyB64: string; tmpDir: string; control: ControlDb }): Promise<RestoreTestResult> {
  const result = await restoreTest(deps);
  if (!result.ok) return result;
  const fileName = `${basename(deps.file).replace(/\.db\.enc$/, "")}.db`;
  const owner = deps.control.prepare("SELECT tenant_id FROM tenant_registrations WHERE file_name = ?").get(fileName) as { tenant_id: string } | undefined;
  const meta = result.contextMeta;
  let reason: string | null = null;
  if (!owner) reason = `no registration owns ${fileName}`;
  else if (!meta) reason = "the restored file has no context_meta";
  else if (meta.kind !== "tenant") reason = `context_meta kind is "${meta.kind}", expected "tenant"`;
  else if (meta.tenant_id !== owner.tenant_id) reason = `context_meta tenant_id is "${meta.tenant_id}", the registration says "${owner.tenant_id}"`;
  return reason === null ? result : { ...result, ok: false, reason };
}

/**
 * Removes what an interrupted run of this module can leave behind: its private plaintext scratch folders (by prefix, in each of
 * `scratchRoots`) and `.part` files anywhere under `backupDir`. Nothing else is touched. Returns the removed paths.
 */
export function sweepBackupLeftovers(deps: { backupDir: string; scratchRoots: string[] }): string[] {
  const removed: string[] = [];
  for (const root of deps.scratchRoots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name.startsWith(BACKUP_SCRATCH_PREFIX) || entry.name.startsWith(RESTORE_SCRATCH_PREFIX))) {
        const path = join(root, entry.name);
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      }
    }
  }
  const walk = (dir: string): void => {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(`${EXTENSION}.part`)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
  };
  walk(deps.backupDir);
  return removed;
}
