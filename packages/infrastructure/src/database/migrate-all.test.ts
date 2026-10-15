import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { createDatabase, latestMigrationVersion, runMigrations } from "./connection.js";
import { backupAll, decryptBackup } from "./backup.js";
import { migrateAll, migrateTenantFile } from "./migrate-all.js";
import { openControlDb } from "./control/open-control-db.js";
import { ContextDbGate, rawDb } from "./context-db-gate.js";

const NOW = "2026-10-08T00:00:00.000Z";
const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

/** Puts a non-empty folder where a sealed file must be written, so that one backup fails. */
function blockPath(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "blocker"), "");
}

describe("migrateAll", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "migrate-all-"));
    dirs.push(dir);
    const tenantDir = join(dir, "tenants");
    mkdirSync(tenantDir);
    const control = openControlDb(join(dir, "control.db"));
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    let n = 0;
    const register = (status = "active") => {
      n += 1;
      const fileName = `${randomUUID()}.db`;
      control
        .prepare(
          "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'P', 'https://x.example', ?, ?, 'op', ?)",
        )
        .run(`reg-${n}`, `t-${n}`, `s-${n}`, fileName, status, NOW);
      return { id: `reg-${n}`, path: join(tenantDir, fileName) };
    };
    return { control, register, deps: { control, personalPath: join(dir, "personal.db"), tenantDir, logger } };
  }

  const hasMigrations = (path: string) => {
    const db = createDatabase(path);
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get() !== undefined;
    db.close();
    return has;
  };

  const version = (path: string) => {
    const db = createDatabase(path);
    const v = (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    db.close();
    return v;
  };

  it("migrates personal and every active or operator-suspended tenant, never a removed or tenant-disabled one, and continues past a failing file", async () => {
    const { control, register, deps } = setup();
    const good = register();
    const bad = register();
    const suspended = register("suspended_by_operator");
    const removed = register("removed");
    const disabled = register("disabled_by_tenant");
    const missing = register();
    for (const r of [good, suspended, removed, disabled]) createDatabase(r.path).close();
    writeFileSync(bad.path, "this is not a sqlite database, just text padding".repeat(20));

    const result = await migrateAll(deps);

    expect(result.migrated).toEqual(["personal", good.id, suspended.id]);
    expect(result.failed.map((f) => f.registrationId).sort()).toEqual([bad.id, missing.id].sort());
    expect(version(deps.personalPath)).toBe(latestMigrationVersion());
    expect(version(good.path)).toBe(latestMigrationVersion());
    expect(version(suspended.path)).toBe(latestMigrationVersion());
    expect(hasMigrations(removed.path)).toBe(false);
    expect(hasMigrations(disabled.path)).toBe(false);
    expect(existsSync(missing.path)).toBe(false);
    control.close();
  });

  it("a suspended pharmacy behind a migration is migrated at startup, after its sealed copy, and then backed up (fix round 1, I1)", async () => {
    const { control, register, deps } = setup();
    const dir = dirname(deps.personalPath);
    const gate = new ContextDbGate({ control, personalPath: deps.personalPath, tenantDir: deps.tenantDir });
    const reg = register("suspended_by_operator");
    gate.createTenantFile(reg.id, `t-${reg.id.slice(4)}`);
    const behind = createDatabase(reg.path);
    behind.exec(
      "DELETE FROM schema_migrations WHERE version = 17; ALTER TABLE model_call_decisions DROP COLUMN conversation_id; ALTER TABLE model_call_decisions DROP COLUMN turn_id; ALTER TABLE action_instances DROP COLUMN model_call_id;",
    );
    behind.close();
    createDatabase(deps.personalPath).close();
    const keyB64 = randomBytes(32).toString("base64");
    const now = new Date("2026-10-14T05:06:07.000Z");
    const outDir = join(dir, "backups");
    const scratchDir = join(dir, "backup-scratch");

    const result = await migrateAll({ ...deps, backup: { outDir, keyB64, now: () => now, scratchDir } });

    expect(result.migrated).toContain(reg.id);
    expect(version(reg.path)).toBe(latestMigrationVersion());
    const sealed = join(outDir, "pre-migration", "2026-10-14T05-06-07Z", `${basename(reg.path, ".db")}.db.enc`);
    const copy = join(dir, "pre-migration-copy.db");
    writeFileSync(copy, decryptBackup(sealed, keyB64));
    expect(version(copy)).toBe(latestMigrationVersion() - 1);

    const day = await backupAll({ gate, control, outDir, keyB64, now: () => now, scratchDir });
    expect(day.skipped).toEqual([]);
    expect(day.map((r) => r.context)).toContain(`t-${reg.id.slice(4)}`);
    gate.close();
    control.close();
  });

  it("does not migrate a suspended pharmacy whose pre-migration copy fails, like an active one", async () => {
    const { control, register, deps } = setup();
    const dir = dirname(deps.personalPath);
    const reg = register("suspended_by_operator");
    createDatabase(reg.path).close();
    const now = new Date("2026-10-14T05:06:07.000Z");
    const outDir = join(dir, "backups");
    blockPath(join(outDir, "pre-migration", "2026-10-14T05-06-07Z", `${basename(reg.path, ".db")}.db.enc`));

    const result = await migrateAll({ ...deps, backup: { outDir, keyB64: randomBytes(32).toString("base64"), now: () => now, scratchDir: join(dir, "scratch") } });

    expect(result.failed.map((f) => f.registrationId)).toEqual([reg.id]);
    expect(hasMigrations(reg.path)).toBe(false);
    control.close();
  });

  it("records a file name outside the pattern as failed and leaves the target untouched", async () => {
    const { control, register, deps } = setup();
    const bad = register();
    control.prepare("UPDATE tenant_registrations SET file_name = '../x.db' WHERE id = ?").run(bad.id);
    const target = join(deps.tenantDir, "..", "x.db");
    createDatabase(target).close();
    const before = readFileSync(target);
    const absent = register();
    control.prepare("UPDATE tenant_registrations SET file_name = '../absent.db' WHERE id = ?").run(absent.id);

    const result = await migrateAll(deps);

    expect(result.failed.map((f) => f.registrationId).sort()).toEqual([bad.id, absent.id].sort());
    expect(readFileSync(target).equals(before)).toBe(true);
    expect(existsSync(join(deps.tenantDir, "..", "absent.db"))).toBe(false);
    control.close();
  });

  it("does not migrate a file whose context_meta names another context", async () => {
    const { control, register, deps } = setup();
    const reg = register();
    const db = createDatabase(reg.path);
    db.exec("CREATE TABLE context_meta (kind TEXT NOT NULL, tenant_id TEXT, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO context_meta VALUES ('tenant', 'someone-else', 1, 'now')").run();
    db.close();

    const result = await migrateAll(deps);

    expect(result.failed.map((f) => f.registrationId)).toEqual([reg.id]);
    const check = createDatabase(reg.path);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    check.close();
    control.close();
  });

  describe("migrateTenantFile (Resume and re-enrolment, owner decision D5)", () => {
    const NOW_DATE = new Date("2026-10-14T05:06:07.000Z");
    function suspendedBehind() {
      const s = setup();
      const dir = dirname(s.deps.personalPath);
      const gate = new ContextDbGate({ control: s.control, personalPath: s.deps.personalPath, tenantDir: s.deps.tenantDir });
      const reg = s.register("suspended_by_operator");
      const id = reg.id;
      const tenantId = `t-${id.slice(4)}`;
      gate.createTenantFile(id, tenantId);
      // One migration behind: a release that adds migration 17 was deployed while the pharmacy was suspended.
      const db = createDatabase(reg.path);
      db.exec(
        "DELETE FROM schema_migrations WHERE version = 17; ALTER TABLE model_call_decisions DROP COLUMN conversation_id; ALTER TABLE model_call_decisions DROP COLUMN turn_id; ALTER TABLE action_instances DROP COLUMN model_call_id;",
      );
      db.close();
      const keyB64 = randomBytes(32).toString("base64");
      const backup = { outDir: join(dir, "backups"), keyB64, now: () => NOW_DATE, scratchDir: join(dir, "backup-scratch") };
      const registration = { id, tenantId, fileName: basename(reg.path) };
      return { ...s, gate, reg, registration, backup, keyB64, folder: join(dir, "backups", "pre-migration", "2026-10-14T05-06-07Z") };
    }

    it("migrates a suspended pharmacy's file that is behind, after a sealed copy of it as it was, and the gate can then open it", async () => {
      const { control, gate, reg, registration, backup, keyB64, folder } = suspendedBehind();

      await migrateTenantFile({ gate, backup }, registration);

      expect(version(reg.path)).toBe(latestMigrationVersion());
      const restored = join(dirname(folder), "restored.db");
      writeFileSync(restored, decryptBackup(join(folder, `${basename(reg.path, ".db")}.db.enc`), keyB64));
      expect(version(restored)).toBe(latestMigrationVersion() - 1);
      control.prepare("UPDATE tenant_registrations SET status = 'active' WHERE id = ?").run(reg.id);
      const lease = gate.lease(reg.id);
      expect(rawDb(lease.db).prepare("SELECT tenant_id FROM context_meta").get()).toEqual({ tenant_id: registration.tenantId });
      lease.release();
      gate.close();
      control.close();
    });

    it("does nothing, and takes no copy, when nothing is pending", async () => {
      const s = setup();
      const gate = new ContextDbGate({ control: s.control, personalPath: s.deps.personalPath, tenantDir: s.deps.tenantDir });
      const reg = s.register("suspended_by_operator");
      gate.createTenantFile(reg.id, `t-${reg.id.slice(4)}`);
      const outDir = join(dirname(s.deps.personalPath), "backups");
      await migrateTenantFile(
        { gate, backup: { outDir, keyB64: randomBytes(32).toString("base64"), now: () => new Date(), scratchDir: join(outDir, "..", "scratch") } },
        { id: reg.id, tenantId: `t-${reg.id.slice(4)}`, fileName: basename(reg.path) },
      );
      expect(existsSync(outDir)).toBe(false);
      gate.close();
      s.control.close();
    });

    it("does not migrate when its copy fails, and says why", async () => {
      const { control, gate, reg, registration, backup, folder } = suspendedBehind();
      blockPath(join(folder, `${basename(reg.path, ".db")}.db.enc`));
      await expect(migrateTenantFile({ gate, backup }, registration)).rejects.toThrow(/pre-migration backup failed/);
      expect(version(reg.path)).toBe(latestMigrationVersion() - 1);
      gate.close();
      control.close();
    });
  });

  describe("pre-migration backup", () => {
    const NOW_DATE = new Date("2026-10-10T03:04:05.000Z");
    const STAMP = "2026-10-10T03-04-05Z";
    const baseName = (path: string) => basename(path, ".db");

    function withBackup() {
      const s = setup();
      const outDir = join(dirname(s.deps.personalPath), "backups");
      const keyB64 = randomBytes(32).toString("base64");
      const errors: string[] = [];
      const logger: Logger = { info() {}, warn() {}, debug() {}, error: (m) => void errors.push(m) };
      const backup = { outDir, keyB64, now: () => NOW_DATE, scratchDir: join(dirname(s.deps.personalPath), "backup-scratch") };
      // An existing, unmigrated personal file: a migration is pending for it.
      createDatabase(s.deps.personalPath).close();
      return { ...s, outDir, keyB64, errors, deps: { ...s.deps, logger, backup }, folder: join(outDir, "pre-migration", STAMP) };
    }

    const hasMigrationTable = (path: string) => {
      const db = createDatabase(path);
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get() !== undefined;
      db.close();
      return has;
    };

    it("backs up a file before migrating it", async () => {
      const { control, register, deps, keyB64, folder } = withBackup();
      const tenant = register();
      createDatabase(tenant.path).close();

      const result = await migrateAll(deps);

      expect(result.failed).toEqual([]);
      const restored = join(dirname(deps.personalPath), "restored.db");
      for (const [file, original] of [
        [join(folder, "personal.db.enc"), deps.personalPath],
        [join(folder, `${baseName(tenant.path)}.db.enc`), tenant.path],
      ] as const) {
        writeFileSync(restored, decryptBackup(file, keyB64));
        // The backup holds the file as it was before the migration; the file itself has moved on.
        expect(hasMigrationTable(restored)).toBe(false);
        expect(hasMigrationTable(original)).toBe(true);
        rmSync(restored, { force: true });
      }
      control.close();
    });

    it("does not back up when no migration is pending", async () => {
      const { control, register, deps, outDir } = withBackup();
      const tenant = register();
      for (const path of [tenant.path, deps.personalPath]) {
        const db = createDatabase(path);
        runMigrations(db);
        db.close();
      }

      const result = await migrateAll(deps);

      expect(result.failed).toEqual([]);
      expect(existsSync(outDir)).toBe(false);
      control.close();
    });

    it("does not back up a file that did not exist yet", async () => {
      const { control, deps, outDir } = withBackup();
      rmSync(deps.personalPath);
      const result = await migrateAll(deps);
      expect(result.migrated).toEqual(["personal"]);
      expect(existsSync(outDir)).toBe(false);
      control.close();
    });

    it("does not migrate a tenant whose backup failed, logs it, and still serves the others", async () => {
      const { control, register, deps, folder, errors } = withBackup();
      const bad = register();
      const good = register();
      createDatabase(bad.path).close();
      createDatabase(good.path).close();
      blockPath(join(folder, `${baseName(bad.path)}.db.enc`));

      const result = await migrateAll(deps);

      expect(result.failed.map((f) => f.registrationId)).toEqual([bad.id]);
      expect(result.migrated).toEqual(["personal", good.id]);
      expect(hasMigrationTable(bad.path)).toBe(false);
      expect(hasMigrationTable(good.path)).toBe(true);
      expect(errors).toContain("context migration failed");
      control.close();
    });

    it("does not migrate the personal file when its backup failed", async () => {
      const { control, deps, folder } = withBackup();
      blockPath(join(folder, "personal.db.enc"));
      const result = await migrateAll(deps);
      expect(result.failed.map((f) => f.registrationId)).toEqual(["personal"]);
      expect(hasMigrationTable(deps.personalPath)).toBe(false);
      control.close();
    });
  });
});
