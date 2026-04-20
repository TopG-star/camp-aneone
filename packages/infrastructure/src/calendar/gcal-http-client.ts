import type { TokenProvider } from "../gmail/token-provider.js";
import type {
  GCalEventsListResponse,
  GCalEventResource,
  GCalEventWriteBody,
} from "./calendar.types.js";
import { fetchWithRetry } from "../http/fetch-with-retry.js";

const BASE_URL = "https://www.googleapis.com/calendar/v3";

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

  async insertEvent(
    calendarId: string,
    body: GCalEventWriteBody,
  ): Promise<GCalEventResource> {
    const url = new URL(
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`,
    );

    const response = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await response.json()) as GCalEventResource;
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    body: Partial<GCalEventWriteBody>,
  ): Promise<GCalEventResource> {
    const url = new URL(
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );

    const response = await this.request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return (await response.json()) as GCalEventResource;
  }

  private async request(
    url: URL,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchWithRetry(async () => {
        const token = await this.tokenProvider.getAccessToken();
        return fetch(url.toString(), {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...init?.headers,
          },
          signal: controller.signal,
        });
      },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Google Calendar API error ${response.status}: ${errorBody}`,
        );
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
