import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "@oneon/domain";
import { createDatabase } from "./connection.js";
import { migrateAll } from "./migrate-all.js";
import { openControlDb } from "./control/open-control-db.js";

const NOW = "2026-10-08T00:00:00.000Z";
const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

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
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'P', 'https://x.example', ?, ?, 'op', ?)",
        )
        .run(`reg-${n}`, `t-${n}`, `s-${n}`, fileName, status, NOW);
      return { id: `reg-${n}`, path: join(tenantDir, fileName) };
    };
    return { control, register, deps: { control, personalPath: join(dir, "personal.db"), tenantDir, lockPath: join(dir, "migrate.lock"), logger } };
  }

  const version = (path: string) => {
    const db = createDatabase(path);
    const v = (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v;
    db.close();
    return v;
  };

  it("migrates personal and every active tenant, and continues past a failing file", () => {
    const { control, register, deps } = setup();
    const good = register();
    const bad = register();
    const suspended = register("suspended_by_operator");
    const missing = register();
    createDatabase(good.path).close();
    writeFileSync(bad.path, "this is not a sqlite database, just text padding".repeat(20));

    const result = migrateAll(deps);

    expect(result.migrated).toEqual(["personal", good.id]);
    expect(result.failed.map((f) => f.registrationId).sort()).toEqual([bad.id, missing.id].sort());
    expect(version(deps.personalPath)).toBe(16);
    expect(version(good.path)).toBe(16);
    expect(existsSync(suspended.path)).toBe(false);
    expect(existsSync(missing.path)).toBe(false);
    expect(existsSync(deps.lockPath)).toBe(false);
    control.close();
  });

  it("refuses to run while the lock file exists", () => {
    const { control, deps } = setup();
    writeFileSync(deps.lockPath, "");
    expect(() => migrateAll(deps)).toThrow();
    expect(existsSync(deps.lockPath)).toBe(true);
    control.close();
  });
});
