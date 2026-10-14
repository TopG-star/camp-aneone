import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOURLY_BACKUPS_KEPT, pruneHourlyBackups } from "./backup.js";

const BASE = Date.UTC(2026, 9, 8, 0);
/** The n-th hour's folder name, `yyyy-mm-ddThhZ`, and a time inside that hour. */
const hour = (n: number) => new Date(BASE + n * 3_600_000).toISOString().slice(0, 13) + "Z";
const at = (n: number) => new Date(BASE + n * 3_600_000 + 60_000);

describe("pruneHourlyBackups (owner decision D6)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const outDir = mkdtempSync(join(tmpdir(), "retention-"));
    dirs.push(outDir);
    /** Writes `<folder>/<name>` with the given modification time. */
    const put = (folder: string, name: string, when: Date) => {
      mkdirSync(join(outDir, folder), { recursive: true });
      const file = join(outDir, folder, name);
      writeFileSync(file, "x");
      utimesSync(file, when, when);
    };
    /** `count` complete hourly folders, hour 0 the oldest, each with control and one pharmacy. */
    const hours = (count: number, from = 0) => {
      for (let n = from; n < from + count; n++) {
        put(`hourly/${hour(n)}`, "control.db.enc", at(n));
        put(`hourly/${hour(n)}`, "aaaa.db.enc", at(n));
      }
    };
    const hourlyFolders = () => (existsSync(join(outDir, "hourly")) ? readdirSync(join(outDir, "hourly")).sort() : []);
    return { outDir, put, hours, hourlyFolders };
  }

  it("keeps the 48 most recent hourly copies", () => {
    expect(HOURLY_BACKUPS_KEPT).toBe(48);
  });

  it("deletes the hourly folders beyond the 48 most recent complete ones, and nothing else", () => {
    const { outDir, put, hours, hourlyFolders } = setup();
    hours(50);
    put("2026-10-01", "control.db.enc", new Date("2026-10-01T01:00:00Z"));
    put("2026-10-01", "aaaa.db.enc", new Date("2026-10-01T01:00:00Z"));
    put("pre-migration/2026-09-30T10-00-00Z", "aaaa.db.enc", new Date("2026-09-30T10:00:00Z"));

    const removed = pruneHourlyBackups({ outDir });

    expect(hourlyFolders()).toEqual(Array.from({ length: 48 }, (_, i) => hour(i + 2)));
    expect(removed.sort()).toEqual([join(outDir, "hourly", hour(0)), join(outDir, "hourly", hour(1))].sort());
    // A daily folder and anything under pre-migration/ are never deleted, however old.
    expect(readdirSync(join(outDir, "2026-10-01")).sort()).toEqual(["aaaa.db.enc", "control.db.enc"]);
    expect(readdirSync(join(outDir, "pre-migration", "2026-09-30T10-00-00Z"))).toEqual(["aaaa.db.enc"]);
  });

  it("does nothing with 48 complete hourly folders or fewer, and does not count a .partial folder among them", () => {
    const { outDir, put, hours, hourlyFolders } = setup();
    hours(48, 1);
    put(`hourly/${hour(0)}.partial`, "control.db.enc", at(0));
    put(`hourly/${hour(60)}.partial`, "control.db.enc", at(60));
    expect(pruneHourlyBackups({ outDir })).toEqual([]);
    expect(hourlyFolders()).toHaveLength(50);
  });

  it("never deletes a file's newest copy: an old folder keeps the only copy of a pharmacy skipped since, and only that file", () => {
    const { outDir, put, hours, hourlyFolders } = setup();
    hours(50);
    // Pharmacy bbbb was copied in the oldest hour only; it has been skipped (or suspended and refused) ever since.
    put(`hourly/${hour(0)}`, "bbbb.db.enc", at(0));
    writeFileSync(join(outDir, "hourly", hour(0), "skipped.json"), "[]");
    writeFileSync(join(outDir, "hourly", hour(1), "skipped.json"), "[]");

    const removed = pruneHourlyBackups({ outDir });

    expect(readdirSync(join(outDir, "hourly", hour(0))).sort()).toEqual(["bbbb.db.enc", "skipped.json"]);
    expect(existsSync(join(outDir, "hourly", hour(1)))).toBe(false);
    expect(hourlyFolders()).toHaveLength(49);
    expect(removed).toContain(join(outDir, "hourly", hour(0), "aaaa.db.enc"));
    expect(removed).toContain(join(outDir, "hourly", hour(1)));
  });

  it("keeps an old hourly copy that is newer than every other copy of that file (a daily or pre-migration copy is older)", () => {
    const { outDir, put, hours } = setup();
    hours(50);
    put("2026-10-01", "bbbb.db.enc", new Date("2026-10-01T01:00:00Z"));
    put("pre-migration/2026-10-02T00-00-00Z", "bbbb.db.enc", new Date("2026-10-02T00:00:00Z"));
    put(`hourly/${hour(1)}`, "bbbb.db.enc", at(1));

    pruneHourlyBackups({ outDir });

    expect(readdirSync(join(outDir, "hourly", hour(1)))).toEqual(["bbbb.db.enc"]);
    expect(existsSync(join(outDir, "hourly", hour(0)))).toBe(false);
  });

  it("deletes an old hourly copy when a newer copy of that file exists in a daily folder", () => {
    const { outDir, put, hours } = setup();
    hours(50);
    put(`hourly/${hour(0)}`, "bbbb.db.enc", at(0));
    put("2026-10-20", "bbbb.db.enc", new Date("2026-10-20T01:00:00Z"));

    pruneHourlyBackups({ outDir });

    expect(existsSync(join(outDir, "hourly", hour(0)))).toBe(false);
    expect(readdirSync(join(outDir, "2026-10-20"))).toEqual(["bbbb.db.enc"]);
  });

  it("does nothing when there is no hourly folder", () => {
    const { outDir } = setup();
    expect(pruneHourlyBackups({ outDir })).toEqual([]);
    expect(pruneHourlyBackups({ outDir: join(outDir, "missing") })).toEqual([]);
  });
});
