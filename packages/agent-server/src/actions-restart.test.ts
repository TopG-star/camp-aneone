import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { personalActor, type CalendarEvent, type CalendarReader, type CalendarWriter, type Logger } from "@oneon/domain";
import { createActionOrchestrator, createActionRegistry, createCalendarEventDefinition } from "@oneon/application";
import {
  createDatabase,
  runMigrations,
  SqliteActionConfigRepository,
  SqliteActionInstanceRepository,
  SqliteLegacyActionRepository,
  SqliteUserRepository,
} from "@oneon/infrastructure";
import { runActionStartupTasks, type ActionsModule } from "./actions-wiring.js";

/**
 * A restart around an in-flight write (spec §7.4, §15.2): the first process starts the executor and
 * dies before recording an outcome. A second process on the same database file must recover the
 * action at startup by verification only, never by running the executor again.
 */

/** Every connection a test opened, closed in afterEach so the temp file can be deleted (Windows locks it). */
const opened: Array<{ open: boolean; close(): void }> = [];

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
const T0 = new Date("2026-10-01T12:00:00.000Z");
const MIN = 60_000;

/** Google Calendar, which outlives our process. `hang` keeps a create pending forever, like a request cut off by a crash. */
function googleCalendar() {
  const events = new Map<string, CalendarEvent>();
  const creates: string[] = [];
  let hang: "before_write" | "after_write" | null = null;
  const reader: CalendarReader = {
    listEvents: async () => [...events.values()],
    searchEvents: async () => [...events.values()],
    getEvent: async (id) => events.get(id) ?? null,
  };
  const writer: CalendarWriter = {
    async create(event, options) {
      creates.push(options.eventId);
      if (hang === "after_write") events.set(options.eventId, { ...event, id: options.eventId, etag: '"v1"', updated: T0.toISOString() });
      if (hang) return new Promise<never>(() => {});
      const created = { ...event, id: options.eventId, etag: '"v1"', updated: T0.toISOString() };
      events.set(created.id, created);
      return created;
    },
    update: async () => { throw new Error("not used"); },
    remove: async () => { throw new Error("not used"); },
  };
  return { events, creates, reader, writer, crashDuringCreate: (when: "before_write" | "after_write") => { hang = when; } };
}

/** One "process": its own database connection, repositories and orchestrator. */
function boot(dbPath: string, google: ReturnType<typeof googleCalendar>, now: Date) {
  const db = createDatabase(dbPath);
  runMigrations(db);
  opened.push(db);
  const clock = () => now;
  const instances = new SqliteActionInstanceRepository(db, clock);
  const orchestrator = createActionOrchestrator({
    registry: createActionRegistry([createCalendarEventDefinition]),
    repo: instances,
    configRepo: new SqliteActionConfigRepository(db),
    capabilities: () => ({
      readers: {
        calendar: google.reader,
        deadlines: { findById: () => null },
        notifications: { isSuppressed: () => null, findById: () => null },
        identity: { googleEmail: "alice@test.com" },
        links: { inboundItem: (id) => `/items/${id}` },
      },
      writers: { calendar: google.writer, notifications: null },
    }),
    notifier: { awaitingApproval: async () => {}, rollbackFailed: async () => {} },
    logger: silent,
    clock,
    newId: () => randomUUID(),
  });
  const users = new SqliteUserRepository(db);
  const actions = { orchestrator, legacyRepo: new SqliteLegacyActionRepository(db) } as unknown as ActionsModule;
  return { db, orchestrator, users, actions, instances };
}

/** Lets pending promise callbacks run without advancing (faked) timers. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function crashMidCreate(dbPath: string, google: ReturnType<typeof googleCalendar>, when: "before_write" | "after_write") {
  const first = boot(dbPath, google, T0);
  first.users.upsert({ id: "user-A", email: "alice@test.com" });
  const outcome = await first.orchestrator.requestAction({
    type: "create_calendar_event",
    input: { title: "Call with Ama", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00", attendees: ["ama@x.com"] },
    actor: personalActor("user-A"),
    initiator: "user",
    keyContext: { source: "chat", turnId: "t1" },
    evidence: [],
    resourceRef: null,
  });
  if (outcome.kind === "refused") throw new Error(outcome.issues.join("; "));
  expect(outcome.instance.status).toBe("awaiting_approval");

  google.crashDuringCreate(when);
  void first.orchestrator.approve(personalActor("user-A"), outcome.instance.id);
  await settle();
  const inFlight = first.instances.findById("user-A", outcome.instance.id)!;
  expect(inFlight.status).toBe("executing");
  expect(google.creates).toEqual([inFlight.executorRequestId]);

  first.db.close(); // the process dies with the write still in flight
  return inFlight;
}

describe("restart around an in-flight calendar write", () => {
  let dir: string | null = null;
  afterEach(() => {
    vi.useRealTimers();
    for (const db of opened.splice(0)) if (db.open) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function dbFile() {
    dir = mkdtempSync(join(tmpdir(), "oneon-restart-"));
    return join(dir, "oneon.db");
  }

  it("completes at startup when the write landed before the crash, without writing again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); // the executor timeout never fires in the dying process
    const dbPath = dbFile();
    const google = googleCalendar();
    const inFlight = await crashMidCreate(dbPath, google, "after_write");

    const second = boot(dbPath, google, new Date(T0.getTime() + 6 * MIN));
    await runActionStartupTasks({ db: second.db, actions: second.actions, userRepo: second.users }, silent);

    const recovered = second.instances.findById("user-A", inFlight.id)!;
    expect(recovered.status).toBe("completed");
    expect(recovered.undo).not.toBeNull();
    expect(second.instances.listEvents("user-A", inFlight.id).map((e) => e.toStatus)).toContain("verifying");
    expect(google.creates).toEqual([inFlight.executorRequestId]); // never re-executed
    expect(google.events.size).toBe(1);
  });

  it("records failed at startup when the write never landed, without writing again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dbPath = dbFile();
    const google = googleCalendar();
    const inFlight = await crashMidCreate(dbPath, google, "before_write");

    const second = boot(dbPath, google, new Date(T0.getTime() + 6 * MIN));
    await runActionStartupTasks({ db: second.db, actions: second.actions, userRepo: second.users }, silent);

    expect(second.instances.findById("user-A", inFlight.id)).toMatchObject({ status: "failed", error: { code: "effect_absent" } });
    expect(google.creates).toEqual([inFlight.executorRequestId]);
    expect(google.events.size).toBe(0);
  });

  it("leaves the action alone when the restart comes before the recovery threshold", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dbPath = dbFile();
    const google = googleCalendar();
    const inFlight = await crashMidCreate(dbPath, google, "after_write");

    const second = boot(dbPath, google, new Date(T0.getTime() + 1 * MIN));
    await runActionStartupTasks({ db: second.db, actions: second.actions, userRepo: second.users }, silent);

    expect(second.instances.findById("user-A", inFlight.id)!.status).toBe("executing");
  });
});
