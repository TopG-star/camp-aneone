import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { updateCalendarEventDefinition as def } from "./update-calendar-event.js";
import { fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const actor = personalActor("u1");

async function setup(attendees: string[] = []) {
  const cal = fakeCalendar();
  await cal.writer.create(
    { title: "Focus", start: "2026-10-07T09:00:00+00:00", end: "2026-10-07T11:00:00+00:00", allDay: false, description: null, attendees, location: null },
    { eventId: "ev1", sendUpdates: "none" },
  );
  return { cal, readers: fakeReaders({ calendar: cal.reader }), writers: fakeWriters({ calendar: cal.writer }) };
}

describe("update_calendar_event", () => {
  it("requires at least one change", () => {
    expect(def.inputSchema.safeParse({ eventId: "ev1" }).success).toBe(false);
  });

  it("is blocked when the event does not exist", async () => {
    const { readers } = await setup();
    const checks = await def.preconditions({ input: def.inputSchema.parse({ eventId: "nope", title: "x" }), actor, readers, now: NOW });
    expect(checks.find((c) => !c.passed)).toMatchObject({ id: "event_exists", kind: "blocking" });
  });

  it("counts people added to a solo event (attendee gap)", async () => {
    const { readers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", attendees: ["ama@example.com"] });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r.ok && r.resolved).toMatchObject({ metrics: { others_involved: 1 }, sendUpdates: "all" });
  });

  it("emails nobody for a title change on an event with attendees", async () => {
    const { readers } = await setup(["ama@example.com"]);
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r.ok && r.resolved).toMatchObject({ metrics: { others_involved: 1 }, sendUpdates: "none", previous: { title: "Focus" } });
  });

  it("emails attendees for a time change", async () => {
    const { readers } = await setup(["ama@example.com"]);
    const input = def.inputSchema.parse({ eventId: "ev1", start: "2026-10-07T10:00:00+00:00" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    expect(r.ok && r.resolved.sendUpdates).toBe("all");
  });

  it("updates with If-Match, verifies, and restores on undo", async () => {
    const { cal, readers, writers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, signal: new AbortController().signal, heartbeat: () => {}, now: NOW });
    if (outcome.kind !== "succeeded") throw new Error(outcome.kind);
    expect((await def.postconditions!({ input, resolved: r.resolved, result: outcome.result, executorRequestId: "req1", readers })).checks.every((c) => c.passed)).toBe(true);
    const ctx = { input, resolved: r.resolved, result: outcome.result, undo: outcome.undoData!, readers, writers };
    expect((await def.undo!.preconditions(ctx)).every((c) => c.passed)).toBe(true);
    expect((await def.undo!.execute(ctx)).kind).toBe("succeeded");
    expect(cal.events.get("ev1")!.title).toBe("Focus");
    expect((await def.undo!.verify(ctx)).every((c) => c.passed)).toBe(true);
  });

  it("fails definitely when the event changed after approval", async () => {
    const { cal, readers, writers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    cal.editElsewhere("ev1", { location: "Room 2" });
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, signal: new AbortController().signal, heartbeat: () => {}, now: NOW });
    expect(outcome).toMatchObject({ kind: "definite_failure", code: "changed_since" });
  });

  it("refuses undo when someone edited after Oneon", async () => {
    const { cal, readers, writers } = await setup();
    const input = def.inputSchema.parse({ eventId: "ev1", title: "Deep work" });
    const r = await def.resolve({ input, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    const outcome = await def.execute!({ instanceId: "a1", input, resolved: r.resolved, actor, executorRequestId: "req1", writers, signal: new AbortController().signal, heartbeat: () => {}, now: NOW });
    if (outcome.kind !== "succeeded") throw new Error();
    cal.editElsewhere("ev1", { title: "Edited by me" });
    const checks = await def.undo!.preconditions({ input, resolved: r.resolved, result: outcome.result, undo: outcome.undoData!, readers, writers });
    expect(checks.find((c) => !c.passed)).toMatchObject({ failureCode: "changed_since" });
  });
});
