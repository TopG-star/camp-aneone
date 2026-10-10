import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, latestMigrationVersion, runMigrations } from "../connection.js";
import { ContextDbGate, TenantRefusedError, rawDb } from "../context-db-gate.js";
import { migrateAll } from "../migrate-all.js";
import { openControlDb } from "../control/open-control-db.js";

/** Applies migrations 001–016 only, by marking 017 as applied for the first run and then taking the marker back. */
function databaseAt016() {
  const db = createDatabase(":memory:");
  db.exec(`
    CREATE TABLE schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO schema_migrations (version, name) VALUES (17, 'link_ids');
  `);
  runMigrations(db);
  db.prepare("DELETE FROM schema_migrations WHERE version = 17").run();
  return db;
}

const columns = (db: ReturnType<typeof createDatabase>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe("Migration 017 over a database that already holds audit and action rows", () => {
  it("adds the link columns, leaves old rows null, and keeps the audit append-only", () => {
    const db = databaseAt016();
    expect(columns(db, "model_call_decisions")).not.toContain("turn_id");
    db.prepare("INSERT INTO users (id, email) VALUES ('u1', 'u1@test.com')").run();
    db.prepare(
      `INSERT INTO model_call_decisions (id, call_id, created_at, context_kind, identity_id, purpose, provider, layers_json, decision, released_json, withheld_json,
         placeholder_count, scanner_d3, scanner_d4, alert, policy_fingerprint, key_version)
       VALUES ('d1', 'c1', '2026-10-01T00:00:00Z', 'personal', 'u1', 'chat_reply', 'deepseek', '{}', 'allow', '[]', '[]', 0, 0, 0, 0, 'p', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO action_instances (id, scope, owner_id, user_id, action_type, definition_version, status, initiator, input_json, idempotency_key, created_at, updated_at)
       VALUES ('a1', 'personal', 'u1', 'u1', 'notify', '1', 'proposed', 'user', '{}', 'k', 'now', 'now')`,
    ).run();

    runMigrations(db);

    expect(columns(db, "model_call_decisions")).toEqual(expect.arrayContaining(["conversation_id", "turn_id"]));
    expect(columns(db, "action_instances")).toContain("model_call_id");
    expect(db.prepare("SELECT conversation_id, turn_id FROM model_call_decisions WHERE id = 'd1'").get()).toEqual({ conversation_id: null, turn_id: null });
    expect(db.prepare("SELECT model_call_id FROM action_instances WHERE id = 'a1'").get()).toEqual({ model_call_id: null });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 17").get()).toEqual({ version: 17 });
    expect(() => db.prepare("UPDATE model_call_decisions SET turn_id = 'x'").run()).toThrow("model_call_decisions is append-only");
    expect(() => db.prepare("DELETE FROM model_call_decisions").run()).toThrow("model_call_decisions is append-only");
    db.close();
  });
});

describe("Migration 017 on a tenant file", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) {
      try { close(); } catch { /* already closed */ }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a tenant file left at 016 is refused as behind, then served once migrated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "link-ids-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const NOW = "2026-10-08T00:00:00.000Z";
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    const tenantDir = join(dir, "tenants");
    const fileName = `${randomUUID()}.db`;
    control
      .prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('reg-1', 'tenant-1', 's', 'P', 'https://x.example', ?, 'active', 'op', ?)",
      )
      .run(fileName, NOW);
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir });
    closers.push(() => gate.close(), () => control.close());
    gate.createTenantFile("reg-1", "tenant-1");
    gate.close();

    // Take the file back to 016: no link columns, no 017 marker, a context_meta that says so.
    const old = createDatabase(join(tenantDir, fileName));
    old.exec("ALTER TABLE model_call_decisions DROP COLUMN conversation_id; ALTER TABLE model_call_decisions DROP COLUMN turn_id; ALTER TABLE action_instances DROP COLUMN model_call_id;");
    old.prepare("DELETE FROM schema_migrations WHERE version = 17").run();
    old.prepare("UPDATE context_meta SET schema_version = 16").run();
    old.close();

    let code: string | null = null;
    try {
      gate.openTenant("reg-1");
    } catch (error) {
      code = error instanceof TenantRefusedError ? error.code : String(error);
    }
    expect(code).toBe("tenant_schema_behind");

    const result = await migrateAll({ control, personalPath: join(dir, "personal.db"), tenantDir, lockPath: join(dir, "migrate.lock"), logger: { info() {}, warn() {}, error() {}, debug() {} } });
    expect(result.failed).toEqual([]);
    expect(result.migrated).toEqual(["personal", "reg-1"]);

    const raw = rawDb(gate.openTenant("reg-1"));
    expect(columns(raw, "model_call_decisions")).toEqual(expect.arrayContaining(["conversation_id", "turn_id"]));
    expect(columns(raw, "action_instances")).toContain("model_call_id");
    expect(raw.prepare("SELECT schema_version FROM context_meta").get()).toEqual({ schema_version: latestMigrationVersion() });
  });
});
