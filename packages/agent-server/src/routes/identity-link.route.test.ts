import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextDbGate,
  LinkIntentRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  backfillIdentities,
  ensureIdentityAnchor,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import { createTokenAuthMiddleware } from "../middleware/auth.js";
import { requireUser } from "../middleware/require-user.js";
import { createIdentityLinkRouter, createIdentitySessionRouter } from "./identity-link.route.js";

const TOKEN = "service-token";
const NOW = "2026-10-08T10:00:00.000Z";

describe("identity linking routes", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Gerry holds a Google login; Staff came in from ImpressoRx (a login at pharmacy A, a membership, a conversation and a grant).
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "identity-link-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => control.close(), () => gate.close());
    let now = Date.parse(NOW);
    const clock = () => new Date(now);
    const identities = new SqliteIdentityRepository(control, (id) => gate.openTenant(id));
    const intents = new LinkIntentRepository(control, clock);
    const personal = gate.openPersonal();

    const gerry = identities.createWithLogin({ kind: "google", subject: "gerry-sub", email: "gerry@x.com" });
    rawDb(personal).prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(gerry.id, "gerry@x.com");

    const registration = (slug: string) => {
      const id = randomUUID();
      const tenantId = randomUUID();
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, ?, 'https://p.example', ?, 'active', ?, ?)",
        )
        .run(id, tenantId, slug, slug, `${id}.db`, gerry.id, NOW);
      gate.createTenantFile(id, tenantId);
      return { id, tenantId };
    };
    const a = registration("a");
    const b = registration("b");

    const staff = identities.createWithLogin({ kind: "impressorx", subject: `${a.id}:staff-1` });
    const membershipA = randomUUID();
    control
      .prepare(
        "INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES (?, ?, ?, 'staff-1', 'manager', '[]', '[]', 'active', ?, ?)",
      )
      .run(membershipA, staff.id, a.id, NOW, NOW);
    const grantId = randomUUID();
    control
      .prepare(
        `INSERT INTO delegation_grants (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value, wrapped_key,
           generation, status, session_id, created_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, 'attended', '[]', 'c', 'w', 1, 'active', 's1', ?, '2099-01-01T00:00:00.000Z')`,
      )
      .run(grantId, staff.id, membershipA, a.id, NOW);
    ensureIdentityAnchor(gate.openTenant(a.id), staff.id);
    rawDb(gate.openTenant(a.id))
      .prepare("INSERT INTO conversations (id, role, content, conversation_id, user_id, tenant_id) VALUES ('c1', 'user', 'hi', 'conv', ?, ?)")
      .run(staff.id, a.tenantId);

    const ensurePersonalUser = vi.fn((user: { id: string; email: string }) => {
      rawDb(personal).prepare("INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)").run(user.id, user.email);
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    // Session auth has already run: this stands in for it.
    let session: { identityId?: string; handoff?: boolean } = {};
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (session.identityId) {
        req.identityId = session.identityId;
        req.userId = session.identityId;
        if (session.handoff) {
          req.sessionId = "s1";
          req.sessionContext = { kind: "tenant", membershipId: membershipA };
        }
      }
      next();
    });
    // Session proofs the server accepts for the hand-off direction: (session id, identity id, membership id).
    const proofs: Array<[string, string, string]> = [["s1", staff.id, membershipA]];
    const hasAttendedGrant = vi.fn((sessionId: string, identityId: string, membershipId: string) =>
      proofs.some(([s1, i, m]) => s1 === sessionId && i === identityId && m === membershipId),
    );
    const releaseGrants = vi.fn(async (_grantIds: string[]) => undefined);
    const deps = { identities, intents, registrations: new TenantRegistrationRepository(control), ensurePersonalUser, hasAttendedGrant, releaseGrants, logger };
    app.use("/api/identity/link", createTokenAuthMiddleware(TOKEN), createIdentityLinkRouter(deps));
    app.use("/api/identity", requireUser, createIdentitySessionRouter(deps));

    const asSession = (identityId: string | undefined, handoff = false) => void (session = { identityId, handoff });
    const startIntent = async (identityId: string, handoff = false) => {
      asSession(identityId, handoff);
      const res = await request(app).post("/api/identity/link-intent").send({});
      expect(res.status).toBe(200);
      return res.body as { linkIntentId: string; secret: string; next: string };
    };
    const link = (body: Record<string, unknown>, token: string | null = TOKEN) => {
      const req = request(app).post("/api/identity/link");
      return (token ? req.set("Authorization", `Bearer ${token}`) : req).send(body);
    };
    const googleLogin = (subject = "gerry-sub", email = "gerry@x.com") => ({ kind: "google", subject, email });
    const impressorxLogin = (over: Record<string, unknown> = {}) => ({ kind: "impressorx", identityId: staff.id, sessionId: "s1", membershipId: membershipA, ...over });
    const preview = (body: Record<string, unknown>, token: string | null = TOKEN) => {
      const req = request(app).post("/api/identity/link/preview");
      return (token ? req.set("Authorization", `Bearer ${token}`) : req).send(body);
    };
    const intentUsed = (id: string) => (control.prepare("SELECT used_at FROM link_intents WHERE id = ?").get(id) as { used_at: string | null }).used_at !== null;
    // A file the merge can open but not update (the registration itself is fine).
    const breakFile = (reg: { id: string }) => rawDb(gate.openTenant(reg.id)).exec("ALTER TABLE conversations RENAME TO conversations_broken");
    const repairFile = (reg: { id: string }) => rawDb(gate.openTenant(reg.id)).exec("ALTER TABLE conversations_broken RENAME TO conversations");
    const state = () => ({
      identities: control.prepare("SELECT id, status, merged_into FROM identities ORDER BY id").all(),
      logins: control.prepare("SELECT id, identity_id FROM login_identities ORDER BY id").all(),
      memberships: control.prepare("SELECT id, identity_id FROM memberships ORDER BY id").all(),
      grants: control.prepare("SELECT id, status FROM delegation_grants ORDER BY id").all(),
      events: control.prepare("SELECT id FROM identity_link_events ORDER BY id").all(),
    });
    const conversationOwner = () => rawDb(gate.openTenant(a.id)).prepare("SELECT user_id FROM conversations WHERE id = 'c1'").get();

    return {
      app, control, gate, identities, intents, personal, gerry, staff, a, b, membershipA, grantId, logger, ensurePersonalUser,
      hasAttendedGrant, releaseGrants, proofs, preview, intentUsed, breakFile, repairFile, impressorxLogin,
      advance: (ms: number) => (now += ms), asSession, startIntent, link, googleLogin, state, conversationOwner, registration,
    };
  }

  describe("POST /api/identity/link-intent", () => {
    it("opens an intent for the signed-in identity: a hand-off session is told to sign in with Google, a Google session to hand off", async () => {
      const s = setup();

      const fromHandoff = await s.startIntent(s.staff.id, true);
      const fromGoogle = await s.startIntent(s.gerry.id);

      expect(fromHandoff).toEqual({ linkIntentId: expect.any(String), secret: expect.any(String), next: "google" });
      expect(fromGoogle).toEqual({ linkIntentId: expect.any(String), secret: expect.any(String), next: "handoff" });
      expect(s.control.prepare("SELECT identity_id FROM link_intents WHERE id = ?").get(fromHandoff.linkIntentId)).toEqual({ identity_id: s.staff.id });
      expect(s.control.prepare("SELECT identity_id FROM link_intents WHERE id = ?").get(fromGoogle.linkIntentId)).toEqual({ identity_id: s.gerry.id });
    });

    it("acts only on the session's identity, whatever the body says, and needs a session", async () => {
      const s = setup();
      s.asSession(s.staff.id, true);

      const res = await request(s.app).post("/api/identity/link-intent").send({ identityId: s.gerry.id, userId: s.gerry.id });
      expect(s.control.prepare("SELECT identity_id FROM link_intents WHERE id = ?").get(res.body.linkIntentId)).toEqual({ identity_id: s.staff.id });

      s.asSession(undefined);
      expect((await request(s.app).post("/api/identity/link-intent").send({})).status).toBe(401);
    });
  });

  describe("POST /api/identity/link", () => {
    it("linking from a hand-off session to an existing Google identity merges into the Google identity", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ linked: true, merged: true, identityId: s.gerry.id });
      expect(s.control.prepare("SELECT status, merged_into FROM identities WHERE id = ?").get(s.staff.id)).toEqual({ status: "disabled", merged_into: s.gerry.id });
      expect(s.control.prepare("SELECT identity_id FROM memberships WHERE id = ?").get(s.membershipA)).toEqual({ identity_id: s.gerry.id });
      expect(s.identities.findByLogin("impressorx", `${s.a.id}:staff-1`)).toEqual({ id: s.gerry.id, status: "active" });
      expect(s.conversationOwner()).toEqual({ user_id: s.gerry.id });
      expect(s.control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(s.grantId)).toEqual({ status: "revoked" });
      expect(s.control.prepare("SELECT used_at FROM link_intents WHERE id = ?").get(intent.linkIntentId)).toEqual({ used_at: expect.any(String) });
    });

    it("linking from a Google session to a hand-off merges the ImpressoRx identity into the Google one, never the other way", async () => {
      const s = setup();
      const intent = await s.startIntent(s.gerry.id);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.impressorxLogin() });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ linked: true, merged: true, identityId: s.gerry.id });
      expect(s.identities.findById(s.gerry.id)).toEqual({ id: s.gerry.id, status: "active" });
      expect(s.identities.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "disabled" });
      expect(s.conversationOwner()).toEqual({ user_id: s.gerry.id });
    });

    it("attaches a new Google login to the current identity when no Google identity exists yet, without a merge", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("brand-new-sub", "new@x.com") });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ linked: true, merged: false, identityId: s.staff.id });
      expect(s.identities.findByLogin("google", "brand-new-sub")).toEqual({ id: s.staff.id, status: "active" });
      expect(s.identities.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "active" });
      expect(s.ensurePersonalUser).toHaveBeenCalledWith({ id: s.staff.id, email: "new@x.com" });
      expect(s.control.prepare("SELECT event, identity_id FROM identity_link_events WHERE identity_id = ?").all(s.staff.id)).toEqual([{ event: "link", identity_id: s.staff.id }]);
      expect(s.conversationOwner()).toEqual({ user_id: s.staff.id });
    });

    it("finds the identity a Google sign-in belongs to by the one-time pre-upgrade marker, so a user who predates identities is merged into, not duplicated", async () => {
      const s = setup();
      rawDb(s.personal).prepare("INSERT INTO users (id, email) VALUES ('old-user', 'old@x.com')").run();
      backfillIdentities(s.personal, s.control);
      const intent = await s.startIntent(s.staff.id, true);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("old-sub", "old@x.com") });

      expect(res.body).toEqual({ linked: true, merged: true, identityId: "old-user" });
      expect(s.identities.findByLogin("google", "old-sub")).toEqual({ id: "old-user", status: "active" });
    });

    it("is a no-op when the two logins already belong to one identity", async () => {
      const s = setup();
      const first = await s.startIntent(s.staff.id, true);
      await s.link({ linkIntentId: first.linkIntentId, secret: first.secret, login: s.googleLogin() });
      const before = s.state();
      const again = await s.startIntent(s.gerry.id);

      const res = await s.link({ linkIntentId: again.linkIntentId, secret: again.secret, login: s.googleLogin() });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ linked: true, merged: false, identityId: s.gerry.id });
      expect(s.state()).toEqual(before);
    });

    it("a link intent from another browser session is refused: without that browser's secret, nothing links and the intent is not burnt", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      const before = s.state();

      for (const secret of ["x".repeat(43), "", intent.secret.slice(1)]) {
        const res = await s.link({ linkIntentId: intent.linkIntentId, secret, login: s.googleLogin() });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "link_expired" });
      }
      expect((await s.link({ linkIntentId: "not-an-intent", secret: intent.secret, login: s.googleLogin() })).body).toEqual({ error: "link_expired" });
      expect(s.state()).toEqual(before);

      expect((await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() })).status).toBe(200);
    });

    it("an intent older than 5 minutes is refused", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      const before = s.state();
      s.advance(5 * 60 * 1000 + 1);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "link_expired" });
      expect(s.state()).toEqual(before);
    });

    it("an intent works once, also when two requests race for it", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      const body = { linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() };

      const results = await Promise.all([s.link(body), s.link(body), s.link(body)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.error === "link_expired")).toBe(true);
      expect(s.control.prepare("SELECT COUNT(*) AS n FROM identity_link_events WHERE detail_json IS NOT NULL").get()).toEqual({ n: 1 });
      expect((await s.link(body)).body).toEqual({ error: "link_expired" });
    });

    it("refuses with link_conflict when both identities already hold a Google login, and merges nothing", async () => {
      const s = setup();
      const other = s.identities.createWithLogin({ kind: "google", subject: "other-sub", email: "other@x.com" });
      const intent = await s.startIntent(s.gerry.id);
      const before = s.state();

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("other-sub", "other@x.com") });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "link_conflict" });
      expect(s.state()).toEqual(before);
      expect(s.identities.findById(other.id)).toEqual({ id: other.id, status: "active" });
    });

    it("refuses with link_conflict when neither identity holds a Google login, or one is disabled", async () => {
      const s = setup();
      const second = s.identities.createWithLogin({ kind: "impressorx", subject: `${s.b.id}:staff-2` });
      s.proofs.push(["s2", second.id, "m2"]);
      let intent = await s.startIntent(s.staff.id, true);
      let res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.impressorxLogin({ identityId: second.id, sessionId: "s2", membershipId: "m2" }) });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "link_needs_google" });

      s.control.prepare("UPDATE identities SET status = 'disabled' WHERE id = ?").run(s.gerry.id);
      intent = await s.startIntent(s.staff.id, true);
      res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "link_account_disabled" });
      expect(s.identities.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "active" });
    });

    it("a refusal does not spend the intent", async () => {
      const s = setup();
      s.identities.createWithLogin({ kind: "google", subject: "other-sub", email: "other@x.com" });
      const intent = await s.startIntent(s.gerry.id);

      const refused = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("other-sub", "other@x.com") });

      expect(refused.body).toEqual({ error: "link_conflict" });
      expect(s.intentUsed(intent.linkIntentId)).toBe(false);
    });

    it("returns link_incomplete with the control database unchanged when a tenant file cannot be updated, and a fresh intent completes the link", async () => {
      const s = setup();
      const membershipB = randomUUID();
      s.identities.attachLogin(s.staff.id, { kind: "impressorx", subject: `${s.b.id}:staff-9` }, s.staff.id);
      s.control
        .prepare(
          "INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES (?, ?, ?, 'staff-9', 'manager', '[]', '[]', 'active', ?, ?)",
        )
        .run(membershipB, s.staff.id, s.b.id, NOW, NOW);
      s.breakFile(s.b);
      const intent = await s.startIntent(s.staff.id, true);
      const before = s.state();

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "link_incomplete" });
      expect(s.state()).toEqual(before);
      expect(s.logger.error).toHaveBeenCalled();
      expect(JSON.stringify(s.logger.error.mock.calls)).not.toContain(intent.secret);
      // The intent is spent, so the same one cannot be replayed.
      expect((await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() })).body).toEqual({ error: "link_expired" });

      s.repairFile(s.b);
      const fresh = await s.startIntent(s.staff.id, true);
      const retry = await s.link({ linkIntentId: fresh.linkIntentId, secret: fresh.secret, login: s.googleLogin() });
      expect(retry.status).toBe(200);
      expect(s.identities.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "disabled" });
      expect(s.conversationOwner()).toEqual({ user_id: s.gerry.id });
    });

    it("returns link_incomplete with the control database unchanged when the control transaction fails part-way", async () => {
      const s = setup();
      s.control.exec("CREATE TRIGGER boom BEFORE INSERT ON identity_link_events BEGIN SELECT RAISE(ABORT, 'boom'); END");
      const intent = await s.startIntent(s.staff.id, true);
      const before = s.state();

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "link_incomplete" });
      expect(s.state()).toEqual(before);
    });

    it("linking never happens by matching email: without an intent, identities that share a login email stay separate", async () => {
      const s = setup();
      const one = s.identities.createWithLogin({ kind: "google", subject: "same-g", email: "same@x.com" });
      const two = s.identities.createWithLogin({ kind: "impressorx", subject: `${s.b.id}:same`, email: "same@x.com" });
      const before = s.state();

      for (const body of [
        { login: s.googleLogin("same-g", "same@x.com") },
        { linkIntentId: "none", secret: "none", login: s.googleLogin("same-g", "same@x.com") },
        { linkIntentId: "none", secret: "none", login: { kind: "impressorx", identityId: two.id } },
      ]) {
        const res = await s.link(body);
        expect([400, 409]).toContain(res.status);
      }

      expect(s.state()).toEqual(before);
      expect(s.identities.findById(one.id)).toEqual({ id: one.id, status: "active" });
      expect(s.identities.findById(two.id)).toEqual({ id: two.id, status: "active" });
    });

    it("uses the service token, not a session, and rejects a malformed body", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      const body = { linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() };

      expect((await s.link(body, null)).status).toBe(401);
      expect((await s.link(body, "wrong-token")).status).toBe(401);
      expect((await s.link({ ...body, login: { kind: "google" } })).status).toBe(400);
      expect((await s.link({ ...body, login: { kind: "email", subject: "x" } })).status).toBe(400);
      expect((await s.link({ linkIntentId: 5, secret: intent.secret, login: body.login })).status).toBe(400);
      expect(s.identities.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "active" });
    });
    it("refuses a hand-off the server cannot prove: the service token alone is not enough", async () => {
      const s = setup();
      const intent = await s.startIntent(s.gerry.id);
      const body = (login: Record<string, unknown>) => ({ linkIntentId: intent.linkIntentId, secret: intent.secret, login });
      const before = s.state();

      for (const login of [
        s.impressorxLogin({ sessionId: "someone-elses-session" }),
        s.impressorxLogin({ membershipId: "another-membership" }),
        s.impressorxLogin({ identityId: s.gerry.id }),
      ]) {
        const res = await s.link(body(login));
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "link_expired" });
      }
      expect((await s.link(body({ kind: "impressorx", identityId: s.staff.id }))).status).toBe(400);
      expect(s.hasAttendedGrant).toHaveBeenCalledWith("someone-elses-session", s.staff.id, s.membershipA);
      expect(s.state()).toEqual(before);
      expect(s.intentUsed(intent.linkIntentId)).toBe(false);

      expect((await s.link(body(s.impressorxLogin()))).status).toBe(200);
    });

    it("moves the memberships of a removed registration without opening its file", async () => {
      const s = setup();
      s.control.prepare("UPDATE tenant_registrations SET status = 'removed' WHERE id = ?").run(s.a.id);
      const intent = await s.startIntent(s.staff.id, true);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });

      expect(res.status).toBe(200);
      expect(s.control.prepare("SELECT identity_id FROM memberships WHERE id = ?").get(s.membershipA)).toEqual({ identity_id: s.gerry.id });
      expect(s.identities.findById(s.staff.id)).toEqual({ id: s.staff.id, status: "disabled" });
    });

    it.each(["suspended_by_operator", "disabled_by_tenant"])(
      "refuses with link_unavailable while a pharmacy is %s, changing nothing and keeping the intent for later",
      async (status) => {
        const s = setup();
        s.control.prepare("UPDATE tenant_registrations SET status = ? WHERE id = ?").run(status, s.a.id);
        const intent = await s.startIntent(s.staff.id, true);
        const before = s.state();
        const body = { linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() };

        const res = await s.link(body);
        const previewed = await s.preview(body);

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "link_unavailable" });
        expect(previewed.status).toBe(409);
        expect(previewed.body).toEqual({ error: "link_unavailable" });
        expect(s.state()).toEqual(before);
        expect(s.intentUsed(intent.linkIntentId)).toBe(false);
        expect(s.releaseGrants).not.toHaveBeenCalled();

        s.control.prepare("UPDATE tenant_registrations SET status = 'active' WHERE id = ?").run(s.a.id);
        expect((await s.link(body)).status).toBe(200);
      },
    );

    it("after the commit, forgets and revokes the old identity's grants, best effort: a failure there does not fail the link", async () => {
      const s = setup();
      s.releaseGrants.mockRejectedValueOnce(new Error("ImpressoRx is down"));
      const intent = await s.startIntent(s.staff.id, true);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });

      expect(res.status).toBe(200);
      expect(s.releaseGrants).toHaveBeenCalledWith([s.grantId]);
      await vi.waitFor(() => expect(s.logger.warn).toHaveBeenCalled());
      expect(s.control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(s.grantId)).toEqual({ status: "revoked" });
    });

    it("never attaches a Google login to another identity because they share an email, even with a valid intent", async () => {
      const s = setup();
      // Same email, different subject: one on a Google login, one on an ImpressoRx login.
      const sameGoogle = s.identities.createWithLogin({ kind: "google", subject: "someone-elses-sub", email: "shared@x.com" });
      const sameImpressorx = s.identities.createWithLogin({ kind: "impressorx", subject: `${s.b.id}:shared`, email: "shared@x.com" });
      const intent = await s.startIntent(s.staff.id, true);

      const res = await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("my-own-sub", "shared@x.com") });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ linked: true, merged: false, identityId: s.staff.id });
      expect(s.identities.findByLogin("google", "my-own-sub")).toEqual({ id: s.staff.id, status: "active" });
      for (const other of [sameGoogle, sameImpressorx]) {
        expect(s.identities.findById(other.id)).toEqual({ id: other.id, status: "active" });
        expect(s.control.prepare("SELECT COUNT(*) AS n FROM login_identities WHERE identity_id = ?").get(other.id)).toEqual({ n: 1 });
      }
      expect(s.identities.findByLogin("google", "someone-elses-sub")).toEqual({ id: sameGoogle.id, status: "active" });
    });
  });

  describe("POST /api/identity/link/preview", () => {
    it("describes the link without making it or spending the intent: the pharmacy side, and the Google email", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      const before = s.state();
      const body = { linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("gerry-sub", "Gerry@X.com") };

      const res = await s.preview(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ googleEmail: "gerry@x.com", memberships: [{ role: "manager", pharmacyName: "a" }] });
      expect(s.state()).toEqual(before);
      expect(s.intentUsed(intent.linkIntentId)).toBe(false);
      expect(s.ensurePersonalUser).not.toHaveBeenCalled();
      expect(s.releaseGrants).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain(intent.secret);
      // It can be asked again, and the link can still be made.
      expect((await s.preview(body)).status).toBe(200);
      expect((await s.link(body)).status).toBe(200);
    });

    it("names the Google email of the identity that opened the intent when the hand-off came second", async () => {
      const s = setup();
      const intent = await s.startIntent(s.gerry.id);

      const res = await s.preview({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.impressorxLogin() });

      expect(res.body).toEqual({ googleEmail: "gerry@x.com", memberships: [{ role: "manager", pharmacyName: "a" }] });
    });

    it("refuses what the link would refuse: another browser's intent, an expired one, an unproven hand-off and a conflict", async () => {
      const s = setup();
      s.identities.createWithLogin({ kind: "google", subject: "other-sub", email: "other@x.com" });
      const intent = await s.startIntent(s.gerry.id);

      expect((await s.preview({ linkIntentId: intent.linkIntentId, secret: "x".repeat(43), login: s.googleLogin() })).body).toEqual({ error: "link_expired" });
      expect((await s.preview({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.impressorxLogin({ sessionId: "nope" }) })).body).toEqual({ error: "link_expired" });
      const conflict = await s.preview({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin("other-sub", "other@x.com") });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ error: "link_conflict" });
      s.advance(5 * 60 * 1000 + 1);
      expect((await s.preview({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() })).body).toEqual({ error: "link_expired" });
    });

    it("takes the service token and a well-formed body", async () => {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      const body = { linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() };
      expect((await s.preview(body, null)).status).toBe(401);
      expect((await s.preview({ ...body, login: { kind: "google" } })).status).toBe(400);
    });
  });

  describe("POST /api/identity/unlink", () => {
    async function linked() {
      const s = setup();
      const intent = await s.startIntent(s.staff.id, true);
      await s.link({ linkIntentId: intent.linkIntentId, secret: intent.secret, login: s.googleLogin() });
      const loginId = (s.control.prepare("SELECT id FROM login_identities WHERE subject = ?").get(`${s.a.id}:staff-1`) as { id: string }).id;
      return { s, loginId };
    }

    it("unlink creates a new identity for the detached login, acting on the session's identity", async () => {
      const { s, loginId } = await linked();
      s.control
        .prepare(
          `INSERT INTO delegation_grants (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value, wrapped_key,
             generation, status, session_id, created_at, absolute_expires_at)
           VALUES ('g-after', ?, ?, ?, 'attended', '[]', 'c', 'w', 1, 'active', 's2', ?, '2099-01-01T00:00:00.000Z')`,
        )
        .run(s.gerry.id, s.membershipA, s.a.id, NOW);
      s.asSession(s.gerry.id);

      const res = await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: loginId });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ identityId: expect.any(String) });
      // The moved membership's grants are forgotten and revoked at ImpressoRx too (best effort, after the commit).
      expect(s.releaseGrants).toHaveBeenLastCalledWith(["g-after"]);
      expect(res.body.identityId).not.toBe(s.gerry.id);
      expect(s.identities.findByLogin("impressorx", `${s.a.id}:staff-1`)).toEqual({ id: res.body.identityId, status: "active" });
      expect(s.control.prepare("SELECT identity_id FROM memberships WHERE id = ?").get(s.membershipA)).toEqual({ identity_id: res.body.identityId });
      expect(s.conversationOwner()).toEqual({ user_id: s.gerry.id });
      expect(s.control.prepare("SELECT event, identity_id FROM identity_link_events WHERE event = 'unlink'").all()).toEqual([{ event: "unlink", identity_id: s.gerry.id }]);
    });

    it("refuses a login that is not the caller's (404), a Google login or a last login (409), and a malformed body (400)", async () => {
      const { s, loginId } = await linked();
      const googleLoginId = (s.control.prepare("SELECT id FROM login_identities WHERE subject = 'gerry-sub'").get() as { id: string }).id;
      const loner = s.identities.createWithLogin({ kind: "impressorx", subject: `${s.b.id}:loner` });
      const lonerLogin = (s.control.prepare("SELECT id FROM login_identities WHERE identity_id = ?").get(loner.id) as { id: string }).id;
      const before = s.state();

      s.asSession(loner.id);
      expect((await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: loginId })).status).toBe(404);
      const last = await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: lonerLogin });
      expect(last.status).toBe(409);
      expect(last.body).toEqual({ error: "unlink_refused", reason: "last_login" });

      s.asSession(s.gerry.id);
      const google = await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: googleLoginId });
      expect(google.status).toBe(409);
      expect(google.body).toEqual({ error: "unlink_refused", reason: "not_detachable" });
      expect((await request(s.app).post("/api/identity/unlink").send({})).status).toBe(400);
      expect((await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: 7 })).status).toBe(400);

      expect(s.state()).toEqual(before);
    });

    it("needs a session", async () => {
      const { s, loginId } = await linked();
      s.asSession(undefined);
      expect((await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: loginId })).status).toBe(401);
    });
  });
});
