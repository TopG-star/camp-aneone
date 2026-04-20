import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleCalendarAdapter } from "../google-calendar-adapter.js";
import type { GCalHttpClient, ListEventsOptions } from "../gcal-http-client.js";
import type { GCalEventResource } from "../calendar.types.js";
import type { CalendarEvent } from "@oneon/domain";
import { TTLCache } from "../../cache/ttl-cache.js";

// ── Mock factories ───────────────────────────────────────────

function mockClient(): GCalHttpClient {
  return {
    listEvents: vi.fn().mockResolvedValue({ kind: "calendar#events", items: [] }),
    insertEvent: vi.fn(),
    patchEvent: vi.fn(),
  } as unknown as GCalHttpClient;
}

function timedEvent(overrides: Partial<GCalEventResource> = {}): GCalEventResource {
  return {
    id: "evt-1",
    summary: "Team Standup",
    description: "Daily sync",
    location: "Zoom",
    start: { dateTime: "2026-04-18T10:00:00-05:00" },
    end: { dateTime: "2026-04-18T10:30:00-05:00" },
    attendees: [
      { email: "alice@test.com", displayName: "Alice" },
      { email: "bob@test.com" },
    ],
    status: "confirmed",
    ...overrides,
  };
}

function allDayEvent(overrides: Partial<GCalEventResource> = {}): GCalEventResource {
  return {
    id: "evt-allday",
    summary: "Company Holiday",
    description: null as unknown as string | undefined,
    location: undefined,
    start: { date: "2026-04-18" },
    end: { date: "2026-04-19" },
    attendees: [],
    status: "confirmed",
    ...overrides,
  };
}

function createAdapter(
  client?: GCalHttpClient,
  calendarId = "primary",
  cacheTtlMs = 180_000,
) {
  const c = client ?? mockClient();
  const cache = new TTLCache<CalendarEvent[]>();
  return {
    adapter: new GoogleCalendarAdapter({
      client: c,
      calendarId,
      cache,
      cacheTtlMs,
    }),
    client: c,
    cache,
  };
}

