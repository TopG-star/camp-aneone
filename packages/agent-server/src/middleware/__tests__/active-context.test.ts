import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Logger, PersonalDb, TenantDb } from "@oneon/domain";
import { randomBytes } from "node:crypto";
import {
  EnrolmentService,
  FakeImpressorx,
  ImpressoRxRefusedError,
  ImpressoRxUnauthorizedError,
  ImpressoRxUnreachableError,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRefusedError,
  TenantRegistrationRepository,
  createDatabase,
  createImpressoRxClient,
  openControlDb,
  runMigrations,
  type MembershipSnapshot,
} from "@oneon/infrastructure";
import { createSnapshotRefresher, resolveActiveContext } from "../active-context.js";

const SUSPENDED_MESSAGE = "This pharmacy has switched Oneon off, or your account is inactive.";

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function tenantDb(): TenantDb {
  const raw = createDatabase(":memory:");
  runMigrations(raw);
  return { kind: "tenant", tenantId: "tenant-1", raw, __brand: "TenantDb" };
}

function app(deps: { openTenant: (id: string) => TenantDb; log: Logger }) {
  const a = express();
  a.use((req, _res, next) => {
    req.identityId = "i1";
    req.userId = "i1";
    req.sessionId = "s1";
    req.sessionContext = { kind: "tenant", membershipId: "m1" };
    next();
  });
  a.use(
    resolveActiveContext({
      gate: { openPersonal: () => ({}) as PersonalDb, openTenant: deps.openTenant },
      memberships: { findById: () => ({ id: "m1", identityId: "i1", tenantRegistrationId: "reg-1", status: "active" }) as never },
      identities: { hasLogin: () => false },
      snapshots: { ensureFresh: async () => ({ ok: true }) },
      logger: deps.log,
    }),
  );
  a.get("/", (req, res) => res.json(req.activeContext));
  return a;
}

describe("resolveActiveContext", () => {
  it("logs a gate refusal with its code and the membership id before answering 403", async () => {
    const log = logger();
    const res = await request(
      app({
        log,
        openTenant: () => {
          throw new TenantRefusedError("tenant_schema_behind");
        },
      }),
    ).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: "tenant_schema_behind", membershipId: "m1" }));
  });

  it("logs an unexpected error too", async () => {
    const log = logger();
    const res = await request(
      app({
        log,
        openTenant: () => {
          throw new Error("SQLITE_BUSY");
        },
      }),
    ).get("/");

    expect(res.status).toBe(403);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: "SQLITE_BUSY", membershipId: "m1" }));
  });

  it("a tenant context carries the registration id beside the rows' tenant id", async () => {
    const res = await request(app({ log: logger(), openTenant: () => tenantDb() })).get("/");

    expect(res.body).toEqual({
      kind: "tenant",
      identityId: "i1",
      membershipId: "m1",
      registrationId: "reg-1",
      tenantId: "tenant-1",
    });
  });
});

