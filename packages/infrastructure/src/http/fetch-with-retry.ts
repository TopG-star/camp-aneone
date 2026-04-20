/**
 * Retry with exponential backoff. Retries on 429, 500, 502, 503, 504 errors
 * and network failures (AbortError from timeout is NOT retried).
 */
export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return false; // Timeout — don't retry
  }
  return true; // Network errors — retry
}

function getDelay(attempt: number, options: RetryOptions): number {
  const delay = Math.min(
    options.baseDelayMs * 2 ** attempt,
    options.maxDelayMs,
  );
  // Add jitter: 50-100% of calculated delay
  return delay * (0.5 + Math.random() * 0.5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse Retry-After header value.
 * Supports both formats:
 *   - Seconds: "120" → 120000ms
 *   - HTTP-date: "Sun, 06 Nov 1994 08:49:37 GMT" → delta from now in ms
 * Returns null if the value is unparseable or results in a negative/zero delay.
 */
function parseRetryAfter(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  // Try HTTP-date format
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : null;
  }
  return null;
}

/**
 * Wraps a fetch-like function with retry logic.
 * Returns the Response on success or throws after exhausting retries.
 */
export async function fetchWithRetry(
  fn: () => Promise<Response>,
  options: Partial<RetryOptions> = {},
): Promise<Response> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fn();

      if (response.ok || !RETRYABLE_STATUS_CODES.has(response.status)) {
        return response;
      }

      // Retryable status code
      if (attempt < opts.maxRetries) {
        const retryAfter = response.headers.get("Retry-After");
        const retryDelay = retryAfter ? parseRetryAfter(retryAfter) : null;
        const delayMs = retryDelay ?? getDelay(attempt, opts);
        await sleep(delayMs);
        continue;
      }

      return response; // Last attempt — return as-is for caller to handle
    } catch (error) {
      if (attempt >= opts.maxRetries || !isRetryableError(error)) {
        throw error;
      }

      await sleep(getDelay(attempt, opts));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Retry logic error: should not reach here");
}
