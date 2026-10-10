import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { sealBuffer } from "@oneon/infrastructure";
import { restoreBackup } from "./restore-backup.js";

describe("restoreBackup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "restore-"));
    dirs.push(dir);
    const keyB64 = randomBytes(32).toString("base64");
    const folder = join(dir, "backups", "2026-10-10");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "personal.db.enc");
    const database = randomBytes(2000);
    writeFileSync(file, sealBuffer(database, keyB64, "2026-10-10/personal.db.enc"));
    return { dir, keyB64, file, database };
  }

  it("decrypts to the output path", () => {
    const { dir, keyB64, file, database } = setup();
    const out = join(dir, "restored.db");
    expect(restoreBackup([file, "--out", out], keyB64)).toBe(out);
    expect(readFileSync(out).equals(database)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("writes the restored database readable by the owner only", () => {
    const { dir, keyB64, file } = setup();
    const out = join(dir, "restored.db");
    restoreBackup([file, "--out", out], keyB64);
    expect(statSync(out).mode & 0o077).toBe(0);
  });

  it("refuses to overwrite an existing file unless --force is given", () => {
    const { dir, keyB64, file, database } = setup();
    const out = join(dir, "live.db");
    writeFileSync(out, "the live database");
    expect(() => restoreBackup([file, "--out", out], keyB64)).toThrow(/already exists.*--force/);
    expect(readFileSync(out, "utf8")).toBe("the live database");
    expect(restoreBackup([file, "--out", out, "--force"], keyB64)).toBe(out);
    expect(readFileSync(out).equals(database)).toBe(true);
  });

  it("writes nothing when the key is wrong or the file was renamed", () => {
    const { dir, keyB64, file } = setup();
    const out = join(dir, "restored.db");
    expect(() => restoreBackup([file, "--out", out], randomBytes(32).toString("base64"))).toThrow();
    const renamed = join(dir, "backups", "2026-10-10", "tenant.db.enc");
    copyFileSync(file, renamed);
    expect(() => restoreBackup([renamed, "--out", out], keyB64)).toThrow(/original folder and file name/);
    expect(existsSync(out)).toBe(false);
  });

  it("defaults the output to the file's name without .enc in the current directory, never beside the backup", () => {
    const { keyB64, file } = setup();
    const previous = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "restore-cwd-"));
    dirs.push(cwd);
    process.chdir(cwd);
    try {
      const out = restoreBackup([file], keyB64);
      expect(out).toBe(join(process.cwd(), "personal.db"));
      expect(existsSync(out)).toBe(true);
    } finally {
      process.chdir(previous);
    }
  });

  it("explains its usage when no file is given", () => {
    expect(() => restoreBackup([], "k")).toThrow(/Usage/);
  });
});
