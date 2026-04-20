import type { TokenProvider } from "./token-provider.js";
import type { GmailListResponse, GmailMessageResource } from "./gmail.types.js";
import { fetchWithRetry } from "../http/fetch-with-retry.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Metadata headers we request — keeps API cost low and response small.
 * Swap to googleapis SDK later by reimplementing this interface.
 */
const METADATA_HEADERS = ["From", "Subject", "Date", "Message-Id", "To"] as const;

export interface ListMessageIdsOptions {
  maxResults: number;
  q?: string;
  labelIds?: string[];
  pageToken?: string;
}

/**
 * Thin fetch wrapper around the Gmail REST API.
 * Only knows how to make HTTP calls — no business logic.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class GmailHttpClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly tokenProvider: TokenProvider,
    options?: { timeoutMs?: number },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listMessageIds(
    options: ListMessageIdsOptions
  ): Promise<GmailListResponse> {
    const url = new URL(`${BASE_URL}/messages`);
    url.searchParams.set("maxResults", String(options.maxResults));

    if (options.q) {
      url.searchParams.set("q", options.q);
    }
    if (options.labelIds) {
      for (const label of options.labelIds) {
        url.searchParams.append("labelIds", label);
      }
    }
    if (options.pageToken) {
      url.searchParams.set("pageToken", options.pageToken);
    }

    const response = await this.request(url);
    const body = (await response.json()) as GmailListResponse;

    return {
      messages: body.messages ?? [],
      nextPageToken: body.nextPageToken,
      resultSizeEstimate: body.resultSizeEstimate,
    };
  }

  async getMessage(messageId: string): Promise<GmailMessageResource> {
    const url = new URL(`${BASE_URL}/messages/${messageId}`);
    url.searchParams.set("format", "metadata");
    for (const header of METADATA_HEADERS) {
      url.searchParams.append("metadataHeaders", header);
    }

    const response = await this.request(url);
    return (await response.json()) as GmailMessageResource;
  }

  private async request(url: URL): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetchWithRetry(async () => {
        const token = await this.tokenProvider.getAccessToken();
        return fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `Gmail API error ${response.status}: ${errorBody}`
        );
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
}
