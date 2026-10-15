import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOURLY_BACKUPS_KEPT, HOURLY_PARTIAL_MAX_AGE_MS, pruneHourlyBackups } from "./backup.js";

const BASE = Date.UTC(2026, 9, 8, 0);
/** The n-th hour's folder name, `yyyy-mm-ddThhZ`, and a time inside that hour. */
const hour = (n: number) => new Date(BASE + n * 3_600_000).toISOString().slice(0, 13) + "Z";
const at = (n: number) => new Date(BASE + n * 3_600_000 + 60_000);
/** A clock just after the last hour any test writes. */
const NOW = () => at(80);

describe("pruneHourlyBackups (owner decisions D6, Q3 and Q4)", () => {
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
    /** `count` complete hourly folders, hour `from` the oldest, each with control and one pharmacy. */
    const hours = (count: number, from = 0) => {
      for (let n = from; n < from + count; n++) {
        put(`hourly/${hour(n)}`, "control.db.enc", at(n));
        put(`hourly/${hour(n)}`, "aaaa.db.enc", at(n));
      }
    };
    const hourlyFolders = () => (existsSync(join(outDir, "hourly")) ? readdirSync(join(outDir, "hourly")).sort() : []);
    const filesIn = (n: number) => readdirSync(join(outDir, "hourly", hour(n))).sort();
    /** Which hours still hold a copy of `name`. */
    const hoursHolding = (name: string) =>
      hourlyFolders()
        .filter((f) => !f.endsWith(".partial") && existsSync(join(outDir, "hourly", f, name)))
        .map((f) => (Date.parse(f.replace("Z", ":00:00Z")) - BASE) / 3_600_000);
    const prune = (now = NOW()) => pruneHourlyBackups({ outDir, now: () => now });
    return { outDir, put, hours, hourlyFolders, filesIn, hoursHolding, prune };
  }

  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  it("keeps 48 hourly copies per file, and leaves a .partial folder for 2 h", () => {
    expect(HOURLY_BACKUPS_KEPT).toBe(48);
    expect(HOURLY_PARTIAL_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("deletes the hourly folders whose every copy is beyond its file's 48 newest, and never a daily or pre-migration copy", () => {
    const { outDir, put, hours, hourlyFolders, prune } = setup();
    hours(50);
    put("2026-10-01", "control.db.enc", new Date("2026-10-01T01:00:00Z"));
    put("2026-10-01", "aaaa.db.enc", new Date("2026-10-01T01:00:00Z"));
    put("pre-migration/2026-09-30T10-00-00Z", "aaaa.db.enc", new Date("2026-09-30T10:00:00Z"));

    const removed = prune();

    expect(hourlyFolders()).toEqual(range(2, 49).map(hour));
    expect(removed.sort()).toEqual([join(outDir, "hourly", hour(0)), join(outDir, "hourly", hour(1))].sort());
    expect(readdirSync(join(outDir, "2026-10-01")).sort()).toEqual(["aaaa.db.enc", "control.db.enc"]);
    expect(readdirSync(join(outDir, "pre-migration", "2026-09-30T10-00-00Z"))).toEqual(["aaaa.db.enc"]);
  });

  it("does nothing while no file has more than 48 hourly copies", () => {
    const { hours, hourlyFolders, prune } = setup();
    hours(48);
    expect(prune()).toEqual([]);
    expect(hourlyFolders()).toHaveLength(48);
  });

  describe("per file (Q3)", () => {
    it("a pharmacy skipped for some hours keeps its own 48 newest copies, reaching back past the folders control no longer needs", () => {
      const { outDir, put, hoursHolding, filesIn, hourlyFolders, prune } = setup();
      // Control is copied every hour 0..59. Pharmacy bbbb is copied in hours 0..49, then skipped for the last ten hours.
      for (const n of range(0, 59)) put(`hourly/${hour(n)}`, "control.db.enc", at(n));
      for (const n of range(0, 49)) put(`hourly/${hour(n)}`, "bbbb.db.enc", at(n));
      for (const n of range(50, 59)) writeFileSync(join(outDir, "hourly", hour(n), "skipped.json"), '["bbbb"]');

      const removed = prune();

      expect(hoursHolding("control.db.enc")).toEqual(range(12, 59));
      expect(hoursHolding("bbbb.db.enc")).toEqual(range(2, 49));
      // Hours 0 and 1 held only copies beyond both files' 48: removed whole. Hours 2..11 keep bbbb and lose only control.
      expect(hourlyFolders()).toEqual(range(2, 59).map(hour));
      expect(filesIn(2)).toEqual(["bbbb.db.enc"]);
      expect(removed).toContain(join(outDir, "hourly", hour(0)));
      expect(removed).toContain(join(outDir, "hourly", hour(2), "control.db.enc"));
      expect(removed).not.toContain(join(outDir, "hourly", hour(2)));
    });

    it("a folder that still holds a kept copy stays, with its skipped.json; only the copies beyond 48 inside it go", () => {
      const { outDir, put, hours, filesIn, prune } = setup();
      hours(50);
      // Pharmacy bbbb was copied in the oldest hour only; it has been skipped since.
      put(`hourly/${hour(0)}`, "bbbb.db.enc", at(0));
      writeFileSync(join(outDir, "hourly", hour(0), "skipped.json"), "[]");
      writeFileSync(join(outDir, "hourly", hour(1), "skipped.json"), "[]");

      const removed = prune();

      expect(filesIn(0)).toEqual(["bbbb.db.enc", "skipped.json"]);
      expect(existsSync(join(outDir, "hourly", hour(1)))).toBe(false);
      expect(removed).toContain(join(outDir, "hourly", hour(0), "aaaa.db.enc"));
      expect(removed).toContain(join(outDir, "hourly", hour(0), "control.db.enc"));
      expect(removed).toContain(join(outDir, "hourly", hour(1)));
    });

    it("an hourly copy within its file's 48 stays even when a daily or pre-migration copy of that file is newer", () => {
      const { outDir, put, hours, filesIn, prune } = setup();
      hours(50);
      put(`hourly/${hour(0)}`, "bbbb.db.enc", at(0));
      put("2026-10-20", "bbbb.db.enc", new Date("2026-10-20T01:00:00Z"));

      prune();

      expect(filesIn(0)).toEqual(["bbbb.db.enc"]);
      expect(readdirSync(join(outDir, "2026-10-20"))).toEqual(["bbbb.db.enc"]);
    });

    it("never deletes the newest copy of a file", () => {
      const { outDir, put, hours, hoursHolding, prune } = setup();
      hours(60);
      put("2026-10-01", "aaaa.db.enc", new Date("2026-10-01T01:00:00Z"));

      prune();

      expect(hoursHolding("aaaa.db.enc")).toContain(59);
      expect(hoursHolding("aaaa.db.enc")).toHaveLength(48);
      expect(existsSync(join(outDir, "2026-10-01", "aaaa.db.enc"))).toBe(true);
    });

    it("a folder with no copy at all goes only once it is older than the 48 newest folders", () => {
      const { outDir, hours, hourlyFolders, prune } = setup();
      hours(50, 1);
      mkdirSync(join(outDir, "hourly", hour(0)), { recursive: true });
      writeFileSync(join(outDir, "hourly", hour(0), "skipped.json"), "[]");
      mkdirSync(join(outDir, "hourly", hour(51)), { recursive: true });
      writeFileSync(join(outDir, "hourly", hour(51), "skipped.json"), "[]");

      prune();

      expect(hourlyFolders()).not.toContain(hour(0));
      expect(hourlyFolders()).toContain(hour(51));
    });
  });

  describe("leftover .partial folders (Q4)", () => {
    it("deletes an hourly .partial folder whose last write is more than 2 h old, keeps a younger one, and never counts either", () => {
      const { outDir, put, hours, hourlyFolders, prune } = setup();
      hours(48, 1);
      put(`hourly/${hour(0)}.partial`, "control.db.enc", at(0));
      put(`hourly/${hour(79)}.partial`, "control.db.enc", at(79));
      // The folders' own modification times count too: set them to their last write.
      utimesSync(join(outDir, "hourly", `${hour(0)}.partial`), at(0), at(0));
      utimesSync(join(outDir, "hourly", `${hour(79)}.partial`), at(79), at(79));

      const removed = prune(new Date(at(79).getTime() + HOURLY_PARTIAL_MAX_AGE_MS)); // exactly 2 h after the young one's write

      expect(removed).toEqual([join(outDir, "hourly", `${hour(0)}.partial`)]);
      expect(hourlyFolders()).toContain(`${hour(79)}.partial`);
      expect(hourlyFolders().filter((f) => !f.endsWith(".partial"))).toHaveLength(48);
    });

    it("measures a .partial folder by its newest write, so a run still writing is left alone", () => {
      const { outDir, put, prune } = setup();
      put(`hourly/${hour(0)}.partial`, "control.db.enc", at(0));
      put(`hourly/${hour(0)}.partial`, "aaaa.db.enc.part", at(10)); // still being written ten hours later
      utimesSync(join(outDir, "hourly", `${hour(0)}.partial`), at(0), at(0));

      expect(prune(at(11))).toEqual([]);
      expect(existsSync(join(outDir, "hourly", `${hour(0)}.partial`))).toBe(true);
    });

    it("never touches a daily .partial folder", () => {
      const { outDir, put, prune } = setup();
      put("2026-10-01.partial", "control.db.enc", new Date("2026-10-01T01:00:00Z"));
      prune();
      expect(existsSync(join(outDir, "2026-10-01.partial", "control.db.enc"))).toBe(true);
    });
  });

  it("does nothing when there is no hourly folder", () => {
    const { outDir, prune } = setup();
    expect(prune()).toEqual([]);
    expect(pruneHourlyBackups({ outDir: join(outDir, "missing") })).toEqual([]);
  });
});
