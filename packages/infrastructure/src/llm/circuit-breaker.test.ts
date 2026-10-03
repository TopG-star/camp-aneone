import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "@oneon/domain";
import { CircuitBreaker, CircuitOpenError } from "./circuit-breaker.js";

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ── Circuit Breaker Tests ────────────────────────────────────

describe("CircuitBreaker", () => {
  let logger: Logger;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    logger = createMockLogger();
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      logger,
    });
  });

  it("starts in closed state", () => {
    expect(breaker.getState()).toBe("closed");
  });

  it("passes through calls in closed state", async () => {
    const result = await breaker.execute(async () => "hello");
    expect(result).toBe("hello");
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after reaching failure threshold", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow("fail");
    }
    expect(breaker.getState()).toBe("open");
  });

  it("rejects calls in open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow("fail");
    }

    await expect(
      breaker.execute(async () => "should not run")
    ).rejects.toThrow(CircuitOpenError);
  });

  it("opens immediately on 401 status code", async () => {
    const authError = Object.assign(new Error("Unauthorized"), { status: 401 });
    await expect(breaker.execute(async () => { throw authError; })).rejects.toThrow("Unauthorized");
    expect(breaker.getState()).toBe("open");
  });

  it("opens immediately on 403 status code", async () => {
    const forbiddenError = Object.assign(new Error("Forbidden"), { status: 403 });
    await expect(breaker.execute(async () => { throw forbiddenError; })).rejects.toThrow("Forbidden");
    expect(breaker.getState()).toBe("open");
  });

  it("transitions to half-open after reset timeout", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("open");

    // Simulate time passing by manipulating the internal state
    // We use _reset + re-trigger to test the timeout logic
    // Instead, let's directly test via the timestamp approach
    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(breaker.getState()).toBe("half-open");
    vi.useRealTimers();
  });

  it("closes after successful call in half-open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe("open");

    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(breaker.getState()).toBe("half-open");

    const result = await breaker.execute(async () => "recovered");
    expect(result).toBe("recovered");
    expect(breaker.getState()).toBe("closed");
    vi.useRealTimers();
  });

  it("reopens on failure in half-open state", async () => {
    const error = new Error("fail");
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    }

    vi.useFakeTimers();
    vi.advanceTimersByTime(1001);
    expect(breaker.getState()).toBe("half-open");

    await expect(breaker.execute(async () => { throw new Error("still broken"); })).rejects.toThrow();
    // After 3 total failures + 1 more = 4, which is ≥ threshold, it opens again
    expect(breaker.getState()).toBe("open");
    vi.useRealTimers();
  });

  it("resets failure count on success", async () => {
    const error = new Error("fail");
    // 2 failures (below threshold of 3)
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();

    // 1 success resets
    await breaker.execute(async () => "ok");
    expect(breaker.getState()).toBe("closed");

    // 2 more failures should still not open
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    await expect(breaker.execute(async () => { throw error; })).rejects.toThrow();
    expect(breaker.getState()).toBe("closed");
  });
});
