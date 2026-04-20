import { describe, it, expect, vi } from "vitest";
import type { CalendarEvent } from "@oneon/domain";
import {
  createListCalendarEventsTool,
  listCalendarEventsSchema,
  type ListCalendarEventsDeps,
} from "./list-calendar-events.js";
import { createToolRegistry } from "./tool-registry.js";

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
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
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

    expect(deps.calendarPort.listEvents).toHaveBeenCalledWith(
      "2026-04-18T00:00:00Z",
      "2026-04-19T00:00:00Z",
    );
  });

  it("returns events in data field", async () => {
    const deps = makeDeps();
    (deps.calendarPort.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
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
    (deps.calendarPort.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue([makeEvent()]);
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
