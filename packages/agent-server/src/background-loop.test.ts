import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BackgroundLoop,
  type BackgroundLoopOptions,
} from "./background-loop.js";
import type { CycleSummary } from "@oneon/application";
import type { Logger } from "@oneon/domain";

// ── Helpers ──────────────────────────────────────────────────

function createMockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeCycleSummary(
  overrides: Partial<CycleSummary> = {}
): CycleSummary {
  return {
    classification: {
      total: 0,
      classified: 0,
      skippedByRule: 0,
      skippedMaxAttempts: 0,
      skippedDailyLimit: 0,
      failed: 0,
    },
    actionsProposed: 0,
    actionsAutoExecuted: 0,
    actionErrors: 0,
    notificationsSent: 0,
    abortedEarly: false,
    durationMs: 50,
    ...overrides,
  };
}

function defaultOptions(
  overrides: Partial<BackgroundLoopOptions> = {}
): BackgroundLoopOptions {
  return {
    intervalMs: 1000,
    batchSize: 10,
    maxDurationMs: 60_000,
    maxConsecutiveErrors: 5,
    backoffMultiplier: 2,
    maxBackoffMs: 300_000,
    maxUsersPerTick: 5,
    ...overrides,
  };
}

const DEFAULT_USER = "user-1";
const singleUserProvider = () => [DEFAULT_USER];

// ── Tests ────────────────────────────────────────────────────

