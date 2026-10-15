import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb, type ControlDb } from "./open-control-db.js";

const TABLES = [
  "identities", "login_identities", "memberships", "platform_operators",
  "channel_identities", "identity_link_events", "tenant_registrations",
  "tenant_registration_events", "delegation_grants", "tenant_ai_limit_versions",
  "tenant_rollups", "used_handoff_jti", "tenant_keys", "link_intents", "tenant_ai_limit_rechecks",
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
      `INSERT INTO tenant_registrations (id, tenant_id, impressorx_tenant_id, tenant_slug, display_name, origin,
         file_name, status, enrolled_by, enrolled_at)
       VALUES ('r1', 't1', 'irx-r1', 'acme', 'Acme', 'https://acme.example', 't1.db', 'active', 'i1', ?)`,
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

  it("tenant_max_class accepts D0, D1, D2 and rejects D3", () => {
    const db = open();
    seed(db);
    const insert = db.prepare("INSERT INTO tenant_ai_limit_versions (id, tenant_registration_id, max_class, set_by, created_at) VALUES (?, 'r1', ?, 'i1', ?)");
    for (const c of ["D0", "D1", "D2"]) insert.run(`v-${c}`, c, NOW);
    expect(() => insert.run("v-D3", "D3", NOW)).toThrow(/CHECK constraint failed/);
  });

  it("tenant_keys ties private key material to the oneon owner", () => {
    const db = open();
    seed(db);
    const insert = db.prepare("INSERT INTO tenant_keys (id, tenant_registration_id, owner, key_id, public_key_jwk, private_key_wrapped, private_key_ciphertext, created_at) VALUES (?, 'r1', ?, ?, '{}', ?, ?, ?)");
    insert.run("k1", "oneon", "kid-1", "w", "c", NOW);
    insert.run("k2", "deployment", "kid-2", null, null, NOW);
    expect(() => insert.run("k3", "deployment", "kid-3", "w", "c", NOW)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("k4", "oneon", "kid-4", null, null, NOW)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("k5", "oneon", "kid-4", "w", null, NOW)).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("k6", "oneon", "kid-1", "w", "c", NOW)).toThrow(/UNIQUE constraint failed/);
  });

  it("every registration holds an ImpressoRx tenant id: an insert or update that leaves it NULL is refused (owner decision D1)", () => {
    const db = open();
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at)
           VALUES ('r2', 't2', 'beta', 'Beta', 'https://beta.example', 't2.db', 'active', 'i1', ?)`,
        )
        .run(NOW),
    ).toThrow(/impressorx_tenant_id is required/);
    expect(() => db.prepare("UPDATE tenant_registrations SET impressorx_tenant_id = NULL WHERE id = 'r1'").run()).toThrow(
      /impressorx_tenant_id is required/,
    );
    expect(db.prepare("SELECT impressorx_tenant_id FROM tenant_registrations WHERE id = 'r1'").get()).toEqual({ impressorx_tenant_id: "irx-r1" });
  });
});
