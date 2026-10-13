import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "./connection.js";
import { ContextDbGate, TenantRefusedError, rawDb } from "./context-db-gate.js";
import { openControlDb } from "./control/open-control-db.js";
import { sealBuffer } from "../crypto/envelope.js";
import { backupAll, decryptBackup, restoreTest, restoreTestOwned, sweepBackupLeftovers } from "./backup.js";

const NOW = "2026-10-08T00:00:00.000Z";
const TODAY = new Date("2026-10-10T03:00:00.000Z");

describe("backups", () => {
  const dirs: string[] = [];
  const open: Array<() => void> = [];
  afterEach(() => {
    for (const close of open.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(tenants = 2) {
    const dir = mkdtempSync(join(tmpdir(), "backup-"));
    dirs.push(dir);
    const tenantDir = join(dir, "tenants");
    mkdirSync(tenantDir);
    const control = openControlDb(join(dir, "control.db"));
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir });
    gate.openPersonal();
    const regs: Array<{ id: string; tenantId: string; fileName: string }> = [];
    for (let n = 1; n <= tenants; n++) {
      const fileName = `${randomUUID()}.db`;
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'P', 'https://x.example', ?, 'active', 'op', ?)",
        )
        .run(`reg-${n}`, `t-${n}`, `s-${n}`, fileName, NOW);
      gate.createTenantFile(`reg-${n}`, `t-${n}`);
      regs.push({ id: `reg-${n}`, tenantId: `t-${n}`, fileName });
    }
    open.push(() => gate.close(), () => control.close());
    const outDir = join(dir, "backups");
    const keyB64 = randomBytes(32).toString("base64");
    return { dir, tenantDir, control, gate, regs, outDir, keyB64, tmpDir: join(dir, "tmp"), deps: { gate, control, outDir, keyB64, now: () => TODAY } };
  }

  function walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  }

  it("backs up every file while a write is in progress and the copy passes integrity_check", async () => {
    const { dir, tenantDir, regs, gate, deps, tmpDir } = setup();
    rawDb(gate.openTenant("reg-1")).prepare("INSERT INTO users (id, email) VALUES ('committed', 'c@anchor.invalid')").run();
    // A second connection holds an open write transaction on the same tenant file for the whole backup.
    const writer = createDatabase(join(tenantDir, regs[0]!.fileName));
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO users (id, email) VALUES ('uncommitted', 'u@anchor.invalid')").run();
    let results;
    try {
      results = await backupAll(deps);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }

    expect(results.map((r) => r.context)).toEqual(["control", "personal", "t-1", "t-2"]);
    expect(results.every((r) => r.file.startsWith(join(deps.outDir, "2026-10-10")) && r.file.endsWith(".db.enc"))).toBe(true);
    for (const r of results) {
      expect(await restoreTest({ file: r.file, keyB64: deps.keyB64, tmpDir })).toMatchObject({ ok: true, integrity: "ok" });
    }
    // Only what was committed is in the copy.
    const restoredPath = join(dir, "restored.db");
    writeFileSync(restoredPath, decryptBackup(results.find((r) => r.context === "t-1")!.file, deps.keyB64));
    const copy = createDatabase(restoredPath);
    expect(copy.prepare("SELECT id FROM users WHERE id IN ('committed', 'uncommitted')").all()).toEqual([{ id: "committed" }]);
    copy.close();
  });

  it("no plaintext database remains in outDir", async () => {
    const { deps } = setup();
    await backupAll(deps);
    const files = walk(deps.outDir);
    expect(files.length).toBe(4);
    for (const file of files) {
      expect(file.endsWith(".db.enc")).toBe(true);
      expect(readFileSync(file).subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    }
  });

  it.skipIf(process.platform === "win32")("writes sealed files readable by the owner only", async () => {
    const { deps } = setup(1);
    const results = await backupAll(deps);
    for (const r of results) expect(statSync(r.file).mode & 0o077).toBe(0);
  });

  it("restoreTest reports the tenant id from context_meta", async () => {
    const { deps, tmpDir } = setup();
    const results = await backupAll(deps);
    const tenant = results.find((r) => r.context === "t-2")!;
    expect(await restoreTest({ file: tenant.file, keyB64: deps.keyB64, tmpDir })).toEqual({
      ok: true,
      integrity: "ok",
      contextMeta: { kind: "tenant", tenant_id: "t-2" },
    });
    const personal = await restoreTest({ file: results.find((r) => r.context === "personal")!.file, keyB64: deps.keyB64, tmpDir });
    expect(personal.contextMeta).toEqual({ kind: "personal", tenant_id: null });
  });

  it("restoreTest deletes its plaintext copy, success or failure", async () => {
    const { deps, tmpDir } = setup(1);
    const results = await backupAll(deps);
    await restoreTest({ file: results[2]!.file, keyB64: deps.keyB64, tmpDir });
    await restoreTest({ file: results[2]!.file, keyB64: randomBytes(32).toString("base64"), tmpDir });
    expect(walk(tmpDir)).toEqual([]);
  });

  it("restoreTest fails with the wrong key", async () => {
    const { deps, tmpDir } = setup(1);
    const results = await backupAll(deps);
    const check = await restoreTest({ file: results[2]!.file, keyB64: randomBytes(32).toString("base64"), tmpDir });
    expect(check.ok).toBe(false);
    expect(check.contextMeta).toBeNull();
  });

  it("restoreTest refuses a backup presented as another file or from another day (associated data)", async () => {
    const { deps, tmpDir } = setup();
    const results = await backupAll(deps);
    const a = results.find((r) => r.context === "t-1")!;
    const b = results.find((r) => r.context === "t-2")!;
    copyFileSync(a.file, b.file);
    expect((await restoreTest({ file: b.file, keyB64: deps.keyB64, tmpDir })).ok).toBe(false);

    const otherDay = join(deps.outDir, "2026-10-09");
    mkdirSync(otherDay);
    const moved = join(otherDay, basename(a.file));
    copyFileSync(a.file, moved);
    expect((await restoreTest({ file: moved, keyB64: deps.keyB64, tmpDir })).ok).toBe(false);
    // The original, under its own name, still restores.
    expect((await restoreTest({ file: a.file, keyB64: deps.keyB64, tmpDir })).ok).toBe(true);
  });

  it("decryptBackup refuses a swapped file too", async () => {
    const { deps } = setup();
    const results = await backupAll(deps);
    copyFileSync(results[2]!.file, results[3]!.file);
    expect(() => decryptBackup(results[3]!.file, deps.keyB64)).toThrow();
  });

  it("restoreTest reports a decrypted file that is not a database", async () => {
    const { deps, tmpDir } = setup(1);
    const folder = join(deps.outDir, "2026-10-01");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "junk.db.enc");
    writeFileSync(file, sealBuffer(Buffer.from("not a database at all, just padding text".repeat(40)), deps.keyB64, "2026-10-01/junk.db.enc"));
    const check = await restoreTest({ file, keyB64: deps.keyB64, tmpDir });
    expect(check.ok).toBe(false);
    expect(walk(tmpDir)).toEqual([]);
  });

  /** A gate whose open of one tenant throws `error` while `broken.on` is true; everything else is the real gate. */
  function flakyGate(gate: ContextDbGate, registrationId: string, error: Error) {
    const broken = { on: true };
    const wrapped = {
      openPersonal: () => gate.openPersonal(),
      openTenant: (id: string) => {
        if (broken.on && id === registrationId) throw error;
        return gate.openTenant(id);
      },
    } as unknown as ContextDbGate;
    return { wrapped, broken };
  }

  it("backs up the other files and then fails when one tenant cannot be opened for a non-refusal reason", async () => {
    const { deps, regs, gate } = setup();
    const { wrapped } = flakyGate(gate, "reg-1", new Error("disk error"));
    const errors: string[] = [];
    const logger = { info() {}, warn() {}, debug() {}, error: (m: string) => void errors.push(m) };
    await expect(backupAll({ ...deps, gate: wrapped, logger })).rejects.toThrow(/t-1/);
    expect(existsSync(join(deps.outDir, "2026-10-10.partial", `${regs[1]!.fileName.replace(/\.db$/, "")}.db.enc`))).toBe(true);
    expect(existsSync(join(deps.outDir, "2026-10-10"))).toBe(false);
    expect(errors.length).toBe(1);
  });

  describe("a day is only complete when every file is in it", () => {
    it("leaves no day folder when one file fails, and the next run writes the whole day", async () => {
      const { deps, gate } = setup();
      const { wrapped, broken } = flakyGate(gate, "reg-1", new Error("disk error"));
      await expect(backupAll({ ...deps, gate: wrapped })).rejects.toThrow();
      expect(existsSync(join(deps.outDir, "2026-10-10"))).toBe(false);

      broken.on = false;
      const results = await backupAll({ ...deps, gate: wrapped });
      expect(results.length).toBe(4);
      expect(readdirSync(deps.outDir)).toEqual(["2026-10-10"]);
      // Sealed for its final place: it restores from there.
      for (const r of results) expect((await restoreTest({ file: r.file, keyB64: deps.keyB64, tmpDir: join(deps.outDir, "..", "tmp") })).ok).toBe(true);
    });

    it("clears a leftover partial folder at the start of a run", async () => {
      const { deps } = setup(1);
      mkdirSync(join(deps.outDir, "2026-10-10.partial"), { recursive: true });
      writeFileSync(join(deps.outDir, "2026-10-10.partial", "stale.db.enc"), "x");
      await backupAll(deps);
      const names = walk(deps.outDir).map((f) => basename(f));
      expect(names.length).toBe(3);
      expect(names).not.toContain("stale.db.enc");
      expect(existsSync(join(deps.outDir, "2026-10-10.partial"))).toBe(false);
    });
  });

  describe("a tenant the gate refuses is skipped, not failed", () => {
    it("completes the day, lists the tenant in skipped.json, and logs it at error", async () => {
      const { deps, regs, gate } = setup();
      const { wrapped } = flakyGate(gate, "reg-1", new TenantRefusedError("tenant_schema_behind"));
      const errors: Array<[string, unknown]> = [];
      const logger = { info() {}, warn() {}, debug() {}, error: (m: string, c?: unknown) => void errors.push([m, c]) };
      const results = await backupAll({ ...deps, gate: wrapped, logger });

      const day = join(deps.outDir, "2026-10-10");
      expect(existsSync(`${day}.partial`)).toBe(false);
      expect(results.map((r) => r.context)).toEqual(["control", "personal", "t-2"]);
      expect(results.skipped).toEqual([{ registrationId: "reg-1", code: "tenant_schema_behind" }]);
      expect(JSON.parse(readFileSync(join(day, "skipped.json"), "utf8"))).toEqual([{ registrationId: "reg-1", code: "tenant_schema_behind" }]);
      expect(readdirSync(day).sort()).toEqual(["control.db.enc", "personal.db.enc", `${regs[1]!.fileName.replace(/\.db$/, "")}.db.enc`, "skipped.json"].sort());
      expect(errors).toHaveLength(1);
      expect(errors[0]![1]).toMatchObject({ registrationId: "reg-1", code: "tenant_schema_behind" });
    });

    it("writes no skipped.json when nothing was skipped", async () => {
      const { deps } = setup();
      const results = await backupAll(deps);
      expect(results.skipped).toEqual([]);
      expect(existsSync(join(deps.outDir, "2026-10-10", "skipped.json"))).toBe(false);
    });

    it("keeps the day partial when a skipped tenant is not the only problem", async () => {
      const { deps, gate } = setup();
      const wrapped = {
        openPersonal: () => gate.openPersonal(),
        openTenant: (id: string) => {
          if (id === "reg-1") throw new TenantRefusedError("tenant_unavailable");
          throw new Error("disk error");
        },
      } as unknown as ContextDbGate;
      await expect(backupAll({ ...deps, gate: wrapped })).rejects.toThrow(/t-2/);
      expect(existsSync(join(deps.outDir, "2026-10-10"))).toBe(false);
    });
  });

  describe("restoreTestOwned: the file must belong to the context its name says", () => {
    it("passes for a tenant file whose context_meta matches its registration", async () => {
      const { deps, tmpDir, control } = setup();
      const results = await backupAll(deps);
      const check = await restoreTestOwned({ file: results.find((r) => r.context === "t-2")!.file, keyB64: deps.keyB64, tmpDir, control });
      expect(check).toMatchObject({ ok: true, contextMeta: { kind: "tenant", tenant_id: "t-2" } });
    });

    it("fails when the registration that owns the file has a different tenant id", async () => {
      const { deps, tmpDir, control } = setup();
      const results = await backupAll(deps);
      control.prepare("UPDATE tenant_registrations SET tenant_id = 'someone-else' WHERE id = 'reg-2'").run();
      const check = await restoreTestOwned({ file: results.find((r) => r.context === "t-2")!.file, keyB64: deps.keyB64, tmpDir, control });
      expect(check.ok).toBe(false);
      expect(check.reason).toMatch(/tenant_id.*t-2.*someone-else/);
    });

    it("fails when no registration owns the file", async () => {
      const { deps, tmpDir, control } = setup();
      const results = await backupAll(deps);
      control.prepare("DELETE FROM tenant_registrations WHERE id = 'reg-2'").run();
      const check = await restoreTestOwned({ file: results.find((r) => r.context === "t-2")!.file, keyB64: deps.keyB64, tmpDir, control });
      expect(check.ok).toBe(false);
      expect(check.reason).toMatch(/no registration/i);
    });

    it("fails when the file holds a personal context, or no context_meta at all", async () => {
      const { deps, tmpDir, control, regs, dir } = setup();
      const results = await backupAll(deps);
      const day = join(deps.outDir, "2026-10-10");
      const name = `${regs[0]!.fileName.replace(/\.db$/, "")}.db.enc`;
      // The personal database sealed under the tenant's file name.
      writeFileSync(join(day, name), sealBuffer(decryptBackup(results.find((r) => r.context === "personal")!.file, deps.keyB64), deps.keyB64, `2026-10-10/${name}`));
      const personal = await restoreTestOwned({ file: join(day, name), keyB64: deps.keyB64, tmpDir, control });
      expect(personal.ok).toBe(false);
      expect(personal.reason).toMatch(/kind/);

      const bare = join(dir, "bare.db");
      const db = createDatabase(bare);
      db.exec("CREATE TABLE t (a)");
      db.close();
      writeFileSync(join(day, name), sealBuffer(readFileSync(bare), deps.keyB64, `2026-10-10/${name}`));
      const missing = await restoreTestOwned({ file: join(day, name), keyB64: deps.keyB64, tmpDir, control });
      expect(missing.ok).toBe(false);
      expect(missing.reason).toMatch(/context_meta/);
    });
  });

  describe("sweepBackupLeftovers", () => {
    it("removes our scratch folders and .part files, and nothing else", () => {
      const { dir, outDir } = setup(0);
      const scratchRoot = join(dir, "scratch");
      mkdirSync(join(scratchRoot, "oneon-backup-abc"), { recursive: true });
      writeFileSync(join(scratchRoot, "oneon-backup-abc", "copy.db"), "plain");
      mkdirSync(join(scratchRoot, "oneon-restore-xyz"));
      mkdirSync(join(scratchRoot, "someone-elses"));
      mkdirSync(join(outDir, "2026-10-10"), { recursive: true });
      writeFileSync(join(outDir, "2026-10-10", "a.db.enc.part"), "x");
      writeFileSync(join(outDir, "2026-10-10", "a.db.enc"), "keep");
      writeFileSync(join(scratchRoot, "other.part"), "not in the backup dir");

      const removed = sweepBackupLeftovers({ backupDir: outDir, scratchRoots: [scratchRoot, join(dir, "missing")] });

      expect(removed.length).toBe(3);
      expect(readdirSync(scratchRoot).sort()).toEqual(["other.part", "someone-elses"]);
      expect(readdirSync(join(outDir, "2026-10-10"))).toEqual(["a.db.enc"]);
    });
  });
});
