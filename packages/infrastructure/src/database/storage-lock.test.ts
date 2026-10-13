import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStorageLock } from "./connection.js";

const CHILD = `
import { acquireStorageLock } from ${JSON.stringify(new URL("./connection.ts", import.meta.url).href)};
acquireStorageLock(process.argv[2]);
console.log("locked");
setInterval(() => {}, 1000);
`;

describe("storage lock", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    dirs.push(dir);
    return dir;
  };

  it("refuses a second taker while held, and can be taken again after release", () => {
    const path = join(tempDir(), "storage.lock");
    const release = acquireStorageLock(path);
    expect(() => acquireStorageLock(path)).toThrow(/another Oneon process is preparing storage/i);
    release();
    acquireStorageLock(path)();
  });

  it("is not blocked by a leftover file nobody holds", () => {
    const path = join(tempDir(), "storage.lock");
    writeFileSync(path, ""); // what a killed first run leaves before SQLite wrote a header
    acquireStorageLock(path)();
    expect(existsSync(path)).toBe(true);
  });

  it("is held by a live child process, and released by the kernel when that process is killed", async () => {
    const dir = tempDir();
    const path = join(dir, "storage.lock");
    const script = join(dir, "child.mts");
    writeFileSync(script, CHILD);
    const child = spawn(process.execPath, ["--import", "tsx", script, path], { stdio: ["ignore", "pipe", "inherit"], cwd: process.cwd() });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (chunk: Buffer) => chunk.toString().includes("locked") && resolve());
        child.once("exit", () => reject(new Error("child exited before locking")));
      });
      expect(() => acquireStorageLock(path)).toThrow(/another Oneon process is preparing storage/i);
      child.kill("SIGKILL");
      await exited;
      acquireStorageLock(path)();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
