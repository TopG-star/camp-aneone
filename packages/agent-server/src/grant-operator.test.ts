import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { acquireStorageLock, createDatabase, decryptBackup, openControlDb, PlatformOperatorRepository } from "@oneon/infrastructure";
import { grantOperator, grantOperatorPaths } from "./grant-operator.js";

const NOW = "2026-10-08T00:00:00.000Z";

describe("grantOperator", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A control file one migration behind (migration 5's table and record are gone), with an identity and optionally a registration. */
  function setup(opts: { registration?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "grant-"));
    dirs.push(dir);
    const controlPath = join(dir, "control.db");
    const db = openControlDb(controlPath);
    db.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    if (opts.registration) {
      db.prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('reg-1', 't-1', 's-1', 'P', 'https://x.example', 'f.db', 'active', 'op', ?)",
      ).run(NOW);
    }
    db.exec("DROP TABLE action_grant_tombstones; DELETE FROM schema_migrations WHERE version = 5");
    db.close();
    return { dir, controlPath, backupDir: join(dir, "backups"), keyB64: randomBytes(32).toString("base64") };
  }

  const isMigrated = (path: string) => {
    const db = createDatabase(path);
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'action_grant_tombstones'").get() !== undefined;
    db.close();
    return has;
  };
  const isOperator = (path: string) => {
    const db = createDatabase(path);
    try {
      return new PlatformOperatorRepository(db as never).isOperator("op");
    } finally {
      db.close();
    }
  };

  it("backs up control.db, sealed, before the migration it triggers", async () => {
    const { dir, controlPath, backupDir, keyB64 } = setup();
    await grantOperator({ controlPath, backupDir, keyB64, identityId: "op" });

    expect(isMigrated(controlPath)).toBe(true);
    expect(isOperator(controlPath)).toBe(true);
    const folder = join(backupDir, "pre-migration");
    const stamps = readdirSync(folder);
    expect(stamps).toHaveLength(1);
    const restored = join(dir, "restored.db");
    writeFileSync(restored, decryptBackup(join(folder, stamps[0]!, "control.db.enc"), keyB64));
    expect(isMigrated(restored)).toBe(false);
  });

  it("refuses with a clear message, migrating nothing, when a migration is pending, a registration exists and no key is set", async () => {
    const { controlPath, backupDir } = setup({ registration: true });
    await expect(grantOperator({ controlPath, backupDir, keyB64: undefined, identityId: "op" })).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/);
    expect(isMigrated(controlPath)).toBe(false);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("goes ahead without a key while no registration exists", async () => {
    const { controlPath, backupDir } = setup();
    await grantOperator({ controlPath, backupDir, keyB64: undefined, identityId: "op" });
    expect(isOperator(controlPath)).toBe(true);
  });

  it("refuses an unknown identity", async () => {
    const { controlPath, backupDir, keyB64 } = setup();
    await expect(grantOperator({ controlPath, backupDir, keyB64, identityId: "nobody" })).rejects.toThrow(/No identity with id nobody/);
  });

  it("refuses a control database that does not exist, and creates nothing", async () => {
    const { dir, backupDir, keyB64 } = setup();
    const before = readdirSync(dir).sort();
    // In a folder that exists (where SQLite would otherwise create a fresh, empty control.db) and in one that does not.
    for (const missing of [join(dir, "other-control.db"), join(dir, "elsewhere", "control.db")]) {
      await expect(grantOperator({ controlPath: missing, backupDir, keyB64, identityId: "op" })).rejects.toThrow(/No control database at .*CONTROL_DATABASE_PATH/s);
    }
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("refuses while another process is preparing storage", async () => {
    const { dir, controlPath, backupDir, keyB64 } = setup();
    const release = acquireStorageLock(join(dir, "storage.lock"));
    try {
      await expect(grantOperator({ controlPath, backupDir, keyB64, identityId: "op" })).rejects.toThrow(/preparing storage/);
      expect(isMigrated(controlPath)).toBe(false);
    } finally {
      release();
    }
  });
});

describe("grantOperatorPaths", () => {
  it("resolves relative paths against where the command was typed (INIT_CWD), not the package folder pnpm runs it in", () => {
    const typedIn = resolve("/srv/camp-aneone");
    expect(grantOperatorPaths({ INIT_CWD: typedIn, CONTROL_DATABASE_PATH: "./data/control.db", BACKUP_DIR: "data/backups" }, resolve("/pkg"))).toEqual({
      controlPath: join(typedIn, "data", "control.db"),
      backupDir: join(typedIn, "data", "backups"),
    });
  });

  it("uses the server's defaults, falls back to the working directory without INIT_CWD, and keeps absolute paths", () => {
    const cwd = resolve("/work");
    const absolute = resolve("/var/lib/oneon/control.db");
    expect(grantOperatorPaths({}, cwd)).toEqual({ controlPath: join(cwd, "data", "control.db"), backupDir: join(cwd, "data", "backups") });
    expect(grantOperatorPaths({ INIT_CWD: resolve("/elsewhere"), CONTROL_DATABASE_PATH: absolute }, cwd).controlPath).toBe(absolute);
  });
});
