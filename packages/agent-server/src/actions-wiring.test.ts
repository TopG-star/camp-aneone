import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "@oneon/domain";
import { createDatabase, runMigrations } from "@oneon/infrastructure";
import { createActionsModule, runActionRecovery, runActionStartupTasks, type ActionsModule } from "./actions-wiring.js";

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
      db,
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
