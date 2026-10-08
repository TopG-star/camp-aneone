import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb, type ControlDb } from "./open-control-db.js";

const TABLES = [
  "identities", "login_identities", "memberships", "platform_operators",
  "channel_identities", "identity_link_events", "tenant_registrations",
  "tenant_registration_events", "delegation_grants", "tenant_ai_limit_versions",
  "tenant_rollups", "used_handoff_jti",
];

const NOW = "2026-10-08T00:00:00.000Z";

describe("control database schema", () => {
  const dirs: string[] = [];
  const dbs: ControlDb[] = [];

  function open(): ControlDb {
    const dir = mkdtempSync(join(tmpdir(), "control-"));
    dirs.push(dir);
    const db = openControlDb(join(dir, "control.db"));
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seed(db: ControlDb) {
    db.prepare("INSERT INTO identities (id, status, created_at) VALUES ('i1', 'active', ?)").run(NOW);
    db.prepare(
      `INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin,
         deployment_public_keys, oneon_key_id, file_name, status, enrolled_by, enrolled_at)
       VALUES ('r1', 't1', 'acme', 'Acme', 'https://acme.example', '[]', 'k1', 't1.db', 'active', 'i1', ?)`,
    ).run(NOW);
  }

  it("creates every control table", () => {
    const db = open();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  it("append-only tables refuse UPDATE and DELETE", () => {
    const db = open();
    seed(db);
    db.prepare("INSERT INTO platform_operators (id, identity_id, action, actor_id, created_at) VALUES ('p1', 'i1', 'grant', NULL, ?)").run(NOW);
    db.prepare("INSERT INTO identity_link_events (id, identity_id, event, created_at) VALUES ('l1', 'i1', 'link', ?)").run(NOW);
    db.prepare("INSERT INTO tenant_registration_events (id, tenant_registration_id, event, created_at) VALUES ('e1', 'r1', 'enrolled', ?)").run(NOW);
    db.prepare("INSERT INTO tenant_ai_limit_versions (id, tenant_registration_id, max_class, set_by, created_at) VALUES ('v1', 'r1', 'D1', 'i1', ?)").run(NOW);

    const rows: Array<[string, string]> = [
      ["platform_operators", "p1"], ["identity_link_events", "l1"],
      ["tenant_registration_events", "e1"], ["tenant_ai_limit_versions", "v1"],
    ];
    for (const [table, id] of rows) {
      expect(() => db.prepare(`UPDATE ${table} SET created_at = 'x' WHERE id = ?`).run(id)).toThrow(`${table} is append-only`);
      expect(() => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)).toThrow(`${table} is append-only`);
    }
  });

  it("login_identities is unique per kind and subject", () => {
    const db = open();
    seed(db);
    const insert = db.prepare("INSERT INTO login_identities (id, identity_id, kind, subject, created_at) VALUES (?, 'i1', 'google', 'sub-1', ?)");
    insert.run("a", NOW);
    expect(() => insert.run("b", NOW)).toThrow(/UNIQUE constraint failed/);
  });

  it("memberships and used_handoff_jti enforce their unique keys", () => {
    const db = open();
    seed(db);
    const member = db.prepare("INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES (?, 'i1', 'r1', 'u1', 'staff', '[]', '[]', 'active', ?, ?)");
    member.run("m1", NOW, NOW);
    expect(() => member.run("m2", NOW, NOW)).toThrow(/UNIQUE constraint failed/);
    const jti = db.prepare("INSERT INTO used_handoff_jti (jti, expires_at, used_at) VALUES ('j1', ?, ?)");
    jti.run(NOW, NOW);
    expect(() => jti.run(NOW, NOW)).toThrow(/UNIQUE constraint failed/);
  });
});
