import { describe, it, expect, vi } from "vitest";
import type { CalendarEvent } from "@oneon/domain";
import {
  createListCalendarEventsTool,
  listCalendarEventsSchema,
  type ListCalendarEventsDeps,
} from "./list-calendar-events.js";
import { createToolRegistry } from "./tool-registry.js";
import { expectMatchesOutputSchema } from "./__tests__/output-contract.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    title: "Team Standup",
    start: "2026-04-18T10:00:00-05:00",
    end: "2026-04-18T10:30:00-05:00",
    allDay: false,
    description: "Daily sync",
    attendees: ["alice@test.com"],
    location: "Zoom",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ListCalendarEventsDeps> = {},
): ListCalendarEventsDeps {
  return {
    calendarPort: {
      listEvents: vi.fn().mockResolvedValue([]),
      searchEvents: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// ── Schema Tests ─────────────────────────────────────────────

describe("listCalendarEventsSchema", () => {
  it("requires timeMin and timeMax", () => {
    expect(() => listCalendarEventsSchema.parse({})).toThrow();
  });

  it("accepts valid ISO-8601 strings", () => {
    const result = listCalendarEventsSchema.parse({
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
    });
    expect(result.timeMin).toBe("2026-04-18T00:00:00Z");
    expect(result.timeMax).toBe("2026-04-19T00:00:00Z");
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("list_calendar_events tool", () => {
  it("calls calendarPort.listEvents with timeMin/timeMax", async () => {
    const deps = makeDeps();
    const tool = createListCalendarEventsTool(deps);

    await tool.execute({ timeMin: "2026-04-18T00:00:00Z", timeMax: "2026-04-19T00:00:00Z" });

    expect(deps.calendarPort!.listEvents).toHaveBeenCalledWith(
      "2026-04-18T00:00:00Z",
      "2026-04-19T00:00:00Z",
    );
  });

  it("uses resolveCalendarPort when userId is provided", async () => {
    const resolvedPort = {
      listEvents: vi.fn().mockResolvedValue([makeEvent()]),
      searchEvents: vi.fn().mockResolvedValue([]),
    };

    const tool = createListCalendarEventsTool({
      resolveCalendarPort: vi.fn().mockReturnValue(resolvedPort),
    });

    await tool.execute({
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
      userId: "user-A",
    });

    expect(resolvedPort.listEvents).toHaveBeenCalledOnce();
  });

  it.each([
    ["the resolver finds no calendar for the user", { resolveCalendarPort: vi.fn().mockReturnValue(null) }],
    ["no resolver is wired", {}],
  ])("never falls back to the global port when a userId is present: %s", async (_name, extra) => {
    const deps = makeDeps(extra);
    const result = await createListCalendarEventsTool(deps).execute({
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
      userId: "user-A",
    });
    expect(deps.calendarPort!.listEvents).not.toHaveBeenCalled();
    expect(result.summary).toBe("Calendar integration is not configured for this user.");
  });

  it("returns events in data field", async () => {
    const deps = makeDeps();
    (deps.calendarPort!.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEvent(),
      makeEvent({ id: "evt-2", title: "Lunch" }),
    ]);
    const tool = createListCalendarEventsTool(deps);

    const result = await tool.execute({
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
    });

    expect(result.data).toHaveLength(2);
    expect(result.summary).toContain("2 calendar events");
    expectMatchesOutputSchema(tool, result);
  });

  it("returns zero-count summary when no events", async () => {
    const deps = makeDeps();
    const tool = createListCalendarEventsTool(deps);

    const result = await tool.execute({
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
    });

    expect(result.data).toEqual([]);
    expect(result.summary).toContain("No calendar events");
  });

  it("uses singular form for 1 event", async () => {
    const deps = makeDeps();
    (deps.calendarPort!.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([makeEvent()]);
    const tool = createListCalendarEventsTool(deps);

    const result = await tool.execute({
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
    });

    expect(result.summary).toContain("1 calendar event");
    expect(result.summary).not.toContain("events");
  });

  it("integrates with tool registry", async () => {
    const deps = makeDeps();
    const registry = createToolRegistry();
    registry.register(createListCalendarEventsTool(deps));

    expect(registry.has("list_calendar_events")).toBe(true);
    const def = registry.get("list_calendar_events");
    expect(def?.name).toBe("list_calendar_events");
  });
});
