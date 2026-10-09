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
  ImpressoRxRefusedError,
  LinkIntentRepository,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  UsedHandoffJti,
  createImpressoRxClient,
  openControlDb,
} from "@oneon/infrastructure";
import { createTokenAuthMiddleware } from "../middleware/auth.js";
import { requireUser } from "../middleware/require-user.js";
import { createHandoffRouter } from "./handoff.route.js";
import { createIdentityLinkRouter, createIdentitySessionRouter } from "./identity-link.route.js";

const ORIGIN = "https://acme.example";
const CODE = "ABCD-EFGH-JKLM";
const TOKEN = "service-token";

// The whole path with a real client against the fake deployment: a hand-off opens a grant, a link or unlink revokes it in
// SQL, and afterwards the client must neither use a cached token of it nor leave it alive at ImpressoRx.
describe("linking revokes grants everywhere", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "identity-grants-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => control.close(), () => gate.close());
    const identities = new SqliteIdentityRepository(control, (id) => gate.openTenant(id));
    const memberships = new MembershipRepository(control);
    const registrations = new TenantRegistrationRepository(control);
    const google = identities.createWithLogin({ kind: "google", subject: "g-sub", email: "g@x.com" });
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE);
    const enrolment = new EnrolmentService({ repo: registrations, oneonOrigin: "https://oneon.example", masterKeyB64: randomBytes(32).toString("base64"), fetchImpl: fake.fetch });
    const registration = await enrolment.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: google.id });
    gate.createTenantFile(registration.id, registration.tenantId);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const client = createImpressoRxClient({
      control,
      grantMasterKeyB64: randomBytes(32).toString("base64"),
      enrolment,
      onSnapshot: (membershipId, snapshot) => memberships.applySnapshot(membershipId, snapshot),
      fetchImpl: fake.fetch,
      logger,
    });

    let session: { identityId?: string; sessionId?: string; membershipId?: string } = {};
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (session.identityId) {
        req.identityId = session.identityId;
        req.userId = session.identityId;
      }
      next();
    });
    app.use(
      "/api/auth/handoff",
      createTokenAuthMiddleware(TOKEN),
      createHandoffRouter({ registrations, enrolment, identities, memberships, jti: new UsedHandoffJti(control), openTenant: (id) => gate.openTenant(id), client, logger }),
    );
    const deps = {
      identities,
      intents: new LinkIntentRepository(control),
      registrations,
      ensurePersonalUser: () => undefined,
      hasAttendedGrant: (sessionId: string, identityId: string, membershipId: string) => client.hasAttendedGrant(sessionId, identityId, membershipId),
      releaseGrants: (grantIds: string[]) => client.releaseGrants(grantIds),
      logger,
    };
    app.use("/api/identity/link", createTokenAuthMiddleware(TOKEN), createIdentityLinkRouter(deps));
    app.use("/api/identity", requireUser, createIdentitySessionRouter(deps));

    const launch = async (staffUserId = "staff-1") => {
      const sessionId = randomUUID();
      const res = await request(app)
        .post("/api/auth/handoff/redeem")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ handoff: await fake.mintHandoff(staffUserId), sessionId, origin: ORIGIN });
      expect(res.status).toBe(200);
      const grantId = (control.prepare("SELECT id FROM delegation_grants WHERE session_id = ?").get(sessionId) as { id: string }).id;
      return { identityId: res.body.identityId as string, membershipId: res.body.membershipId as string, sessionId, grantId };
    };
    const startIntent = async (identityId: string) => {
      session = { identityId };
      const res = await request(app).post("/api/identity/link-intent").send({});
      return res.body as { linkIntentId: string; secret: string };
    };
    return { app, control, fake, client, logger, google, launch, startIntent, asSession: (identityId: string) => void (session = { identityId }) };
  }

  it("a merge forgets the old identity's cached token and revokes its grant at ImpressoRx", async () => {
    const s = await setup();
    const staff = await s.launch();
    const grant = s.client.forGrant(staff.grantId);
    await grant.accessToken(); // cached since the hand-off
    const intent = await s.startIntent(staff.identityId);

    const res = await request(s.app)
      .post("/api/identity/link")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ ...intent, login: { kind: "google", subject: "g-sub", email: "g@x.com" } });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ merged: true, identityId: s.google.id });
    await expect(grant.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
    await vi.waitFor(() => expect(s.fake.grants.get(staff.grantId)!.status).toBe("revoked"));
  });

  it("an unlink does the same for the moved membership's grants", async () => {
    const s = await setup();
    const first = await s.launch();
    const intent = await s.startIntent(first.identityId);
    await request(s.app)
      .post("/api/identity/link")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ ...intent, login: { kind: "google", subject: "g-sub", email: "g@x.com" } })
      .expect(200);
    // The next hand-off opens a new grant under the merged identity.
    const second = await s.launch();
    expect(second.identityId).toBe(s.google.id);
    const grant = s.client.forGrant(second.grantId);
    await grant.accessToken();
    const loginId = (s.control.prepare("SELECT id FROM login_identities WHERE kind = 'impressorx'").get() as { id: string }).id;
    s.asSession(s.google.id);

    const res = await request(s.app).post("/api/identity/unlink").send({ loginIdentityId: loginId });

    expect(res.status).toBe(200);
    await expect(grant.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
    await vi.waitFor(() => expect(s.fake.grants.get(second.grantId)!.status).toBe("revoked"));
  });

  it("an unreachable ImpressoRx does not fail the link: the token is still forgotten and a warning is logged", async () => {
    const s = await setup();
    const staff = await s.launch();
    const grant = s.client.forGrant(staff.grantId);
    await grant.accessToken();
    const intent = await s.startIntent(staff.identityId);
    s.fake.networkFailure = true;

    const res = await request(s.app)
      .post("/api/identity/link")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ ...intent, login: { kind: "google", subject: "g-sub", email: "g@x.com" } });

    expect(res.status).toBe(200);
    // The release runs after the response; ImpressoRx stays unreachable until it has tried and given up.
    await vi.waitFor(() => expect(s.logger.warn).toHaveBeenCalledWith("Revoking a grant at ImpressoRx failed", expect.anything()));
    s.fake.networkFailure = false;
    await expect(grant.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
    expect(s.fake.grants.get(staff.grantId)!.status).toBe("active");
  });
});
