/**
 * Tiny fetch-based HTTP client for the DeepSeek v1 (OpenAI-compatible) API.
 * No SDK dependency. Handles JSON output enforcement, 429 rate-limit, abort, and
 * empty-content responses per DeepSeek v4 API behaviour notes.
 */

// ── Request / Response shapes ─────────────────────────────────────────────────

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekRequest {
  model: string;
  messages: DeepSeekMessage[];
  /** Recommended: keep ≥512 to avoid mid-stream JSON truncation. */
  max_tokens: number;
  /**
   * Pass `{ type: "json_object" }` for classification/intent calls.
   * Requires the word "json" to appear in the system or user prompt.
   */
  response_format?: { type: "json_object" };
}

interface DeepSeekApiResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

// ── Typed error hierarchy ─────────────────────────────────────────────────────

export class DeepSeekApiError extends Error {
  /** Matches the property name that CircuitBreaker.extractStatusCode inspects. */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DeepSeekApiError";
    this.status = status;
  }
}

/** Thrown immediately on HTTP 429 — do not retry, surface to caller. */
export class DeepSeekRateLimitError extends DeepSeekApiError {
  constructor() {
    super("DeepSeek rate limit exceeded (429). Reduce concurrency or back off.", 429);
    this.name = "DeepSeekRateLimitError";
  }
}

/**
 * Thrown when the API returns an empty content field.
 * Per DeepSeek docs: occasionally happens; callers should retry.
 */
export class DeepSeekEmptyResponseError extends Error {
  constructor() {
    super("DeepSeek returned empty content field. Retry is appropriate.");
    this.name = "DeepSeekEmptyResponseError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class DeepSeekHttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.deepseek.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * POST /v1/chat/completions and return the first choice's content string.
   *
   * Throws:
   * - `DeepSeekRateLimitError`  on HTTP 429
   * - `DeepSeekApiError`        on any other non-2xx response
   * - `DeepSeekEmptyResponseError` when content is null / empty string
   * - `DOMException` (name === "AbortError") when the provided signal fires
   */
  async chatCompletion(
    body: DeepSeekRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      // Re-throw AbortError and network errors as-is so callers can distinguish them.
      throw err;
    }

    if (response.status === 429) {
      throw new DeepSeekRateLimitError();
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new DeepSeekApiError(
        `DeepSeek API error HTTP ${response.status}: ${text}`,
        response.status,
      );
    }

    const data = (await response.json()) as DeepSeekApiResponse;
    const content = data.choices?.[0]?.message?.content;

    if (content === null || content === undefined || content === "") {
      throw new DeepSeekEmptyResponseError();
    }

    return content;
  }
}
