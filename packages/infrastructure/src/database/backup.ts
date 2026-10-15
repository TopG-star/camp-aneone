import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Logger } from "@oneon/domain";
import { openBuffer, sealBuffer } from "../crypto/envelope.js";
import type { ContextDbGate } from "./context-db-gate.js";
import { rawDb, type TenantRefusedError } from "./context-db-gate.js";
import { forEachTenant } from "./for-each-tenant.js";
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
  /** Private scratch for the plaintext copy (see backupScratchDir). */
  scratchDir: string;
}

/** A tenant the gate refused to open (typed refusal); it has no file in the day, and the day is listed as having skipped it. */
export interface SkippedTenant {
  registrationId: string;
  code: TenantRefusedError["code"];
}

/** The files written, with the tenants skipped. */
export type BackupAllResult = BackupResult[] & { skipped: SkippedTenant[] };

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
/** A tenant backup that runs longer than this is logged as an overrun; it is never cut short. */
const TENANT_BACKUP_BUDGET_MS = 10 * 60 * 1000;

/**
 * Where backups and restore tests keep their plaintext scratch: a folder beside control.db, so the copies stay on the data volume,
 * never in BACKUP_DIR (which is synced off-site) and never in the shared OS tmpdir (whose sweep could hit another process's files).
 */
export function backupScratchDir(controlDatabasePath: string): string {
  return join(dirname(controlDatabasePath), "backup-scratch");
}

/** The UTC date, the name of a day's backup folder. */
export function backupDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The UTC hour, `yyyy-mm-ddThhZ`, the name of an hourly backup folder under `<outDir>/hourly/`. */
export function backupHour(date: Date): string {
  return `${date.toISOString().slice(0, 13)}Z`;
}

/** Owner decisions D6 and Q3: each file keeps its own 48 newest hourly copies; older hourly copies are deleted (never a file's newest copy). */
export const HOURLY_BACKUPS_KEPT = 48;

/** Owner decision Q4: an hourly `.partial` folder whose last write is more than this old is a leftover of a run that died, and is deleted. */
export const HOURLY_PARTIAL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

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
 * to `<dir>/<name>.db.enc`. The plaintext copy lives only in a private folder under `scratchDir` and is removed in `finally`.
 */