describe("GoogleCalendarAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── listEvents ─────────────────────────────────────────

  describe("listEvents", () => {
    it("calls client.listEvents with calendarId and time range", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [],
      });

      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledWith("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
      });
    });

    it("maps timed GCalEventResource to domain CalendarEvent", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent()],
      });

      const events = await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        id: "evt-1",
        title: "Team Standup",
        start: "2026-04-18T10:00:00-05:00",
        end: "2026-04-18T10:30:00-05:00",
        allDay: false,
        description: "Daily sync",
        attendees: ["alice@test.com", "bob@test.com"],
        location: "Zoom",
      });
    });

    it("maps all-day event using date field as-is (no UTC midnight conversion)", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [allDayEvent()],
      });

      const events = await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-20T00:00:00Z");

      expect(events).toHaveLength(1);
      expect(events[0].allDay).toBe(true);
      expect(events[0].start).toBe("2026-04-18");
      expect(events[0].end).toBe("2026-04-19");
    });

    it("defaults missing summary to '(no title)'", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent({ summary: undefined })],
      });

      const [event] = await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      expect(event.title).toBe("(no title)");
    });

    it("defaults missing attendees to empty array", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent({ attendees: undefined })],
      });

      const [event] = await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      expect(event.attendees).toEqual([]);
    });

    it("returns empty array when no events", async () => {
      const { adapter } = createAdapter();
      const events = await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      expect(events).toEqual([]);
    });

    it("caches listEvents results by time range", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent()],
      });

      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledTimes(1);
    });

    it("does not use cache for different time ranges", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [],
      });

      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      await adapter.listEvents("2026-04-19T00:00:00Z", "2026-04-20T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledTimes(2);
    });

    it("uses custom calendarId in client calls", async () => {
      const { adapter, client } = createAdapter(undefined, "work@group.calendar.google.com");
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [],
      });

      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledWith(
        "work@group.calendar.google.com",
        expect.any(Object),
      );
    });
  });

  // ── createEvent ────────────────────────────────────────

  describe("createEvent", () => {
    it("calls client.insertEvent with mapped body", async () => {
      const { adapter, client } = createAdapter();
      const created = timedEvent({ id: "new-evt" });
      (client.insertEvent as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const input: Omit<CalendarEvent, "id"> = {
        title: "New Meeting",
        start: "2026-04-18T14:00:00Z",
        end: "2026-04-18T15:00:00Z",
        allDay: false,
        description: "Discussion",
        attendees: ["alice@test.com"],
        location: "Room A",
      };

      await adapter.createEvent(input);

      expect(client.insertEvent).toHaveBeenCalledWith("primary", {
        summary: "New Meeting",
        description: "Discussion",
        location: "Room A",
        start: { dateTime: "2026-04-18T14:00:00Z" },
        end: { dateTime: "2026-04-18T15:00:00Z" },
        attendees: [{ email: "alice@test.com" }],
      });
    });

    it("returns mapped domain CalendarEvent", async () => {
      const { adapter, client } = createAdapter();
      const created = timedEvent({ id: "new-evt", summary: "Created" });
      (client.insertEvent as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const result = await adapter.createEvent({
        title: "Created",
        start: "2026-04-18T14:00:00Z",
        end: "2026-04-18T15:00:00Z",
        allDay: false,
        description: null,
        attendees: [],
        location: null,
      });

      expect(result.id).toBe("new-evt");
      expect(result.title).toBe("Created");
    });

    it("invalidates cache after create", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent()],
      });
      (client.insertEvent as ReturnType<typeof vi.fn>).mockResolvedValue(
        timedEvent({ id: "new" }),
      );

      // Populate cache
      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      expect(client.listEvents).toHaveBeenCalledTimes(1);

      // Create invalidates
      await adapter.createEvent({
        title: "X",
        start: "2026-04-18T14:00:00Z",
        end: "2026-04-18T15:00:00Z",
        allDay: false,
        description: null,
        attendees: [],
        location: null,
      });

      // Next list should call API again
      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      expect(client.listEvents).toHaveBeenCalledTimes(2);
    });
  });

  // ── updateEvent ────────────────────────────────────────

  describe("updateEvent", () => {
    it("calls client.patchEvent with mapped partial body", async () => {
      const { adapter, client } = createAdapter();
      const updated = timedEvent({ summary: "Updated" });
      (client.patchEvent as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

      await adapter.updateEvent("evt-1", { title: "Updated" });

      expect(client.patchEvent).toHaveBeenCalledWith("primary", "evt-1", {
        summary: "Updated",
      });
    });

    it("maps attendees update correctly", async () => {
      const { adapter, client } = createAdapter();
      const updated = timedEvent();
      (client.patchEvent as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

      await adapter.updateEvent("evt-1", {
        attendees: ["new@test.com"],
      });

      expect(client.patchEvent).toHaveBeenCalledWith("primary", "evt-1", {
        attendees: [{ email: "new@test.com" }],
      });
    });

    it("maps start/end updates to dateTime", async () => {
      const { adapter, client } = createAdapter();
      (client.patchEvent as ReturnType<typeof vi.fn>).mockResolvedValue(timedEvent());

      await adapter.updateEvent("evt-1", {
        start: "2026-04-18T16:00:00Z",
        end: "2026-04-18T17:00:00Z",
      });

      expect(client.patchEvent).toHaveBeenCalledWith("primary", "evt-1", {
        start: { dateTime: "2026-04-18T16:00:00Z" },
        end: { dateTime: "2026-04-18T17:00:00Z" },
      });
    });

    it("returns mapped domain CalendarEvent", async () => {
      const { adapter, client } = createAdapter();
      (client.patchEvent as ReturnType<typeof vi.fn>).mockResolvedValue(
        timedEvent({ summary: "Patched" }),
      );

      const result = await adapter.updateEvent("evt-1", { title: "Patched" });
      expect(result.title).toBe("Patched");
    });

    it("invalidates cache after update", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent()],
      });
      (client.patchEvent as ReturnType<typeof vi.fn>).mockResolvedValue(timedEvent());

      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");
      await adapter.updateEvent("evt-1", { title: "Y" });
      await adapter.listEvents("2026-04-18T00:00:00Z", "2026-04-19T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledTimes(2);
    });
  });

  // ── searchEvents ───────────────────────────────────────

  describe("searchEvents", () => {
    it("calls client.listEvents with q parameter", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent()],
      });

      await adapter.searchEvents("standup", "2026-04-18T00:00:00Z", "2026-04-25T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledWith("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-25T00:00:00Z",
        q: "standup",
      });
    });

    it("uses default time range when timeMin/timeMax omitted", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [],
      });

      // No time bounds — adapter should provide sensible defaults
      await adapter.searchEvents("standup");

      const callArgs = (client.listEvents as ReturnType<typeof vi.fn>).mock.calls[0][1] as ListEventsOptions;
      expect(callArgs.q).toBe("standup");
      // Defaults should be present (timeMin = now-30d, timeMax = now+30d or similar)
      expect(callArgs.timeMin).toBeDefined();
      expect(callArgs.timeMax).toBeDefined();
    });

    it("caches search results by query + time range", async () => {
      const { adapter, client } = createAdapter();
      (client.listEvents as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: "calendar#events",
        items: [timedEvent()],
      });

      await adapter.searchEvents("standup", "2026-04-18T00:00:00Z", "2026-04-25T00:00:00Z");
      await adapter.searchEvents("standup", "2026-04-18T00:00:00Z", "2026-04-25T00:00:00Z");

      expect(client.listEvents).toHaveBeenCalledTimes(1);
    });
  });
});
