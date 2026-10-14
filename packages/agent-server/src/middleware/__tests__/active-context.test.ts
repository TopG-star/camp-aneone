import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Logger, PersonalDb, TenantDb } from "@oneon/domain";
import { randomBytes } from "node:crypto";
import {
  ContextDbGate,
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
  rawDb,
  runMigrations,
  type MembershipSnapshot,
  type TenantLease,
} from "@oneon/infrastructure";
import { createSnapshotRefresher, requirePersonalContext, resolveActiveContext } from "../active-context.js";

const SUSPENDED_MESSAGE = "This pharmacy has switched Oneon off, or your account is inactive.";

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function tenantDb(): TenantDb {
  const raw = createDatabase(":memory:");
  runMigrations(raw);
  return { kind: "tenant", tenantId: "tenant-1", raw, __brand: "TenantDb" };
}

/** A gate's lease over a plain open function, for tests that only care which handle is opened. */
function leaseOf(open: (id: string) => TenantDb) {
  const leaseFor = (db: TenantDb): TenantLease => ({ db, release: () => {}, retain: () => leaseFor(db) });
  return (id: string) => leaseFor(open(id));
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
      gate: { openPersonal: () => ({}) as PersonalDb, lease: leaseOf(deps.openTenant) },
      memberships: { findById: () => ({ id: "m1", identityId: "i1", tenantRegistrationId: "reg-1", status: "active" }) as never },
      identities: { hasLogin: () => false },
      snapshots: { ensureFresh: async () => ({ ok: true }), checkLive: async () => ({ ok: false, reason: "launch_required" }) },
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

describe("the request's tenant handle is leased for the length of the request", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(ensureFresh: () => Promise<{ ok: true }> = async () => ({ ok: true })) {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "active-context-lease-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const op = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "op" }).id;
    // A cache of one, so opening any other pharmacy pushes the request's handle out of the LRU.
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants"), cacheSize: 1 });
    closers.push(() => gate.close(), () => control.close());
    for (const [id, file] of [["reg-1", "11111111-1111-1111-1111-111111111111.db"], ["reg-2", "22222222-2222-2222-2222-222222222222.db"]] as const) {
      control
        .prepare(
          "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'P', 'https://x.example', ?, 'active', ?, 'now')",
        )
        .run(id, `t-${id}`, id, file, op);
      gate.createTenantFile(id, `t-${id}`);
    }
    const releases = vi.fn();
    const leases = vi.fn();
    const middleware = resolveActiveContext({
      gate: {
        openPersonal: () => ({}) as PersonalDb,
        lease: (id) => {
          leases(id);
          const lease = gate.lease(id);
          return { db: lease.db, release: () => (releases(), lease.release()), retain: () => lease.retain() };
        },
      },
      memberships: { findById: () => ({ id: "m1", identityId: "i1", tenantRegistrationId: "reg-1", status: "active" }) as never },
      identities: { hasLogin: () => false },
      snapshots: { ensureFresh, checkLive: async () => ({ ok: false, reason: "launch_required" }) },
      logger: logger(),
    });
    const req = { identityId: "i1", userId: "i1", sessionId: "s1", sessionContext: { kind: "tenant", membershipId: "m1" } } as unknown as express.Request;
    const res = Object.assign(new EventEmitter(), { status: vi.fn().mockReturnThis(), json: vi.fn() }) as unknown as express.Response;
    return { gate, control, middleware, req, res, releases, leases };
  }

  it("an LRU eviction during the request does not close its handle, and the lease is released once at the response's end", async () => {
    const { gate, middleware, req, res, releases } = setup();
    const next = vi.fn();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // Another request opens another pharmacy, and the eviction grace runs out while this request is still in its turn.
    gate.withTenant("reg-2", () => undefined);
    vi.advanceTimersByTime(10 * 60_000);
    expect(rawDb(req.contextDb!).prepare("SELECT tenant_id FROM context_meta").get()).toEqual({ tenant_id: "t-reg-1" });
    expect(releases).not.toHaveBeenCalled();

    res.emit("finish");
    res.emit("close");
    expect(releases).toHaveBeenCalledTimes(1);
  });

  it("a handler that holds the context keeps its handle across a client disconnect and an LRU eviction, and the handle closes only after the handler finishes", async () => {
    const { gate, middleware, req, res, releases } = setup();
    await middleware(req, res, vi.fn());
    const db = req.contextDb!;

    let proceed!: () => void;
    const reachedAwait = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let rowsSeen = -1;
    const handler = req.holdContext!(async () => {
      await reachedAwait; // the model call, say
      rawDb(db).prepare("INSERT INTO users (id, email) VALUES ('late', 'late@anchor.invalid')").run();
      rowsSeen = (rawDb(db).prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'late'").get() as { n: number }).n;
    });

    res.emit("close"); // the client is gone: the request's own lease is released
    expect(releases).toHaveBeenCalledTimes(1);
    gate.withTenant("reg-2", () => undefined); // with a cache of one, an unheld reg-1 would be evicted and closed here
    expect(rawDb(db).open).toBe(true);

    proceed();
    await handler;
    expect(rowsSeen).toBe(1);
    // Nothing holds reg-1 any more: the next open of another pharmacy evicts it and closes it at once.
    gate.withTenant("reg-2", () => undefined);
    expect(rawDb(db).open).toBe(false);
  });

  it("holdContext retains the request's own lease (re-review N1): no second lease by id, the same handle, and a suspension cannot refuse it", async () => {
    const { gate, control, middleware, req, res, leases } = setup();
    await middleware(req, res, vi.fn());
    const db = req.contextDb!;
    // The operator suspends the pharmacy while the request is admitted: a new lease would now be refused.
    control.prepare("UPDATE tenant_registrations SET status = 'suspended_by_operator' WHERE id = 'reg-1'").run();
    gate.detach("reg-1");

    const seen = await req.holdContext!(async () => rawDb(db).prepare("SELECT tenant_id FROM context_meta").get());

    expect(seen).toEqual({ tenant_id: "t-reg-1" });
    expect(leases).toHaveBeenCalledTimes(1); // the middleware's own, nothing by registration id
    expect(rawDb(db).open).toBe(true); // the request still holds it
    res.emit("finish");
    expect(rawDb(db).open).toBe(false); // the last release of the detached handle closes it
  });

  it("holdContext once the request's own lease has ended is refused with a TenantRefusedError, and opens nothing", async () => {
    const { middleware, req, res, leases } = setup();
    await middleware(req, res, vi.fn());
    res.emit("close");
    const work = vi.fn();
    expect(() => req.holdContext!(work)).toThrow(TenantRefusedError);
    expect(work).not.toHaveBeenCalled();
    expect(leases).toHaveBeenCalledTimes(1);
  });

  it("releases the handler's own lease when its work throws", async () => {
    const { gate, middleware, req, res } = setup();
    await middleware(req, res, vi.fn());
    const db = req.contextDb!;
    expect(() =>
      req.holdContext!(() => {
        throw new Error("handler failed");
      }),
    ).toThrow("handler failed");
    await expect(req.holdContext!(async () => Promise.reject(new Error("async failed")))).rejects.toThrow("async failed");
    res.emit("finish");
    // Neither failed hold left a lease behind: the evicted handle closes at once.
    gate.withTenant("reg-2", () => undefined);
    expect(rawDb(db).open).toBe(false);
  });

  it("a client that goes away during the snapshot check does not leave the lease held", async () => {
    let finishCheck!: () => void;
    const { gate, middleware, req, res, releases } = setup(
      () =>
        new Promise((resolve) => {
          finishCheck = () => resolve({ ok: true });
        }),
    );
    const next = vi.fn();
    const running = middleware(req, res, next);
    res.emit("close"); // gone before the check came back
    finishCheck();
    await running;
    expect(next).not.toHaveBeenCalled();
    expect(releases).toHaveBeenCalledTimes(1);
    // Nothing holds reg-1: another pharmacy's open evicts it and closes it at once.
    const db = gate.withTenant("reg-1", (d) => d);
    gate.withTenant("reg-2", () => undefined);
    expect(rawDb(db).open).toBe(false);
  });

  it("releases on close when the client goes away before the response finishes", async () => {
    const { middleware, req, res, releases } = setup();
    await middleware(req, res, vi.fn());
    res.emit("close");
    expect(releases).toHaveBeenCalledTimes(1);
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
        "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), 'reg-1', 'tenant-1', 'acme', 'Acme Pharmacy', 'https://acme.example', 'reg-1.db', 'active', ?, 'now')",
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
        gate: { openPersonal: () => ({}) as PersonalDb, lease: leaseOf(openTenant) },
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
    const snapshots = createSnapshotRefresher({ memberships, registrations, client, logger: log, clock });
    a.use(
      resolveActiveContext({
        gate: { openPersonal: () => ({}) as PersonalDb, lease: leaseOf(() => tenantDb()) },
        memberships,
        identities: { hasLogin: () => false },
        snapshots,
        logger: log,
      }),
    );
    a.get("/", (_req, res) => res.json({ ok: true }));
    const grantStatuses = () => control.prepare("SELECT status, revoked_reason FROM delegation_grants").all() as Array<{ status: string; revoked_reason: string | null }>;
    return { app: a, fake, advance, control, membership, memberships, grantId, sent, log, grantStatuses, snapshots, identityId };
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

describe("live check against the fake deployment (spec 9.3: the approver is checked at the moment of approval)", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const ORIGIN = "https://acme.example";

  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "active-context-live-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    let now = Date.now();
    const clock = () => new Date(now);
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
    await client.exchangeHandoff(registration.id, await fake.mintHandoff("staff-1"), "s1", identityId, membership.id, "staff-1");
    sent.length = 0;
    const snapshots = createSnapshotRefresher({ memberships, registrations, client, logger: log, clock });
    const grantStatuses = () => control.prepare("SELECT status, revoked_reason FROM delegation_grants").all() as Array<{ status: string; revoked_reason: string | null }>;
    const live = (sessionId: string | null = "s1") => snapshots.checkLive({ sessionId: sessionId ?? undefined, membership: { id: membership.id, identityId } });
    return { fake, control, membership, memberships, sent, log, grantStatuses, snapshots, live, advance: (ms: number) => (now += ms) };
  }

  it("asks ImpressoRx now, even though the stored snapshot is fresh, and returns what it says, with the snapshot's token version", async () => {
    const s = await setup();
    s.fake.snapshots.set("staff-1", { userId: "staff-1", role: "viewer", permissions: ["a.b"], locationIds: ["l9"], tokenVersion: 2, tenantStatus: "Active" });

    const result = await s.live();

    expect(s.sent).toEqual(["/api/oneon/me"]);
    expect(result).toMatchObject({ ok: true, tokenVersion: 2, membership: { id: s.membership.id, role: "viewer", permissions: ["a.b"], locationIds: ["l9"], status: "active" } });
  });

  it("a real 401 suspends the membership, revokes its grants locally and reports membership_suspended", async () => {
    const s = await setup();
    s.fake.grants.get([...s.fake.grants.keys()][0]!)!.status = "revoked";

    expect(await s.live()).toEqual({ ok: false, reason: "membership_suspended" });

    expect(s.memberships.findById(s.membership.id)!.status).toBe("suspended");
    expect(s.grantStatuses()).toEqual([{ status: "revoked", revoked_reason: "membership_suspended" }]);
  });

  it("a snapshot that says the tenant is not serviceable suspends the membership too", async () => {
    const s = await setup();
    s.fake.snapshots.set("staff-1", { userId: "staff-1", role: "manager", permissions: [], locationIds: [], tokenVersion: 1, tenantStatus: "Suspended" });

    expect(await s.live()).toEqual({ ok: false, reason: "membership_suspended" });
    expect(s.grantStatuses()).toEqual([{ status: "revoked", revoked_reason: "membership_suspended" }]);
  });

  it.each([404, 400, 302])("a %i from GET /me is launch_required with no side effects", async (status) => {
    const s = await setup();
    s.fake.meStatus = status;

    expect(await s.live()).toEqual({ ok: false, reason: "launch_required" });

    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.grantStatuses()).toEqual([{ status: "active", revoked_reason: null }]);
    expect(s.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ membershipId: s.membership.id, status }));
  });

  it("no usable bound grant (another session, no session, an expired grant) is launch_required and sends nothing", async () => {
    const s = await setup();

    expect(await s.live("other-session")).toEqual({ ok: false, reason: "launch_required" });
    expect(await s.live(null)).toEqual({ ok: false, reason: "launch_required" });
    s.advance(31 * 60_000);
    expect(await s.live()).toEqual({ ok: false, reason: "launch_required" });

    expect(s.sent).toEqual([]);
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
  });

  it("an unreachable ImpressoRx is reported, not hidden behind the cached snapshot, and sets no cooldown", async () => {
    const s = await setup();
    s.fake.unavailable = true;

    expect(await s.live()).toEqual({ ok: false, reason: "impressorx_unreachable" });
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.grantStatuses()).toEqual([{ status: "active", revoked_reason: null }]);

    s.fake.unavailable = false;
    expect(await s.live()).toMatchObject({ ok: true }); // straight away: the refresh cooldown does not apply to a live check
  });
});

describe("requirePersonalContext", () => {
  function guarded(session: { sessionContext?: { kind: "tenant"; membershipId: string }; sessionId?: string }) {
    const a = express();
    a.use((req, _res, next) => {
      Object.assign(req, session);
      next();
    });
    a.get("/", requirePersonalContext, (_req, res) => res.json({ ok: true }));
    return a;
  }

  it("tells a hand-off session that Personal is not available from a pharmacy, and to sign in with Google", async () => {
    for (const session of [{ sessionId: "s1", sessionContext: { kind: "tenant" as const, membershipId: "m1" } }, { sessionId: "s1" }]) {
      const res = await request(guarded(session)).get("/");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "personal_context_required",
        message: "Personal isn't available when you open Oneon from a pharmacy. Sign in with Google to use it.",
      });
    }
  });

  it("answers a Google session that chose a pharmacy with the bare code: it can switch to Personal", async () => {
    const res = await request(guarded({ sessionContext: { kind: "tenant" as const, membershipId: "m1" } })).get("/");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "personal_context_required" });
  });

  it("lets a personal context, or a request without a session, through", async () => {
    expect((await request(guarded({})).get("/")).body).toEqual({ ok: true });
  });
});