describe("BackgroundLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a cycle immediately on start", async () => {
    const runCycle = vi.fn(async () => makeCycleSummary());
    const logger = createMockLogger();
    const loop = new BackgroundLoop(() => runCycle(), singleUserProvider, logger, defaultOptions());

    loop.start();
    // Flush the microtask for the immediate cycle
    await vi.advanceTimersByTimeAsync(0);

    expect(runCycle).toHaveBeenCalledTimes(1);

    await loop.stop();
  });

  it("runs cycles at the configured interval", async () => {
    const runCycle = vi.fn(async () => makeCycleSummary());
    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      () => runCycle(),
      singleUserProvider,
      logger,
      defaultOptions({ intervalMs: 500 })
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // immediate cycle

    // Advance by 500ms — should trigger second cycle
    await vi.advanceTimersByTimeAsync(500);
    expect(runCycle).toHaveBeenCalledTimes(2);

    // Advance by another 500ms — third cycle
    await vi.advanceTimersByTimeAsync(500);
    expect(runCycle).toHaveBeenCalledTimes(3);

    await loop.stop();
  });

  it("prevents overlapping cycles (skips tick if previous still running)", async () => {
    let resolveSlowCycle: (() => void) | null = null;
    let callCount = 0;
    const runCycle = vi.fn(
      () =>
        new Promise<CycleSummary>((resolve) => {
          callCount++;
          resolveSlowCycle = () => resolve(makeCycleSummary());
        })
    );
    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      () => runCycle(),
      singleUserProvider,
      logger,
      defaultOptions({ intervalMs: 100 })
    );

    loop.start();
    // Immediate cycle starts (promise pending)
    await vi.advanceTimersByTimeAsync(0);
    expect(callCount).toBe(1);

    // Next tick fires but previous is still running — should skip
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(1); // still 1

    // Resolve the first cycle
    resolveSlowCycle!();
    // Flush microtasks so inFlightPromise clears
    await vi.advanceTimersByTimeAsync(0);

    // Next tick should now run
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    // Resolve second cycle before stopping
    resolveSlowCycle!();
    await vi.advanceTimersByTimeAsync(0);

    await loop.stop();
  });

  it("stop() waits for in-flight cycle to complete", async () => {
    let resolveSlowCycle: (() => void) | null = null;
    const runCycle = vi.fn(
      () =>
        new Promise<CycleSummary>((resolve) => {
          resolveSlowCycle = () => resolve(makeCycleSummary());
        })
    );
    const logger = createMockLogger();
    const loop = new BackgroundLoop(() => runCycle(), singleUserProvider, logger, defaultOptions());

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // start immediate cycle

    // Stop while cycle is in-flight
    const stopPromise = loop.stop();

    // Resolve the cycle
    resolveSlowCycle!();

    // Use real timers to await the stop
    vi.useRealTimers();
    await stopPromise;
    vi.useFakeTimers();

    expect(loop.isRunning()).toBe(false);
  });

  it("never throws — catches and logs cycle errors", async () => {
    const runCycle = vi.fn(async () => {
      throw new Error("DB crashed");
    });
    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      () => runCycle(),
      singleUserProvider,
      logger,
      defaultOptions({ intervalMs: 100 })
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // immediate cycle throws

    // Loop should still be running
    expect(loop.isRunning()).toBe(true);
    expect(logger.error).toHaveBeenCalled();

    await loop.stop();
  });

  it("applies exponential backoff after consecutive errors", async () => {
    let callCount = 0;
    const runCycle = vi.fn(async () => {
      callCount++;
      throw new Error("LLM down");
    });
    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      () => runCycle(),
      singleUserProvider,
      logger,
      defaultOptions({
        intervalMs: 1000,
        maxConsecutiveErrors: 10,
        backoffMultiplier: 2,
      })
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // first cycle fails => backoff 2000ms

    // After 1000ms (normal interval), should NOT run because backoff is 2000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(runCycle).toHaveBeenCalledTimes(1);

    // After another 1000ms (total 2000ms), should run
    await vi.advanceTimersByTimeAsync(1000);
    expect(runCycle).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it("resets backoff after a successful cycle", async () => {
    let shouldFail = true;
    const runCycle = vi.fn(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("Temporary failure");
      }
      return makeCycleSummary();
    });
    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      () => runCycle(),
      singleUserProvider,
      logger,
      defaultOptions({
        intervalMs: 1000,
        backoffMultiplier: 2,
      })
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // first cycle fails, backoff to 2000

    // Second cycle should succeed after backoff
    await vi.advanceTimersByTimeAsync(2000);
    // The second call succeeds -> backoff should reset

    // Third cycle should be at normal interval (1000ms), not 4000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(runCycle).toHaveBeenCalledTimes(3);

    await loop.stop();
  });

  it("isRunning reflects state correctly", async () => {
    const runCycle = vi.fn(async () => makeCycleSummary());
    const logger = createMockLogger();
    const loop = new BackgroundLoop(() => runCycle(), singleUserProvider, logger, defaultOptions());

    expect(loop.isRunning()).toBe(false);

    loop.start();
    expect(loop.isRunning()).toBe(true);

    await loop.stop();
    expect(loop.isRunning()).toBe(false);
  });

  it("start is idempotent (calling start twice doesn't create duplicate loops)", async () => {
    const runCycle = vi.fn(async () => makeCycleSummary());
    const logger = createMockLogger();
    const loop = new BackgroundLoop(() => runCycle(), singleUserProvider, logger, defaultOptions());

    loop.start();
    loop.start(); // second call should be no-op

    await vi.advanceTimersByTimeAsync(0);

    // Should only have run once, not twice
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled(); // warns about already running

    await loop.stop();
  });

  // ── Multi-user A/B integration test (9L) ──────────────────

  it("processes multiple users per tick with no cross-contamination", async () => {
    const USER_A = "user-alpha";
    const USER_B = "user-beta";
    const eligibleUsers = () => [USER_A, USER_B];

    // Track which userId each invocation received
    const invocations: string[] = [];

    const userCycleRunner = vi.fn(async (userId: string) => {
      invocations.push(userId);
      return makeCycleSummary({
        classification: {
          total: 3,
          classified: 2,
          skippedByRule: 1,
          skippedMaxAttempts: 0,
          skippedDailyLimit: 0,
          failed: 0,
        },
        actionsProposed: 1,
        notificationsSent: userId === USER_A ? 1 : 0,
      });
    });

    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      userCycleRunner,
      eligibleUsers,
      logger,
      defaultOptions({ maxUsersPerTick: 5 }),
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // immediate cycle

    // Both users were processed
    expect(invocations).toEqual([USER_A, USER_B]);
    expect(userCycleRunner).toHaveBeenCalledTimes(2);
    expect(userCycleRunner).toHaveBeenCalledWith(USER_A);
    expect(userCycleRunner).toHaveBeenCalledWith(USER_B);

    // Aggregated log should show combined stats
    expect(logger.info).toHaveBeenCalledWith(
      "Processing cycle completed",
      expect.objectContaining({
        usersProcessed: 2,
        userErrors: 0,
        total: 6,        // 3 + 3
        classified: 4,   // 2 + 2
        actionsProposed: 2,
      }),
    );

    await loop.stop();
  });

  it("respects maxUsersPerTick cap", async () => {
    const allUsers = ["u1", "u2", "u3", "u4", "u5"];
    const eligibleUsers = () => allUsers;
    const invocations: string[] = [];

    const userCycleRunner = vi.fn(async (userId: string) => {
      invocations.push(userId);
      return makeCycleSummary();
    });

    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      userCycleRunner,
      eligibleUsers,
      logger,
      defaultOptions({ maxUsersPerTick: 3 }),
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    // Only first 3 users processed
    expect(invocations).toEqual(["u1", "u2", "u3"]);
    expect(userCycleRunner).toHaveBeenCalledTimes(3);

    await loop.stop();
  });

  it("triggers backoff only when ALL users fail, not partial", async () => {
    const USER_A = "user-ok";
    const USER_B = "user-fail";
    const eligibleUsers = () => [USER_A, USER_B];

    const userCycleRunner = vi.fn(async (userId: string) => {
      if (userId === USER_B) throw new Error("user-fail exploded");
      return makeCycleSummary();
    });

    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      userCycleRunner,
      eligibleUsers,
      logger,
      defaultOptions({ intervalMs: 1000 }),
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0); // immediate cycle

    // Partial failure — backoff should NOT have been applied
    expect(loop.errorCount).toBe(0);
    expect(loop.lastError).toBeNull();

    // Logged the per-user error
    expect(logger.error).toHaveBeenCalledWith(
      "Processing cycle failed for user",
      expect.objectContaining({ userId: USER_B }),
    );

    // Next tick at normal interval should still fire
    await vi.advanceTimersByTimeAsync(1000);
    expect(userCycleRunner).toHaveBeenCalledTimes(4); // 2 initial + 2 second tick

    await loop.stop();
  });

  it("triggerNow(userId) runs only the specified user", async () => {
    const USER_A = "user-alpha";
    const USER_B = "user-beta";
    const eligibleUsers = () => [USER_A, USER_B];
    const invocations: string[] = [];

    const userCycleRunner = vi.fn(async (userId: string) => {
      invocations.push(userId);
      return makeCycleSummary();
    });

    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      userCycleRunner,
      eligibleUsers,
      logger,
      defaultOptions(),
    );

    // Don't start the loop — just trigger for a single user
    const triggered = loop.triggerNow(USER_B);
    expect(triggered).toBe(true);

    // Flush microtasks so the async cycle completes
    await vi.advanceTimersByTimeAsync(0);

    expect(invocations).toEqual([USER_B]);
    expect(userCycleRunner).toHaveBeenCalledTimes(1);
    expect(userCycleRunner).toHaveBeenCalledWith(USER_B);
  });

  it("skips tick when no eligible users exist", async () => {
    const emptyProvider = () => [] as string[];
    const userCycleRunner = vi.fn(async () => makeCycleSummary());
    const logger = createMockLogger();
    const loop = new BackgroundLoop(
      userCycleRunner,
      emptyProvider,
      logger,
      defaultOptions(),
    );

    loop.start();
    await vi.advanceTimersByTimeAsync(0);

    // Runner was never called — no eligible users
    expect(userCycleRunner).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      "No eligible users for processing cycle",
    );

    // No errors recorded
    expect(loop.errorCount).toBe(0);
    expect(loop.lastError).toBeNull();

    await loop.stop();
  });
});
