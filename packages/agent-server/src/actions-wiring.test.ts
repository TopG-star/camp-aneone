import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { ActionInstance, ContextDb, Logger, TenantDb } from "@oneon/domain";
import {
  ContextDbGate,
  EnrolmentService,
  FakeImpressorx,
  MembershipRepository,
  SqliteIdentityRepository,
  TenantRegistrationRepository,
  createDatabase,
  createImpressoRxClient,
  ensureIdentityAnchor,
  openControlDb,
  runMigrations,
} from "@oneon/infrastructure";
import type { AnyActionDefinition } from "@oneon/application";
import { createActionsFor, createActionsModule, runActionRecovery, runActionStartupTasks, runTenantActionRecovery, type ActionsModule } from "./actions-wiring.js";
import { activeMembershipLookup, actorForContext } from "./context-wiring.js";
import { createSnapshotRefresher } from "./middleware/active-context.js";
import { createActionsRouter } from "./routes/actions.route.js";
import { createTenantDelegation } from "./tenant-delegation.js";

vi.mock("@oneon/infrastructure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oneon/infrastructure")>()),
  runActionDriftCheck: vi.fn().mockReturnValue(0),
}));

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeContainer(opts: { importThrows?: boolean; sweepThrowsFor?: string }) {
  const sweep = vi.fn(async (userId: string) => {
    if (userId === opts.sweepThrowsFor) throw new Error("sweep boom");
    return { recovered: 0 };
  });
  const expireStale = vi.fn(async (_userId: string) => 0);
  const listUnimportedProposed = vi.fn((_userId: string) => {
    if (opts.importThrows) throw new Error("import boom");
    return [];
  });
  const actions = {
    legacyRepo: { listUnimportedProposed },
    orchestrator: { requestAction: vi.fn(), sweep, expireStale },
  } as unknown as ActionsModule;
  const userRepo = { list: () => [{ id: "u1" }, { id: "u2" }] };
  return { container: { db: {} as never, actions, userRepo }, sweep, expireStale };
}

