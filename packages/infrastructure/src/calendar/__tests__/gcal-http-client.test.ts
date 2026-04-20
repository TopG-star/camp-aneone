import { describe, it, expect, vi, beforeEach } from "vitest";
import { GCalHttpClient } from "../gcal-http-client.js";
import type { TokenProvider } from "../../gmail/token-provider.js";
import type { GCalEventsListResponse, GCalEventResource } from "../calendar.types.js";

// ── Mock global fetch ────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockTokenProvider(token = "test-access-token"): TokenProvider {
  return { getAccessToken: vi.fn().mockResolvedValue(token) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fakeEvent: GCalEventResource = {
  id: "evt-1",
  summary: "Team Standup",
  description: "Daily sync",
  location: "Zoom",
  start: { dateTime: "2026-04-18T10:00:00-05:00" },
  end: { dateTime: "2026-04-18T10:30:00-05:00" },
  attendees: [{ email: "alice@test.com" }],
  status: "confirmed",
};

describe("GCalHttpClient", () => {
  let tokenProvider: TokenProvider;
  let client: GCalHttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenProvider = mockTokenProvider();
    client = new GCalHttpClient(tokenProvider);
  });

  // ── listEvents ─────────────────────────────────────────

  describe("listEvents", () => {
    it("calls events.list with Authorization header", async () => {
      const response: GCalEventsListResponse = {
        kind: "calendar#events",
        items: [fakeEvent],
      };
      mockFetch.mockResolvedValue(jsonResponse(response));

      await client.listEvents("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events"
      );
      expect(opts.headers.Authorization).toBe("Bearer test-access-token");
    });

    it("passes timeMin and timeMax as query params", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ kind: "calendar#events", items: [] })
      );

      await client.listEvents("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
      });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.get("timeMin")).toBe("2026-04-18T00:00:00Z");
      expect(parsed.searchParams.get("timeMax")).toBe("2026-04-19T00:00:00Z");
    });

    it("sets singleEvents=true and orderBy=startTime", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ kind: "calendar#events", items: [] })
      );

      await client.listEvents("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
      });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.get("singleEvents")).toBe("true");
      expect(parsed.searchParams.get("orderBy")).toBe("startTime");
    });

    it("passes timeZone when provided", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ kind: "calendar#events", items: [] })
      );

      await client.listEvents("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
        timeZone: "America/New_York",
      });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.get("timeZone")).toBe("America/New_York");
    });

    it("passes q (search query) when provided", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ kind: "calendar#events", items: [] })
      );

      await client.listEvents("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
        q: "standup",
      });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.get("q")).toBe("standup");
    });

    it("returns items array (empty when no events)", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ kind: "calendar#events" })
      );

      const result = await client.listEvents("primary", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
      });

      expect(result.items).toEqual([]);
    });

    it("URL-encodes calendarId", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ kind: "calendar#events", items: [] })
      );

      await client.listEvents("user@example.com", {
        timeMin: "2026-04-18T00:00:00Z",
        timeMax: "2026-04-19T00:00:00Z",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain(
        "/calendars/user%40example.com/events"
      );
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
          status: 401,
        })
      );

      await expect(
        client.listEvents("primary", {
          timeMin: "2026-04-18T00:00:00Z",
          timeMax: "2026-04-19T00:00:00Z",
        })
      ).rejects.toThrow("Google Calendar API error 401");
    });
  });

  // ── insertEvent ────────────────────────────────────────

  describe("insertEvent", () => {
    it("calls events.insert with POST and JSON body", async () => {
      mockFetch.mockResolvedValue(jsonResponse(fakeEvent));

      const body = {
        summary: "New Meeting",
        start: { dateTime: "2026-04-18T14:00:00Z" },
        end: { dateTime: "2026-04-18T15:00:00Z" },
      };
      await client.insertEvent("primary", body);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain("/calendars/primary/events");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(opts.body)).toEqual(body);
    });

    it("returns created event resource", async () => {
      mockFetch.mockResolvedValue(jsonResponse(fakeEvent));

      const result = await client.insertEvent("primary", {
        summary: "New Meeting",
        start: { dateTime: "2026-04-18T14:00:00Z" },
        end: { dateTime: "2026-04-18T15:00:00Z" },
      });

      expect(result.id).toBe("evt-1");
      expect(result.summary).toBe("Team Standup");
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Bad Request" } }), {
          status: 400,
        })
      );

      await expect(
        client.insertEvent("primary", {
          summary: "Bad",
          start: { dateTime: "invalid" },
          end: { dateTime: "invalid" },
        })
      ).rejects.toThrow("Google Calendar API error 400");
    });
  });

  // ── patchEvent ─────────────────────────────────────────

  describe("patchEvent", () => {
    it("calls events.patch with PATCH method", async () => {
      mockFetch.mockResolvedValue(jsonResponse(fakeEvent));

      await client.patchEvent("primary", "evt-1", {
        summary: "Updated Title",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain("/calendars/primary/events/evt-1");
      expect(opts.method).toBe("PATCH");
      expect(JSON.parse(opts.body)).toEqual({ summary: "Updated Title" });
    });

    it("returns updated event resource", async () => {
      const updated = { ...fakeEvent, summary: "Updated" };
      mockFetch.mockResolvedValue(jsonResponse(updated));

      const result = await client.patchEvent("primary", "evt-1", {
        summary: "Updated",
      });

      expect(result.summary).toBe("Updated");
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Not Found" } }), {
          status: 404,
        })
      );

      await expect(
        client.patchEvent("primary", "bad-id", { summary: "x" })
      ).rejects.toThrow("Google Calendar API error 404");
    });
  });

  // ── Auth ───────────────────────────────────────────────

  it("acquires a fresh token per request", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ kind: "calendar#events", items: [] })
    );

    await client.listEvents("primary", {
      timeMin: "2026-04-18T00:00:00Z",
      timeMax: "2026-04-19T00:00:00Z",
    });

    expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(1);
  });
});