export async function backupDatabase(
  db: Database.Database,
  /** `sealAsDir` is the folder the file will finally live in, when it is written elsewhere first and renamed (it is sealed for that place). */
  target: { dir: string; name: string; keyB64: string; scratchDir: string; sealAsDir?: string },
): Promise<string> {
  const file = join(target.dir, `${target.name}${EXTENSION}`);
  const aad = backupAad(join(target.sealAsDir ?? target.dir, `${target.name}${EXTENSION}`));
  mkdirSync(target.scratchDir, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(target.scratchDir, BACKUP_SCRATCH_PREFIX)); // 0700 where the OS has modes
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

export interface BackupDeps {
  gate: ContextDbGate;
  control: ControlDb;
  outDir: string;
  keyB64: string;
  now: () => Date;
  /** Private scratch for the plaintext copies (see backupScratchDir). */
  scratchDir: string;
  logger?: Logger;
}

/**
 * Backs up control, personal and every active or operator-suspended tenant (owner decision D5) into `<outDir>/<yyyy-mm-dd>/`. The files are written into
 * `<yyyy-mm-dd>.partial/` and that folder is renamed only when every file succeeded, so a day folder always means a complete day:
 * after a failure (or a crash) no day folder exists and the next run starts the day again. Every file is tried; any failure is
 * thrown at the end. A tenant the gate refuses to open with a typed refusal (e.g. tenant_schema_behind) is skipped, not failed:
 * it is logged at error, listed in `skipped.json` in the day folder, and does not hold the day back. Files are sealed for their final folder, not the partial one.
 */
export function backupAll(deps: BackupDeps): Promise<BackupAllResult> {
  return backupSet(deps, join(deps.outDir, backupDay(deps.now())), { personal: true });
}

/**
 * Owner decisions D2 and D6: the hourly sealed copy, in addition to the daily snapshot. Control and every active or operator-suspended
 * pharmacy (the personal file stays daily only) into `<outDir>/hourly/<yyyy-mm-ddThhZ>/`, by exactly the daily rules: written into
 * `<yyyy-mm-ddThhZ>.partial/` and renamed when complete, a refused pharmacy listed in `skipped.json`, each file sealed for
 * `<yyyy-mm-ddThhZ>/<name>.db.enc` (so restore-backup opens it unchanged). An hour is backed up once.
 */
export function backupHourly(deps: BackupDeps): Promise<BackupAllResult> {
  return backupSet(deps, join(deps.outDir, "hourly", backupHour(deps.now())), { personal: false });
}

async function backupSet(deps: BackupDeps, finalDir: string, opts: { personal: boolean }): Promise<BackupAllResult> {
  const dir = `${finalDir}${PARTIAL_SUFFIX}`;
  if (existsSync(finalDir)) throw new Error(`${finalDir} already exists; it is backed up once`);
  rmSync(dir, { recursive: true, force: true }); // a crashed run's leftovers
  const completed: BackupResult[] = [];
  const failed: Array<{ context: string; error: string }> = [];

  // Handles come from the gate (and the control handle): tenant files are never opened any other way.
  const skipped: SkippedTenant[] = [];
  const fixed: Array<{ context: string; name: string; db: () => Database.Database }> = [
    { context: "control", name: "control", db: () => deps.control },
    ...(opts.personal ? [{ context: "personal", name: "personal", db: () => rawDb(deps.gate.openPersonal()) }] : []),
  ];
  for (const job of fixed) {
    try {
      completed.push({ file: await backupDatabase(job.db(), { dir, name: job.name, keyB64: deps.keyB64, scratchDir: deps.scratchDir, sealAsDir: finalDir }), context: job.context });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ context: job.context, error: message });
      deps.logger?.error("backup failed", { context: job.context, error: message });
    }
  }

  // Tenants go through the shared runner (one leased file at a time). The budget is cooperative and a backup cannot be preempted:
  // an overrun is logged, never aborted, because half a backup is worthless. Suspended pharmacies are backed up too, through the
  // gate's maintenance lease (owner decision D5).
  const registrations = new TenantRegistrationRepository(deps.control);
  const byId = new Map(registrations.listBackedUp().map((r) => [r.id, r]));
  const visit = await forEachTenant(
    {
      gate: deps.gate,
      registrations,
      maintenance: { list: () => registrations.listBackedUp(), lease: (id) => deps.gate.leaseForMaintenance(id) },
      logger: deps.logger,
    },
    async (db, _deadline, reg) => {
      completed.push({
        file: await backupDatabase(rawDb(db), { dir, name: reg.fileName.replace(/\.db$/, ""), keyB64: deps.keyB64, scratchDir: deps.scratchDir, sealAsDir: finalDir }),
        context: reg.tenantId,
      });
    },
    { budgetMs: TENANT_BACKUP_BUDGET_MS },
  );
  for (const refusal of visit.refused) {
    skipped.push(refusal);
    // A file that is gone is its own alert: it needs a restore, where a schema that is behind needs a fix and a re-migration.
    if (refusal.code === "tenant_file_missing") {
      deps.logger?.error("backup skipped: the tenant file is missing", { alert: "tenant_file_missing", registrationId: refusal.registrationId, code: refusal.code });
    } else {
      deps.logger?.error("backup skipped: the tenant is refused service", { registrationId: refusal.registrationId, code: refusal.code });
    }
  }
  for (const registrationId of visit.failed) {
    const message = visit.errors[registrationId]!;
    failed.push({ context: byId.get(registrationId)?.tenantId ?? registrationId, error: message });
    deps.logger?.error("backup failed", { context: byId.get(registrationId)?.tenantId ?? registrationId, error: message });
  }
  if (failed.length > 0) throw new BackupIncompleteError(completed, failed);
  if (skipped.length > 0) writeFileSync(join(dir, "skipped.json"), JSON.stringify(skipped, null, 2), { mode: 0o600 });
  renameSync(dir, finalDir);
  return Object.assign(
    completed.map((c) => ({ ...c, file: join(finalDir, basename(c.file)) })),
    { skipped },
  );
}

/** The newest restorable sealed copy of one context; `newestAt` is null when it has none. */
export interface NewestBackupCopy {
  context: "control" | "personal" | "tenant";
  /** Set for a pharmacy. */
  registrationId?: string;
  newestAt: Date | null;
  /** Pharmacies only: when it was enrolled or last moved to active, whichever is later. A pharmacy with no copy is measured from here. */
  activeSince?: Date;
}

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_FOLDER = /^\d{4}-\d{2}-\d{2}T\d{2}Z$/;

const subfolders = (folder: string): string[] =>
  existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/**
 * Every restorable sealed copy: the `.db.enc` files of complete day folders (`<day>/`), complete hourly folders
 * (`hourly/<yyyy-mm-ddThhZ>/`) and pre-migration runs (`pre-migration/<run>/`); never a `.partial` folder or a `.part` file.
 */
function restorableCopies(outDir: string): Array<{ folder: string; name: string; at: number }> {
  const copies: Array<{ folder: string; name: string; at: number }> = [];
  const scan = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(EXTENSION)) copies.push({ folder, name: entry.name, at: statSync(join(folder, entry.name)).mtimeMs });
    }
  };
  for (const day of subfolders(outDir).filter((name) => DAY_FOLDER.test(name))) scan(join(outDir, day));
  for (const hour of subfolders(join(outDir, "hourly")).filter((name) => HOUR_FOLDER.test(name))) scan(join(outDir, "hourly", hour));
  for (const run of subfolders(join(outDir, "pre-migration"))) scan(join(outDir, "pre-migration", run));
  return copies;
}

/**
 * For control, personal and every backed-up pharmacy (active or operator-suspended, owner decision D5), when its newest restorable copy
 * was written: the latest modification time among its sealed files in complete day and hourly folders and in `pre-migration/<run>/`
 * (see restorableCopies). Only reads; nothing is opened or removed. A pharmacy the nightly run skips still has its pre-migration copy
 * counted here.
 */