describe("runActionStartupTasks", () => {
  it("resolves and still recovers every user when the legacy import throws", async () => {
    const { container, sweep, expireStale } = fakeContainer({ importThrows: true });
    const logger = fakeLogger();
    await expect(runActionStartupTasks(container, logger)).resolves.toBeUndefined();
    expect(sweep.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(expireStale.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("resolves and still recovers the other users when one user's sweep throws", async () => {
    const { container, sweep, expireStale } = fakeContainer({ sweepThrowsFor: "u1" });
    const logger = fakeLogger();
    await expect(runActionStartupTasks(container, logger)).resolves.toBeUndefined();
    expect(sweep.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(expireStale.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("runActionRecovery", () => {
  it("never throws and still expires when sweep fails", async () => {
    const { container, expireStale } = fakeContainer({ sweepThrowsFor: "u1" });
    const logger = fakeLogger();
    await expect(runActionRecovery(container.actions, "u1", logger)).resolves.toBeUndefined();
    expect(expireStale).toHaveBeenCalledWith("u1");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("per-user calendar adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  function module() {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const createGoogleTokenProvider = vi.fn((userId: string) => ({ getAccessToken: async () => `tok-${userId}` }));
    const actions = createActionsModule({
      context: { kind: "personal", raw: db, __brand: "PersonalDb" },
      publicUrl: "https://oneon.test",
      calendarId: "primary",
      calendarCacheTtlMs: 60_000,
      oauthTokenRepo: null,
      deadlines: { findById: () => null },
      notificationRepo: {} as never,
      preferenceRepo: {} as never,
      notificationPort: {} as never,
      notificationWriter: {} as never,
      createGoogleTokenProvider,
      logger: fakeLogger(),
    });
    return { actions, createGoogleTokenProvider };
  }

  it("reads see an action write immediately and each user has their own adapter", async () => {
    const stored: Array<Record<string, unknown>> = [];
    const listCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        if (init?.method === "POST") {
          const created = { ...JSON.parse(init.body as string), etag: '"v1"', updated: "2026-10-01T10:00:00.000Z" };
          stored.push(created);
          return new Response(JSON.stringify(created), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        listCalls.push(auth);
        return new Response(JSON.stringify({ kind: "calendar#events", items: [...stored] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const { actions, createGoogleTokenProvider } = module();
    const readerA = actions.calendarReaderFor("u1")!;
    const writerA = actions.capabilitiesFor("u1").writers.calendar!;

    expect(await readerA.listEvents("2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z")).toEqual([]);
    await writerA.create(
      { title: "Call with Ama", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", allDay: false, description: null, attendees: [], location: null },
      { eventId: "abc123", sendUpdates: "none" },
    );
    const after = await readerA.listEvents("2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z");

    expect(after.map((e) => e.title)).toEqual(["Call with Ama"]);
    expect(listCalls).toEqual(["Bearer tok-u1", "Bearer tok-u1"]);
    expect(actions.calendarReaderFor("u1")).toBe(readerA);
    expect(actions.calendarReaderFor("u2")).not.toBe(readerA);
    expect(createGoogleTokenProvider.mock.calls.map((c) => c[0]).sort()).toEqual(["u1", "u2"]);
  });

  it("returns null when the user has no Google token", () => {
    const { actions, createGoogleTokenProvider } = module();
    createGoogleTokenProvider.mockReturnValueOnce(null as never);
    expect(actions.calendarReaderFor("nobody")).toBeNull();
  });
});

describe("runTenantActionRecovery", () => {
  function tenants(failOpenFor?: string) {
    const trail: string[] = [];
    const handle = (registrationId: string) => ({ kind: "tenant", tenantId: "t-" + registrationId, raw: {}, __brand: "TenantDb" }) as unknown as TenantDb;
    const module = () =>
      ({
        orchestrator: {
          sweep: vi.fn(async (owner: string) => (trail.push("sweep " + owner), { recovered: 0 })),
          expireStale: vi.fn(async (owner: string) => (trail.push("expire " + owner), 0)),
        },
      }) as unknown as ActionsModule;
    return {
      trail,
      deps: {
        registrations: { listActive: () => [{ id: "r1" }, { id: "r2" }] as never },
        gate: {
          lease: (id: string) => {
            trail.push("open " + id);
            if (id === failOpenFor) throw new Error("tenant_unavailable");
            return { db: handle(id), release: () => void trail.push("release " + id) };
          },
        },
        actionsFor: (_db: ContextDb) => module(),
      },
    };
  }

  it("visits each active tenant once, opening one file at a time", async () => {
    const { trail, deps } = tenants();
    await runTenantActionRecovery(deps, fakeLogger());
    expect(trail).toEqual(["open r1", "sweep t-r1", "expire t-r1", "release r1", "open r2", "sweep t-r2", "expire t-r2", "release r2"]);
  });

  it("logs a tenant that fails to open and still recovers the others", async () => {
    const { trail, deps } = tenants("r1");
    const logger = fakeLogger();
    await expect(runTenantActionRecovery(deps, logger)).resolves.toBeUndefined();
    expect(trail).toEqual(["open r1", "open r2", "sweep t-r2", "expire t-r2", "release r2"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stops a tenant's expiry at the deadline and leaves it for the next pass, without cutting the sweep short", async () => {
    const { trail, deps } = tenants();
    const logger = fakeLogger();
    const slow = vi.spyOn(Date, "now");
    try {
      slow.mockReturnValueOnce(0).mockReturnValue(10_000); // the deadline is set at 2000; every later look at the clock is past it
      await runTenantActionRecovery(deps, logger);
    } finally {
      slow.mockRestore();
    }
    expect(trail).toContain("sweep t-r1");
    expect(trail).not.toContain("expire t-r1");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("time budget"), expect.anything());
  });

  it("expires on the next pass what a pass skipped at its deadline", async () => {
    const { trail, deps } = tenants();
    const clock = vi.spyOn(Date, "now");
    try {
      let t = 0;
      clock.mockImplementation(() => (t += 5000)); // every look at the clock is 5 s later: past each tenant's 2 s budget
      await runTenantActionRecovery(deps, fakeLogger());
    } finally {
      clock.mockRestore();
    }
    expect(trail.filter((t) => t.startsWith("expire"))).toEqual([]);
    trail.length = 0;
    await runTenantActionRecovery(deps, fakeLogger());
    expect(trail.filter((t) => t.startsWith("expire"))).toEqual(["expire t-r1", "expire t-r2"]);
  });

  it("runs after personal recovery in the startup tasks", async () => {
    const { container, sweep } = fakeContainer({});
    const { trail, deps } = tenants();
    await runActionStartupTasks({ ...container, tenants: deps }, fakeLogger());
    expect(sweep.mock.calls.map((c) => c[0])).toEqual(["u1", "u2"]);
    expect(trail[0]).toBe("open r1");
  });
});

describe("actionsFor", () => {
  function factory() {
    const createGoogleTokenProvider = vi.fn();
    const actionsFor = createActionsFor({
      publicUrl: "https://oneon.test",
      calendarId: "primary",
      calendarCacheTtlMs: 60_000,
      oauthTokenRepo: null,
      deadlines: { findById: () => null },
      notificationRepo: {} as never,
      preferenceRepo: {} as never,
      notificationPort: {} as never,
      notificationWriter: {} as never,
      createGoogleTokenProvider,
      logger: fakeLogger(),
    });
    const open = (kind: "personal" | "tenant") => {
      const raw = createDatabase(":memory:");
      runMigrations(raw);
      return (kind === "personal"
        ? { kind, raw, __brand: "PersonalDb" }
        : { kind, tenantId: "t-a", raw, __brand: "TenantDb" }) as unknown as ContextDb;
    };
    return { actionsFor, open, createGoogleTokenProvider };
  }

  it("builds a module once per handle", () => {
    const { actionsFor, open } = factory();
    const tenant = open("tenant");
    expect(actionsFor(tenant)).toBe(actionsFor(tenant));
    expect(actionsFor(open("tenant"))).not.toBe(actionsFor(tenant));
  });

  it("gives a tenant handle no personal definitions, no Google access and no legacy repository", () => {
    const { actionsFor, open, createGoogleTokenProvider } = factory();
    const personal = actionsFor(open("personal"));
    const tenant = actionsFor(open("tenant"));
    expect(personal.registry.list().length).toBeGreaterThan(0);
    expect(tenant.registry.list()).toEqual([]);
    expect(tenant.calendarReaderFor("i1")).toBeNull();
    const caps = tenant.capabilitiesFor("i1");
    expect(caps.writers).toEqual({ calendar: null, notifications: null });
    expect(createGoogleTokenProvider).not.toHaveBeenCalled();
    expect(() => tenant.legacyRepo).toThrow();
  });
});

describe("activeMembershipLookup", () => {
  const membership = { id: "m1", identityId: "i1", tenantRegistrationId: "r1", role: "manager", permissions: ["p"], locationIds: [], status: "active" };
  it("finds the identity's active membership at the registration holding the tenant id", () => {
    const lookup = activeMembershipLookup(
      { findByTenantId: (t: string) => (t === "t-a" ? { id: "r1" } : null) },
      { listActiveForIdentity: () => [{ ...membership, tenantRegistrationId: "r0" }, membership] } as never,
    );
    expect(lookup.activeFor("i1", "t-a")).toBe(membership);
  });

  it("returns null for an unknown or inactive registration, or an identity without a membership there", () => {
    const none = { listActiveForIdentity: () => [] } as never;
    expect(activeMembershipLookup({ findByTenantId: () => null }, { listActiveForIdentity: () => [membership] } as never).activeFor("i1", "t-a")).toBeNull();
    expect(activeMembershipLookup({ findByTenantId: () => ({ id: "r1" }) }, none).activeFor("i1", "t-a")).toBeNull();
  });
});

describe("tenant actions against the fake ImpressoRx (spec 7, 9.2, 9.3)", () => {
  const HOUR = 3_600_000;
  const ORIGIN = "https://acme.example";
  const CODE = "ABCD-EFGH-JKLM";
  const SUSPENDED = "This pharmacy has switched Oneon off, or your account is inactive.";
  const dirs: string[] = [];
  const closers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  type Exec = NonNullable<AnyActionDefinition["execute"]>;
  const succeed: Exec = async () => ({ kind: "succeeded", result: { done: true }, undoData: null });

  /** A tenant definition that exists only in these tests: B-core registers no tenant action types. */
  function transfer(execute: Exec): AnyActionDefinition {
    const floor = {
      risk: "L2" as const,
      approval: { mode: "always" as const, thresholds: {} },
      requiredPermissions: ["impressorx:inventory.transfer"],
      approverRoles: ["manager"],
      expiryHours: 48,
    };
    return {
      type: "inventory_transfer",
      version: "1",
      scope: "tenant",
      label: "Transfer stock",
      description: "Moves stock between locations.",
      inputSchema: z.object({ n: z.number() }).strict(),
      effects: { reads: [], writes: ["ImpressoRx inventory"] },
      floor,
      defaults: { ...floor, enabled: true },
      thresholdMetrics: {},
      rollbackClass: "irreversible",
      recoveryThresholdMs: 60_000,
      executionTimeoutMs: 5_000,
      disableWarning: null,
      unavailableReason: null,
      consequenceKeys: ["metrics"],
      idempotencyKey: (_input: { n: number }, ctx) => (ctx.source === "chat" ? ctx.turnId : ctx.resourceId),
      preconditions: async () => [],
      resolve: async () => ({ ok: true, resolved: { metrics: {} } }),
      riskFor: (_r, f) => f,
      describe: (_r, input: { n: number }) => `Transfer ${input.n}`,
      execute,
      postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: true }] }),
      undo: null,
    };
  }

  async function setup(executor: Exec = succeed) {
    const dir = mkdtempSync(join(tmpdir(), "tenant-actions-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(() => gate.close(), () => control.close());

    const identities = new SqliteIdentityRepository(control, (id) => gate.openTenant(id));
    const identityId = identities.createWithLogin({ kind: "impressorx", subject: "reg:staff-1" }).id;
    const registrations = new TenantRegistrationRepository(control);
    const memberships = new MembershipRepository(control);
    const fake = new FakeImpressorx(ORIGIN, "acme", CODE);
    fake.snapshots.set("staff-1", { userId: "staff-1", role: "manager", permissions: ["inventory.transfer"], locationIds: [], tokenVersion: 1, tenantStatus: "Active" });
    // Runs after the fake has answered a token request and before Oneon sees the reply; it may throw to lose the reply.
    const hooks: { afterToken?: (grantType: string) => void | Promise<void> } = {};
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      if (String(input).endsWith("/api/oneon/token")) await hooks.afterToken?.(fake.tokenRequests.at(-1)!.grantType);
      return res;
    };
    const enrolment = new EnrolmentService({ repo: registrations, oneonOrigin: "https://oneon.example", masterKeyB64: randomBytes(32).toString("base64"), fetchImpl });
    const registration = await enrolment.enrol({ origin: ORIGIN, tenantSlug: "acme", enrolmentCode: CODE, enrolledBy: identityId });
    gate.createTenantFile(registration.id, registration.tenantId);
    const tenantDb = gate.openTenant(registration.id);
    ensureIdentityAnchor(tenantDb, identityId);
    const logger = fakeLogger();
    const client = createImpressoRxClient({
      control,
      grantMasterKeyB64: randomBytes(32).toString("base64"),
      enrolment,
      onSnapshot: (id, snapshot) => memberships.applySnapshot(id, snapshot),
      fetchImpl,
      logger,
      sleep: async () => undefined,
    });
    const membership = memberships.upsertFromHandoff({ identityId, tenantRegistrationId: registration.id, externalUserId: "staff-1", role: "manager" });
    const sessionId = "session-1";
    const { grantId: attendedGrantId } = await client.exchangeHandoff(registration.id, await fake.mintHandoff("staff-1"), sessionId, identityId, membership.id, "staff-1");

    const lookup = activeMembershipLookup(registrations, memberships);
    const snapshots = createSnapshotRefresher({ memberships, registrations, client, logger });
    const delegation = createTenantDelegation({ client, memberships: lookup, snapshots, logger });
    const executed = vi.fn(executor);
    const actions = createActionsModule({
      context: tenantDb,
      memberships: lookup,
      delegation,
      definitions: () => [transfer(executed)],
      publicUrl: "https://oneon.test",
      calendarId: "primary",
      calendarCacheTtlMs: 60_000,
      oauthTokenRepo: null,
      deadlines: { findById: () => null },
      notificationRepo: {} as never,
      preferenceRepo: {} as never,
      notificationPort: {} as never,
      notificationWriter: {} as never,
      createGoogleTokenProvider: () => null,
      logger,
    });
    const ctx = { kind: "tenant" as const, identityId, membershipId: membership.id, tenantId: tenantDb.tenantId, registrationId: registration.id };
    const actor = actorForContext(ctx, memberships)!;
    const session = { sessionId, identityId };
    const propose = async () => {
      const outcome = await actions.orchestrator.requestAction({
        type: "inventory_transfer",
        input: { n: 1 },
        actor,
        initiator: "user",
        keyContext: { source: "rule", resourceId: `r-${Math.random()}` },
        evidence: [],
        resourceRef: null,
        session,
      });
      if (outcome.kind === "refused") throw new Error(outcome.issues.join());
      expect(outcome.instance.status).toBe("awaiting_approval");
      return outcome.instance;
    };
    const find = (id: string): ActionInstance => actions.instanceRepo.findById(tenantDb.tenantId, id)!;
    const grantRows = () =>
      control
        .prepare("SELECT id, kind, action_id, scope_json, status, revoked_reason, idle_expires_at, absolute_expires_at FROM delegation_grants WHERE kind = 'action'")
        .all() as Array<{
        id: string;
        kind: string;
        action_id: string;
        scope_json: string;
        status: string;
        revoked_reason: string | null;
        idle_expires_at: string;
        absolute_expires_at: string;
      }>;
    const attendedStatus = () => (control.prepare("SELECT status FROM delegation_grants WHERE id = ?").get(attendedGrantId) as { status: string }).status;
    const events = (id: string) => actions.instanceRepo.listEvents(tenantDb.tenantId, id);
    const app = (opts: { sessionId?: string } = { sessionId }) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.identityId = identityId;
        req.sessionId = opts.sessionId;
        req.activeContext = ctx;
        req.contextDb = tenantDb;
        next();
      });
      a.use("/api/actions", createActionsRouter({ actionsFor: () => actions, actorFor: (c) => actorForContext(c, memberships), logger }));
      return a;
    };
    return {
      control, fake, hooks, client, memberships, membership, actions, actor, session, ctx, propose, find, grantRows, attendedGrantId, attendedStatus,
      events, executed, logger, app, delegation, identityId, registration,
      sweep: () => actions.orchestrator.sweep(tenantDb.tenantId),
    };
  }

  /** ImpressoRx goes away right after the action grant was issued: the action is approved and its grant is live. */
  const dropAfterIssue = (s: Awaited<ReturnType<typeof setup>>) => {
    s.hooks.afterToken = (grantType) => {
      if (grantType === "issue") s.fake.unavailable = true;
    };
  };

  it("approving a tenant action issues an action-bound grant scoped to its permissions", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();

    const approved = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(approved.status).toBe("approved"); // ImpressoRx went away, so it waits; the grant it was issued is the proof of the issue
    const [grant] = s.grantRows();
    expect(s.grantRows()).toHaveLength(1);
    expect(grant).toMatchObject({ kind: "action", action_id: instance.id, status: "active", scope_json: JSON.stringify(["inventory.transfer"]) });
    const approvedAt = s.events(instance.id).find((e) => e.toStatus === "approved" && e.fromStatus !== "approved")!.createdAt;
    expect(grant!.absolute_expires_at).toBe(new Date(Date.parse(approvedAt) + 24 * HOUR).toISOString());
    expect(grant!.idle_expires_at).toBe(grant!.absolute_expires_at); // idle expiry equals absolute expiry for an action grant
    expect(s.fake.grants.get(grant!.id)).toMatchObject({ unattended: true, scope: ["inventory.transfer"] });
  });

  it("approval checks the approver live and refuses a role changed since the snapshot", async () => {
    const s = await setup();
    const instance = await s.propose();
    s.fake.snapshots.set("staff-1", { userId: "staff-1", role: "viewer", permissions: ["inventory.transfer"], locationIds: [], tokenVersion: 2, tenantStatus: "Active" });

    const res = await request(s.app()).post(`/api/actions/${instance.id}/approve`);

    expect(res.status).toBe(403);
    expect(s.find(instance.id).status).toBe("awaiting_approval");
    expect(s.memberships.findById(s.membership.id)!.role).toBe("viewer"); // the live snapshot was applied to the membership
    expect(s.fake.tokenRequests.filter((r) => r.grantType === "issue")).toHaveLength(0);
    expect(s.executed).not.toHaveBeenCalled();
  });

  it("approves through the route when the live check passes, executing in the request", async () => {
    const s = await setup();
    const instance = await s.propose();

    const res = await request(s.app()).post(`/api/actions/${instance.id}/approve`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(s.executed).toHaveBeenCalledTimes(1);
    expect(s.fake.tokenRequests.map((r) => r.grantType)).toEqual(["handoff", "issue", "grant"]);
  });

  it("a remote 401 on the live check suspends the membership, revokes its grants, answers 403 and records nothing", async () => {
    const s = await setup();
    const instance = await s.propose();
    const before = s.events(instance.id).length;
    s.fake.grants.get(s.attendedGrantId)!.status = "revoked";

    const res = await request(s.app()).post(`/api/actions/${instance.id}/approve`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "membership_suspended", message: SUSPENDED });
    expect(s.memberships.findById(s.membership.id)!.status).toBe("suspended");
    expect(s.attendedStatus()).toBe("revoked");
    expect(s.find(instance.id).status).toBe("awaiting_approval");
    expect(s.events(instance.id)).toHaveLength(before);
  });

  it.each([404, 400, 302])("a %i from the live check is launch_required, with no side effects", async (status) => {
    const s = await setup();
    const instance = await s.propose();
    s.fake.meStatus = status;

    const res = await request(s.app()).post(`/api/actions/${instance.id}/approve`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("launch_required");
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.attendedStatus()).toBe("active");
    expect(s.find(instance.id).status).toBe("awaiting_approval");
  });

  it("an approval from a session that holds no grant for this membership is launch_required", async () => {
    const s = await setup();
    const instance = await s.propose();

    const res = await request(s.app({ sessionId: "somebody-else" })).post(`/api/actions/${instance.id}/approve`);
    const none = await request(s.app({})).post(`/api/actions/${instance.id}/approve`);

    expect(res.body.error).toBe("launch_required");
    expect(none.body.error).toBe("launch_required");
    expect(s.find(instance.id).status).toBe("awaiting_approval");
  });

  it("an unreachable ImpressoRx at approval answers 503 impressorx_unreachable and records nothing", async () => {
    const s = await setup();
    const instance = await s.propose();
    const before = s.events(instance.id).length;
    s.fake.unavailable = true;

    const res = await request(s.app()).post(`/api/actions/${instance.id}/approve`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "impressorx_unreachable", message: expect.stringMatching(/ImpressoRx/) });
    expect(s.memberships.findById(s.membership.id)!.status).toBe("active");
    expect(s.attendedStatus()).toBe("active");
    expect(s.find(instance.id).status).toBe("awaiting_approval");
    expect(s.events(instance.id)).toHaveLength(before);
  });

  it("every attended call goes through the grant bound to the session, identity and membership, never the unbound lookup", async () => {
    const s = await setup();
    const unbound = vi.spyOn(s.client, "forSession");
    const bound = vi.spyOn(s.client, "forBoundSession");
    const instance = await s.propose();

    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(unbound).not.toHaveBeenCalled();
    expect(bound.mock.calls.length).toBeGreaterThanOrEqual(3); // the live check, the issue and the token for the executor
    for (const call of bound.mock.calls) expect(call).toEqual([s.session.sessionId, s.identityId, s.membership.id]);
  });

  it("outside a request the executor uses the action grant, not the attended one", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    const grantId = s.grantRows()[0]!.id;
    s.fake.unavailable = false;
    s.hooks.afterToken = undefined;
    const attendedGeneration = s.fake.grants.get(s.attendedGrantId)!.generation;
    const actionGeneration = s.fake.grants.get(grantId)!.generation;
    vi.setSystemTime(Date.now() + 10 * 60_000);

    await s.sweep();

    expect(s.find(instance.id).status).toBe("completed");
    expect(s.executed).toHaveBeenCalledTimes(1);
    expect(s.fake.grants.get(grantId)!.generation).toBe(actionGeneration + 1);
    expect(s.fake.grants.get(s.attendedGrantId)!.generation).toBe(attendedGeneration);
  });

  it("a request whose session holds another membership's grant falls back to the action grant", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    const grantId = s.grantRows()[0]!.id;
    s.fake.unavailable = false;
    const attendedGeneration = s.fake.grants.get(s.attendedGrantId)!.generation;

    await s.delegation.open(s.find(instance.id), { sessionId: "another-session", identityId: s.identityId });

    expect(s.fake.grants.get(s.attendedGrantId)!.generation).toBe(attendedGeneration);
    expect(s.fake.grants.get(grantId)!.generation).toBeGreaterThan(1);
  });

  it("with no grant and no session it fails no_action_grant, which is not a revocation: Retry stays and nothing says the access ended", async () => {
    const s = await setup();
    s.fake.allowUnattended = false; // no action grant can be issued
    s.hooks.afterToken = (grantType) => {
      if (grantType === "issue") s.fake.unavailable = true; // and ImpressoRx is down for the in-request attempt
    };
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    expect(s.find(instance.id).status).toBe("approved");
    expect(s.grantRows()).toEqual([]);
    s.fake.unavailable = false;
    vi.setSystemTime(Date.now() + 10 * 60_000);

    await s.sweep();

    expect(s.find(instance.id)).toMatchObject({ status: "failed", error: { code: "no_action_grant", stage: "recheck" } });
    expect(s.executed).not.toHaveBeenCalled();
    const res = await request(s.app()).get(`/api/actions/${instance.id}`);
    expect(res.body).toMatchObject({ status: "failed", allowedOperations: ["retry"], error: { code: "no_action_grant" } });
    expect(res.body.error.message).toBe("Oneon couldn't keep access to finish this on its own. Retry while you're signed in.");
  });

  it("an issue that could not be completed (unreachable) leaves no grant, and the sweeper fails the action as no_action_grant too", async () => {
    const s = await setup();
    s.hooks.afterToken = (grantType) => {
      if (grantType !== "issue") return;
      s.fake.networkFailure = true; // the issue was applied at ImpressoRx but nothing more gets through
      throw new TypeError("fetch failed");
    };
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    expect(s.find(instance.id).status).toBe("approved");
    s.hooks.afterToken = undefined;
    s.fake.networkFailure = false;
    vi.setSystemTime(Date.now() + 10 * 60_000);

    await s.sweep();

    expect(s.find(instance.id)).toMatchObject({ status: "failed", error: { code: "no_action_grant" } });
  });

  it("a cancel that arrives while the grant is being issued still ends with that grant revoked (spec 7.1)", async () => {
    const s = await setup();
    const instance = await s.propose();
    s.hooks.afterToken = async (grantType) => {
      if (grantType !== "issue") return;
      s.hooks.afterToken = undefined;
      await s.actions.orchestrator.cancel(s.actor, instance.id); // ImpressoRx has issued the grant; Oneon has not stored it yet
    };

    const result = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(result.status).toBe("cancelled");
    expect(s.grantRows()).toHaveLength(1);
    const [grant] = s.grantRows();
    expect(grant).toMatchObject({ action_id: instance.id, status: "revoked" });
    await vi.waitFor(() => expect(s.fake.grants.get(grant!.id)!.status).toBe("revoked"));
    expect(s.executed).not.toHaveBeenCalled();
  });

  it("an issue whose reply was lost and that a later exchange replays after the action ended is stored revoked, and revoked at ImpressoRx", async () => {
    const s = await setup();
    const instance = await s.propose();
    s.hooks.afterToken = (grantType) => {
      if (grantType !== "issue") return;
      s.fake.networkFailure = true; // applied at ImpressoRx; the reply and everything after it is lost
      throw new TypeError("fetch failed");
    };
    const approved = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    expect(approved.status).toBe("approved");
    expect(s.grantRows()).toEqual([]);
    await s.actions.orchestrator.cancel(s.actor, instance.id);
    s.hooks.afterToken = undefined;
    s.fake.networkFailure = false;

    await s.client.forBoundSession(s.session.sessionId, s.identityId, s.membership.id)!.accessToken({ oneonActionId: "later" }); // the next exchange replays the stored issue

    const [grant] = s.grantRows();
    expect(grant).toMatchObject({ action_id: instance.id, status: "revoked", revoked_reason: "action_ended" });
    await vi.waitFor(() => expect(s.fake.grants.get(grant!.id)!.status).toBe("revoked"));
  });

  it("when ImpressoRx refuses to issue (unattended access off) the approval stands and the action runs in the request with the attended token", async () => {
    const s = await setup();
    s.fake.allowUnattended = false;
    const instance = await s.propose();

    const done = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(done.status).toBe("completed");
    expect(s.grantRows()).toEqual([]);
    expect(s.attendedStatus()).toBe("active");
    expect(s.fake.theftRevocations).toEqual([]);
    expect(s.executed).toHaveBeenCalledTimes(1);
  });

  it("a refused exchange fails delegation_revoked and revokes the local grant", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    const grantId = s.grantRows()[0]!.id;
    s.fake.unavailable = false;
    s.fake.grants.get(grantId)!.status = "revoked"; // ImpressoRx says no: e.g. unattended access was switched off
    vi.setSystemTime(Date.now() + 10 * 60_000);

    await s.sweep();

    expect(s.find(instance.id)).toMatchObject({ status: "failed", error: { code: "delegation_revoked" } });
    expect(s.grantRows()[0]).toMatchObject({ id: grantId, status: "revoked" });
    expect(s.executed).not.toHaveBeenCalled();
  });

  it("a locally revoked grant is a refusal too: delegation_revoked", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    s.fake.unavailable = false;
    s.control.prepare("UPDATE delegation_grants SET status = 'revoked', revoked_reason = 'test' WHERE kind = 'action'").run();
    vi.setSystemTime(Date.now() + 10 * 60_000);

    await s.sweep();

    expect(s.find(instance.id)).toMatchObject({ status: "failed", error: { code: "delegation_revoked" } });
  });

  it("an unreachable ImpressoRx keeps the action approved and retries, then approval_stale after the limit", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    const notes = () => s.events(instance.id).filter((e) => e.fromStatus === "approved" && e.toStatus === "approved");
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.data).toEqual({ retry: "impressorx_unreachable" });

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await s.sweep();
    expect(s.find(instance.id).status).toBe("approved");
    expect(notes()).toHaveLength(2);

    vi.setSystemTime(Date.now() + 24 * HOUR);
    await s.sweep();

    expect(s.find(instance.id)).toMatchObject({ status: "failed", error: { code: "approval_stale", stage: "recheck" } });
    expect(s.executed).not.toHaveBeenCalled();
    expect(s.grantRows()[0]).toMatchObject({ status: "revoked" }); // revoked here even though ImpressoRx could not be told
    await vi.waitFor(() => expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("ImpressoRx"), expect.anything()));
  });

  it("a permanent refusal from the executor's call (tRPC FORBIDDEN) fails the action once, without retrying", async () => {
    const s = await setup(async (ctx) => {
      await ctx.impressorx!.trpc("inventory.transfer", { n: 1 }, "mutation"); // B-core: every procedure refuses agents
      return { kind: "succeeded", result: {}, undoData: null };
    });
    const instance = await s.propose();

    const done = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(done).toMatchObject({ status: "failed", error: { code: "impressorx_refused", stage: "execution" } });
    vi.setSystemTime(Date.now() + 25 * HOUR);
    await s.sweep();
    expect(s.find(instance.id)).toMatchObject({ status: "failed", error: { code: "impressorx_refused" } });
    expect(s.executed).toHaveBeenCalledTimes(1);
  });

  it("a remote 401 during the executor's call revokes that grant and fails delegation_revoked", async () => {
    const holder: { s?: Awaited<ReturnType<typeof setup>> } = {};
    const s = await setup(async (ctx) => {
      holder.s!.fake.grants.get(holder.s!.attendedGrantId)!.status = "revoked"; // taken back while the action runs
      await ctx.impressorx!.trpc("inventory.transfer", { n: 1 }, "mutation");
      return { kind: "succeeded", result: {}, undoData: null };
    });
    holder.s = s;
    const instance = await s.propose();

    const done = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(done).toMatchObject({ status: "failed", error: { code: "delegation_revoked" } });
    expect(s.attendedStatus()).toBe("revoked");
  });

  it("an unreachable ImpressoRx during the executor's call is an unknown outcome and goes to verification", async () => {
    const holder: { s?: Awaited<ReturnType<typeof setup>> } = {};
    const s = await setup(async (ctx) => {
      holder.s!.fake.unavailable = true;
      await ctx.impressorx!.trpc("inventory.transfer", { n: 1 }, "mutation");
      return { kind: "succeeded", result: {}, undoData: null };
    });
    holder.s = s;
    const instance = await s.propose();

    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    const verifying = s.events(instance.id).find((e) => e.toStatus === "verifying")!;
    expect(verifying.data).toMatchObject({ outcome: "unknown", code: "impressorx_unreachable" });
  });

  it("reaching completed revokes the action grant at ImpressoRx", async () => {
    const s = await setup();
    const instance = await s.propose();

    const done = await s.actions.orchestrator.approve(s.actor, instance.id, s.session);

    expect(done.status).toBe("completed");
    const [grant] = s.grantRows();
    expect(grant).toMatchObject({ action_id: instance.id, status: "revoked", revoked_reason: "action_completed" });
    await vi.waitFor(() => expect(s.fake.grants.get(grant!.id)!.status).toBe("revoked"));
  });

  it("failed, rejected and cancelled actions release their grant too, and an action that never had one is fine", async () => {
    const s = await setup(async () => ({ kind: "definite_failure", code: "nope", message: "no" }));
    const failing = await s.propose();
    await s.actions.orchestrator.approve(s.actor, failing.id, s.session);
    expect(s.find(failing.id).status).toBe("failed");
    const [grant] = s.grantRows();
    expect(grant).toMatchObject({ status: "revoked", revoked_reason: "action_failed" });
    await vi.waitFor(() => expect(s.fake.grants.get(grant!.id)!.status).toBe("revoked"));

    const rejected = await s.propose();
    await expect(s.actions.orchestrator.reject(s.actor, rejected.id)).resolves.toMatchObject({ status: "rejected" });
    const cancelled = await s.propose();
    await expect(s.actions.orchestrator.cancel(s.actor, cancelled.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(s.grantRows()).toHaveLength(1);
  });

  it("a failed delegation_revoked action keeps the Retry operation and tells the person to reconnect", async () => {
    const s = await setup();
    dropAfterIssue(s);
    const instance = await s.propose();
    await s.actions.orchestrator.approve(s.actor, instance.id, s.session);
    s.fake.unavailable = false;
    s.control.prepare("UPDATE delegation_grants SET status = 'revoked' WHERE kind = 'action'").run();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await s.sweep();

    const res = await request(s.app()).get(`/api/actions/${instance.id}`);

    expect(res.body).toMatchObject({ status: "failed", error: { code: "delegation_revoked" }, allowedOperations: ["retry"] });
    expect(res.body.error.message).toMatch(/reconnect/i);
  });
});
