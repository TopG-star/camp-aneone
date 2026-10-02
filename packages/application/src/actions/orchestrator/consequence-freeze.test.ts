import { describe, it, expect } from "vitest";
import { personalActor, type CalendarWriter } from "@oneon/domain";
import { harness, request } from "../__tests__/orchestrator-harness.js";
import { fakeCalendar, fakeReaders, fakeWriters } from "../__tests__/fakes.js";
import { updateCalendarEventDefinition } from "../definitions/update-calendar-event.js";

/**
 * Spec §7.3: approval freezes the action's consequences. If the version resolved at execution
 * differs from the approved one, the action fails and the newly resolved version never runs.
 */
function freezeHarness() {
  const cal = fakeCalendar();
  const writes: string[] = [];
  const writer: CalendarWriter = {
    create: async (e, o) => { writes.push("create"); return cal.writer.create(e, o); },
    update: async (id, c, o) => { writes.push("update"); return cal.writer.update(id, c, o); },
    remove: async (id, o) => { writes.push("remove"); return cal.writer.remove(id, o); },
  };
  const h = harness([updateCalendarEventDefinition], {
    capabilities: () => ({ readers: fakeReaders({ calendar: cal.reader }), writers: fakeWriters({ calendar: writer }) }),
  });
  return { cal, h, writes };
}

const EVENT = { title: "Planning", start: "2026-10-07T09:00:00+00:00", end: "2026-10-07T10:00:00+00:00", allDay: false, description: null, location: null };

async function requestMove(h: ReturnType<typeof harness>) {
  const outcome = await h.orchestrator.requestAction(
    request({
      type: "update_calendar_event",
      input: { eventId: "ev1", start: "2026-10-07T09:30:00+00:00" },
      initiator: "user",
      keyContext: { source: "chat", turnId: "t1" },
    }),
  );
  if (outcome.kind === "refused") throw new Error(`refused: ${outcome.issues.join("; ")}`);
  return outcome.instance;
}

function lastEventData(h: ReturnType<typeof harness>, actionId: string) {
  return h.repo.listEvents("u1", actionId).at(-1)!.data as { approved: Record<string, unknown>; current: Record<string, unknown> };
}

describe("approval freezes consequences (update_calendar_event)", () => {
  it("fails with changed_since_approval, writing nothing, when an attendee is added after approval was requested", async () => {
    const { cal, h, writes } = freezeHarness();
    await cal.writer.create({ ...EVENT, attendees: ["ama@x.com"] }, { eventId: "ev1", sendUpdates: "none" });

    const pending = await requestMove(h);
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.resolved).toMatchObject({ othersInvolved: ["ama@x.com"], sendUpdates: "all" });

    cal.editElsewhere("ev1", { attendees: ["ama@x.com", "kojo@x.com"] });
    const result = await h.orchestrator.approve(personalActor("u1"), pending.id);

    expect(result).toMatchObject({ status: "failed", error: { code: "changed_since_approval", stage: "recheck" } });
    expect(lastEventData(h, pending.id)).toMatchObject({
      approved: { othersInvolved: ["ama@x.com"] },
      current: { othersInvolved: ["ama@x.com", "kojo@x.com"] },
    });
    expect(writes).toEqual([]);
    expect(cal.events.get("ev1")!.start).toBe(EVENT.start);
  });

  it("fails with changed_since_approval, writing nothing, when sendUpdates would change from none to all", async () => {
    const { cal, h, writes } = freezeHarness();
    await cal.writer.create({ ...EVENT, attendees: [] }, { eventId: "ev1", sendUpdates: "none" });
    // Without attendees the move would run on its own; require approval so there is an approved version to freeze.
    h.configRepo.save({
      scope: "personal",
      ownerId: "u1",
      actionType: "update_calendar_event",
      configJson: '{"approval":{"mode":"always"}}',
      changedBy: "u1",
    });

    const pending = await requestMove(h);
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.resolved).toMatchObject({ sendUpdates: "none", othersInvolved: [] });

    cal.editElsewhere("ev1", { attendees: ["kojo@x.com"] });
    const result = await h.orchestrator.approve(personalActor("u1"), pending.id);

    expect(result).toMatchObject({ status: "failed", error: { code: "changed_since_approval", stage: "recheck" } });
    expect(lastEventData(h, pending.id)).toMatchObject({
      approved: { sendUpdates: "none" },
      current: { sendUpdates: "all", othersInvolved: ["kojo@x.com"] },
    });
    expect(writes).toEqual([]);
    expect(cal.events.get("ev1")!.start).toBe(EVENT.start);
  });

  it("runs the approved version when nothing changed in between", async () => {
    const { cal, h, writes } = freezeHarness();
    await cal.writer.create({ ...EVENT, attendees: ["ama@x.com"] }, { eventId: "ev1", sendUpdates: "none" });

    const pending = await requestMove(h);
    const result = await h.orchestrator.approve(personalActor("u1"), pending.id);

    expect(result.status).toBe("completed");
    expect(writes).toEqual(["update"]);
    expect(cal.events.get("ev1")!.start).toBe("2026-10-07T09:30:00+00:00");
  });
});
