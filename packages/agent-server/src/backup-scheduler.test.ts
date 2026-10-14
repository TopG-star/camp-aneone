import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@oneon/domain";
import { SqliteIdentityRepository, TenantRegistrationRepository, newestBackupCopies, openControlDb } from "@oneon/infrastructure";
import { BACKUP_STALE_AFTER_HOURS, BackupScheduler } from "./background-loop.js";

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

  it("does not count a partial day as done, and never restore-tests from a partial or pre-migration folder", async () => {
    mkdirSync(join(outDir, "2026-10-10.partial"));
    writeFileSync(join(outDir, "2026-10-10.partial", "tenant-p.db.enc"), "x");
    mkdirSync(join(outDir, "pre-migration", "2026-10-10T01-00-00Z"), { recursive: true });
    writeFileSync(join(outDir, "pre-migration", "2026-10-10T01-00-00Z", "tenant-q.db.enc"), "x");
    mkdirSync(join(outDir, "2026-10-09"));
    writeFileSync(join(outDir, "2026-10-09", "tenant-ok.db.enc"), "x");
    const backupAll = vi.fn(async () => {});
    const { scheduler, restoreTest } = make(backupAll);
    await scheduler.tick();
    expect(backupAll).toHaveBeenCalledTimes(1);
    expect(restoreTest).toHaveBeenCalledTimes(1);
    expect(restoreTest.mock.calls[0]![0]).toBe(join(outDir, "2026-10-09", "tenant-ok.db.enc"));
  });

  it("says the day completed with tenants skipped when backupAll reports some", async () => {
    const backupAll = vi.fn(async () => Object.assign([], { skipped: [{ registrationId: "reg-1", code: "tenant_schema_behind" }] }));
    const { scheduler, log } = make(backupAll);
    await scheduler.tick();
    expect(log.warn).toHaveBeenCalledWith("Nightly backup completed with tenants skipped", { day: "2026-10-10", skipped: 1 });
  });

  it("logs the reason when a restored file does not belong to its context", async () => {
    const owned = vi.fn(async (_file: string) => ({ ok: false, integrity: "ok", contextMeta: null, reason: "no registration owns x.db" }));
    const { scheduler, log } = make(fakeBackup(), owned);
    await scheduler.tick();
    expect(log.error).toHaveBeenCalledWith("Monthly restore test failed", expect.objectContaining({ reason: "no registration owns x.db" }));
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

describe("BackupScheduler age alerts", () => {
  const NOW = new Date("2026-10-10T03:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "scheduler-age-"));
    mkdirSync(join(outDir, "2026-10-10")); // today is done: no backup runs
  });
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  type Copy = { context: "control" | "personal" | "tenant"; registrationId?: string; newestAt: Date | null; activeSince?: Date };
  const alertsOf = (log: ReturnType<typeof logger>, kind: string) =>
    log.error.mock.calls.filter((c) => (c[1] as { alert?: string } | undefined)?.alert === kind).map((c) => c[1] as Record<string, unknown>);
  function run(copies: () => Copy[], log = logger()) {
    const scheduler = new BackupScheduler({
      outDir,
      backupAll: vi.fn(async () => {}),
      restoreTest: vi.fn(async () => ({ ok: true, integrity: "ok", contextMeta: null })),
      newestCopies: copies,
      logger: log,
      now: () => NOW,
    });
    return { scheduler, log };
  }

  it("names the threshold: 26 hours", () => {
    expect(BACKUP_STALE_AFTER_HOURS).toBe(26);
  });

  it("raises backup_stale for a pharmacy whose newest copy is older than 26 hours, with its age", async () => {
    const { scheduler, log } = run(() => [{ context: "tenant", registrationId: "reg-1", newestAt: hoursAgo(26.5) }]);
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toEqual([{ alert: "backup_stale", context: "tenant", registrationId: "reg-1", ageHours: 26.5 }]);
  });

  it("raises backup_stale with ageHours \"none\" for a pharmacy with no copy at all", async () => {
    const { scheduler, log } = run(() => [{ context: "tenant", registrationId: "reg-1", newestAt: null, activeSince: hoursAgo(40) }]);
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toEqual([{ alert: "backup_stale", context: "tenant", registrationId: "reg-1", ageHours: "none" }]);
  });

  it("does not alert for a pharmacy with no copy that became active within 26 hours, and does once 26 hours have passed", async () => {
    const { scheduler, log } = run(() => [
      { context: "tenant", registrationId: "reg-new", newestAt: null, activeSince: hoursAgo(2) },
      { context: "tenant", registrationId: "reg-edge", newestAt: null, activeSince: hoursAgo(BACKUP_STALE_AFTER_HOURS) },
      { context: "tenant", registrationId: "reg-old", newestAt: null, activeSince: hoursAgo(26.5) },
    ]);
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toEqual([{ alert: "backup_stale", context: "tenant", registrationId: "reg-old", ageHours: "none" }]);
  });

  it("a pharmacy with an old copy is stale whatever its activeSince says", async () => {
    const { scheduler, log } = run(() => [{ context: "tenant", registrationId: "reg-1", newestAt: hoursAgo(30), activeSince: hoursAgo(1) }]);
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toEqual([{ alert: "backup_stale", context: "tenant", registrationId: "reg-1", ageHours: 30 }]);
  });

  describe("against real registrations", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    function pharmacies() {
      const dir = mkdtempSync(join(tmpdir(), "scheduler-age-reg-"));
      dirs.push(dir);
      const control = openControlDb(join(dir, "control.db"));
      const operator = new SqliteIdentityRepository(control).createWithLogin({ kind: "google", subject: "op" }).id;
      const clock = { at: hoursAgo(100) };
      const registrations = new TenantRegistrationRepository(control, () => clock.at);
      const jwk = { kty: "OKP", crv: "Ed25519", x: "x" } as never;
      const sealed = { wrappedKey: "w", ciphertext: "c" } as never;
      const enrol = (slug: string) =>
        registrations.create({
          tenantSlug: slug, displayName: slug, origin: "https://x.example", deploymentKeyId: `d-${slug}`, deploymentPublicKeyJwk: jwk,
          oneonKeyId: `o-${slug}`, oneonPublicKeyJwk: jwk, oneonPrivateKeySealed: sealed, impressorxTenantId: `irx-${slug}`, enrolledBy: operator,
        });
      return { control, registrations, clock, enrol, operator };
    }
    const day = (extra: string[]) => {
      for (const name of ["control", "personal", ...extra]) {
        const file = join(outDir, "2026-10-10", `${name}.db.enc`);
        writeFileSync(file, "x");
        utimesSync(file, hoursAgo(1), hoursAgo(1));
      }
    };

    it("a new pharmacy is quiet until 26 hours after enrolment", async () => {
      const { control, registrations, clock, enrol } = pharmacies();
      clock.at = hoursAgo(2);
      enrol("acme");
      day([]);
      const first = run(() => newestBackupCopies({ outDir, registrations }));
      await first.scheduler.tick();
      expect(alertsOf(first.log, "backup_stale")).toEqual([]);

      const later = new Date(NOW.getTime() + 25 * 60 * 60 * 1000); // 27 hours after enrolment, still without a copy
      const scheduler = new BackupScheduler({
        outDir, backupAll: vi.fn(async () => {}), restoreTest: vi.fn(async () => ({ ok: true, integrity: "ok", contextMeta: null })),
        newestCopies: () => newestBackupCopies({ outDir, registrations }), logger: first.log, now: () => later,
      });
      await scheduler.tick();
      expect(alertsOf(first.log, "backup_stale")).toEqual([expect.objectContaining({ alert: "backup_stale", context: "tenant", ageHours: "none" })]);
      control.close();
    });

    it("a pharmacy resumed after a long suspension is quiet for 26 hours from the resume", async () => {
      const { control, registrations, clock, enrol, operator } = pharmacies();
      const reg = enrol("acme"); // enrolled 100 hours ago
      clock.at = hoursAgo(60);
      registrations.transitionStatus(reg.id, "active", "suspended_by_operator", operator, "operator_suspend");
      clock.at = hoursAgo(2);
      registrations.transitionStatus(reg.id, "suspended_by_operator", "active", operator, "operator_resume");
      day([]); // control and personal fresh; this pharmacy has no copy
      const { scheduler, log } = run(() => newestBackupCopies({ outDir, registrations }));
      await scheduler.tick();
      expect(alertsOf(log, "backup_stale")).toEqual([]);
      control.close();
    });
  });

  it("does the same for control.db and the personal file", async () => {
    const { scheduler, log } = run(() => [
      { context: "control", newestAt: hoursAgo(30) },
      { context: "personal", newestAt: null },
    ]);
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toEqual([
      { alert: "backup_stale", context: "control", ageHours: 30 },
      { alert: "backup_stale", context: "personal", ageHours: "none" },
    ]);
  });

  it("is quiet for copies at or inside 26 hours", async () => {
    const { scheduler, log } = run(() => [
      { context: "control", newestAt: hoursAgo(1) },
      { context: "personal", newestAt: hoursAgo(BACKUP_STALE_AFTER_HOURS) },
      { context: "tenant", registrationId: "reg-1", newestAt: hoursAgo(25.9) },
    ]);
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toEqual([]);
  });

  it("alerts again on every hourly tick while a copy stays stale, even after the day's backup has run", async () => {
    const { scheduler, log } = run(() => [{ context: "tenant", registrationId: "reg-1", newestAt: hoursAgo(40) }]);
    await scheduler.tick();
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toHaveLength(2);
  });

  it("checks the ages even when the nightly backup failed", async () => {
    rmSync(join(outDir, "2026-10-10"), { recursive: true });
    const log = logger();
    const scheduler = new BackupScheduler({
      outDir,
      backupAll: vi.fn().mockRejectedValue(new Error("disk full")),
      restoreTest: vi.fn(async () => ({ ok: true, integrity: "ok", contextMeta: null })),
      newestCopies: () => [{ context: "control", newestAt: hoursAgo(50) }],
      logger: log,
      now: () => NOW,
    });
    await scheduler.tick();
    expect(alertsOf(log, "backup_stale")).toHaveLength(1);
  });

  it("a skipped pharmacy whose only copy is a pre-migration backup: quiet while that copy is fresh, stale once it ages", async () => {
    const registrations = { listActive: () => [{ id: "reg-skipped", fileName: "skipped.db" }], activeSince: () => hoursAgo(500) } as never;
    const stamp = (folder: string, name: string, at: Date) => {
      mkdirSync(join(outDir, folder), { recursive: true });
      const file = join(outDir, folder, name);
      writeFileSync(file, "x");
      utimesSync(file, at, at);
    };
    // The nightly day has control and personal, and lists the pharmacy as skipped: it has no file of its own in any day.
    stamp("2026-10-10", "control.db.enc", hoursAgo(1));
    stamp("2026-10-10", "personal.db.enc", hoursAgo(1));
    writeFileSync(join(outDir, "2026-10-10", "skipped.json"), JSON.stringify([{ registrationId: "reg-skipped", code: "tenant_schema_behind" }]));
    stamp("pre-migration/2026-10-10T01-00-00Z", "skipped.db.enc", hoursAgo(2));
    const fresh = run(() => newestBackupCopies({ outDir, registrations }));
    await fresh.scheduler.tick();
    expect(alertsOf(fresh.log, "backup_stale")).toEqual([]);

    stamp("pre-migration/2026-10-10T01-00-00Z", "skipped.db.enc", hoursAgo(30));
    const aged = run(() => newestBackupCopies({ outDir, registrations }));
    await aged.scheduler.tick();
    expect(alertsOf(aged.log, "backup_stale")).toEqual([{ alert: "backup_stale", context: "tenant", registrationId: "reg-skipped", ageHours: 30 }]);
  });

  it("never throws when the age check itself fails", async () => {
    const { scheduler, log } = run(() => {
      throw new Error("unreadable folder");
    });
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("Backup age check failed", expect.objectContaining({ error: "unreadable folder" }));
  });
});
