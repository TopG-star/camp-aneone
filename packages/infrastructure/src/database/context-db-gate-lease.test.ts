import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContextDbGate, TenantRefusedError, rawDb } from "./context-db-gate.js";
import { createDatabase, latestMigrationVersion } from "./connection.js";
import { openControlDb } from "./control/open-control-db.js";

const NOW = "2026-10-08T00:00:00.000Z";

describe("ContextDbGate leases", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(cacheSize: number) {
    const dir = mkdtempSync(join(tmpdir(), "lease-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants"), cacheSize });
    closers.push(() => gate.close(), () => control.close());
    let n = 0;
    const register = () => {
      n += 1;
      control
        .prepare(
          "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'P', 'https://x.example', ?, 'active', 'op', ?)",
        )
        .run(`reg-${n}`, `t-${n}`, `s-${n}`, `${randomUUID()}.db`, NOW);
      gate.createTenantFile(`reg-${n}`, `t-${n}`);
      return `reg-${n}`;
    };
    const setStatus = (id: string, status: string) => control.prepare("UPDATE tenant_registrations SET status = ? WHERE id = ?").run(status, id);
    const pathOf = (id: string) =>
      join(dir, "tenants", (control.prepare("SELECT file_name FROM tenant_registrations WHERE id = ?").get(id) as { file_name: string }).file_name);
    return { gate, control, register, setStatus, pathOf };
  }

  const refusal = (fn: () => unknown): string | null => {
    try {
      fn();
    } catch (error) {
      return error instanceof TenantRefusedError ? error.code : String(error);
    }
    return null;
  };

  it("never evicts a leased entry; the cache stays over its size while every entry is leased", () => {
    const { gate, register } = setup(1);
    const a = register();
    const b = register();
    const c = register();
    const leases = [gate.lease(a), gate.lease(b), gate.lease(c)];
    for (const lease of leases) expect(rawDb(lease.db).open).toBe(true);
    expect(gate.lease(a).db).toBe(leases[0]!.db);
  });

  it("closes an unleased entry the LRU evicts at once, with no timer", () => {
    vi.useFakeTimers();
    const { gate, register } = setup(1);
    const first = gate.withTenant(register(), (db) => db);
    expect(rawDb(first).open).toBe(true); // unleased but still cached
    gate.withTenant(register(), () => undefined);
    expect(rawDb(first).open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("LRU churn never closes a handle a lease still holds, and starts no timer", () => {
    vi.useFakeTimers();
    const { gate, register } = setup(1);
    const lease = gate.lease(register());
    gate.withTenant(register(), () => undefined);
    gate.withTenant(register(), () => undefined);
    expect(rawDb(lease.db).open).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    lease.release();
    expect(rawDb(lease.db).open).toBe(true); // back at its size of 1: still cached
  });

  it("an over-size cache is trimmed as leases end, least recently used first", () => {
    const { gate, register } = setup(1);
    const a = gate.lease(register());
    const b = gate.lease(register());
    const c = gate.lease(register());
    a.release();
    expect(rawDb(a.db).open).toBe(false);
    expect(rawDb(b.db).open).toBe(true);
    b.release();
    expect(rawDb(b.db).open).toBe(false);
    expect(rawDb(c.db).open).toBe(true); // the cache is back to its size of 1
    c.release();
    expect(rawDb(c.db).open).toBe(true);
  });

  it("a suspension refuses new leases at once and closes a leased handle on the last release", () => {
    const { gate, control, register } = setup(4);
    const a = register();
    const one = gate.lease(a);
    const two = gate.lease(a);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
    expect(() => gate.lease(a)).toThrow(TenantRefusedError);
    expect(() => gate.withTenant(a, () => undefined)).toThrow(TenantRefusedError);
    expect(rawDb(one.db).open).toBe(true);
    one.release();
    one.release(); // idempotent: must not release the second lease
    expect(rawDb(two.db).open).toBe(true);
    two.release();
    expect(rawDb(two.db).open).toBe(false);
  });

  it("a suspension closes an unleased handle at once", () => {
    const { gate, control, register } = setup(4);
    const a = register();
    const db = gate.withTenant(a, (d) => d);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
    expect(() => gate.lease(a)).toThrow(TenantRefusedError);
    expect(rawDb(db).open).toBe(false);
  });

  it("detach closes an unleased handle at once, with no later lease attempt", () => {
    const { gate, register } = setup(4);
    const a = register();
    const db = gate.withTenant(a, (d) => d);
    expect(rawDb(db).open).toBe(true);
    gate.detach(a);
    expect(rawDb(db).open).toBe(false);
  });

  it("detach on a leased handle closes it at the last release, with no lease attempt in between", () => {
    const { gate, control, register } = setup(4);
    const a = register();
    const one = gate.lease(a);
    const two = gate.lease(a);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
    gate.detach(a);
    expect(rawDb(one.db).open).toBe(true);
    one.release();
    expect(rawDb(two.db).open).toBe(true);
    two.release();
    expect(rawDb(two.db).open).toBe(false);
  });

  it("detach of a registration with no open handle does nothing", () => {
    const { gate, register } = setup(4);
    expect(() => gate.detach(register())).not.toThrow();
  });

  it("close() closes everything at once: leased, cached and suspended-while-leased", () => {
    const { gate, control, register } = setup(1);
    const cached = gate.withTenant(register(), (d) => d);
    const b = register();
    const leased = gate.lease(b);
    const c = register();
    const suspended = gate.lease(c);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(c);
    expect(() => gate.lease(c)).toThrow(TenantRefusedError);
    gate.close();
    expect(rawDb(cached).open).toBe(false);
    expect(rawDb(leased.db).open).toBe(false);
    expect(rawDb(suspended.db).open).toBe(false);
    leased.release(); // after close: harmless
  });

  describe("withTenant", () => {
    it("holds the lease while a sync function runs and releases it after", () => {
      const { gate, control, register } = setup(4);
      const a = register();
      let inside = false;
      const result = gate.withTenant(a, (db) => {
        // Suspend mid-use: the handle must survive until the function returns.
        control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
        expect(() => gate.lease(a)).toThrow(TenantRefusedError);
        inside = rawDb(db).open;
        return db;
      });
      expect(inside).toBe(true);
      expect(rawDb(result).open).toBe(false);
    });

    it("releases when a sync function throws", () => {
      const { gate, control, register } = setup(4);
      const a = register();
      let captured: ReturnType<typeof gate.lease>["db"] | undefined;
      expect(() =>
        gate.withTenant(a, (db) => {
          captured = db;
          control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
          expect(() => gate.lease(a)).toThrow(TenantRefusedError); // the refusal detaches the entry: it now closes only on release
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(rawDb(captured!).open).toBe(false);
    });

    it("holds the lease across an async function and releases on resolve", async () => {
      const { gate, control, register } = setup(4);
      const a = register();
      let openDuring = false;
      const db = await gate.withTenant(a, async (handle) => {
        control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
        expect(() => gate.lease(a)).toThrow(TenantRefusedError);
        await new Promise((resolve) => setTimeout(resolve, 5));
        openDuring = rawDb(handle).open;
        return handle;
      });
      expect(openDuring).toBe(true);
      expect(rawDb(db).open).toBe(false);
    });

    it("releases when an async function rejects, and passes the rejection on", async () => {
      const { gate, control, register } = setup(4);
      const a = register();
      let captured: ReturnType<typeof gate.lease>["db"] | undefined;
      await expect(
        gate.withTenant(a, async (db) => {
          captured = db;
          control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
          expect(() => gate.lease(a)).toThrow(TenantRefusedError); // the refusal detaches the entry: it now closes only on release
          throw new Error("async boom");
        }),
      ).rejects.toThrow("async boom");
      expect(rawDb(captured!).open).toBe(false);
    });
  });

  describe("leaseForMaintenance (owner decision D5: backups and Resume's migration only)", () => {
    it("opens an active or an operator-suspended pharmacy; lease() still refuses the suspended one", () => {
      const { gate, register, setStatus } = setup(4);
      const active = register();
      const suspended = register();
      setStatus(suspended, "suspended_by_operator");

      const a = gate.leaseForMaintenance(active);
      const s = gate.leaseForMaintenance(suspended);

      expect(a.db.tenantId).toBe("t-1");
      expect(s.db.tenantId).toBe("t-2");
      expect(refusal(() => gate.lease(suspended))).toBe("tenant_unavailable");
      a.release();
      s.release();
    });

    it("refuses a removed or tenant-disabled pharmacy, and an unknown one", () => {
      const { gate, register, setStatus } = setup(4);
      const removed = register();
      const disabled = register();
      setStatus(removed, "removed");
      setStatus(disabled, "disabled_by_tenant");
      expect(refusal(() => gate.leaseForMaintenance(removed))).toBe("tenant_unavailable");
      expect(refusal(() => gate.leaseForMaintenance(disabled))).toBe("tenant_unavailable");
      expect(refusal(() => gate.leaseForMaintenance("nope"))).toBe("tenant_unavailable");
    });

    it("follows lease()'s rules: never evicted while held, released once, a detach closes it at the last release", () => {
      const { gate, register, setStatus } = setup(1);
      const a = register();
      setStatus(a, "suspended_by_operator");
      const one = gate.leaseForMaintenance(a);
      const two = gate.leaseForMaintenance(a);
      expect(two.db).toBe(one.db);
      gate.withTenant(register(), () => undefined); // LRU pressure: the held entry stays open
      expect(rawDb(one.db).open).toBe(true);
      gate.detach(a);
      one.release();
      one.release(); // idempotent
      expect(rawDb(two.db).open).toBe(true);
      two.release();
      expect(rawDb(two.db).open).toBe(false);
    });

    it("a suspended pharmacy's file is not kept open: it closes when its last maintenance lease ends, and lease() never gets it", () => {
      const { gate, register, setStatus } = setup(4);
      const a = register();
      setStatus(a, "suspended_by_operator");
      const one = gate.leaseForMaintenance(a);
      expect(rawDb(one.db).open).toBe(true);
      one.release();
      expect(rawDb(one.db).open).toBe(false); // with no lease() attempt in between
      expect(refusal(() => gate.lease(a))).toBe("tenant_unavailable");
      const again = gate.leaseForMaintenance(a);
      expect(rawDb(again.db).open).toBe(true);
      again.release();
    });

    it("an active pharmacy's maintenance lease uses the cache like lease()", () => {
      const { gate, register } = setup(4);
      const a = register();
      const m = gate.leaseForMaintenance(a);
      const l = gate.lease(a);
      expect(l.db).toBe(m.db);
      m.release();
      l.release();
      expect(rawDb(m.db).open).toBe(true); // cached, as after any lease
    });

    it("a backup that arrives while the migration holds a file that is behind is refused, not handed the unmigrated file", () => {
      const { gate, register, setStatus, pathOf } = setup(4);
      const a = register();
      setStatus(a, "suspended_by_operator");
      const conn = createDatabase(pathOf(a));
      conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latestMigrationVersion());
      conn.close();
      const migration = gate.leaseForMaintenance(a, { allowSchemaBehind: true });
      expect(refusal(() => gate.leaseForMaintenance(a))).toBe("tenant_schema_behind");
      // Once migrated on that connection, the same handle is shared.
      rawDb(migration.db).prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'again')").run(latestMigrationVersion());
      const backup = gate.leaseForMaintenance(a);
      expect(backup.db).toBe(migration.db);
      migration.release();
      expect(rawDb(backup.db).open).toBe(true);
      backup.release();
      expect(rawDb(backup.db).open).toBe(false);
    });

    it("refuses a missing file, a file of another tenant and a schema that is behind, like lease()", () => {
      const { gate, register, setStatus, pathOf } = setup(4);
      const behind = register();
      setStatus(behind, "suspended_by_operator");
      const conn = createDatabase(pathOf(behind));
      conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latestMigrationVersion());
      conn.close();
      expect(refusal(() => gate.leaseForMaintenance(behind))).toBe("tenant_schema_behind");

      const missing = register();
      rmSync(pathOf(missing));
      expect(refusal(() => gate.leaseForMaintenance(missing))).toBe("tenant_file_missing");
    });

    it("with allowSchemaBehind opens a file that is behind for migration, without caching it: it closes at the release", () => {
      const { gate, register, setStatus, pathOf } = setup(4);
      const a = register();
      setStatus(a, "suspended_by_operator");
      const conn = createDatabase(pathOf(a));
      conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latestMigrationVersion());
      conn.close();

      const lease = gate.leaseForMaintenance(a, { allowSchemaBehind: true });
      expect(lease.db.tenantId).toBe("t-1");
      lease.release();
      expect(rawDb(lease.db).open).toBe(false);
      // Nothing behind was cached: an active registration's next lease checks the file again.
      setStatus(a, "active");
      expect(refusal(() => gate.lease(a))).toBe("tenant_schema_behind");
    });

    it("with allowSchemaBehind still refuses a file that names another tenant", () => {
      const { gate, control, register } = setup(4);
      const a = register();
      const b = register();
      gate.close();
      control.prepare("UPDATE tenant_registrations SET file_name = (SELECT file_name FROM tenant_registrations WHERE id = ?) WHERE id = ?").run(a, b);
      expect(refusal(() => gate.leaseForMaintenance(b, { allowSchemaBehind: true }))).toBe("tenant_unavailable");
    });
  });

  it("createTenantFile leaves no open handle behind and returns none", () => {
    const { gate, control } = setup(4);
    control
      .prepare(
        "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), 'fresh', 't-fresh', 's-fresh', 'P', 'https://x.example', ?, 'active', 'op', ?)",
      )
      .run(`${randomUUID()}.db`, NOW);
    expect(gate.createTenantFile("fresh", "t-fresh")).toBeUndefined();
    const db = gate.withTenant("fresh", (d) => d);
    expect(db.tenantId).toBe("t-fresh"); // the file is real and opens through a lease
  });
});
