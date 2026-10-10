import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptBackup } from "../backup.js";
import { createDatabase } from "../connection.js";
import { openControlDb, openControlDbForStartup } from "./open-control-db.js";

const NOW = "2026-10-08T00:00:00.000Z";
const STAMP = "2026-10-10T03-04-05Z";

/** Puts a non-empty folder where a sealed file must be written, so that one backup fails. */
function blockPath(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "blocker"), "");
}

describe("openControlDbForStartup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "open-control-"));
    dirs.push(dir);
    const path = join(dir, "control.db");
    const keyB64 = randomBytes(32).toString("base64");
    const backup = { outDir: join(dir, "backups"), keyB64, now: () => new Date("2026-10-10T03:04:05.000Z") };
    return { dir, path, keyB64, backup };
  }

  /** A control file one migration behind: migration 5's table is gone and its record with it. */
  function oldControlFile(path: string, withRegistration = false) {
    const db = openControlDb(path);
    if (withRegistration) {
      db.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
      db.prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('reg-1', 't-1', 's-1', 'P', 'https://x.example', 'f.db', 'active', 'op', ?)",
      ).run(NOW);
    }
    db.exec("DROP TABLE action_grant_tombstones; DELETE FROM schema_migrations WHERE version = 5");
    db.close();
  }

  const hasTombstones = (path: string) => {
    const db = createDatabase(path);
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'action_grant_tombstones'").get() !== undefined;
    db.close();
    return has;
  };

  it("backs up an existing control file before migrating it", async () => {
    const { dir, path, keyB64, backup } = setup();
    oldControlFile(path);

    const db = await openControlDbForStartup(path, backup);
    db.close();

    const restored = join(dir, "restored.db");
    writeFileSync(restored, decryptBackup(join(backup.outDir, "pre-migration", STAMP, "control.db.enc"), keyB64));
    expect(hasTombstones(restored)).toBe(false);
    expect(hasTombstones(path)).toBe(true);
  });

  it("makes no backup when the file is new or has nothing pending", async () => {
    const { path, backup } = setup();
    (await openControlDbForStartup(path, backup)).close();
    (await openControlDbForStartup(path, backup)).close();
    expect(existsSync(backup.outDir)).toBe(false);
  });

  it("does not migrate, and stops, when the backup fails", async () => {
    const { path, backup } = setup();
    oldControlFile(path);
    blockPath(join(backup.outDir, "pre-migration", STAMP, "control.db.enc"));

    await expect(openControlDbForStartup(path, backup)).rejects.toThrow(/control.*backup/i);
    expect(hasTombstones(path)).toBe(false);
  });

  it("migrates without a backup key only while no registration exists", async () => {
    const free = setup();
    oldControlFile(free.path);
    (await openControlDbForStartup(free.path, null)).close();
    expect(hasTombstones(free.path)).toBe(true);

    const registered = setup();
    oldControlFile(registered.path, true);
    await expect(openControlDbForStartup(registered.path, null)).rejects.toThrow(/BACKUP_ENCRYPTION_KEY/);
    expect(hasTombstones(registered.path)).toBe(false);
  });
});