export function newestBackupCopies(deps: { outDir: string; registrations: Pick<TenantRegistrationRepository, "listBackedUp" | "activeSince"> }): NewestBackupCopy[] {
  const newest = new Map<string, number>();
  for (const { name, at } of restorableCopies(deps.outDir)) {
    if (at > (newest.get(name) ?? -Infinity)) newest.set(name, at);
  }

  const copy = (fileName: string): Date | null => {
    const at = newest.get(`${fileName}${EXTENSION}`);
    return at === undefined ? null : new Date(at);
  };
  return [
    { context: "control", newestAt: copy("control") },
    { context: "personal", newestAt: copy("personal") },
    ...deps.registrations.listBackedUp().map((reg) => ({
      context: "tenant" as const,
      registrationId: reg.id,
      newestAt: copy(reg.fileName.replace(/\.db$/, "")),
      activeSince: deps.registrations.activeSince(reg.id) ?? new Date(reg.enrolledAt),
    })),
  ];
}

/**
 * Owner decisions D6, Q3 and Q4, run after each successful hourly backup. Hourly retention counts per file:
 * - each file (control, each pharmacy) keeps its own HOURLY_BACKUPS_KEPT newest copies among the complete hourly folders, by folder hour,
 *   so a pharmacy skipped for some hours still keeps 48; its older hourly copies are deleted;
 * - the newest copy of any file, across every daily, hourly and pre-migration copy, is never deleted;
 * - a complete hourly folder is deleted whole (with its `skipped.json`) only when it holds no copy that must be kept, and, if it holds no
 *   copy at all, only once it is older than the 48 newest complete folders; otherwise only the copies beyond 48 inside it are deleted;
 * - an hourly `.partial` folder whose newest write (the folder or anything in it) is more than HOURLY_PARTIAL_MAX_AGE_MS old is deleted;
 * - daily folders (and their `.partial` folders) and anything under `pre-migration/` are never touched.
 * Returns what was removed: each folder removed whole, and each file removed alone.
 */
export function pruneHourlyBackups(deps: { outDir: string; now?: () => Date }): string[] {
  const hourly = join(deps.outDir, "hourly");
  const now = (deps.now ?? (() => new Date()))().getTime();
  const removed: string[] = [];

  // Q4: leftovers of an hourly run that never finished.
  for (const name of subfolders(hourly).filter((n) => n.endsWith(PARTIAL_SUFFIX) && HOUR_FOLDER.test(n.slice(0, -PARTIAL_SUFFIX.length)))) {
    const folder = join(hourly, name);
    const lastWrite = Math.max(statSync(folder).mtimeMs, ...readdirSync(folder).map((entry) => statSync(join(folder, entry)).mtimeMs));
    if (now - lastWrite > HOURLY_PARTIAL_MAX_AGE_MS) {
      rmSync(folder, { recursive: true, force: true });
      removed.push(folder);
    }
  }

  const complete = subfolders(hourly)
    .filter((name) => HOUR_FOLDER.test(name))
    .sort()
    .map((name) => join(hourly, name));
  if (complete.length === 0) return removed;

  // The newest copy of each file name anywhere (on a tie, the first found). That copy is never deleted.
  const newest = new Map<string, { folder: string; at: number }>();
  for (const copy of restorableCopies(deps.outDir)) {
    const current = newest.get(copy.name);
    if (!current || copy.at > current.at) newest.set(copy.name, copy);
  }

  // Q3: per file, its hourly copies newest first; the first 48 are kept.
  const copiesOf = new Map<string, string[]>();
  for (const folder of [...complete].reverse()) {
    for (const name of readdirSync(folder).filter((n) => n.endsWith(EXTENSION))) copiesOf.set(name, [...(copiesOf.get(name) ?? []), folder]);
  }
  const doomed = new Set<string>();
  for (const [name, folders] of copiesOf) {
    for (const folder of folders.slice(HOURLY_BACKUPS_KEPT)) {
      const top = newest.get(name);
      if (top && top.folder === folder) continue; // a file's newest copy is never deleted
      doomed.add(join(folder, name));
    }
  }

  const beyondNewestFolders = new Set(complete.slice(0, Math.max(0, complete.length - HOURLY_BACKUPS_KEPT)));
  for (const folder of complete) {
    const copies = readdirSync(folder).filter((n) => n.endsWith(EXTENSION)).map((n) => join(folder, n));
    const going = copies.filter((c) => doomed.has(c));
    const wholeFolder = copies.length === 0 ? beyondNewestFolders.has(folder) : going.length === copies.length;
    if (wholeFolder) {
      rmSync(folder, { recursive: true, force: true });
      removed.push(folder);
      continue;
    }
    for (const copy of going) {
      rmSync(copy, { force: true });
      removed.push(copy);
    }
  }
  return removed;
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
  mkdirSync(deps.tmpDir, { recursive: true, mode: 0o700 });
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
