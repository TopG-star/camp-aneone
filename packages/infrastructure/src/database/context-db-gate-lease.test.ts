import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContextDbGate, EVICTION_GRACE_MS, TenantRefusedError, rawDb } from "./context-db-gate.js";
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
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'P', 'https://x.example', ?, 'active', 'op', ?)",
        )
        .run(`reg-${n}`, `t-${n}`, `s-${n}`, `${randomUUID()}.db`, NOW);
      gate.createTenantFile(`reg-${n}`, `t-${n}`);
      return `reg-${n}`;
    };
    return { gate, control, register };
  }

  it("never evicts a leased entry; the cache may exceed its size while leased", () => {
    vi.useFakeTimers();
    const { gate, register } = setup(1);
    const a = register();
    const lease = gate.lease(a);
    register();
    register();
    vi.advanceTimersByTime(EVICTION_GRACE_MS * 2);
    expect(rawDb(lease.db).open).toBe(true);
    expect(gate.openTenant(a)).toBe(lease.db);
  });

  it("closes an unleased handle the LRU evicted only after the grace period", () => {
    vi.useFakeTimers();
    const { gate, register } = setup(1);
    const first = gate.openTenant(register());
    register();
    expect(rawDb(first).open).toBe(true);
    vi.advanceTimersByTime(EVICTION_GRACE_MS - 1);
    expect(rawDb(first).open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(rawDb(first).open).toBe(false);
  });

  it("a suspension refuses new opens at once but defers the close of a leased handle to the last release", () => {
    const { gate, control, register } = setup(4);
    const a = register();
    const one = gate.lease(a);
    const two = gate.lease(a);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
    expect(() => gate.openTenant(a)).toThrow(TenantRefusedError);
    expect(() => gate.lease(a)).toThrow(TenantRefusedError);
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
    const db = gate.openTenant(a);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(a);
    expect(() => gate.openTenant(a)).toThrow(TenantRefusedError);
    expect(rawDb(db).open).toBe(false);
  });

  it("close() closes everything at once: leased, cached and awaiting grace", () => {
    vi.useFakeTimers();
    const { gate, register } = setup(1);
    const graced = gate.openTenant(register());
    const b = register();
    const leased = gate.lease(b);
    register(); // pushes `graced` out of the cache, keeps leased b
    gate.close();
    expect(rawDb(graced).open).toBe(false);
    expect(rawDb(leased.db).open).toBe(false);
    leased.release(); // after close: harmless
  });
});
