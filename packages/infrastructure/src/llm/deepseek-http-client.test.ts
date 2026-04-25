import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DeepSeekHttpClient,
  DeepSeekRateLimitError,
  DeepSeekApiError,
  DeepSeekEmptyResponseError,
  type DeepSeekRequest,
} from "./deepseek-http-client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_REQUEST: DeepSeekRequest = {
  model: "deepseek-test-model",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 512,
};

function makeResponse(
  status: number,
  body: unknown,
  contentType = "application/json",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType },
  });
}

function makeTextResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DeepSeekHttpClient", () => {
  let client: DeepSeekHttpClient;

  beforeEach(() => {
    client = new DeepSeekHttpClient("sk-test-key", "https://api.test.deepseek.com");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns content from the first choice on HTTP 200", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(200, {
        choices: [{ message: { content: '{"category":"work"}' } }],
      }),
    );

    const result = await client.chatCompletion(BASE_REQUEST);

    expect(result).toBe('{"category":"work"}');
    expect(fetch).toHaveBeenCalledOnce();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test.deepseek.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test-key");
  });

  it("sends response_format when provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "{}" } }] }),
    );

    await client.chatCompletion({ ...BASE_REQUEST, response_format: { type: "json_object" } });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.response_format).toEqual({ type: "json_object" });
  });

  it("throws DeepSeekRateLimitError on HTTP 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeTextResponse(429, "rate limited"));

    await expect(client.chatCompletion(BASE_REQUEST)).rejects.toThrow(DeepSeekRateLimitError);
  });

  it("DeepSeekRateLimitError.status is 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeTextResponse(429, ""));

    const err = await client.chatCompletion(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(DeepSeekRateLimitError);
    expect(err.status).toBe(429);
  });

  it("throws DeepSeekApiError with status on non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeTextResponse(500, "internal error"));

    const err = await client.chatCompletion(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("HTTP 500");
  });

  it("throws DeepSeekApiError with status on HTTP 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeTextResponse(401, "unauthorized"));

    const err = await client.chatCompletion(BASE_REQUEST).catch((e) => e);
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect(err.status).toBe(401);
  });

  it("throws DeepSeekEmptyResponseError when content is empty string", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "" } }] }),
    );

    await expect(client.chatCompletion(BASE_REQUEST)).rejects.toThrow(DeepSeekEmptyResponseError);
  });

  it("throws DeepSeekEmptyResponseError when content is null", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: null } }] }),
    );

    await expect(client.chatCompletion(BASE_REQUEST)).rejects.toThrow(DeepSeekEmptyResponseError);
  });

  it("propagates AbortError when signal is fired", async () => {
    const controller = new AbortController();

    vi.mocked(fetch).mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    controller.abort();
    const err = await client.chatCompletion(BASE_REQUEST, controller.signal).catch((e) => e);

    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
  });

  it("passes the abort signal to fetch", async () => {
    const controller = new AbortController();

    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "ok" } }] }),
    );

    await client.chatCompletion(BASE_REQUEST, controller.signal);

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it("strips trailing slash from baseUrl", async () => {
    const trailingSlashClient = new DeepSeekHttpClient("key", "https://test.api/");
    vi.mocked(fetch).mockResolvedValueOnce(
      makeResponse(200, { choices: [{ message: { content: "ok" } }] }),
    );

    await trailingSlashClient.chatCompletion(BASE_REQUEST);

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test.api/v1/chat/completions");
  });
});
