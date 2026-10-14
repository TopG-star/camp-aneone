import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContextDbGate, TenantRefusedError, rawDb } from "./context-db-gate.js";
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
    return { gate, control, register };
  }

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
