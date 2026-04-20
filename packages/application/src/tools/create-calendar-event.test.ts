import { describe, it, expect, vi } from "vitest";
import type { CalendarEvent } from "@oneon/domain";
import {
  createCreateCalendarEventTool,
  createCalendarEventSchema,
  type CreateCalendarEventDeps,
} from "./create-calendar-event.js";
import { createToolRegistry } from "./tool-registry.js";

// ── Fixtures ─────────────────────────────────────────────────

function makeCreated(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "new-evt",
    title: "Team Lunch",
    start: "2026-04-18T12:00:00Z",
    end: "2026-04-18T13:00:00Z",
    allDay: false,
    description: "Casual lunch",
    attendees: ["alice@test.com"],
    location: "Cafe",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<CreateCalendarEventDeps> = {},
): CreateCalendarEventDeps {
  return {
    calendarPort: {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue(makeCreated()),
      updateEvent: vi.fn(),
      searchEvents: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

// ── Schema Tests ─────────────────────────────────────────────

describe("createCalendarEventSchema", () => {
  it("requires title, start, and end", () => {
    expect(() => createCalendarEventSchema.parse({})).toThrow();
  });

  it("defaults optional fields", () => {
    const result = createCalendarEventSchema.parse({
      title: "Meeting",
      start: "2026-04-18T14:00:00Z",
      end: "2026-04-18T15:00:00Z",
    });
    expect(result.description).toBeNull();
    expect(result.attendees).toEqual([]);
    expect(result.location).toBeNull();
  });

  it("accepts full input", () => {
    const result = createCalendarEventSchema.parse({
      title: "Meeting",
      start: "2026-04-18T14:00:00Z",
      end: "2026-04-18T15:00:00Z",
      description: "Discussion",
      attendees: ["bob@test.com"],
      location: "Room A",
    });
    expect(result.attendees).toEqual(["bob@test.com"]);
  });

  it("rejects invalid email in attendees", () => {
    expect(() =>
      createCalendarEventSchema.parse({
        title: "Meeting",
        start: "2026-04-18T14:00:00Z",
        end: "2026-04-18T15:00:00Z",
        attendees: ["not-an-email"],
      }),
    ).toThrow();
  });
});

// ── Tool Execution Tests ─────────────────────────────────────

describe("create_calendar_event tool", () => {
  it("calls calendarPort.createEvent with mapped input", async () => {
    const deps = makeDeps();
    const tool = createCreateCalendarEventTool(deps);

    await tool.execute({
      title: "Team Lunch",
      start: "2026-04-18T12:00:00Z",
      end: "2026-04-18T13:00:00Z",
      description: "Casual lunch",
      attendees: ["alice@test.com"],
      location: "Cafe",
    });

    expect(deps.calendarPort.createEvent).toHaveBeenCalledWith({
      title: "Team Lunch",
      start: "2026-04-18T12:00:00Z",
      end: "2026-04-18T13:00:00Z",
      allDay: false,
      description: "Casual lunch",
      attendees: ["alice@test.com"],
      location: "Cafe",
    });
  });

  it("returns created event in data field", async () => {
    const deps = makeDeps();
    const tool = createCreateCalendarEventTool(deps);

    const result = await tool.execute({
      title: "Team Lunch",
      start: "2026-04-18T12:00:00Z",
      end: "2026-04-18T13:00:00Z",
      description: null,
      attendees: [],
      location: null,
    });

    expect(result.data).toEqual(makeCreated());
    expect(result.summary).toContain('Created calendar event "Team Lunch"');
  });

  it("includes start time in summary", async () => {
    const deps = makeDeps();
    const tool = createCreateCalendarEventTool(deps);

    const result = await tool.execute({
      title: "Meeting",
      start: "2026-04-18T14:00:00Z",
      end: "2026-04-18T15:00:00Z",
      description: null,
      attendees: [],
      location: null,
    });

    expect(result.summary).toContain("2026-04-18T12:00");
  });

  it("integrates with tool registry", async () => {
    const deps = makeDeps();
    const registry = createToolRegistry();
    registry.register(createCreateCalendarEventTool(deps));

    expect(registry.has("create_calendar_event")).toBe(true);
  });
});
