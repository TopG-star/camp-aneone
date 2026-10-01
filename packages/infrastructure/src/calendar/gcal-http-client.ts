import type { TokenProvider } from "../gmail/token-provider.js";
import type {
  GCalEventsListResponse,
  GCalEventResource,
  GCalEventWriteBody,
} from "./calendar.types.js";
import { fetchWithRetry } from "../http/fetch-with-retry.js";
import { ExternalCallError } from "@oneon/domain";

const BASE_URL = "https://www.googleapis.com/calendar/v3";

export class GCalApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Google Calendar API error ${status}: ${body}`);
    this.name = "GCalApiError";
  }
}

type SendUpdates = "all" | "none";

export interface ListEventsOptions {
  timeMin: string;
  timeMax: string;
  timeZone?: string;
  q?: string;
  maxResults?: number;
}

/**
 * Thin fetch wrapper around the Google Calendar REST API v3.
 * Every method takes `calendarId` — nothing is hardcoded to "primary".
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class GCalHttpClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly tokenProvider: TokenProvider,
    options?: { timeoutMs?: number },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listEvents(
    calendarId: string,
    options: ListEventsOptions,
  ): Promise<GCalEventsListResponse> {
    const url = new URL(
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("timeMin", options.timeMin);
    url.searchParams.set("timeMax", options.timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    if (options.timeZone) {
      url.searchParams.set("timeZone", options.timeZone);
    }
    if (options.q) {
      url.searchParams.set("q", options.q);
    }
    if (options.maxResults !== undefined) {
      url.searchParams.set("maxResults", String(options.maxResults));
    }

    const response = await this.request(url);
    const body = (await response.json()) as GCalEventsListResponse;

    return {
      kind: body.kind,
      items: body.items ?? [],
      nextPageToken: body.nextPageToken,
      timeZone: body.timeZone,
    };
  }

  async getEvent(calendarId: string, eventId: string): Promise<GCalEventResource | null> {
    try {
      const response = await this.request(this.eventUrl(calendarId, eventId));
      return (await response.json()) as GCalEventResource;
    } catch (error) {
      if (error instanceof GCalApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  async insertEvent(
    calendarId: string,
    body: GCalEventWriteBody,
    options: { sendUpdates: SendUpdates } = { sendUpdates: "none" },
  ): Promise<GCalEventResource> {
    const url = new URL(`${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("sendUpdates", options.sendUpdates);
    const response = await this.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      { retry: false },
    );
    return (await response.json()) as GCalEventResource;
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    body: Partial<GCalEventWriteBody>,
    options?: { ifMatch?: string; sendUpdates?: SendUpdates },
  ): Promise<GCalEventResource> {
    const url = this.eventUrl(calendarId, eventId);
    if (options?.sendUpdates) url.searchParams.set("sendUpdates", options.sendUpdates);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.ifMatch) headers["If-Match"] = options.ifMatch;
    const response = await this.request(
      url,
      { method: "PATCH", headers, body: JSON.stringify(body) },
      { retry: !options?.ifMatch },
    );
    return (await response.json()) as GCalEventResource;
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    options: { ifMatch: string; sendUpdates: SendUpdates },
  ): Promise<void> {
    const url = this.eventUrl(calendarId, eventId);
    url.searchParams.set("sendUpdates", options.sendUpdates);
    await this.request(url, { method: "DELETE", headers: { "If-Match": options.ifMatch } }, { retry: false });
  }

  private eventUrl(calendarId: string, eventId: string): URL {
    return new URL(`${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }

  private async request(url: URL, init?: RequestInit, options: { retry: boolean } = { retry: true }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const attempt = async (): Promise<Response> => {
      let token: string;
      try {
        token = await this.tokenProvider.getAccessToken();
      } catch (error) {
        throw new ExternalCallError(
          "definite",
          "auth",
          `Google token unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return fetch(url.toString(), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init?.headers },
        signal: controller.signal,
      });
    };

    try {
      const response = options.retry ? await fetchWithRetry(attempt) : await attempt();
      if (!response.ok) {
        throw new GCalApiError(response.status, await response.text());
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