describe("snapshot refresh (spec 4.6: at least every 5 minutes while a session is active)", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const SNAPSHOT: MembershipSnapshot = { userId: "staff-1", role: "Manager", permissions: ["jobs.read"], locationIds: ["l1"], tokenVersion: 1, tenantStatus: "Active" };

  function setup(opts: { bound?: boolean; session?: boolean; client?: "none" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "active-context-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    let now = Date.parse("2026-10-08T10:00:00Z");
    const clock = () => new Date(now);
    const advance = (ms: number) => {
      now += ms;
    };
    const identityId = new SqliteIdentityRepository(control).createWithLogin({ kind: "impressorx", subject: "reg:staff-1" }).id;
    control
      .prepare(
        "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('reg-1', 'tenant-1', 'acme', 'Acme Pharmacy', 'https://acme.example', 'reg-1.db', 'active', ?, 'now')",
      )
      .run(identityId);
    const memberships = new MembershipRepository(control, clock);
    const membership = memberships.upsertFromHandoff({ identityId, tenantRegistrationId: "reg-1", externalUserId: "staff-1", role: "Manager" });
    memberships.applySnapshot(membership.id, SNAPSHOT);

    // What the real client does: me() asks the deployment, and its onSnapshot hook writes the membership.
    let meImpl: () => Promise<MembershipSnapshot> = async () => {
      memberships.applySnapshot(membership.id, SNAPSHOT);
      return SNAPSHOT;
    };
    const me = vi.fn(() => meImpl());
    const client = {
      forBoundSession: vi.fn(() => (opts.bound === false ? null : { me })),
      revokeForMembership: vi.fn(),
    };
    const log = logger();
    const openTenant = vi.fn(() => tenantDb());
    const a = express();
    a.use((req, _res, next) => {
      req.identityId = identityId;
      req.userId = identityId;
      if (opts.session !== false) req.sessionId = "s1";
      req.sessionContext = { kind: "tenant", membershipId: membership.id };
      next();
    });
    a.use(
      resolveActiveContext({
        gate: { openPersonal: () => ({}) as PersonalDb, openTenant },
        memberships,
        identities: { hasLogin: () => false },
        snapshots: createSnapshotRefresher({ memberships, registrations: new TenantRegistrationRepository(control), client: opts.client === "none" ? null : client, logger: log, clock }),
        logger: log,
      }),
    );
    a.get("/", (req, res) => res.json({ ok: true, context: req.activeContext?.kind }));
    return {
      app: a, advance, memberships, membership, identityId, me, client, log, openTenant, control,
      setMe: (impl: () => Promise<MembershipSnapshot>) => (meImpl = impl),
      snapshotAt: () => memberships.findById(membership.id)!.snapshotAt,
    };
  }

  it("refreshes a snapshot older than 5 minutes and not a newer one", async () => {
    const s = setup();
    const before = s.snapshotAt();

    s.advance(300_000); // exactly 5 minutes is not older than 5 minutes
    expect((await request(s.app).get("/")).status).toBe(200);
    expect(s.me).not.toHaveBeenCalled();
    expect(s.snapshotAt()).toBe(before);

    s.advance(1_000);
    expect((await request(s.app).get("/")).status).toBe(200);
    expect(s.me).toHaveBeenCalledTimes(1);
    expect(s.snapshotAt()).not.toBe(before);

    expect((await request(s.app).get("/")).status).toBe(200); // the refresh made it newer
    expect(s.me).toHaveBeenCalledTimes(1);
  });

  it("refreshes through the grant bound to the session, the identity and the membership", async () => {
    const s = setup();
    s.advance(301_000);

    await request(s.app).get("/");

    expect(s.client.forBoundSession).toHaveBeenCalledWith("s1", s.identityId, s.membership.id);
    expect(Object.keys(s.client)).not.toContain("forSession"); // the unbound lookup is not even available to the middleware
  });

  it("a refused refresh suspends the membership, revokes its grants and returns 403", async () => {
    const s = setup();
    s.setMe(async () => {
      throw new ImpressoRxUnauthorizedError();
    });
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "membership_suspended", message: SUSPENDED_MESSAGE });
    expect(s.memberships.findById(s.membership.id)!.status).toBe("suspended");
    expect(s.client.revokeForMembership).toHaveBeenCalledWith(s.membership.id, "membership_suspended");
    expect(s.openTenant).not.toHaveBeenCalled(); // no context opens
  });

  it("an unreachable ImpressoRx keeps the cached snapshot and logs a warning", async () => {
    const s = setup();
    s.setMe(async () => {
      throw new ImpressoRxUnreachableError();
    });
    const before = s.snapshotAt();
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(200);
    expect(s.snapshotAt()).toBe(before);
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.client.revokeForMembership).not.toHaveBeenCalled();
    expect(s.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ membershipId: s.membership.id }));
  });

  it("a stale snapshot without a usable bound grant asks for a relaunch and suspends nothing", async () => {
    const s = setup({ bound: false });
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "launch_required", message: expect.stringMatching(/ImpressoRx/) });
    expect(s.me).not.toHaveBeenCalled();
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.client.revokeForMembership).not.toHaveBeenCalled();
  });

  it("a Google session on a linked membership (no session id) or without a client also needs a relaunch when stale", async () => {
    const google = setup({ session: false });
    google.advance(301_000);
    expect((await request(google.app).get("/")).body.error).toBe("launch_required");
    expect(google.client.forBoundSession).not.toHaveBeenCalled();

    const unconfigured = setup({ client: "none" });
    unconfigured.advance(301_000);
    expect((await request(unconfigured.app).get("/")).body.error).toBe("launch_required");
    expect(unconfigured.memberships.findById(unconfigured.membership.id)!.status).toBe("active");
  });

  it("a fresh snapshot needs no grant at all", async () => {
    const s = setup({ bound: false });
    s.advance(60_000);

    expect((await request(s.app).get("/")).status).toBe(200);
  });

  it.each([
    ["a refusal made locally", new ImpressoRxRefusedError("Grant has expired"), "Grant has expired"],
    ["an unexpected status", new ImpressoRxRefusedError("ImpressoRx answered 404", 404), "ImpressoRx answered 404"],
  ])("%s asks for a relaunch, suspends nothing and logs why", async (_name, refusal, reason) => {
    const s = setup();
    s.setMe(async () => {
      throw refusal;
    });
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("launch_required");
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.client.revokeForMembership).not.toHaveBeenCalled();
    expect(s.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ membershipId: s.membership.id, status: refusal.status, reason }));
  });

  it("an inactive registration is the gate's own refusal, with no call to ImpressoRx and no side effect", async () => {
    const s = setup();
    s.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = 'reg-1'").run();
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
    expect(s.client.forBoundSession).not.toHaveBeenCalled();
    expect(s.me).not.toHaveBeenCalled();
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.client.revokeForMembership).not.toHaveBeenCalled();
  });

  it("after an unreachable refresh, no new refresh is tried for 30 seconds", async () => {
    const s = setup();
    s.setMe(async () => {
      throw new ImpressoRxUnreachableError();
    });
    const before = s.snapshotAt();
    s.advance(301_000);

    expect((await request(s.app).get("/")).status).toBe(200);
    expect(s.me).toHaveBeenCalledTimes(1);

    s.advance(29_000);
    expect((await request(s.app).get("/")).status).toBe(200);
    expect((await request(s.app).get("/")).status).toBe(200);
    expect(s.me).toHaveBeenCalledTimes(1); // still inside the cooldown: the cached snapshot is kept
    expect(s.snapshotAt()).toBe(before);

    s.advance(1_000);
    expect((await request(s.app).get("/")).status).toBe(200);
    expect(s.me).toHaveBeenCalledTimes(2); // the cooldown is over
  });

  it("the cooldown does not hide a missing grant", async () => {
    const s = setup();
    s.setMe(async () => {
      throw new ImpressoRxUnreachableError();
    });
    s.advance(301_000);
    await request(s.app).get("/");

    s.client.forBoundSession.mockReturnValueOnce(null);
    expect((await request(s.app).get("/")).body.error).toBe("launch_required"); // inside the cooldown, but this session has no usable grant
  });

  it("a snapshot that reports the tenant not serviceable suspends the membership and kills its grants", async () => {
    const s = setup();
    s.setMe(async () => {
      s.memberships.applySnapshot(s.membership.id, { ...SNAPSHOT, tenantStatus: "Suspended" });
      return { ...SNAPSHOT, tenantStatus: "Suspended" };
    });
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("membership_suspended");
    expect(s.client.revokeForMembership).toHaveBeenCalledWith(s.membership.id, "membership_suspended");
  });

  it("a suspended membership gets the suspended message without any call to ImpressoRx", async () => {
    const s = setup();
    s.memberships.setStatus(s.membership.id, "suspended");
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "membership_suspended", message: SUSPENDED_MESSAGE });
    expect(s.me).not.toHaveBeenCalled();
  });

  it("concurrent requests share one in-flight refresh, and the next stale request starts a new one", async () => {
    const s = setup();
    let finish!: () => void;
    s.setMe(
      () =>
        new Promise<MembershipSnapshot>((resolve) => {
          finish = () => {
            s.memberships.applySnapshot(s.membership.id, SNAPSHOT);
            resolve(SNAPSHOT);
          };
        }),
    );
    s.advance(301_000);

    const pending = [1, 2, 3].map(() => request(s.app).get("/").then((r) => r));
    await vi.waitFor(() => expect(s.client.forBoundSession).toHaveBeenCalledTimes(3));
    finish();
    const replies = await Promise.all(pending);

    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(s.me).toHaveBeenCalledTimes(1);

    s.advance(301_000);
    s.setMe(async () => {
      s.memberships.applySnapshot(s.membership.id, SNAPSHOT);
      return SNAPSHOT;
    });
    expect((await request(s.app).get("/")).status).toBe(200);
    expect(s.me).toHaveBeenCalledTimes(2);
  });

  it("concurrent requests all see a refusal from the one shared refresh", async () => {
    const s = setup();
    let fail!: () => void;
    s.setMe(
      () =>
        new Promise<MembershipSnapshot>((_resolve, reject) => {
          fail = () => reject(new ImpressoRxUnauthorizedError());
        }),
    );
    s.advance(301_000);

    const pending = [1, 2].map(() => request(s.app).get("/").then((r) => r));
    await vi.waitFor(() => expect(s.client.forBoundSession).toHaveBeenCalledTimes(2));
    fail();
    const replies = await Promise.all(pending);

    expect(replies.map((r) => r.body.error)).toEqual(["membership_suspended", "membership_suspended"]);
    expect(s.me).toHaveBeenCalledTimes(1);
    expect(s.client.revokeForMembership).toHaveBeenCalledTimes(1);
  });
});

