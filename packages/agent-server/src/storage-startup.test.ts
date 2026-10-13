import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { acquireStorageLock, createDatabase, openControlDb } from "@oneon/infrastructure";
import { prepareStorage } from "./storage-startup.js";

const NOW = "2026-10-08T00:00:00.000Z";

describe("prepareStorage", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(opts: { key?: boolean; registration?: boolean; existingPersonal?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    dirs.push(dir);
    const env = {
      DATABASE_PATH: join(dir, "oneon.db"),
      CONTROL_DATABASE_PATH: join(dir, "control.db"),
      TENANT_DATA_DIR: join(dir, "tenants"),
      BACKUP_DIR: join(dir, "backups"),
      BACKUP_ENCRYPTION_KEY: opts.key === false ? undefined : randomBytes(32).toString("base64"),
    };
    mkdirSync(env.TENANT_DATA_DIR);
    if (opts.registration) {
      const control = openControlDb(env.CONTROL_DATABASE_PATH);
      control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('reg-1', 't-1', 's-1', 'P', 'https://x.example', '11111111-1111-1111-1111-111111111111.db', 'suspended_by_operator', 'op', ?)",
        )
        .run(NOW);
      control.close();
    }
    if (opts.existingPersonal) createDatabase(env.DATABASE_PATH).close();
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { dir, env, log };
  }

  it("with no key and no registration, starts, warns that backups are off, and writes none", async () => {
    const { env, log } = setup({ key: false, existingPersonal: true });
    await prepareStorage(env, log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/BACKUP_ENCRYPTION_KEY.*backups are disabled/i));
    expect(existsSync(env.BACKUP_DIR)).toBe(false);
  });

  it("refuses to start without the key once any registration exists, whatever its status", async () => {
    const { env, log } = setup({ key: false, registration: true });
    await expect(prepareStorage(env, log)).rejects.toThrow(/BACKUP_ENCRYPTION_KEY is required/);
  });

  it("with the key, backs up a personal file that has a migration pending, before migrating it", async () => {
    const { env, log } = setup({ existingPersonal: true });
    await prepareStorage(env, log);
    const [stamp] = readdirSync(join(env.BACKUP_DIR, "pre-migration"));
    expect(readdirSync(join(env.BACKUP_DIR, "pre-migration", stamp!))).toEqual(["personal.db.enc"]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("stops startup with a clear error when the personal backup fails, leaving the file unmigrated", async () => {
    const { dir, env, log } = setup({ existingPersonal: true });
    writeFileSync(join(dir, "backups"), "a file where the backup folder should be");
    await expect(prepareStorage(env, log)).rejects.toThrow(/personal database.*not migrated/i);
    const db = createDatabase(env.DATABASE_PATH);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    db.close();
  });

  it("is not blocked by a leftover lock file, and leaves nothing held", async () => {
    const { dir, env, log } = setup({ existingPersonal: true });
    writeFileSync(join(dir, "storage.lock"), "");
    await prepareStorage(env, log);
    // Released: a second preparation runs straight after.
    await prepareStorage(env, log);
  });

  it("refuses with a readable error while another process holds the storage lock, and touches nothing", async () => {
    const { dir, env, log } = setup({ existingPersonal: true });
    const release = acquireStorageLock(join(dir, "storage.lock"));
    try {
      await expect(prepareStorage(env, log)).rejects.toThrow(/another Oneon process is preparing storage/i);
    } finally {
      release();
    }
    expect(existsSync(env.CONTROL_DATABASE_PATH)).toBe(false);
  });

  it("holds the lock while the control database is opened and migrated, and releases it when it fails", async () => {
    const { dir, env, log } = setup({ key: false, registration: true });
    await expect(prepareStorage(env, log)).rejects.toThrow(/BACKUP_ENCRYPTION_KEY is required/);
    acquireStorageLock(join(dir, "storage.lock"))();
  });

  it("sweeps leftover plaintext scratch folders beside control.db and .part files, and only those", async () => {
    const { dir, env, log } = setup({ existingPersonal: true });
    const scratchRoot = join(dir, "backup-scratch");
    const scratch = join(scratchRoot, "oneon-backup-abc");
    const restoreScratch = join(scratchRoot, "oneon-restore-xyz");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(restoreScratch);
    writeFileSync(join(scratch, "copy.db"), "plaintext");
    mkdirSync(join(env.BACKUP_DIR, "2026-10-09"), { recursive: true });
    writeFileSync(join(env.BACKUP_DIR, "2026-10-09", "a.db.enc.part"), "x");
    writeFileSync(join(env.BACKUP_DIR, "2026-10-09", "a.db.enc"), "keep");
    writeFileSync(join(dir, "notes.part"), "outside the backup dir");
    await prepareStorage(env, log);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(restoreScratch)).toBe(false);
    expect(existsSync(join(env.BACKUP_DIR, "2026-10-09", "a.db.enc.part"))).toBe(false);
    expect(existsSync(join(env.BACKUP_DIR, "2026-10-09", "a.db.enc"))).toBe(true);
    expect(existsSync(join(dir, "notes.part"))).toBe(true);
  });

  it("never touches the OS tmpdir, where another process may have a scratch folder in flight", async () => {
    const { env, log } = setup({ existingPersonal: true });
    const foreign = mkdtempSync(join(tmpdir(), "oneon-backup-"));
    try {
      await prepareStorage(env, log);
      expect(existsSync(foreign)).toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("does nothing to in-memory databases", async () => {
    const { env, log } = setup({ key: false });
    await prepareStorage({ ...env, DATABASE_PATH: ":memory:", CONTROL_DATABASE_PATH: ":memory:" }, log);
    expect(log.error).not.toHaveBeenCalled();
  });
});
