import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestBackupCopies } from "./backup.js";

const registrations = {
  listBackedUp: () => [
    { id: "reg-1", fileName: "aaaa.db" },
    { id: "reg-2", fileName: "bbbb.db" },
  ],
  activeSince: (id: string) => new Date(id === "reg-1" ? "2026-09-01T00:00:00Z" : "2026-10-09T00:00:00Z"),
} as never;

describe("newestBackupCopies", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const outDir = mkdtempSync(join(tmpdir(), "age-"));
    dirs.push(outDir);
    /** Writes `<folder>/<name>` and stamps its modification time. */
    const put = (folder: string, name: string, at: string) => {
      mkdirSync(join(outDir, folder), { recursive: true });
      const file = join(outDir, folder, name);
      writeFileSync(file, "x");
      utimesSync(file, new Date(at), new Date(at));
    };
    const ofContext = (copies: ReturnType<typeof newestBackupCopies>, context: string, registrationId?: string) =>
      copies.find((c) => c.context === context && c.registrationId === registrationId)!;
    return { outDir, put, ofContext };
  }

  it("reports the newest completed copy of control, personal and each active pharmacy, and none where there is no copy", () => {
    const { outDir, put, ofContext } = setup();
    put("2026-10-08", "control.db.enc", "2026-10-08T01:00:00Z");
    put("2026-10-09", "control.db.enc", "2026-10-09T01:00:00Z");
    put("2026-10-09", "personal.db.enc", "2026-10-09T01:00:05Z");
    put("2026-10-09", "aaaa.db.enc", "2026-10-09T01:00:10Z");
    const copies = newestBackupCopies({ outDir, registrations });
    expect(ofContext(copies, "control").newestAt).toEqual(new Date("2026-10-09T01:00:00Z"));
    expect(ofContext(copies, "personal").newestAt).toEqual(new Date("2026-10-09T01:00:05Z"));
    expect(ofContext(copies, "tenant", "reg-1").newestAt).toEqual(new Date("2026-10-09T01:00:10Z"));
    expect(ofContext(copies, "tenant", "reg-2").newestAt).toBeNull();
  });

  it("counts a pre-migration copy, so a skipped pharmacy's only copy is found", () => {
    const { outDir, put, ofContext } = setup();
    put("2026-10-09", "control.db.enc", "2026-10-09T01:00:00Z");
    put("pre-migration/2026-10-05T12-00-00Z", "bbbb.db.enc", "2026-10-05T12:00:00Z");
    const copies = newestBackupCopies({ outDir, registrations });
    expect(ofContext(copies, "tenant", "reg-2").newestAt).toEqual(new Date("2026-10-05T12:00:00Z"));
  });

  it("counts a copy in a complete hourly folder, never one in an unfinished hourly folder", () => {
    const { outDir, put, ofContext } = setup();
    put("2026-10-09", "aaaa.db.enc", "2026-10-09T01:00:00Z");
    put("hourly/2026-10-09T05Z", "aaaa.db.enc", "2026-10-09T05:00:10Z");
    put("hourly/2026-10-09T06Z.partial", "aaaa.db.enc", "2026-10-09T06:00:10Z");
    put("hourly/2026-10-09T05Z", "control.db.enc", "2026-10-09T05:00:00Z");
    const copies = newestBackupCopies({ outDir, registrations });
    expect(ofContext(copies, "tenant", "reg-1").newestAt).toEqual(new Date("2026-10-09T05:00:10Z"));
    expect(ofContext(copies, "control").newestAt).toEqual(new Date("2026-10-09T05:00:00Z"));
  });

  it("takes the newest across day folders and pre-migration folders", () => {
    const { outDir, put, ofContext } = setup();
    put("2026-10-01", "aaaa.db.enc", "2026-10-01T01:00:00Z");
    put("pre-migration/2026-10-07T08-00-00Z", "aaaa.db.enc", "2026-10-07T08:00:00Z");
    expect(ofContext(newestBackupCopies({ outDir, registrations }), "tenant", "reg-1").newestAt).toEqual(new Date("2026-10-07T08:00:00Z"));
  });

  it("does not count an unfinished day (.partial), a .part file, or a folder that is not a day", () => {
    const { outDir, put, ofContext } = setup();
    put("2026-10-09.partial", "aaaa.db.enc", "2026-10-09T01:00:00Z");
    put("2026-10-08", "aaaa.db.enc.part", "2026-10-08T01:00:00Z");
    put("notes", "aaaa.db.enc", "2026-10-08T01:00:00Z");
    expect(ofContext(newestBackupCopies({ outDir, registrations }), "tenant", "reg-1").newestAt).toBeNull();
  });

  it("tells when each pharmacy became active, so a pharmacy with no copy can be told from a new one", () => {
    const { outDir, ofContext } = setup();
    const copies = newestBackupCopies({ outDir, registrations });
    expect(ofContext(copies, "tenant", "reg-1").activeSince).toEqual(new Date("2026-09-01T00:00:00Z"));
    expect(ofContext(copies, "tenant", "reg-2").activeSince).toEqual(new Date("2026-10-09T00:00:00Z"));
    expect(ofContext(copies, "control").activeSince).toBeUndefined();
  });

  it("reports none everywhere when the backup folder does not exist", () => {
    const copies = newestBackupCopies({ outDir: join(tmpdir(), "no-such-backup-folder-oneon"), registrations });
    expect(copies.map((c) => c.newestAt)).toEqual([null, null, null, null]);
  });
});
