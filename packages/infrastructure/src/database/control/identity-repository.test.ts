import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openControlDb, type ControlDb } from "./open-control-db.js";
import { SqliteIdentityRepository } from "./identity-repository.js";
import { ContextDbGate, ensureIdentityAnchor, rawDb } from "../context-db-gate.js";
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

  it("never resolves the backfill marker namespace as a subject, and never attaches one as a sub", () => {
    const { control, raw, personal, repo } = setup();
    raw.prepare("INSERT INTO users (id, email) VALUES ('u1', 'a@x.com')").run();
    backfillIdentities(personal, control);

    expect(repo.findByLogin("google", "email:a@x.com")).toBeNull();
    expect(repo.attachGoogleSubByEmailOnce("a@x.com", "email:b@x.com")).toBeNull();
    expect(control.prepare("SELECT subject FROM login_identities").get()).toEqual({ subject: "email:a@x.com" });
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

describe("ensureIdentityForUser", () => {
  it("is idempotent, and a user added after backfill resolves by sub to its users.id", async () => {
    const { ensureIdentityForUser } = await import("./ensure-identity.js");
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    const control = openControlDb(join(dir, "control.db"));
    try {
      const repo = new SqliteIdentityRepository(control);
      expect(ensureIdentityForUser(control, { id: "late", email: "late@x.com" })).toBe(true);
      expect(ensureIdentityForUser(control, { id: "late", email: "late@x.com" })).toBe(false);
      expect(repo.attachGoogleSubByEmailOnce("late@x.com", "sub-late")).toEqual({ id: "late", status: "active" });
    } finally {
      control.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("linking identities", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const NOW = "2026-10-08T10:00:00.000Z";

  // A Google identity (the target), an ImpressoRx-only identity with a login at pharmacy A and one at B, a colleague
  // who shares the pharmacy files, and tenant rows of every kind a merge touches or must leave alone.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "link-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => control.close(), () => gate.close());
    const repo = new SqliteIdentityRepository(control, (registrationId) => gate.openTenant(registrationId));

    const google = repo.createWithLogin({ kind: "google", subject: "g-sub", email: "gerry@x.com" });
    const colleague = repo.createWithLogin({ kind: "impressorx", subject: "colleague-login" });

    const registration = () => {
      const id = randomUUID();
      const tenantId = randomUUID();
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'Pharmacy', 'https://p.example', ?, 'active', ?, ?)",
        )
        .run(id, tenantId, `slug-${id.slice(0, 8)}`, `${id}.db`, google.id, NOW);
      gate.createTenantFile(id, tenantId);
      return { id, tenantId };
    };
    const a = registration();
    const b = registration();

    const staff = repo.createWithLogin({ kind: "impressorx", subject: `${a.id}:staff-1` });
    repo.attachLogin(staff.id, { kind: "impressorx", subject: `${b.id}:staff-9` }, staff.id);

    const membership = (identityId: string, reg: { id: string }, externalUserId: string) => {
      const id = randomUUID();
      control
        .prepare(
          "INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES (?, ?, ?, ?, 'manager', '[]', '[]', 'active', ?, ?)",
        )
        .run(id, identityId, reg.id, externalUserId, NOW, NOW);
      return id;
    };
    const staffMembershipA = membership(staff.id, a, "staff-1");
    const staffMembershipB = membership(staff.id, b, "staff-9");
    const colleagueMembershipA = membership(colleague.id, a, "colleague-1");

    const grant = (identityId: string, membershipId: string, reg: { id: string }) => {
      const id = randomUUID();
      control
        .prepare(
          `INSERT INTO delegation_grants (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value,
             wrapped_key, generation, status, session_id, created_at, absolute_expires_at)
           VALUES (?, ?, ?, ?, 'attended', '[]', 'c', 'w', 1, 'active', 's1', ?, '2099-01-01T00:00:00.000Z')`,
        )
        .run(id, identityId, membershipId, reg.id, NOW);
      return id;
    };
    const staffGrantA = grant(staff.id, staffMembershipA, a);
    const colleagueGrantA = grant(colleague.id, colleagueMembershipA, a);

    // Tenant rows in file A (file B gets a conversation only).
    const raw = (reg: { id: string }) => rawDb(gate.openTenant(reg.id));
    const tenantA = raw(a);
    for (const id of [staff.id, colleague.id]) ensureIdentityAnchor(gate.openTenant(a.id), id);
    const conversation = (db: Database.Database, id: string, userId: string, tenantId: string) =>
      db
        .prepare("INSERT INTO conversations (id, role, content, conversation_id, user_id, tenant_id) VALUES (?, 'user', 'hi', 'conv', ?, ?)")
        .run(id, userId, tenantId);
    conversation(tenantA, "c-staff", staff.id, a.tenantId);
    conversation(tenantA, "c-colleague", colleague.id, a.tenantId);
    ensureIdentityAnchor(gate.openTenant(b.id), staff.id);
    conversation(raw(b), "c-staff-b", staff.id, b.tenantId);

    const action = (id: string, userId: string, initiatorUserId: string) =>
      tenantA
        .prepare(
          `INSERT INTO action_instances (id, scope, owner_id, user_id, tenant_id, action_type, definition_version, status, initiator,
             initiator_user_id, input_json, idempotency_key, created_at, updated_at)
           VALUES (?, 'tenant', ?, ?, ?, 'x', '1', 'proposed', 'user', ?, '{}', ?, ?, ?)`,
        )
        .run(id, a.tenantId, userId, a.tenantId, initiatorUserId, id, NOW, NOW);
    action("a-own", staff.id, staff.id);
    action("a-for-colleague", colleague.id, staff.id);
    action("a-colleague", colleague.id, colleague.id);

    // Append-only history that names the old identity.
    tenantA
      .prepare("INSERT INTO action_events (id, action_id, seq, to_status, actor_json, created_at, tenant_id) VALUES ('e1', 'a-own', 1, 'proposed', ?, ?, ?)")
      .run(JSON.stringify({ kind: "user", identityId: staff.id }), NOW, a.tenantId);
    tenantA
      .prepare(
        `INSERT INTO model_call_decisions (id, call_id, created_at, context_kind, identity_id, tenant_id, purpose, provider, layers_json, decision,
           released_json, withheld_json, placeholder_count, scanner_d3, scanner_d4, alert, policy_fingerprint, key_version)
         VALUES ('d1', 'call1', ?, 'tenant', ?, ?, 'chat', 'p', '[]', 'allow', '[]', '[]', 0, 0, 0, 0, 'fp', 1)`,
      )
      .run(NOW, staff.id, a.tenantId);
    tenantA
      .prepare(
        "INSERT INTO model_call_outcomes (call_id, created_at, status, attempts, latency_ms, checks_json, key_version, tenant_id) VALUES ('call1', ?, 'answered', 1, 1, '[]', 1, ?)",
      )
      .run(NOW, a.tenantId);

    return { control, gate, repo, raw, google, staff, colleague, a, b, staffMembershipA, staffMembershipB, colleagueMembershipA, staffGrantA, colleagueGrantA };
  }

  const owners = (db: Database.Database) => ({
    conversations: db.prepare("SELECT id, user_id FROM conversations ORDER BY id").all(),
    actions: db.prepare("SELECT id, user_id, initiator_user_id FROM action_instances ORDER BY id").all(),
  });

  const snapshotOfControl = (control: ControlDb) => ({
    identities: control.prepare("SELECT id, status, merged_into FROM identities ORDER BY id").all(),
    logins: control.prepare("SELECT id, identity_id FROM login_identities ORDER BY id").all(),
    memberships: control.prepare("SELECT id, identity_id FROM memberships ORDER BY id").all(),
    grants: control.prepare("SELECT id, status, revoked_reason FROM delegation_grants ORDER BY id").all(),
    events: control.prepare("SELECT id FROM identity_link_events ORDER BY id").all(),
  });

  it("merges the ImpressoRx identity into the Google identity: logins, memberships, tenant rows, status and a link event", () => {
    const s = setup();

    s.repo.mergeInto(s.staff.id, s.google.id, s.google.id);

    expect(s.repo.findByLogin("impressorx", `${s.a.id}:staff-1`)).toEqual(s.google);
    expect(s.repo.findByLogin("impressorx", `${s.b.id}:staff-9`)).toEqual(s.google);
    expect(s.repo.listMemberships(s.google.id).map((m) => m.id).sort()).toEqual([s.staffMembershipA, s.staffMembershipB].sort());
    expect(s.repo.listMemberships(s.staff.id)).toEqual([]);
    expect(s.control.prepare("SELECT status, merged_into FROM identities WHERE id = ?").get(s.staff.id)).toEqual({ status: "disabled", merged_into: s.google.id });
    expect(s.repo.findById(s.google.id)).toEqual({ id: s.google.id, status: "active" });

    // Tenant file A: the conversations and actions of the old identity now belong to the Google identity; the colleague's stay.
    expect(owners(s.raw(s.a))).toEqual({
      conversations: [
        { id: "c-colleague", user_id: s.colleague.id },
        { id: "c-staff", user_id: s.google.id },
      ],
      actions: [
        { id: "a-colleague", user_id: s.colleague.id, initiator_user_id: s.colleague.id },
        { id: "a-for-colleague", user_id: s.colleague.id, initiator_user_id: s.google.id },
        { id: "a-own", user_id: s.google.id, initiator_user_id: s.google.id },
      ],
    });
    expect(s.raw(s.b).prepare("SELECT user_id FROM conversations").all()).toEqual([{ user_id: s.google.id }]);
    for (const reg of [s.a, s.b]) {
      expect(s.raw(reg).prepare("SELECT email FROM users WHERE id = ?").get(s.google.id)).toEqual({ email: `${s.google.id}@anchor.invalid` });
    }

    const merged = s.control
      .prepare("SELECT identity_id, actor_identity_id, login_identity_id, detail_json FROM identity_link_events WHERE event = 'link' AND detail_json IS NOT NULL")
      .all() as Array<Record<string, string>>;
    expect(merged).toHaveLength(2); // one per moved login
    for (const e of merged) {
      expect(e).toMatchObject({ identity_id: s.google.id, actor_identity_id: s.google.id });
      expect(e.login_identity_id).toBeTruthy();
      expect(JSON.parse(e.detail_json)).toEqual({ mergedFrom: s.staff.id });
    }
  });

  it("append-only rows keep the old identity id", () => {
    const s = setup();

    s.repo.mergeInto(s.staff.id, s.google.id, s.google.id);

    const tenantA = s.raw(s.a);
    expect(tenantA.prepare("SELECT actor_json FROM action_events").get()).toEqual({ actor_json: JSON.stringify({ kind: "user", identityId: s.staff.id }) });
    expect(tenantA.prepare("SELECT identity_id FROM model_call_decisions").get()).toEqual({ identity_id: s.staff.id });
    expect(tenantA.prepare("SELECT status FROM model_call_outcomes").get()).toEqual({ status: "answered" });
  });

  it("revokes every grant of the old identity and leaves other grants alone", () => {
    const s = setup();

    s.repo.mergeInto(s.staff.id, s.google.id, s.google.id);

    const status = (id: string) => s.control.prepare("SELECT status, revoked_reason FROM delegation_grants WHERE id = ?").get(id);
    expect(status(s.staffGrantA)).toEqual({ status: "revoked", revoked_reason: "identity_merged" });
    expect(status(s.colleagueGrantA)).toEqual({ status: "active", revoked_reason: null });
  });

  it("can be repeated after a failure: a tenant file an earlier attempt already updated is not a problem", () => {
    const s = setup();
    s.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(s.b.id);
    expect(() => s.repo.mergeInto(s.staff.id, s.google.id, s.google.id)).toThrow();

    s.control.prepare("UPDATE tenant_registrations SET status = 'active' WHERE id = ?").run(s.b.id);
    s.repo.mergeInto(s.staff.id, s.google.id, s.google.id);

    expect(s.repo.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "disabled" });
    expect(owners(s.raw(s.a)).conversations).toContainEqual({ id: "c-staff", user_id: s.google.id });
    expect(s.raw(s.b).prepare("SELECT user_id FROM conversations").all()).toEqual([{ user_id: s.google.id }]);
  });

  it("leaves the control database unchanged when a tenant file cannot be updated", () => {
    const s = setup();
    s.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(s.b.id);
    const before = snapshotOfControl(s.control);

    expect(() => s.repo.mergeInto(s.staff.id, s.google.id, s.google.id)).toThrow();

    expect(snapshotOfControl(s.control)).toEqual(before);
  });

  it("leaves the control database unchanged when the control transaction fails part-way", () => {
    const s = setup();
    s.control.exec("CREATE TRIGGER boom BEFORE INSERT ON identity_link_events BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const before = snapshotOfControl(s.control);

    expect(() => s.repo.mergeInto(s.staff.id, s.google.id, s.google.id)).toThrow(/boom/);

    expect(snapshotOfControl(s.control)).toEqual(before);
  });

  it("refuses to merge an identity into itself, a missing identity, or a disabled one", () => {
    const s = setup();
    expect(() => s.repo.mergeInto(s.staff.id, s.staff.id, s.google.id)).toThrow();
    expect(() => s.repo.mergeInto("missing", s.google.id, s.google.id)).toThrow();
    s.repo.mergeInto(s.staff.id, s.google.id, s.google.id);
    expect(() => s.repo.mergeInto(s.staff.id, s.google.id, s.google.id)).toThrow();
    expect(() => s.repo.mergeInto(s.colleague.id, s.staff.id, s.google.id)).toThrow();
  });

  it("never links by matching email", () => {
    const s = setup();
    const one = s.repo.createWithLogin({ kind: "google", subject: "g-same", email: "same@x.com" });
    const two = s.repo.createWithLogin({ kind: "impressorx", subject: "irx-same", email: "same@x.com" });
    const before = snapshotOfControl(s.control);

    expect(s.repo.attachGoogleSubByEmailOnce("same@x.com", "g-other")).toBeNull();

    expect(s.repo.findByLogin("impressorx", "irx-same")).toEqual(two);
    expect(s.repo.findByLogin("google", "g-same")).toEqual(one);
    expect(s.repo.findByLogin("google", "g-other")).toBeNull();
    expect(snapshotOfControl(s.control)).toEqual(before);
  });

  it("attaches a new login to an identity and records the link event", () => {
    const s = setup();

    const loginId = s.repo.attachLogin(s.google.id, { kind: "google", subject: "g-second", email: "second@x.com" }, s.google.id);

    expect(s.repo.findByLogin("google", "g-second")).toEqual(s.google);
    expect(s.control.prepare("SELECT identity_id, event, actor_identity_id FROM identity_link_events WHERE login_identity_id = ?").get(loginId)).toEqual({
      identity_id: s.google.id,
      event: "link",
      actor_identity_id: s.google.id,
    });
    expect(() => s.repo.attachLogin(s.google.id, { kind: "google", subject: "g-second" }, s.google.id)).toThrow(/UNIQUE/);
  });

  it("unlink creates a new identity for the detached login and its memberships, and records it", () => {
    const s = setup();
    s.repo.mergeInto(s.staff.id, s.google.id, s.google.id);
    const loginA = (s.control.prepare("SELECT id FROM login_identities WHERE subject = ?").get(`${s.a.id}:staff-1`) as { id: string }).id;
    s.control
      .prepare(
        `INSERT INTO delegation_grants (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value, wrapped_key,
           generation, status, session_id, created_at, absolute_expires_at)
         VALUES ('g-after', ?, ?, ?, 'attended', '[]', 'c', 'w', 1, 'active', 's2', ?, '2099-01-01T00:00:00.000Z')`,
      )
      .run(s.google.id, s.staffMembershipA, s.a.id, NOW);

    const detached = s.repo.unlink(s.google.id, loginA, s.google.id);

    expect(detached.identityId).not.toBe(s.google.id);
    expect(s.repo.findById(detached.identityId)).toEqual({ id: detached.identityId, status: "active" });
    expect(s.repo.findByLogin("impressorx", `${s.a.id}:staff-1`)).toEqual({ id: detached.identityId, status: "active" });
    expect(s.repo.hasLogin(detached.identityId, "google")).toBe(false);
    expect(s.repo.listMemberships(detached.identityId).map((m) => m.id)).toEqual([s.staffMembershipA]);
    // The Google identity keeps its other login and the pharmacy B membership.
    expect(s.repo.hasLogin(s.google.id, "google")).toBe(true);
    expect(s.repo.findByLogin("impressorx", `${s.b.id}:staff-9`)).toEqual(s.google);
    expect(s.repo.listMemberships(s.google.id).map((m) => m.id)).toEqual([s.staffMembershipB]);
    // Earlier conversations stay with the identity they were created under.
    expect(owners(s.raw(s.a)).conversations).toContainEqual({ id: "c-staff", user_id: s.google.id });
    // The moved membership's grant belonged to the old owner.
    expect(s.control.prepare("SELECT status, revoked_reason FROM delegation_grants WHERE id = 'g-after'").get()).toEqual({ status: "revoked", revoked_reason: "identity_unlinked" });
    const event = s.control.prepare("SELECT identity_id, login_identity_id, actor_identity_id, detail_json FROM identity_link_events WHERE event = 'unlink'").get() as Record<string, string>;
    expect(event).toMatchObject({ identity_id: s.google.id, login_identity_id: loginA, actor_identity_id: s.google.id });
    expect(JSON.parse(event.detail_json)).toEqual({ newIdentityId: detached.identityId, membershipIds: [s.staffMembershipA] });
  });

  it("unlink refuses a Google login, the last login of an identity, and a login that is not the caller's", () => {
    const s = setup();
    const loginOf = (subject: string) => (s.control.prepare("SELECT id FROM login_identities WHERE subject = ?").get(subject) as { id: string }).id;
    const googleLogin = loginOf("g-sub");
    const colleagueLogin = loginOf("colleague-login");

    expect(() => s.repo.unlink(s.google.id, googleLogin, s.google.id)).toThrow(expect.objectContaining({ reason: "not_detachable" }));
    expect(() => s.repo.unlink(s.colleague.id, colleagueLogin, s.colleague.id)).toThrow(expect.objectContaining({ reason: "last_login" }));
    expect(() => s.repo.unlink(s.google.id, colleagueLogin, s.google.id)).toThrow(expect.objectContaining({ reason: "login_not_found" }));
    expect(() => s.repo.unlink(s.google.id, "missing", s.google.id)).toThrow(expect.objectContaining({ reason: "login_not_found" }));
    expect(s.repo.findByLogin("impressorx", "colleague-login")).toEqual(s.colleague);
  });
});
