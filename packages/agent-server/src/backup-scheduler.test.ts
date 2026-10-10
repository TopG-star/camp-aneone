import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@oneon/domain";
import { BackupScheduler } from "./background-loop.js";

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } satisfies Logger;
}

describe("BackupScheduler", () => {
  let outDir: string;
  let now: Date;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "scheduler-"));
    now = new Date("2026-10-10T03:00:00.000Z");
  });
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  /** A backup that writes the day's folder with the given files, as backupAll does. */
  function fakeBackup(files: string[] = ["control", "personal", "tenant-a"]) {
    return vi.fn(async () => {
      const dir = join(outDir, now.toISOString().slice(0, 10));
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(join(dir, `${f}.db.enc`), "x");
    });
  }

  const okRestore = () =>
    vi.fn(async (_file: string) => ({ ok: true, integrity: "ok", contextMeta: { kind: "tenant", tenant_id: "t" } as { kind: string; tenant_id: string | null } | null }));
  const make = (backupAll: () => Promise<unknown>, restoreTest = okRestore(), log = logger()) => ({
    scheduler: new BackupScheduler({ outDir, backupAll, restoreTest, logger: log, now: () => now }),
    restoreTest,
    log,
  });

  it("runs the nightly backup once per calendar day", async () => {
    const backupAll = fakeBackup();
    const { scheduler } = make(backupAll);
    await scheduler.tick();
    await scheduler.tick();
    expect(backupAll).toHaveBeenCalledTimes(1);
    now = new Date("2026-10-10T23:59:00.000Z");
    await scheduler.tick();
    expect(backupAll).toHaveBeenCalledTimes(1);
    now = new Date("2026-10-11T00:01:00.000Z");
    await scheduler.tick();
    expect(backupAll).toHaveBeenCalledTimes(2);
  });

  it("treats an existing folder for today as the day being done, even across a restart", async () => {
    mkdirSync(join(outDir, "2026-10-10"));
    const backupAll = fakeBackup();
    await make(backupAll).scheduler.tick();
    expect(backupAll).not.toHaveBeenCalled();
  });

  it("logs a failed backup at error level, never throws, and tries again on the next tick", async () => {
    const backupAll = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation(fakeBackup());
    const { scheduler, log } = make(backupAll);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("Nightly backup failed", expect.objectContaining({ error: "disk full" }));
    await scheduler.tick();
    expect(backupAll).toHaveBeenCalledTimes(2);
  });

  it("restores one tenant from the latest backup once a month, rotating through the tenants", async () => {
    const backupAll = fakeBackup(["control", "personal", "tenant-a", "tenant-b", "tenant-c"]);
    const { scheduler, restoreTest, log } = make(backupAll);
    const restored: string[] = [];
    restoreTest.mockImplementation(async (file: string) => {
      restored.push((file.split(/[\\/]/).pop() as string).replace(".db.enc", ""));
      return { ok: true, integrity: "ok", contextMeta: { kind: "tenant", tenant_id: "t" } };
    });

    // Two days in October, then one tick in each of the next three months.
    for (const day of ["2026-10-10", "2026-10-11", "2026-10-20", "2026-11-02", "2026-12-02", "2027-01-02"]) {
      now = new Date(`${day}T03:00:00.000Z`);
      await scheduler.tick();
    }

    expect(restored).toHaveLength(4);
    expect(restored.every((t) => t.startsWith("tenant-"))).toBe(true);
    // Consecutive months pick different tenants, and the rotation wraps after three.
    expect(new Set(restored.slice(0, 3)).size).toBe(3);
    expect(restored[3]).toBe(restored[0]);
    expect(restoreTest.mock.calls[0]![0]).toContain("2026-10-10");
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Monthly restore test passed", expect.objectContaining({ tenantId: "t" }));
  });

  it("logs a failed restore test at error level", async () => {
    const failing = vi.fn(async (_file: string) => ({ ok: false, integrity: "decryption failed", contextMeta: null }));
    const { scheduler, log } = make(fakeBackup(), failing);
    await scheduler.tick();
    expect(log.error).toHaveBeenCalledWith("Monthly restore test failed", expect.objectContaining({ integrity: "decryption failed" }));
  });

  it("logs a restore test that throws, and does not stop the schedule", async () => {
    const crashing = vi.fn(async (_file: string): Promise<never> => {
      throw new Error("boom");
    });
    const { scheduler, log } = make(fakeBackup(), crashing);
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("Monthly restore test crashed", expect.objectContaining({ error: "boom" }));
  });

  it("skips the restore test, and tries again later, while there is no tenant backup", async () => {
    const { scheduler, restoreTest } = make(fakeBackup(["control", "personal"]));
    await scheduler.tick();
    expect(restoreTest).not.toHaveBeenCalled();
    now = new Date("2026-10-11T03:00:00.000Z");
    mkdirSync(join(outDir, "2026-10-11"), { recursive: true });
    writeFileSync(join(outDir, "2026-10-11", "tenant-z.db.enc"), "x");
    await scheduler.tick();
    expect(restoreTest).toHaveBeenCalledTimes(1);
  });

  it("stop() waits for the tick in flight", async () => {
    let release!: () => void;
    const backupAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { scheduler } = make(backupAll);
    scheduler.start();
    await vi.waitFor(() => expect(backupAll).toHaveBeenCalled());
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
