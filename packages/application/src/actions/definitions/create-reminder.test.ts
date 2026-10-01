import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { createReminderDefinition as def } from "./create-reminder.js";
import { deadline, fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const input = { deadlineId: "d1", inboundItemId: "i1" };
const actor = personalActor("u1");

function setup(d = deadline()) {
  const cal = fakeCalendar();
  const readers = fakeReaders({ calendar: cal.reader, deadlines: { findById: (id) => (id === d.id ? d : null) } });
  const writers = fakeWriters({ calendar: cal.writer });
  return { cal, readers, writers };
}

describe("create_reminder preconditions", () => {
  it("passes for an open future deadline with a connected calendar", async () => {
    const { readers } = setup();
    const checks = await def.preconditions({ input, actor, readers, now: NOW });
    expect(checks.every((c) => c.passed)).toBe(true);
  });

  it.each([
    ["deadline done", deadline({ status: "done" }), "deadline_open", "obsolete"],
    ["due date passed", deadline({ dueDate: "2026-09-30T23:00:00Z" }), "due_date_not_passed", "obsolete"],
  ])("%s → %s (%s)", async (_n, d, id, kind) => {
    const { readers } = setup(d);
    const failed = (await def.preconditions({ input, actor, readers, now: NOW })).find((c) => !c.passed);
    expect(failed).toMatchObject({ id, kind });
  });

  it("is obsolete when the deadline is gone and blocked without a calendar", async () => {
    const readers = fakeReaders();
    const checks = await def.preconditions({ input, actor, readers, now: NOW });
    expect(checks.filter((c) => !c.passed).map((c) => [c.id, c.kind])).toEqual([
      ["deadline_exists", "obsolete"],
      ["calendar_connected", "blocking"],
    ]);
  });
});

describe("create_reminder resolve, execute, verify, undo", () => {
  it("builds an all-day event on the deadline's own date", async () => {
    const { readers } = setup(deadline({ dueDate: "2026-10-07T23:30:00-05:00" }));
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r).toEqual({
      ok: true,
      resolved: {
        metrics: { others_involved: 0 },
        sendUpdates: "none",
        event: {
          title: "Due: Submit Q4 report", start: "2026-10-07", end: "2026-10-08", allDay: true,
          description: "From Oneon: https://oneon.test/items/i1", attendees: [], location: null,
        },
      },
    });
    if (r.ok) expect(def.describe(r.resolved, input)).toBe('Add an all-day reminder "Due: Submit Q4 report" on 7 Oct 2026 to your calendar.');
  });

  it("creates with the request id, verifies, and undoes when unchanged", async () => {
    const { cal, readers, writers } = setup();
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error("resolve failed");
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    expect(outcome).toEqual({ kind: "succeeded", result: { eventId: "req1", etag: '"v1"' }, undoData: { eventId: "req1", versionAfter: '"v1"' } });

    const v = await def.postconditions!({ input, resolved: r.resolved, result: { eventId: "req1" }, executorRequestId: "req1", readers });
    expect(v.checks.every((c) => c.passed)).toBe(true);

    const undoCtx = { input, resolved: r.resolved, result: { eventId: "req1" }, undo: { eventId: "req1", versionAfter: '"v1"' }, readers, writers };
    expect((await def.undo!.preconditions(undoCtx)).every((c) => c.passed)).toBe(true);
    expect((await def.undo!.execute(undoCtx)).kind).toBe("succeeded");
    expect(await def.undo!.verify(undoCtx)).toEqual([{ id: "event_deleted", passed: true }]);
    expect(cal.events.size).toBe(0);
  });

  it("verifies by request id when the create outcome was unknown", async () => {
    const { cal, readers, writers } = setup();
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    await cal.writer.create(r.resolved.event, { eventId: "req1", sendUpdates: "none" });
    const v = await def.postconditions!({ input, resolved: r.resolved, result: null, executorRequestId: "req1", readers });
    expect(v.checks.find((c) => c.id === v.effectCheckId)!.passed).toBe(true);
    void writers;
  });

  it("refuses undo when the event changed since", async () => {
    const { cal, readers, writers } = setup();
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, heartbeat: () => {}, now: NOW });
    cal.editElsewhere("req1", { description: "my notes" });
    const checks = await def.undo!.preconditions({ input, resolved: r.resolved, result: { eventId: "req1" }, undo: { eventId: "req1", versionAfter: '"v1"' }, readers, writers });
    expect(checks.find((c) => !c.passed)).toMatchObject({ id: "unchanged_since", failureCode: "changed_since" });
  });

  it("defaults to approval with an auto floor", () => {
    expect(def.floor.approval.mode).toBe("auto");
    expect(def.defaults.approval.mode).toBe("always");
    expect(def.idempotencyKey(input, { source: "rule", resourceId: "i1" })).toBe("deadline:d1");
  });
});
