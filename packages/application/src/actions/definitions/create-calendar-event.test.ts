import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { createCalendarEventDefinition as def } from "./create-calendar-event.js";
import { fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const actor = personalActor("u1");
const base = { title: "Call with Ama", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00" };

function setup(ownerEmail: string | null = "owner@test.com") {
  const cal = fakeCalendar();
  return { cal, readers: fakeReaders({ calendar: cal.reader, identity: { googleEmail: ownerEmail } }), writers: fakeWriters({ calendar: cal.writer }) };
}

async function resolve(input: Record<string, unknown>, ownerEmail?: string | null) {
  const { readers } = setup(ownerEmail);
  const parsed = def.inputSchema.parse(input);
  const r = await def.resolve({ input: parsed, actor, readers, now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  return { parsed, resolved: r.resolved };
}

describe("create_calendar_event input", () => {
  it("refuses a time without a UTC offset (Review Focus 1)", () => {
    const result = def.inputSchema.safeParse({ ...base, start: "2026-10-07T10:00:00" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe("Use an ISO-8601 date-time with a UTC offset, e.g. 2026-10-07T10:00:00+00:00");
  });

  it("refuses an end before the start", () => {
    expect(def.inputSchema.safeParse({ ...base, end: "2026-10-07T09:00:00+00:00" }).success).toBe(false);
  });
});

describe("create_calendar_event resolve", () => {
  it("runs automatically with nobody else involved", async () => {
    const { resolved } = await resolve(base);
    expect(resolved).toMatchObject({ metrics: { others_involved: 0 }, othersInvolved: [], sendUpdates: "none" });
    expect(def.riskFor(resolved, "L1")).toBe("L1");
    expect(def.describe(resolved, def.inputSchema.parse(base))).toBe('Create "Call with Ama", Wed 7 Oct 2026, 10:00–10:30 UTC.');
  });

  it("counts other people, raises risk and says Google will email them", async () => {
    const input = { ...base, attendees: ["ama@example.com"] };
    const { parsed, resolved } = await resolve(input);
    expect(resolved).toMatchObject({ metrics: { others_involved: 1 }, othersInvolved: ["ama@example.com"], sendUpdates: "all" });
    expect(def.riskFor(resolved, "L1")).toBe("L2");
    expect(def.describe(resolved, parsed)).toBe(
      'Create "Call with Ama", Wed 7 Oct 2026, 10:00–10:30 UTC, and invite ama@example.com. Google will email the invitation.',
    );
  });

  it("does not count the owner's own address in any casing (Review Focus 2)", async () => {
    const { resolved } = await resolve({ ...base, attendees: ["Owner@Test.com"] }, "owner@test.com");
    expect(resolved.metrics.others_involved).toBe(0);
  });

  it("de-duplicates attendees case-insensitively (Review Focus 5)", async () => {
    const { resolved } = await resolve({ ...base, attendees: ["a@x.com", "A@x.com"] });
    expect(resolved.event.attendees).toEqual(["a@x.com"]);
    expect(resolved.metrics.others_involved).toBe(1);
  });
});

describe("create_calendar_event execute, verify, undo", () => {
  it("creates, verifies, warns about cancellations and undoes", async () => {
    const { cal, readers, writers } = setup();
    const parsed = def.inputSchema.parse({ ...base, attendees: ["ama@example.com"] });
    const r = await def.resolve({ input: parsed, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    const outcome = await def.execute!({ instanceId: "a1", input: parsed, resolved: r.resolved, actor, executorRequestId: "req1", writers, signal: new AbortController().signal, heartbeat: () => {}, now: NOW });
    expect(outcome.kind).toBe("succeeded");
    const v = await def.postconditions!({ input: parsed, resolved: r.resolved, result: { eventId: "req1" }, executorRequestId: "req1", readers });
    expect(v.checks.every((c) => c.passed)).toBe(true);
    expect(def.undo!.warning(r.resolved)).toBe("Google will email cancellations to ama@example.com.");
    if (outcome.kind !== "succeeded") throw new Error();
    const ctx = { input: parsed, resolved: r.resolved, result: outcome.result, undo: outcome.undoData!, readers, writers };
    expect((await def.undo!.execute(ctx)).kind).toBe("succeeded");
    expect(cal.events.size).toBe(0);
  });

  it("reports a wrong attendee list as a partial result", async () => {
    const { cal, readers, writers } = setup();
    const parsed = def.inputSchema.parse({ ...base, attendees: ["ama@example.com"] });
    const r = await def.resolve({ input: parsed, actor, readers, now: NOW });
    if (!r.ok) throw new Error();
    await def.execute!({ instanceId: "a1", input: parsed, resolved: r.resolved, actor, executorRequestId: "req1", writers, signal: new AbortController().signal, heartbeat: () => {}, now: NOW });
    cal.editElsewhere("req1", { attendees: [] });
    const v = await def.postconditions!({ input: parsed, resolved: r.resolved, result: { eventId: "req1" }, executorRequestId: "req1", readers });
    expect(v.checks.find((c) => c.id === v.effectCheckId)!.passed).toBe(true);
    expect(v.checks.find((c) => c.id === "attendees_match")!.passed).toBe(false);
  });
});
