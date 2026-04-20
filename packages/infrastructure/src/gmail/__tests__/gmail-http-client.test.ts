import { describe, it, expect, vi, beforeEach } from "vitest";
import { GmailHttpClient } from "../gmail-http-client.js";
import type { TokenProvider } from "../token-provider.js";
import type { GmailListResponse, GmailMessageResource } from "../gmail.types.js";

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

describe("GmailHttpClient", () => {
  let tokenProvider: TokenProvider;
  let client: GmailHttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    tokenProvider = mockTokenProvider();
    client = new GmailHttpClient(tokenProvider);
  });

  // ── listMessageIds ──────────────────────────────────────

  describe("listMessageIds", () => {
    it("calls messages.list with Authorization header", async () => {
      const response: GmailListResponse = {
        messages: [{ id: "msg-1", threadId: "t-1" }],
        resultSizeEstimate: 1,
      };
      mockFetch.mockResolvedValue(jsonResponse(response));

      await client.listMessageIds({ maxResults: 10 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url.toString()).toContain(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages"
      );
      expect(opts.headers.Authorization).toBe("Bearer test-access-token");
    });

    it("passes maxResults as query parameter", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], resultSizeEstimate: 0 })
      );

      await client.listMessageIds({ maxResults: 25 });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.get("maxResults")).toBe("25");
    });

    it("passes q parameter when provided", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], resultSizeEstimate: 0 })
      );

      await client.listMessageIds({ maxResults: 10, q: "after:1700000000" });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.get("q")).toBe("after:1700000000");
    });

    it("passes labelIds as repeated query params", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], resultSizeEstimate: 0 })
      );

      await client.listMessageIds({
        maxResults: 10,
        labelIds: ["INBOX", "UNREAD"],
      });

      const [url] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.getAll("labelIds")).toEqual([
        "INBOX",
        "UNREAD",
      ]);
    });

    it("returns message ID/threadId pairs", async () => {
      const response: GmailListResponse = {
        messages: [
          { id: "msg-1", threadId: "t-1" },
          { id: "msg-2", threadId: "t-2" },
        ],
        resultSizeEstimate: 2,
      };
      mockFetch.mockResolvedValue(jsonResponse(response));

      const result = await client.listMessageIds({ maxResults: 10 });

      expect(result.messages).toEqual([
        { id: "msg-1", threadId: "t-1" },
        { id: "msg-2", threadId: "t-2" },
      ]);
    });

    it("returns empty array when no messages", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ resultSizeEstimate: 0 })
      );

      const result = await client.listMessageIds({ maxResults: 10 });

      expect(result.messages).toEqual([]);
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
          status: 401,
        })
      );

      await expect(
        client.listMessageIds({ maxResults: 10 })
      ).rejects.toThrow("Gmail API error 401");
    });
  });

  // ── getMessage ──────────────────────────────────────────

  describe("getMessage", () => {
    const fakeMessage: GmailMessageResource = {
      id: "msg-1",
      threadId: "t-1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Hello world",
      internalDate: "1700000000000",
      payload: {
        headers: [
          { name: "From", value: "alice@example.com" },
          { name: "Subject", value: "Test Subject" },
          { name: "Date", value: "Tue, 14 Nov 2023 12:00:00 +0000" },
          { name: "Message-Id", value: "<abc123@example.com>" },
          { name: "To", value: "bob@example.com" },
        ],
      },
    };

    it("fetches message with format=metadata and specific headers", async () => {
      mockFetch.mockResolvedValue(jsonResponse(fakeMessage));

      await client.getMessage("msg-1");

      const [url, opts] = mockFetch.mock.calls[0];
      const parsed = new URL(url.toString());
      expect(parsed.pathname).toBe("/gmail/v1/users/me/messages/msg-1");
      expect(parsed.searchParams.get("format")).toBe("metadata");
      expect(parsed.searchParams.getAll("metadataHeaders")).toEqual(
        expect.arrayContaining(["From", "Subject", "Date", "Message-Id", "To"])
      );
      expect(opts.headers.Authorization).toBe("Bearer test-access-token");
    });

    it("returns the full message resource", async () => {
      mockFetch.mockResolvedValue(jsonResponse(fakeMessage));

      const result = await client.getMessage("msg-1");

      expect(result.id).toBe("msg-1");
      expect(result.snippet).toBe("Hello world");
      expect(result.labelIds).toContain("INBOX");
      expect(result.payload.headers).toHaveLength(5);
    });

    it("throws on non-200 response", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Not Found" } }), {
          status: 404,
        })
      );

      await expect(client.getMessage("bad-id")).rejects.toThrow(
        "Gmail API error 404"
      );
    });

    it("acquires a fresh token per request", async () => {
      mockFetch.mockResolvedValue(jsonResponse(fakeMessage));

      await client.getMessage("msg-1");

      expect(tokenProvider.getAccessToken).toHaveBeenCalledTimes(1);
    });
  });
});
