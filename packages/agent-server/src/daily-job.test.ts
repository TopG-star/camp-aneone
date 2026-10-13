import { describe, expect, it, vi } from "vitest";
import { DailyJob } from "./background-loop.js";

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
