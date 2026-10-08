import { describe, it, expect, vi, afterEach } from "vitest";
import type { ContextDb, Logger, TenantDb } from "@oneon/domain";
import { createDatabase, runMigrations } from "@oneon/infrastructure";
import { createActionsFor, createActionsModule, runActionRecovery, runActionStartupTasks, runTenantActionRecovery, type ActionsModule } from "./actions-wiring.js";
import { activeMembershipLookup } from "./context-wiring.js";

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
        registrations: { listActive: () => [{ id: "r1" }, { id: "r2" }] },
        openTenant: (id: string) => {
          trail.push("open " + id);
          if (id === failOpenFor) throw new Error("tenant_unavailable");
          return handle(id);
        },
        actionsFor: (_db: ContextDb) => module(),
      },
    };
  }

  it("visits each active tenant once, opening one file at a time", async () => {
    const { trail, deps } = tenants();
    await runTenantActionRecovery(deps, fakeLogger());
    expect(trail).toEqual(["open r1", "sweep t-r1", "expire t-r1", "open r2", "sweep t-r2", "expire t-r2"]);
  });

  it("logs a tenant that fails to open and still recovers the others", async () => {
    const { trail, deps } = tenants("r1");
    const logger = fakeLogger();
    await expect(runTenantActionRecovery(deps, logger)).resolves.toBeUndefined();
    expect(trail).toEqual(["open r1", "open r2", "sweep t-r2", "expire t-r2"]);
    expect(logger.warn).toHaveBeenCalled();
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
