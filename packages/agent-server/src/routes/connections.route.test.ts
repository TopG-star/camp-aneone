import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsViewSchema, RevokeConnectionResultSchema } from "@oneon/contracts";
import type { ContextDb } from "@oneon/domain";
import {
  ContextDbGate,
  EnrolmentService,
  FakeImpressorx,
  ImpressoRxRefusedError,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  createImpressoRxClient,
  ensureIdentityAnchor,
  openControlDb,
} from "@oneon/infrastructure";
import { contextRepos } from "../context-wiring.js";
import { requireUser } from "../middleware/require-user.js";
import { createConnectionsRouter } from "./connections.route.js";

const ORIGIN_A = "https://acme.example";
const ORIGIN_B = "https://beta.example";
const CODE = "ABCD-EFGH-JKLM";
const HOUR = 3_600_000;

// The whole path with a real client against fake deployments: grants opened by hand-offs and issues, listed and revoked
// through the route, and pharmacy files read through the real gate.
describe("Settings → Connections routes", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "connections-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => control.close(), () => gate.close());
    const identities = new SqliteIdentityRepository(control, (id) => gate.openTenant(id));
    const memberships = new MembershipRepository(control);
    const registrations = new TenantRegistrationRepository(control);

    const person = identities.createWithLogin({ kind: "google", subject: "p-sub", email: "p@x.com" });
    const other = identities.createWithLogin({ kind: "google", subject: "q-sub", email: "q@x.com" });

    const fakeA = new FakeImpressorx(ORIGIN_A, "acme", CODE);
    const fakeB = new FakeImpressorx(ORIGIN_B, "beta", CODE);
    const fetchImpl = (input: string | URL, init?: RequestInit) => (String(input).startsWith(ORIGIN_B) ? fakeB.fetch(input, init) : fakeA.fetch(input, init));
    const enrolment = new EnrolmentService({ repo: registrations, oneonOrigin: "https://oneon.example", masterKeyB64: randomBytes(32).toString("base64"), fetchImpl });
    const regA = await enrolment.enrol({ origin: ORIGIN_A, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: person.id, displayName: "Acme Pharmacy" });
    const regB = await enrolment.enrol({ origin: ORIGIN_B, tenantSlug: "beta", enrolmentCode: CODE, enrolledBy: person.id, displayName: "Beta Pharmacy" });
    gate.createTenantFile(regA.id, regA.tenantId);
    gate.createTenantFile(regB.id, regB.tenantId);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const client = createImpressoRxClient({
      control,
      grantMasterKeyB64: randomBytes(32).toString("base64"),
      enrolment,
      onSnapshot: (membershipId, snapshot) => memberships.applySnapshot(membershipId, snapshot),
      fetchImpl,
      logger,
      sleep: async () => undefined,
    });

    const member = (identityId: string, reg: { id: string }, staff: string) => memberships.upsertFromHandoff({ identityId, tenantRegistrationId: reg.id, externalUserId: staff, role: "manager" });
    const personA = member(person.id, regA, "staff-pa");
    const personB = member(person.id, regB, "staff-pb");
    const otherA = member(other.id, regA, "staff-qa");
    const launch = async (fake: FakeImpressorx, reg: { id: string }, identityId: string, membershipId: string, staff: string, sessionId: string) => {
      const { grantId } = await client.exchangeHandoff(reg.id, await fake.mintHandoff(staff), sessionId, identityId, membershipId, staff);
      return grantId;
    };
    const grants = {
      personA: await launch(fakeA, regA, person.id, personA.id, "staff-pa", "sess-pa"),
      personB: await launch(fakeB, regB, person.id, personB.id, "staff-pb", "sess-pb"),
      otherA: await launch(fakeA, regA, other.id, otherA.id, "staff-qa", "sess-qa"),
    };

    // Tenant actions: the registry is a stand-in (B-core registers no tenant action types), the repository is the real one.
    const trail: string[] = [];
    const listFilters: unknown[] = [];
    const registry = { has: (type: string) => type === "inventory_transfer", get: () => ({ label: "Transfer stock" }) };
    const actionsFor = (db: ContextDb) => {
      const real = contextRepos(db).actionInstances;
      return {
        registry,
        instanceRepo: {
          ...real,
          list: (...args: Parameters<typeof real.list>) => (trail.push(`read ${db.kind === "tenant" ? db.tenantId : "personal"}`), listFilters.push(args[1]), real.list(...args)),
        },
      } as never;
    };
    const openTenant = (id: string) => (trail.push(`open ${id}`), gate.openTenant(id));
    let counter = 0;
    const failAction = (reg: { id: string }, userId: string, code: string, over: { type?: string; status?: "failed" | "completed"; retryOf?: string } = {}) => {
      const db = gate.openTenant(reg.id);
      ensureIdentityAnchor(db, userId);
      const repo = contextRepos(db).actionInstances;
      const id = `action-${++counter}`;
      const actor = { kind: "system" } as const;
      repo.create(
        {
          id, scope: "tenant", ownerId: db.tenantId, userId, tenantId: db.tenantId, locationIds: [], actionType: over.type ?? "inventory_transfer",
          definitionVersion: "1", initiator: "user", initiatorUserId: userId, input: {}, evidence: [], idempotencyKey: id, retryOf: over.retryOf ?? null,
          attemptNumber: over.retryOf ? 2 : 1, resourceRef: null,
        },
        actor,
      );
      repo.appendTransition({ actionId: id, expectedStatus: "proposed", toStatus: "validating", actor });
      repo.appendTransition({ actionId: id, expectedStatus: "validating", toStatus: "approved", actor });
      if (over.status === "completed") {
        repo.appendTransition({ actionId: id, expectedStatus: "approved", toStatus: "executing", actor });
        repo.appendTransition({ actionId: id, expectedStatus: "executing", toStatus: "verifying", actor });
        repo.appendTransition({ actionId: id, expectedStatus: "verifying", toStatus: "completed", actor });
      } else {
        repo.appendTransition({ actionId: id, expectedStatus: "approved", toStatus: "failed", actor, patch: { error: { code, message: "x", stage: "recheck" } } });
      }
      return { id, updatedAt: repo.findById(db.tenantId, id)!.updatedAt };
    };

    // Session auth has already run: this stands in for it. A hand-off session also carries a session id and its context.
    let session: { identityId?: string; sessionId?: string; membershipId?: string } = {};
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (session.identityId) {
        req.identityId = session.identityId;
        req.userId = session.identityId;
      }
      if (session.sessionId && session.membershipId) {
        req.sessionId = session.sessionId;
        req.sessionContext = { kind: "tenant", membershipId: session.membershipId };
      }
      next();
    });
    app.use("/api/connections", requireUser, createConnectionsRouter({ client, memberships, registrations, openTenant, actionsFor, logger }));
    const asSession = (identityId: string | undefined, handoff?: { sessionId: string; membershipId: string }) => void (session = { identityId, ...handoff });

    asSession(person.id);
    return {
      app, control, gate, client, logger, trail, listFilters, person, other, regA, regB, personA, personB, otherA, grants, fakeA, fakeB, failAction, asSession, enrolment,
    };
  }

  describe("GET /api/connections", () => {
    it("lists only the caller's grants, as metadata the page can show", async () => {
      const s = await setup();

      const res = await request(s.app).get("/api/connections");

      expect(res.status).toBe(200);
      expect(ConnectionsViewSchema.safeParse(res.body).success).toBe(true);
      const byId = new Map<string, Record<string, unknown>>((res.body.grants as Array<{ id: string }>).map((g) => [g.id, g]));
      expect([...byId.keys()].sort()).toEqual([s.grants.personA, s.grants.personB].sort());
      expect(byId.get(s.grants.personA)).toEqual({
        id: s.grants.personA,
        tenantName: "Acme Pharmacy",
        kind: "attended",
        scope: [],
        createdAt: expect.any(String),
        lastUsedAt: null,
        expiresAt: expect.any(String),
        status: "active",
        current: false,
      });
      expect(byId.get(s.grants.personB)).toMatchObject({ tenantName: "Beta Pharmacy" });
      // The sooner of the idle and the absolute expiry: an attended grant is idle for 30 minutes.
      const idle = Date.parse(byId.get(s.grants.personA)!.expiresAt as string) - Date.parse(byId.get(s.grants.personA)!.createdAt as string);
      expect(Math.abs(idle - 30 * 60 * 1000)).toBeLessThan(1000);
      // Nothing that opens a connection leaves the server.
      expect(JSON.stringify(res.body)).not.toContain(s.fakeA.grantValue(s.grants.personA)!);
      expect(JSON.stringify(res.body)).not.toContain("sess-pa");

      s.asSession(s.other.id);
      const theirs = await request(s.app).get("/api/connections");
      expect((theirs.body.grants as Array<{ id: string }>).map((g) => g.id)).toEqual([s.grants.otherA]);
    });

    it("lists the unattended grants a person's actions hold, with their scope", async () => {
      const s = await setup();
      const { grantId } = await s.client
        .forBoundSession("sess-pa", s.person.id, s.personA.id)!
        .issue({ kind: "action", oneonActionId: "act-1", scope: ["jobs.read"], absoluteExpiresAt: new Date(Date.now() + 24 * HOUR).toISOString() });

      const res = await request(s.app).get("/api/connections");

      expect(res.body.grants).toContainEqual(expect.objectContaining({ id: grantId, kind: "action", scope: ["jobs.read"], tenantName: "Acme Pharmacy", status: "active" }));
    });

    it("lists only live grants: a revoked grant and one past its expiry are not connections", async () => {
      const s = await setup();
      s.control.prepare("UPDATE delegation_grants SET status = 'revoked', revoked_reason = 'test' WHERE id = ?").run(s.grants.personB);
      s.control.prepare("UPDATE delegation_grants SET absolute_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(s.grants.personA);

      const res = await request(s.app).get("/api/connections");

      expect(res.body.grants).toEqual([]);
    });

    it("marks the grant of the session the request comes from as current, and no other", async () => {
      const s = await setup();
      s.asSession(s.person.id, { sessionId: "sess-pa", membershipId: s.personA.id });

      const res = await request(s.app).get("/api/connections");

      const current = (res.body.grants as Array<{ id: string; current: boolean }>).filter((g) => g.current).map((g) => g.id);
      expect(current).toEqual([s.grants.personA]);
    });

    it("needs a session", async () => {
      const s = await setup();
      s.asSession(undefined);
      expect((await request(s.app).get("/api/connections")).status).toBe(401);
    });

    it("needsReconnect lists delegation_revoked actions across the caller's tenants, with the pharmacy, the action's label and when it failed", async () => {
      const s = await setup();
      const inA = s.failAction(s.regA, s.person.id, "delegation_revoked");
      const inB = s.failAction(s.regB, s.person.id, "delegation_revoked");
      // None of these is something to reconnect for.
      s.failAction(s.regA, s.person.id, "no_action_grant"); // has its own Retry message on the action
      s.failAction(s.regA, s.person.id, "approval_stale");
      s.failAction(s.regA, s.person.id, "delegation_revoked", { status: "completed" });
      s.failAction(s.regA, s.other.id, "delegation_revoked"); // a colleague's action in the same pharmacy file

      const res = await request(s.app).get("/api/connections");

      expect(res.status).toBe(200);
      expect(res.body.unavailable).toEqual([]);
      expect([...res.body.needsReconnect].sort((x: { actionId: string }, y: { actionId: string }) => x.actionId.localeCompare(y.actionId))).toEqual([
        { tenantName: "Acme Pharmacy", membershipId: s.personA.id, actionId: inA.id, label: "Transfer stock", failedAt: inA.updatedAt },
        { tenantName: "Beta Pharmacy", membershipId: s.personB.id, actionId: inB.id, label: "Transfer stock", failedAt: inB.updatedAt },
      ]);
    });

    it("leaves out an original that was retried, but lists a retry that failed again with delegation_revoked", async () => {
      const s = await setup();
      const retriedAndDone = s.failAction(s.regA, s.person.id, "delegation_revoked");
      s.failAction(s.regA, s.person.id, "unused", { status: "completed", retryOf: retriedAndDone.id });
      const failedTwice = s.failAction(s.regA, s.person.id, "delegation_revoked");
      const retryFailedAgain = s.failAction(s.regA, s.person.id, "delegation_revoked", { retryOf: failedTwice.id });
      const neverRetried = s.failAction(s.regA, s.person.id, "delegation_revoked");

      const res = await request(s.app).get("/api/connections");

      expect((res.body.needsReconnect as Array<{ actionId: string }>).map((a) => a.actionId).sort()).toEqual([retryFailedAgain.id, neverRetried.id].sort());
    });

    it("asks only for the caller's own failed actions that were not retried, so a colleague's are never read, and does not list them", async () => {
      const s = await setup();
      s.failAction(s.regA, s.other.id, "delegation_revoked");
      const mine = s.failAction(s.regA, s.person.id, "delegation_revoked");

      const res = await request(s.app).get("/api/connections");

      expect((res.body.needsReconnect as Array<{ actionId: string }>).map((a) => a.actionId)).toEqual([mine.id]);
      expect(s.listFilters.length).toBeGreaterThan(0);
      for (const filter of s.listFilters) expect(filter).toMatchObject({ statuses: ["failed"], userId: s.person.id, excludeRetried: true });
    });

    it("names an action type the registry does not know by its type rather than failing", async () => {
      const s = await setup();
      s.failAction(s.regA, s.person.id, "delegation_revoked", { type: "retired_type" });

      const res = await request(s.app).get("/api/connections");

      expect(res.body.needsReconnect).toEqual([expect.objectContaining({ label: "retired_type" })]);
    });

    it("only reads the files of the caller's active memberships, one at a time", async () => {
      const s = await setup();
      s.failAction(s.regA, s.other.id, "delegation_revoked");
      s.trail.length = 0;
      s.control.prepare("UPDATE memberships SET status = 'suspended' WHERE id = ?").run(s.personB.id);

      const res = await request(s.app).get("/api/connections");

      expect(res.body.needsReconnect).toEqual([]);
      expect(s.trail).toEqual([`open ${s.regA.id}`, `read ${s.regA.tenantId}`]);
    });

    it("opens each pharmacy file, reads it, and only then opens the next", async () => {
      const s = await setup();
      const tenantOf = new Map([[s.regA.id, s.regA.tenantId], [s.regB.id, s.regB.tenantId]]);
      s.trail.length = 0;

      await request(s.app).get("/api/connections");

      expect(s.trail.map((entry) => entry.split(" ")[0])).toEqual(["open", "read", "open", "read"]);
      expect(new Set(s.trail.filter((entry) => entry.startsWith("open")))).toEqual(new Set([`open ${s.regA.id}`, `open ${s.regB.id}`]));
      for (const [i, entry] of s.trail.entries()) if (entry.startsWith("open")) expect(s.trail[i + 1]).toBe(`read ${tenantOf.get(entry.slice(5))}`);
    });

    it("skips a pharmacy file that will not open, says so, logs it and still lists the others", async () => {
      const s = await setup();
      const inA = s.failAction(s.regA, s.person.id, "delegation_revoked");
      s.failAction(s.regB, s.person.id, "delegation_revoked");
      s.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = ?").run(s.regB.id);

      const res = await request(s.app).get("/api/connections");

      expect(res.status).toBe(200);
      expect(res.body.needsReconnect).toEqual([expect.objectContaining({ actionId: inA.id, tenantName: "Acme Pharmacy" })]);
      expect(res.body.unavailable).toEqual(["Beta Pharmacy"]);
      expect(s.logger.warn).toHaveBeenCalledWith("Connections could not read a pharmacy file", expect.objectContaining({ registrationId: s.regB.id }));
      // The grants do not depend on the file.
      expect(res.body.grants).toHaveLength(2);
    });

    it("lists a pharmacy once however many memberships the person has there", async () => {
      const s = await setup();
      s.failAction(s.regA, s.person.id, "delegation_revoked");
      const extra = new MembershipRepository(s.control).upsertFromHandoff({ identityId: s.person.id, tenantRegistrationId: s.regA.id, externalUserId: "staff-pa-2", role: "manager" });
      s.trail.length = 0;

      const res = await request(s.app).get("/api/connections");

      expect(res.body.needsReconnect).toHaveLength(1);
      expect(s.trail.filter((entry) => entry === `open ${s.regA.id}`)).toHaveLength(1);
      // The caller's own membership at that pharmacy, which the page uses to tell whether the session is in it.
      expect([s.personA.id, extra.id]).toContain(res.body.needsReconnect[0].membershipId);
    });

    it("works in a pharmacy context too: a hand-off session sees its own connections, and nothing but the identity picks them", async () => {
      const s = await setup();
      s.asSession(s.person.id, { sessionId: "sess-pb", membershipId: s.personB.id });

      const res = await request(s.app).get("/api/connections?identityId=" + s.other.id + "&tenantId=" + s.regA.tenantId);

      expect(res.status).toBe(200);
      expect((res.body.grants as Array<{ id: string }>).map((g) => g.id).sort()).toEqual([s.grants.personA, s.grants.personB].sort());
    });
  });

  describe("POST /api/connections/:grantId/revoke", () => {
    it("revokes the grant at ImpressoRx and here, and the client forgets its cached token", async () => {
      const s = await setup();
      const grant = s.client.forGrant(s.grants.personA);
      await grant.accessToken(); // cached since the hand-off

      const res = await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({});

      expect(res.status).toBe(200);
      expect(RevokeConnectionResultSchema.safeParse(res.body).success).toBe(true);
      expect(res.body).toEqual({ remote: "revoked" });
      expect(s.fakeA.grants.get(s.grants.personA)!.status).toBe("revoked");
      expect(s.control.prepare("SELECT status, revoked_reason FROM delegation_grants WHERE id = ?").get(s.grants.personA)).toEqual({ status: "revoked", revoked_reason: "revoked_by_person" });
      await expect(grant.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
      // The other connections are untouched.
      expect(s.fakeB.grants.get(s.grants.personB)!.status).toBe("active");
      expect((await request(s.app).get("/api/connections")).body.grants.map((g: { id: string }) => g.id)).toEqual([s.grants.personB]);
    });

    it("answers 404 for another identity's grant, exactly as for one that does not exist, and changes nothing", async () => {
      const s = await setup();

      const theirs = await request(s.app).post(`/api/connections/${s.grants.otherA}/revoke`).send({ identityId: s.other.id });
      const missing = await request(s.app).post("/api/connections/no-such-grant/revoke").send({});

      expect(theirs.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(theirs.body).toEqual(missing.body);
      expect(theirs.body).toEqual({ error: "grant_not_found" });
      expect(s.control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(s.grants.otherA)).toEqual({ status: "active" });
      expect(s.fakeA.grants.get(s.grants.otherA)!.status).toBe("active");
    });

    it("when ImpressoRx cannot be reached the grant is still revoked here and the answer says so", async () => {
      const s = await setup();
      const grant = s.client.forGrant(s.grants.personA);
      await grant.accessToken();
      s.fakeA.networkFailure = true;

      const res = await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ remote: "unreachable" });
      expect(s.control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(s.grants.personA)).toEqual({ status: "revoked" });
      s.fakeA.networkFailure = false;
      await expect(grant.accessToken()).rejects.toBeInstanceOf(ImpressoRxRefusedError);
      expect(s.fakeA.grants.get(s.grants.personA)!.status).toBe("active");
    });

    it("is idempotent: revoking a grant again is a 200, and finishes a remote revoke that was missed", async () => {
      const s = await setup();
      s.fakeA.networkFailure = true;
      expect((await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({})).body).toEqual({ remote: "unreachable" });
      s.fakeA.networkFailure = false;

      const again = await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({});
      const third = await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({});

      expect(again.status).toBe(200);
      expect(again.body).toEqual({ remote: "revoked" });
      expect(third.status).toBe(200);
      expect(third.body).toEqual({ remote: "revoked" });
      expect(s.fakeA.grants.get(s.grants.personA)!.status).toBe("revoked");
    });

    it("revoking the grant of the session you are in signs that session out of the pharmacy", async () => {
      const s = await setup();
      expect(s.client.hasAttendedGrant("sess-pa", s.person.id, s.personA.id)).toBe(true);
      s.asSession(s.person.id, { sessionId: "sess-pa", membershipId: s.personA.id });

      const res = await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({});

      expect(res.status).toBe(200);
      expect(s.client.hasAttendedGrant("sess-pa", s.person.id, s.personA.id)).toBe(false);
    });

    it("needs a session", async () => {
      const s = await setup();
      s.asSession(undefined);
      expect((await request(s.app).post(`/api/connections/${s.grants.personA}/revoke`).send({})).status).toBe(401);
      expect(s.control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(s.grants.personA)).toEqual({ status: "active" });
    });

    it("without ImpressoRx delegation there are no grants to list or revoke", async () => {
      const s = await setup();
      const app = express();
      app.use((req, _res, next) => {
        req.identityId = s.person.id;
        req.userId = s.person.id;
        next();
      });
      app.use(
        "/api/connections",
        createConnectionsRouter({
          client: null,
          memberships: new MembershipRepository(s.control),
          registrations: new TenantRegistrationRepository(s.control),
          openTenant: (id) => s.gate.openTenant(id),
          actionsFor: () => ({ registry: { has: () => false, get: () => ({}) }, instanceRepo: { list: () => [] } }) as never,
          logger: s.logger,
        }),
      );

      const list = await request(app).get("/api/connections");
      const revoke = await request(app).post(`/api/connections/${s.grants.personA}/revoke`).send({});

      expect(list.body).toEqual({ grants: [], needsReconnect: [], unavailable: [] });
      expect(revoke.status).toBe(404);
    });
  });
});
