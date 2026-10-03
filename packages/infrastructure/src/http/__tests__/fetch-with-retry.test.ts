import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry } from "../fetch-with-retry.js";

describe("fetchWithRetry", () => {
  it("does not retry an error marked retryable: false", async () => {
    const error = Object.assign(new Error("auth"), { retryable: false });
    const fn = vi.fn().mockRejectedValue(error);
    await expect(fetchWithRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
