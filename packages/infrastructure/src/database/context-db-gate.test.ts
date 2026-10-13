import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertRowTenant } from "@oneon/domain";
import { createDatabase, latestMigrationVersion, runMigrations } from "./connection.js";
import { ContextDbGate, EVICTION_GRACE_MS, TenantRefusedError, rawDb, ensureIdentityAnchor } from "./context-db-gate.js";
import { openControlDb, type ControlDb } from "./control/open-control-db.js";

const NOW = "2026-10-08T00:00:00.000Z";

describe("ContextDbGate", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  function setup(cacheSize?: number) {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    dirs.push(dir);
    const control: ControlDb = openControlDb(join(dir, "control.db"));
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    const tenantDir = join(dir, "tenants");
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir, cacheSize });
    closers.push(() => gate.close(), () => control.close());
    let n = 0;
    const register = (opts: { status?: string; fileName?: string; tenantId?: string } = {}) => {
      n += 1;
      const id = `reg-${n}`;
      const tenantId = opts.tenantId ?? `tenant-${n}`;
      const fileName = opts.fileName ?? `${randomUUID()}.db`;
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, ?, 'https://x.example', ?, ?, 'op', ?)",
        )
        .run(id, tenantId, `slug-${n}`, `Pharmacy ${n}`, fileName, opts.status ?? "active", NOW);
      return { id, tenantId, fileName, path: join(tenantDir, fileName) };
    };
    return { gate, control, register };
  }

  afterEach(() => {
    for (const close of closers.splice(0)) {
      try { close(); } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const refusal = (fn: () => unknown) => {
    try { fn(); } catch (e) { expect(e).toBeInstanceOf(TenantRefusedError); return (e as TenantRefusedError).code; }
    throw new Error("expected a refusal");
  };

  it("creates a tenant file, then opens it again after the cache is gone", () => {
    const { gate, register } = setup();
    const reg = register();
    const created = gate.createTenantFile(reg.id, reg.tenantId);
    expect(created.kind).toBe("tenant");
    expect(existsSync(reg.path)).toBe(true);
    expect(() => gate.createTenantFile(reg.id, reg.tenantId)).toThrow("tenant_file_exists");
    gate.close();
    expect(gate.openTenant(reg.id).tenantId).toBe(reg.tenantId);
  });

  it("writes the personal context_meta row once", () => {
    const { gate } = setup();
    gate.openPersonal();
    gate.close();
    const personal = gate.openPersonal();
    expect(personal.kind).toBe("personal");
    expect(rawDb(personal).prepare("SELECT kind, tenant_id, schema_version FROM context_meta").all()).toEqual([
      { kind: "personal", tenant_id: null, schema_version: latestMigrationVersion() },
    ]);
  });

  it("openTenant refuses an unknown registration", () => {
    const { gate } = setup();
    expect(refusal(() => gate.openTenant("nope"))).toBe("tenant_unavailable");
  });

  it("openTenant refuses a suspended registration", () => {
    const { gate, register } = setup();
    const reg = register({ status: "suspended_by_operator" });
    expect(refusal(() => gate.openTenant(reg.id))).toBe("tenant_unavailable");
  });

  it("refuses a cached handle once the registration is suspended", () => {
    const { gate, control, register } = setup();
    const reg = register();
    gate.createTenantFile(reg.id, reg.tenantId);
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(reg.id);
    expect(refusal(() => gate.openTenant(reg.id))).toBe("tenant_unavailable");
  });

  it("openTenant refuses a file missing on disk and does not create it", () => {
    const { gate, register } = setup();
    const reg = register();
    expect(refusal(() => gate.openTenant(reg.id))).toBe("tenant_unavailable");
    expect(existsSync(reg.path)).toBe(false);
  });

  it("openTenant refuses a file name outside the pattern", () => {
    const { gate, register } = setup();
    const reg = register({ fileName: "../oneon.db" });
    expect(refusal(() => gate.openTenant(reg.id))).toBe("tenant_unavailable");
  });

  it("openTenant refuses a file whose context_meta names another tenant", () => {
    const { gate, control, register } = setup();
    const a = register();
    const b = register();
    gate.createTenantFile(a.id, a.tenantId);
    gate.createTenantFile(b.id, b.tenantId);
    gate.close();
    // b's registry row now points at a's file.
    control.prepare("UPDATE tenant_registrations SET file_name = ? WHERE id = ?").run(a.fileName, b.id);
    expect(refusal(() => gate.openTenant(b.id))).toBe("tenant_unavailable");
  });

  it("openTenant refuses a file at an old schema version", () => {
    const { gate, register } = setup();
    const reg = register();
    gate.createTenantFile(reg.id, reg.tenantId);
    gate.close();
    const db = createDatabase(reg.path);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latestMigrationVersion());
    db.close();
    expect(refusal(() => gate.openTenant(reg.id))).toBe("tenant_schema_behind");
  });

  it("the cache closes the least recently used handle beyond its size, after a grace period", () => {
    vi.useFakeTimers();
    try {
      const { gate, register } = setup(2);
      const handles = [register(), register(), register()].map((r) => gate.createTenantFile(r.id, r.tenantId));
      expect(rawDb(handles[0]!).open).toBe(true);
      vi.advanceTimersByTime(EVICTION_GRACE_MS);
      expect(rawDb(handles[0]!).open).toBe(false);
      expect(rawDb(handles[1]!).open).toBe(true);
      expect(rawDb(handles[2]!).open).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("anchors an identity in a tenant file", () => {
    const { gate, register } = setup();
    const reg = register();
    const db = gate.createTenantFile(reg.id, reg.tenantId);
    ensureIdentityAnchor(db, "id-1");
    ensureIdentityAnchor(db, "id-1");
    expect(rawDb(db).prepare("SELECT email FROM users WHERE id = 'id-1'").all()).toEqual([{ email: "id-1@anchor.invalid" }]);
  });

  it("assertRowTenant throws tenant_mismatch across contexts", () => {
    const { gate, register } = setup();
    const reg = register();
    const tenant = gate.createTenantFile(reg.id, reg.tenantId);
    const personal = gate.openPersonal();
    expect(() => assertRowTenant(tenant, "other")).toThrow("tenant_mismatch");
    expect(() => assertRowTenant(tenant, null)).toThrow("tenant_mismatch");
    expect(() => assertRowTenant(personal, "t")).toThrow("tenant_mismatch");
    expect(() => assertRowTenant(tenant, reg.tenantId)).not.toThrow();
    expect(() => assertRowTenant(personal, null)).not.toThrow();
  });

  it("migration 016 applies over a database already at 015 with the append-only triggers in place", () => {
    const db = createDatabase(":memory:");
    // Pretend 016 is applied so the first run stops at 015, then roll that marker back.
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
             INSERT INTO schema_migrations (version, name) VALUES (16, 'context_meta_and_tenant_id');`);
    runMigrations(db);
    db.prepare("DELETE FROM schema_migrations WHERE version = 16").run();
    const hasTenantId = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === "tenant_id");
    expect(hasTenantId("conversations")).toBe(false);
    runMigrations(db);
    for (const table of ["conversations", "action_events", "model_call_decisions", "model_call_outcomes"]) {
      expect(hasTenantId(table)).toBe(true);
    }
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 16").get()).toEqual({ version: 16 });
    db.close();
  });
});
