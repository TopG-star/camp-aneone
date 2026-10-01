import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExternalCallError } from "@oneon/domain";
import { GCalHttpClient } from "../gcal-http-client.js";
import { GoogleCalendarAdapter } from "../google-calendar-adapter.js";
import { TTLCache } from "../../cache/ttl-cache.js";

const tokenProvider = { getAccessToken: vi.fn().mockResolvedValue("tok") };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function adapter() {
  return new GoogleCalendarAdapter({
    client: new GCalHttpClient(tokenProvider),
    calendarId: "test-cal",
    cache: new TTLCache(),
    cacheTtlMs: 1000,
  });
}

const EVENT = {
  id: "abc123",
  etag: '"v1"',
  updated: "2026-10-01T10:00:00.000Z",
  summary: "Call with Ama",
  start: { dateTime: "2026-10-07T10:00:00Z" },
  end: { dateTime: "2026-10-07T10:30:00Z" },
  attendees: [{ email: "ama@example.com" }],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GoogleCalendarAdapter reader", () => {
  it("returns the event with its version", async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await expect(adapter().getEvent("abc123")).resolves.toMatchObject({ id: "abc123", etag: '"v1"', title: "Call with Ama" });
  });

  it("returns null for 404 and 410", async () => {
    fetchMock.mockResolvedValueOnce(json(404, {})).mockResolvedValueOnce(json(410, {}));
    await expect(adapter().getEvent("x")).resolves.toBeNull();
    await expect(adapter().getEvent("x")).resolves.toBeNull();
  });

  it("treats a cancelled event as gone (Review Focus 3)", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...EVENT, status: "cancelled" }));
    await expect(adapter().getEvent("abc123")).resolves.toBeNull();
  });
});

describe("GoogleCalendarAdapter writer", () => {
  it("creates with the client-chosen id and explicit sendUpdates", async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await adapter().create(
      { title: "Call with Ama", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", allDay: false, description: null, attendees: ["ama@example.com"], location: null },
      { eventId: "abc123", sendUpdates: "all" },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("sendUpdates")).toBe("all");
    expect(JSON.parse(init.body as string)).toMatchObject({ id: "abc123", summary: "Call with Ama" });
  });

  it("sends If-Match on update and remove", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...EVENT, etag: '"v2"' })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await adapter().update("abc123", { title: "New" }, { ifMatch: '"v1"', sendUpdates: "none" });
    await adapter().remove("abc123", { ifMatch: '"v2"', sendUpdates: "all" });
    const [, patchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((patchInit.headers as Record<string, string>)["If-Match"]).toBe('"v1"');
    expect(deleteInit.method).toBe("DELETE");
    expect((deleteInit.headers as Record<string, string>)["If-Match"]).toBe('"v2"');
    expect(new URL(deleteUrl).searchParams.get("sendUpdates")).toBe("all");
  });

  it.each([
    [409, "unknown", "already_exists"],
    [412, "definite", "changed_since"],
    [400, "definite", "rejected_by_google"],
    [403, "definite", "rejected_by_google"],
    [404, "definite", "not_found"],
    [429, "unknown", "google_unavailable"],
    [503, "unknown", "google_unavailable"],
  ])("maps HTTP %i on create to %s / %s without retrying", async (status, outcome, code) => {
    fetchMock.mockResolvedValue(json(status, { error: { message: "x" } }));
    const error = await adapter()
      .create(
        { title: "t", start: "2026-10-07T10:00:00Z", end: "2026-10-07T11:00:00Z", allDay: false, description: null, attendees: [], location: null },
        { eventId: "abc123", sendUpdates: "none" },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCallError);
    expect(error).toMatchObject({ outcome, code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to unknown", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = await adapter().remove("abc123", { ifMatch: '"v1"', sendUpdates: "none" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "unknown", code: "google_unreachable" });
  });

  it("maps a token refresh failure to a definite auth failure", async () => {
    tokenProvider.getAccessToken.mockRejectedValueOnce(new Error("Token refresh failed"));
    const error = await adapter().remove("abc123", { ifMatch: '"v1"', sendUpdates: "none" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "definite", code: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