describe("snapshot refresh against the fake deployment (what ImpressoRx really sends)", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const ORIGIN = "https://acme.example";

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "active-context-fake-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    let now = Date.now();
    const clock = () => new Date(now);
    const advance = (ms: number) => {
      now += ms;
    };
    const identityId = new SqliteIdentityRepository(control).createWithLogin({ kind: "impressorx", subject: "reg:staff-1" }).id;
    const registrations = new TenantRegistrationRepository(control);
    const fake = new FakeImpressorx(ORIGIN, "acme", "ABCD-EFGH-JKLM", clock);
    const sent: string[] = [];
    const fetchImpl = (input: string | URL, init?: RequestInit) => {
      sent.push(new URL(input.toString()).pathname);
      return fake.fetch(input, init);
    };
    const enrolment = new EnrolmentService({ repo: registrations, oneonOrigin: "https://oneon.example", masterKeyB64: randomBytes(32).toString("base64"), fetchImpl, clock });
    const registration = await enrolment.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: "ABCD-EFGH-JKLM", enrolledBy: identityId });
    const memberships = new MembershipRepository(control, clock);
    const membership = memberships.upsertFromHandoff({ identityId, tenantRegistrationId: registration.id, externalUserId: "staff-1", role: "Manager" });
    const log = logger();
    const client = createImpressoRxClient({
      control,
      grantMasterKeyB64: randomBytes(32).toString("base64"),
      enrolment,
      onSnapshot: (id, snapshot) => memberships.applySnapshot(id, snapshot),
      fetchImpl,
      logger: log,
      clock,
    });
    const { grantId } = await client.exchangeHandoff(registration.id, await fake.mintHandoff("staff-1"), "s1", identityId, membership.id, "staff-1");
    sent.length = 0;

    const a = express();
    a.use((req, _res, next) => {
      req.identityId = identityId;
      req.userId = identityId;
      req.sessionId = "s1";
      req.sessionContext = { kind: "tenant", membershipId: membership.id };
      next();
    });
    a.use(
      resolveActiveContext({
        gate: { openPersonal: () => ({}) as PersonalDb, openTenant: () => tenantDb() },
        memberships,
        identities: { hasLogin: () => false },
        snapshots: createSnapshotRefresher({ memberships, registrations, client, logger: log, clock }),
        logger: log,
      }),
    );
    a.get("/", (_req, res) => res.json({ ok: true }));
    const grantStatuses = () => control.prepare("SELECT status, revoked_reason FROM delegation_grants").all() as Array<{ status: string; revoked_reason: string | null }>;
    return { app: a, fake, advance, control, membership, memberships, grantId, sent, log, grantStatuses };
  }

  it("a real 401 on the token exchange suspends the membership and revokes its grants locally", async () => {
    const s = await setup();
    s.fake.grants.get(s.grantId)!.status = "revoked"; // ImpressoRx no longer honours the grant
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "membership_suspended", message: SUSPENDED_MESSAGE });
    expect(s.memberships.findById(s.membership.id)!.status).toBe("suspended");
    expect(s.grantStatuses()).toEqual([{ status: "revoked", revoked_reason: "membership_suspended" }]);
  });

  it("a real 401 from GET /me suspends the membership too", async () => {
    const s = await setup();
    s.fake.grants.get(s.grantId)!.status = "revoked";
    s.control.prepare("UPDATE memberships SET snapshot_at = ? WHERE id = ?").run(new Date(0).toISOString(), s.membership.id); // stale, but the cached access token is still good

    const res = await request(s.app).get("/");

    expect(s.sent).toEqual(["/api/oneon/me"]);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("membership_suspended");
    expect(s.memberships.findById(s.membership.id)!.status).toBe("suspended");
    expect(s.grantStatuses()).toEqual([{ status: "revoked", revoked_reason: "membership_suspended" }]);
  });

  it("an operator-suspended registration does not suspend the membership and sends nothing to ImpressoRx", async () => {
    const s = await setup();
    s.control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator'").run();
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "context_unavailable" });
    expect(s.sent).toEqual([]);
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.grantStatuses()).toEqual([{ status: "active", revoked_reason: null }]);
  });

  it.each([404, 400, 302])("a %i from GET /me asks for a relaunch, suspends nothing and logs the status", async (status) => {
    const s = await setup();
    s.fake.meStatus = status;
    s.advance(301_000);

    const res = await request(s.app).get("/");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("launch_required");
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.grantStatuses()).toEqual([{ status: "active", revoked_reason: null }]);
    expect(s.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ membershipId: s.membership.id, status }));
  });

  it("a healthy ImpressoRx refreshes the snapshot through the bound grant", async () => {
    const s = await setup();
    const before = s.memberships.findById(s.membership.id)!.snapshotAt;
    s.advance(301_000);

    expect((await request(s.app).get("/")).status).toBe(200);

    expect(s.memberships.findById(s.membership.id)!.snapshotAt).not.toBe(before);
    expect(s.sent).toContain("/api/oneon/me");
  });
});
