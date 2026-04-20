import { describe, it, expect, vi } from "vitest";
import type { CalendarEvent } from "@oneon/domain";
import {
  createSearchCalendarTool,
  searchCalendarSchema,
  type SearchCalendarDeps,
} from "./search-calendar.js";
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
  overrides: Partial<SearchCalendarDeps> = {},
): SearchCalendarDeps {
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

describe("searchCalendarSchema", () => {
  it("requires query", () => {
    expect(() => searchCalendarSchema.parse({})).toThrow();
  });

  it("defaults timeMin and timeMax to ±30 days", () => {
    const result = searchCalendarSchema.parse({ query: "standup" });
    expect(result.query).toBe("standup");
    expect(result.timeMin).toBeDefined();
    expect(result.timeMax).toBeDefined();
  });

  it("accepts explicit time bounds", () => {
    const result = searchCalendarSchema.parse({
      query: "standup",
      timeMin: "2026-04-01T00:00:00Z",
      timeMax: "2026-04-30T00:00:00Z",
    });
    expect(result.timeMin).toBe("2026-04-01T00:00:00Z");
    expect(result.timeMax).toBe("2026-04-30T00:00:00Z");
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("search_calendar tool", () => {
  it("calls calendarPort.searchEvents with query and time bounds", async () => {
    const deps = makeDeps();
    const tool = createSearchCalendarTool(deps);

    await tool.execute({
      query: "standup",
      timeMin: "2026-04-01T00:00:00Z",
      timeMax: "2026-04-30T00:00:00Z",
    });

    expect(deps.calendarPort.searchEvents).toHaveBeenCalledWith(
      "standup",
      "2026-04-01T00:00:00Z",
      "2026-04-30T00:00:00Z",
    );
  });

  it("returns matching events in data field", async () => {
    const deps = makeDeps();
    (deps.calendarPort.searchEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEvent(),
      makeEvent({ id: "evt-2", title: "Sprint Standup" }),
    ]);
    const tool = createSearchCalendarTool(deps);

    const result = await tool.execute({
      query: "standup",
      timeMin: "2026-04-01T00:00:00Z",
      timeMax: "2026-04-30T00:00:00Z",
    });

    expect(result.data).toHaveLength(2);
    expect(result.summary).toContain('2 calendar events matching "standup"');
  });

  it("returns zero-count summary when no matches", async () => {
    const deps = makeDeps();
    const tool = createSearchCalendarTool(deps);

    const result = await tool.execute({
      query: "nonexistent",
      timeMin: "2026-04-01T00:00:00Z",
      timeMax: "2026-04-30T00:00:00Z",
    });

    expect(result.data).toEqual([]);
    expect(result.summary).toContain('No calendar events found matching "nonexistent"');
  });

  it("uses singular form for 1 match", async () => {
    const deps = makeDeps();
    (deps.calendarPort.searchEvents as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeEvent(),
    ]);
    const tool = createSearchCalendarTool(deps);

    const result = await tool.execute({
      query: "standup",
      timeMin: "2026-04-01T00:00:00Z",
      timeMax: "2026-04-30T00:00:00Z",
    });

    expect(result.summary).toContain('1 calendar event matching');
    expect(result.summary).not.toContain("events matching");
  });

  it("integrates with tool registry", async () => {
    const deps = makeDeps();
    const registry = createToolRegistry();
    registry.register(createSearchCalendarTool(deps));

    expect(registry.has("search_calendar")).toBe(true);
  });
});
