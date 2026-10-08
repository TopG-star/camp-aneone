import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb, type ControlDb } from "./open-control-db.js";
import { SqliteIdentityRepository } from "./identity-repository.js";
import { backfillIdentities } from "./backfill-identities.js";
import { createDatabase, runMigrations } from "../connection.js";
import type { PersonalDb } from "@oneon/domain";

describe("identity repository and backfill", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    dirs.push(dir);
    const control: ControlDb = openControlDb(join(dir, "control.db"));
    const raw = createDatabase(join(dir, "personal.db"));
    runMigrations(raw);
    closers.push(() => control.close(), () => raw.close());
    const personal: PersonalDb = { kind: "personal", raw, __brand: "PersonalDb" };
    return { control, raw, personal, repo: new SqliteIdentityRepository(control) };
  }

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("backfill creates one identity per user with the same id", () => {
    const { control, raw, personal } = setup();
    raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@x.com'), ('u2', 'b@x.com')").run();

    expect(backfillIdentities(personal, control)).toBe(2);

    const ids = control.prepare("SELECT id FROM identities ORDER BY id").all();
    expect(ids).toEqual([{ id: "u1" }, { id: "u2" }]);
    const login = control.prepare("SELECT kind, subject, email FROM login_identities WHERE identity_id = 'u1'").get();
    expect(login).toEqual({ kind: "google", subject: "email:a@x.com", email: "a@x.com" });
  });

  it("backfill is idempotent", () => {
    const { control, raw, personal } = setup();
    raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@x.com')").run();

    expect(backfillIdentities(personal, control)).toBe(1);
    expect(backfillIdentities(personal, control)).toBe(0);
    expect(control.prepare("SELECT COUNT(*) AS n FROM identities").get()).toEqual({ n: 1 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM login_identities").get()).toEqual({ n: 1 });
  });

  it("attaches the Google sub by email exactly once", () => {
    const { control, raw, personal, repo } = setup();
    raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@x.com')").run();
    backfillIdentities(personal, control);

    expect(repo.attachGoogleSubByEmailOnce("a@x.com", "sub-1")).toEqual({ id: "u1", status: "active" });
    expect(repo.attachGoogleSubByEmailOnce("a@x.com", "sub-2")).toBeNull();
    expect(repo.findByLogin("google", "sub-1")).toEqual({ id: "u1", status: "active" });
    expect(repo.findByLogin("google", "sub-2")).toBeNull();
  });

  it("findByLogin ignores email", () => {
    const { repo } = setup();
    repo.createWithLogin({ kind: "google", subject: "sub-9", email: "a@x" });

    expect(repo.findByLogin("google", "a@x")).toBeNull();
    expect(repo.findByLogin("google", "sub-9")).not.toBeNull();
  });

  it("createWithLogin uses the given id and generates one otherwise", () => {
    const { repo } = setup();
    expect(repo.createWithLogin({ kind: "google", subject: "s1", id: "fixed" }).id).toBe("fixed");
    expect(repo.createWithLogin({ kind: "google", subject: "s2" }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("linkLogin moves a login identity and records the link event", () => {
    const { control, repo } = setup();
    const a = repo.createWithLogin({ kind: "google", subject: "s1" });
    const b = repo.createWithLogin({ kind: "impressorx", subject: "irx-1" });
    const loginId = (control.prepare("SELECT id FROM login_identities WHERE identity_id = ?").get(b.id) as { id: string }).id;

    repo.linkLogin(a.id, loginId, a.id);

    expect(repo.findByLogin("impressorx", "irx-1")).toEqual(a);
    expect(control.prepare("SELECT event, identity_id, actor_identity_id FROM identity_link_events").all()).toEqual([
      { event: "link", identity_id: a.id, actor_identity_id: a.id },
    ]);
    expect(() => repo.linkLogin(a.id, "missing", a.id)).toThrow();
  });

  it("lists memberships of an identity", () => {
    const { control, repo } = setup();
    const a = repo.createWithLogin({ kind: "google", subject: "s1" });
    control
      .prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('r1', 't1', 'slug', 'Name', 'https://x', 'f.db', 'active', ?, 'now')",
      )
      .run(a.id);
    control
      .prepare(
        "INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES ('m1', ?, 'r1', 'ext', 'manager', ?, ?, 'active', 'snap', 'now')",
      )
      .run(a.id, JSON.stringify(["a", "b"]), JSON.stringify(["l1"]));

    expect(repo.listMemberships(a.id)).toEqual([
      {
        id: "m1",
        identityId: a.id,
        tenantRegistrationId: "r1",
        externalUserId: "ext",
        role: "manager",
        permissions: ["a", "b"],
        locationIds: ["l1"],
        status: "active",
        snapshotAt: "snap",
      },
    ]);
  });
});
