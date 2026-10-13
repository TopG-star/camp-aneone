import { describe, expect, it, vi } from "vitest";
import { DailyJob, PeriodicJob } from "./background-loop.js";
import { deploymentKeyRefreshJob } from "./tenant-jobs.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe("DailyJob", () => {
  it("runs once per UTC day", async () => {
    let now = new Date("2026-10-10T03:00:00.000Z");
    const run = vi.fn(async () => {});
    const job = new DailyJob({ name: "j", run, logger: logger(), now: () => now });
    await job.tick();
    await job.tick();
    expect(run).toHaveBeenCalledTimes(1);
    now = new Date("2026-10-11T00:00:01.000Z");
    await job.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs a failure and retries at the next look, never throwing", async () => {
    const log = logger();
    const run = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const job = new DailyJob({ name: "rollups", run, logger: log, now: () => new Date("2026-10-10T03:00:00.000Z") });
    await expect(job.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("rollups failed", expect.objectContaining({ error: "disk full" }));
    await job.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not overlap, and stop() waits for the run in flight", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const job = new DailyJob({ name: "j", run, logger: logger(), now: () => new Date("2026-10-10T03:00:00.000Z") });
    const first = job.tick();
    void job.tick();
    expect(run).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await first;
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("PeriodicJob", () => {
  it("runs on every tick, not at start, never overlaps, and logs a failure without throwing", async () => {
    vi.useFakeTimers();
    try {
      const log = logger();
      const run = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
      const job = new PeriodicJob({ name: "recovery", run, intervalMs: 1000, logger: log });
      job.start();
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(log.error).toHaveBeenCalledWith("recovery failed", expect.objectContaining({ error: "boom" }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(run).toHaveBeenCalledTimes(3);
      await job.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a tick while the previous run is in flight, and stop() waits for it", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const job = new PeriodicJob({ name: "r", run, intervalMs: 1000, logger: logger() });
    const first = job.tick();
    void job.tick();
    expect(run).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = job.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await first;
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe("deploymentKeyRefreshJob", () => {
  it("refreshes every deployment's keys once at startup, not only after a day, and logs each failed one", async () => {
    const log = logger();
    const refreshAll = vi.fn(async (onError: (registrationId: string) => void) => onError("reg-2"));
    const job = deploymentKeyRefreshJob({ refreshAll }, log);
    job.start();
    await job.stop();
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("Deployment key refresh failed", { registrationId: "reg-2" });
  });

  it("runs again on the next UTC day", async () => {
    let now = new Date("2026-10-10T03:00:00.000Z");
    const refreshAll = vi.fn(async () => {});
    const job = deploymentKeyRefreshJob({ refreshAll }, logger(), () => now);
    await job.tick();
    await job.tick();
    now = new Date("2026-10-11T00:00:01.000Z");
    await job.tick();
    expect(refreshAll).toHaveBeenCalledTimes(2);
  });
});
