import { describe, it, expect } from "vitest";
import { ExternalCallError, personalActor, type CalendarWriter } from "@oneon/domain";
import { harness, request } from "../__tests__/orchestrator-harness.js";
import { fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";
import { createCalendarEventDefinition } from "../definitions/create-calendar-event.js";
import { updateCalendarEventDefinition } from "../definitions/update-calendar-event.js";

const MIN = 60_000;
const unknown = () => new ExternalCallError("unknown", "google_unavailable", "Google Calendar API error 503: {}");

/** The orchestrator over a fake Google calendar whose writer can be wrapped per test. */
function calendarHarness(wrap: (w: CalendarWriter) => CalendarWriter) {
  const cal = fakeCalendar();
  const writer = wrap(cal.writer);
  const h = harness([createCalendarEventDefinition, updateCalendarEventDefinition], {
    capabilities: () => ({
      readers: fakeReaders({ calendar: cal.reader }),
      writers: fakeWriters({ calendar: writer }),
    }),
  });
  return { cal, h };
}

async function chat(h: ReturnType<typeof harness>, type: string, input: Record<string, unknown>) {
  const outcome = await h.orchestrator.requestAction(
    request({ type, input, initiator: "user", keyContext: { source: "chat", turnId: "t1" } }),
  );
  if (outcome.kind === "refused") throw new Error(`refused: ${outcome.issues.join("; ")}`);
  return outcome.instance;
}

const FOCUS = { title: "Focus", start: "2026-10-07T09:00:00+00:00", end: "2026-10-07T11:00:00+00:00", allDay: false, description: null, attendees: [], location: null };

describe("update_calendar_event effect check (I1)", () => {
  it("ends failed, not partially_completed, when an update with an unknown outcome never landed", async () => {
    const { cal, h } = calendarHarness((w) => ({ ...w, update: async () => { throw unknown(); } }));
    await cal.writer.create(FOCUS, { eventId: "ev1", sendUpdates: "none" });

    const instance = await chat(h, "update_calendar_event", { eventId: "ev1", title: "Deep work" });
    expect(instance.status).toBe("verifying");

    h.advanceClock(6 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)).toMatchObject({ status: "failed", error: { code: "effect_absent" } });
    expect(h.repo.trail(instance.id)).not.toContain("partially_completed");
  });
});

describe("undo data after an unknown outcome (I2)", () => {
  it("a create that landed but reported unknown completes with undo data and can be undone", async () => {
    const { cal, h } = calendarHarness((w) => ({ ...w, create: async (e, o) => { await w.create(e, o); throw unknown(); } }));

    const instance = await chat(h, "create_calendar_event", {
      title: "Call with Ama",
      start: "2026-10-07T10:00:00+00:00",
      end: "2026-10-07T10:30:00+00:00",
    });
    expect(instance.status).toBe("completed");
    expect(instance.undo).toEqual({ eventId: instance.executorRequestId, versionAfter: '"v1"', sendUpdates: "none" });

    const undone = await h.orchestrator.requestUndo(personalActor("u1"), instance.id);
    expect(undone.status).toBe("rolled_back");
    expect(cal.events.size).toBe(0);
  });

  it("an update that landed but reported unknown completes with its previous values and can be undone", async () => {
    let calls = 0;
    // Only the forward update reports unknown; the undo's update answers normally.
    const { cal, h } = calendarHarness((w) => ({
      ...w,
      update: async (id, c, o) => {
        const updated = await w.update(id, c, o);
        if (calls++ === 0) throw unknown();
        return updated;
      },
    }));
    await cal.writer.create(FOCUS, { eventId: "ev1", sendUpdates: "none" });

    const instance = await chat(h, "update_calendar_event", { eventId: "ev1", title: "Deep work" });
    expect(instance.status).toBe("completed");
    expect(instance.undo).toMatchObject({ eventId: "ev1", previous: { title: "Focus" }, versionBefore: '"v1"', versionAfter: '"v2"' });

    expect((await h.orchestrator.requestUndo(personalActor("u1"), instance.id)).status).toBe("rolled_back");
    expect(cal.events.get("ev1")!.title).toBe("Focus");
  });

  it("does not derive undo data when a field the checks don't cover was edited before verification", async () => {
    const { cal, h } = calendarHarness((w) => ({
      ...w,
      create: async (e, o) => {
        await w.create(e, o);
        cal.editElsewhere(o.eventId, { description: "My notes" });
        throw unknown();
      },
    }));
    const instance = await chat(h, "create_calendar_event", {
      title: "Call with Ama",
      start: "2026-10-07T10:00:00+00:00",
      end: "2026-10-07T10:30:00+00:00",
    });
    expect(instance.status).toBe("completed");
    expect(instance.undo).toBeNull();
  });

  it("does not derive undo data when the event no longer looks as Oneon wrote it", async () => {
    const { cal, h } = calendarHarness((w) => ({
      ...w,
      create: async (e, o) => {
        await w.create(e, o);
        cal.editElsewhere(o.eventId, { title: "Renamed by someone" });
        throw unknown();
      },
    }));
    const instance = await chat(h, "create_calendar_event", {
      title: "Call with Ama",
      start: "2026-10-07T10:00:00+00:00",
      end: "2026-10-07T10:30:00+00:00",
    });
    expect(instance.status).toBe("partially_completed");
    expect(instance.undo).toBeNull();
  });
});
