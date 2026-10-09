import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextDbGate,
  EnrolmentService,
  FakeImpressorx,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  UsedHandoffJti,
  createImpressoRxClient,
  openControlDb,
  rawDb,
} from "@oneon/infrastructure";
import { createTokenAuthMiddleware } from "../middleware/auth.js";
import { createHandoffRouter } from "./handoff.route.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";
const TOKEN = "service-token";
const GENERIC = { error: "handoff_rejected", reason: "generic" };

describe("hand-off redemption", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "handoff-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => gate.close(), () => control.close());
    let now = Date.now();
    const clock = () => new Date(now);

    const identities = new SqliteIdentityRepository(control, (id) => gate.openTenant(id));
    const operatorId = identities.createWithLogin({ kind: "google", subject: "op" }).id;
    const registrations = new TenantRegistrationRepository(control);
    const memberships = new MembershipRepository(control);
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE, clock);
    const enrolment = new EnrolmentService({
      repo: registrations,
      oneonOrigin: "https://oneon.example",
      masterKeyB64: randomBytes(32).toString("base64"),
      fetchImpl: fake.fetch,
      clock,
    });
    const registration = await enrolment.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: operatorId });
    gate.createTenantFile(registration.id, registration.tenantId);

    // Lets a test act in the middle of a hand-off: right after ImpressoRx has answered the exchange, before Oneon stores it.
    const hooks: { afterExchange?: () => void } = {};
    const client = createImpressoRxClient({
      control,
      grantMasterKeyB64: randomBytes(32).toString("base64"),
      enrolment,
      onSnapshot: (membershipId, snapshot) => memberships.applySnapshot(membershipId, snapshot),
      fetchImpl: async (input, init) => {
        const res = await fake.fetch(input, init);
        if (String(input).endsWith("/api/oneon/token")) hooks.afterExchange?.();
        return res;
      },
      clock,
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const app = express();
    app.use(express.json());
    app.use(
      "/api/auth/handoff",
      createTokenAuthMiddleware(TOKEN),
      createHandoffRouter({
        registrations,
        enrolment,
        identities,
        memberships,
        jti: new UsedHandoffJti(control, clock),
        openTenant: (id) => gate.openTenant(id),
        client,
        logger,
      }),
    );

    const redeem = async (handoff: string, sessionId: string = randomUUID(), origin: string | null = ORIGIN) => {
      const res = await request(app)
        .post("/api/auth/handoff/redeem")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ handoff, sessionId, ...(origin === null ? {} : { origin }) });
      return { res, sessionId };
    };
    return { app, control, gate, client, fake, registration, registrations, identities, hooks, redeem, logger, advance: (ms: number) => (now += ms) };
  }

  it("first hand-off creates an identity and membership, and an anchor row in the tenant file", async () => {
    const { control, gate, fake, registration, redeem } = await setup();
    const { res } = await redeem(await fake.mintHandoff("staff-1"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ identityId: expect.any(String), membershipId: expect.any(String) });
    expect(control.prepare("SELECT COUNT(*) AS n FROM identities WHERE id = ?").get(res.body.identityId)).toEqual({ n: 1 });
    expect(control.prepare("SELECT kind, subject FROM login_identities WHERE identity_id = ?").get(res.body.identityId)).toEqual({
      kind: "impressorx",
      subject: `${registration.id}:staff-1`,
    });
    const membership = control
      .prepare("SELECT identity_id, external_user_id, role, status, permissions_json FROM memberships WHERE id = ?")
      .get(res.body.membershipId);
    expect(membership).toEqual({
      identity_id: res.body.identityId,
      external_user_id: "staff-1",
      role: "manager",
      status: "active",
      permissions_json: JSON.stringify(["jobs.read"]),
    });
    const anchor = rawDb(gate.openTenant(registration.id)).prepare("SELECT id, email FROM users").all();
    expect(anchor).toEqual([{ id: res.body.identityId, email: `${res.body.identityId}@anchor.invalid` }]);
  });

  it("a second hand-off for the same staff user reuses the identity and the membership", async () => {
    const { control, fake, redeem } = await setup();
    const first = (await redeem(await fake.mintHandoff("staff-1"))).res;
    const second = (await redeem(await fake.mintHandoff("staff-1"))).res;

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(control.prepare("SELECT COUNT(*) AS n FROM memberships").get()).toEqual({ n: 1 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM login_identities WHERE kind = 'impressorx'").get()).toEqual({ n: 1 });
  });

  it("after a merge, the next hand-off finds the membership under the merged identity and opens its session there", async () => {
    const { control, gate, registration, identities, fake, redeem } = await setup();
    const first = (await redeem(await fake.mintHandoff("staff-1"))).res;
    const google = identities.createWithLogin({ kind: "google", subject: "g-sub", email: "g@x.com" });
    identities.mergeInto(first.body.identityId, google.id, google.id);
    // The merge revoked the old identity's attended grant: its session is over.
    expect(control.prepare("SELECT identity_id, status FROM delegation_grants").all()).toEqual([{ identity_id: first.body.identityId, status: "revoked" }]);

    const second = (await redeem(await fake.mintHandoff("staff-1"))).res;

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ identityId: google.id, membershipId: first.body.membershipId });
    expect(control.prepare("SELECT COUNT(*) AS n FROM memberships").get()).toEqual({ n: 1 });
    expect(control.prepare("SELECT identity_id FROM memberships WHERE id = ?").get(first.body.membershipId)).toEqual({ identity_id: google.id });
    expect(control.prepare("SELECT identity_id, membership_id, status FROM delegation_grants WHERE status = 'active'").all()).toEqual([
      { identity_id: google.id, membership_id: first.body.membershipId, status: "active" },
    ]);
    expect(rawDb(gate.openTenant(registration.id)).prepare("SELECT id FROM users WHERE id = ?").get(google.id)).toEqual({ id: google.id });
  });

  it("a merge that lands while the hand-off is being exchanged refuses it and revokes the grant it just stored, here and at ImpressoRx", async () => {
    const { control, identities, hooks, fake, client, redeem } = await setup();
    const first = (await redeem(await fake.mintHandoff("staff-1"))).res;
    const earlier = new Set(fake.grants.keys());
    const google = identities.createWithLogin({ kind: "google", subject: "g-sub", email: "g@x.com" });
    // The second hand-off finds the identity and membership, then the merge moves both before its grant is stored.
    hooks.afterExchange = () => {
      hooks.afterExchange = undefined;
      identities.mergeInto(first.body.identityId, google.id, google.id);
    };

    const { res, sessionId } = await redeem(await fake.mintHandoff("staff-1"));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "handoff_rejected", reason: "generic" });
    expect(client.forSession(sessionId)).toBeNull();
    expect(control.prepare("SELECT COUNT(*) AS n FROM delegation_grants WHERE status = 'active'").get()).toEqual({ n: 0 });
    const stored = [...fake.grants].filter(([id]) => !earlier.has(id));
    expect(stored).toHaveLength(1);
    expect(stored[0]![1].status).toBe("revoked");
  });

  it("an identity disabled while the hand-off is being exchanged is refused the same way", async () => {
    const { control, identities, hooks, fake, client, redeem } = await setup();
    const first = (await redeem(await fake.mintHandoff("staff-1"))).res;
    const earlier = new Set(fake.grants.keys());
    hooks.afterExchange = () => {
      hooks.afterExchange = undefined;
      control.prepare("UPDATE identities SET status = 'disabled' WHERE id = ?").run(first.body.identityId);
    };

    const { res, sessionId } = await redeem(await fake.mintHandoff("staff-1"));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "handoff_rejected", reason: "generic" });
    expect(client.forSession(sessionId)).toBeNull();
    expect(identities.findById(first.body.identityId)?.status).toBe("disabled");
    const stored = [...fake.grants].filter(([id]) => !earlier.has(id));
    expect(stored).toHaveLength(1);
    expect(stored[0]![1].status).toBe("revoked");
  });

  it("after an email change, the same identity is used (email is never a key)", async () => {
    const { control, fake, redeem } = await setup();
    const first = (await redeem(await fake.mintHandoff("staff-1"))).res;
    // The hand-off carries the staff user id only; whatever email the user has at ImpressoRx does not enter the lookup.
    fake.snapshots.set("staff-1", { userId: "staff-1", role: "manager", permissions: ["jobs.read"], locationIds: ["loc-1"], tokenVersion: 2, tenantStatus: "active" });
    const second = (await redeem(await fake.mintHandoff("staff-1"))).res;

    expect(second.body.identityId).toBe(first.body.identityId);
    expect(control.prepare("SELECT email FROM login_identities WHERE kind = 'impressorx'").all()).toEqual([{ email: null }]);
  });

  it("rejects a replayed hand-off as expired", async () => {
    const { fake, redeem } = await setup();
    const handoff = await fake.mintHandoff("staff-1");
    expect((await redeem(handoff)).res.status).toBe(200);

    const replay = (await redeem(handoff)).res;
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "handoff_rejected", reason: "expired" });
  });

  it("rejects a hand-off whose lifetime has run out as expired", async () => {
    const { fake, redeem, advance } = await setup();
    const handoff = await fake.mintHandoff("staff-1");
    advance(120_000);

    const res = (await redeem(handoff)).res;
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "handoff_rejected", reason: "expired" });
  });

  it("a forged token with a known issuer and an expiry past on the wall clock is generic (no tenant oracle)", async () => {
    const { fake, redeem } = await setup();
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const nowSec = Math.floor(Date.now() / 1000);
    const forged = [
      b64({ alg: "EdDSA", kid: "unknown-kid" }),
      b64({ iss: "impressorx:acme", aud: "oneon", iat: nowSec - 660, exp: nowSec - 600, jti: randomUUID(), sub: "staff-1", tenantSlug: "acme", tv: 1, role: "manager" }),
      "A".repeat(86),
    ].join(".");
    const unknownIssuer = (await redeem(await fake.mintHandoff("staff-1", { issuer: "impressorx:nope" }))).res;

    const res = (await redeem(forged)).res;
    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC);
    expect(res.body).toEqual(unknownIssuer.body);
  });

  it("pins the origin: the right Origin succeeds; a wrong or missing one is generic and consumes nothing", async () => {
    const { fake, redeem } = await setup();
    const handoff = await fake.mintHandoff("staff-1");

    const wrong = (await redeem(handoff, randomUUID(), "https://evil.example")).res;
    const missing = (await redeem(handoff, randomUUID(), null)).res;
    const suffix = (await redeem(handoff, randomUUID(), `${ORIGIN}.evil.example`)).res;
    for (const res of [wrong, missing, suffix]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(GENERIC);
    }
    expect(fake.grants.size).toBe(0);
    // The jti was not consumed by the refusals: the same hand-off still opens with the right origin.
    expect((await redeem(handoff)).res.status).toBe(200);
  });

  it("a grant is only found for the identity and membership it was opened for", async () => {
    const { client, fake, redeem } = await setup();
    const shared = randomUUID();
    const a = (await redeem(await fake.mintHandoff("staff-1"), shared)).res.body;
    const b = (await redeem(await fake.mintHandoff("staff-2"), shared)).res.body;

    expect(client.hasAttendedGrant(shared, a.identityId, a.membershipId)).toBe(true);
    expect(client.hasAttendedGrant(shared, b.identityId, b.membershipId)).toBe(true);
    expect(client.hasAttendedGrant(shared, a.identityId, b.membershipId)).toBe(false);
    expect(client.hasAttendedGrant(shared, b.identityId, a.membershipId)).toBe(false);
    expect(client.hasAttendedGrant(randomUUID(), a.identityId, a.membershipId)).toBe(false);
  });

  it("answers a wrong audience, an unknown issuer, a suspended registration and a long-lived hand-off identically", async () => {
    const { fake, registration, registrations, redeem } = await setup();
    const wrongAudience = (await redeem(await fake.mintHandoff("staff-1", { audience: "someone-else" }))).res;
    const unknownIssuer = (await redeem(await fake.mintHandoff("staff-1", { issuer: "impressorx:nope" }))).res;
    const tooLong = (await redeem(await fake.mintHandoff("staff-1", { ttlSeconds: 300 }))).res;
    const notAJws = (await redeem("not-a-jws")).res;
    registrations.setStatus(registration.id, "suspended_by_operator", null, "test");
    const suspended = (await redeem(await fake.mintHandoff("staff-1"))).res;

    for (const res of [wrongAudience, unknownIssuer, tooLong, notAJws, suspended]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(GENERIC);
    }
  });

  it("requires the service token, and a malformed body is the generic rejection", async () => {
    const { app, fake, redeem } = await setup();
    const handoff = await fake.mintHandoff("staff-1");
    expect((await request(app).post("/api/auth/handoff/redeem").send({ handoff, sessionId: randomUUID() })).status).toBe(401);
    expect((await request(app).post("/api/auth/handoff/redeem").set("Authorization", "Bearer wrong").send({ handoff })).status).toBe(401);

    const missing = await request(app).post("/api/auth/handoff/redeem").set("Authorization", `Bearer ${TOKEN}`).send({ handoff });
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual(GENERIC);
    // The bad requests burned nothing: the hand-off still works.
    expect((await redeem(handoff)).res.status).toBe(200);
  });

  it("a hand-off while another identity is signed in links nothing", async () => {
    const { control, fake, redeem } = await setup();
    const a = (await redeem(await fake.mintHandoff("staff-1"))).res;
    // Redemption never reads the browser's existing session; the dashboard replaces the cookie.
    const b = (await redeem(await fake.mintHandoff("staff-2"))).res;

    expect(b.body.identityId).not.toBe(a.body.identityId);
    expect(control.prepare("SELECT COUNT(*) AS n FROM identity_link_events").get()).toEqual({ n: 0 });
    expect(control.prepare("SELECT COUNT(*) AS n FROM login_identities").get()).toEqual({ n: 3 });
  });

  it("a suspended tenant at ImpressoRx is membership_suspended and holds no live grant", async () => {
    const { control, fake, redeem } = await setup();
    fake.snapshots.set("staff-1", { userId: "staff-1", role: "manager", permissions: [], locationIds: [], tokenVersion: 1, tenantStatus: "Disabled" });

    const { res, sessionId } = await redeem(await fake.mintHandoff("staff-1"));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "handoff_rejected", reason: "membership_suspended" });
    expect(control.prepare("SELECT status FROM memberships").get()).toEqual({ status: "suspended" });
    expect(control.prepare("SELECT status FROM delegation_grants WHERE session_id = ?").get(sessionId)).toEqual({ status: "revoked" });
    expect([...fake.grants.values()].every((g) => g.status === "revoked")).toBe(true);
  });

  it("a revoked membership is membership_suspended before any exchange", async () => {
    const { control, fake, redeem } = await setup();
    await redeem(await fake.mintHandoff("staff-1"));
    control.prepare("UPDATE memberships SET status = 'revoked'").run();

    const res = (await redeem(await fake.mintHandoff("staff-1"))).res;
    expect(res.body).toEqual({ error: "handoff_rejected", reason: "membership_suspended" });
    expect(fake.grants.size).toBe(1);
  });

  it("an unreachable ImpressoRx is the generic rejection and creates no session", async () => {
    const { control, fake, redeem } = await setup();
    fake.networkFailure = true;

    const { res, sessionId } = await redeem(await fake.mintHandoff("staff-1"));

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC);
    expect(control.prepare("SELECT COUNT(*) AS n FROM delegation_grants WHERE session_id = ?").get(sessionId)).toEqual({ n: 0 });
  });

  it("sign-out revokes the attended grant", async () => {
    const { app, control, fake, redeem } = await setup();
    const { sessionId } = await redeem(await fake.mintHandoff("staff-1"));
    const grantId = [...fake.grants.keys()][0]!;
    expect(fake.grants.get(grantId)!.status).toBe("active");

    const res = await request(app).post("/api/auth/handoff/sign-out").set("Authorization", `Bearer ${TOKEN}`).send({ sessionId });

    expect(res.status).toBe(204);
    expect(fake.grants.get(grantId)!.status).toBe("revoked");
    expect(control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(grantId)).toEqual({ status: "revoked" });
  });

  it("sign-out for a session with no grant is harmless", async () => {
    const { app } = await setup();
    const res = await request(app).post("/api/auth/handoff/sign-out").set("Authorization", `Bearer ${TOKEN}`).send({ sessionId: randomUUID() });
    expect(res.status).toBe(204);
  });

  it("never logs the hand-off", async () => {
    const { fake, redeem, logger } = await setup();
    const handoff = await fake.mintHandoff("staff-1");
    await redeem(handoff);
    await redeem(handoff);
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])).not.toContain(handoff);
  });
});
