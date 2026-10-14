import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb } from "./open-control-db.js";
import { TenantAiLimitRepository } from "./tenant-ai-limit-repository.js";

describe("tenant AI limit repository (spec 9.4)", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "tenant-ai-limit-"));
    dirs.push(dir);
    const path = join(dir, "control.db");
    const control = openControlDb(path);
    closers.push(() => control.close());
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('admin', 'active', 'now'), ('admin-2', 'active', 'now')").run();
    for (const [id, tenantId] of [["r1", "t1"], ["r2", "t2"]]) {
      control
        .prepare(
          "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'Name', 'https://x', ?, 'active', 'admin', 'now')",
        )
        .run(id, tenantId, `slug-${id}`, `${id}.db`);
    }
    let now = Date.parse("2026-10-08T10:00:00.000Z");
    const clock = () => new Date(now);
    const repo = new TenantAiLimitRepository(control, clock);
    const version = (maxClass: "D0" | "D1" | "D2", over: Partial<Parameters<TenantAiLimitRepository["append"]>[0]> = {}) => ({
      registrationId: "r1",
      maxClass,
      setBy: "admin",
      liveCheckRef: JSON.stringify({ tokenVersion: 3, checkedAt: new Date(now).toISOString() }),
      evidence: null,
      ...over,
    });
    return { control, path, repo, version, advance: (ms: number) => (now += ms), clock };
  }

  it("defaults to D1 when the pharmacy has no row", () => {
    const { repo } = setup();
    expect(repo.current("r1")).toBe("D1");
    expect(repo.history("r1")).toEqual([]);
  });

  it("the newest row applies, and a row written in the same millisecond still comes after the one before it", () => {
    const { repo, version } = setup();
    repo.append(version("D0"));
    repo.append(version("D2"));
    repo.append(version("D1"));

    expect(repo.current("r1")).toBe("D1");
  });

  it("the newest row is the last one inserted, not the one with the latest created_at (a clock that stepped back changes nothing)", () => {
    const { repo, version, advance } = setup();
    repo.append(version("D0"));
    advance(-3_600_000); // the clock is an hour earlier when the next row is written
    repo.append(version("D2"));

    expect(repo.current("r1")).toBe("D2");
    expect(repo.history("r1").map((v) => v.maxClass)).toEqual(["D2", "D0"]);
    expect(repo.history("r1")[0]!.createdAt < repo.history("r1")[1]!.createdAt).toBe(true);
  });

  it("keeps each pharmacy's limit and history apart", () => {
    const { repo, version } = setup();
    repo.append(version("D0"));
    repo.append(version("D2", { registrationId: "r2" }));

    expect(repo.current("r1")).toBe("D0");
    expect(repo.current("r2")).toBe("D2");
    expect(repo.history("r1").map((v) => v.maxClass)).toEqual(["D0"]);
    expect(repo.history("r2").map((v) => v.maxClass)).toEqual(["D2"]);
  });

  it("history lists the newest first, with who set each row, the live check and the evidence", () => {
    const { repo, version, advance } = setup();
    repo.append(version("D2", { evidence: { providers: [{ id: "anthropic", tenantDpa: { reference: "DPA-1" } }] } }));
    advance(60_000);
    repo.append(version("D0", { setBy: "admin-2", liveCheckRef: '{"tokenVersion":4}' }));

    const history = repo.history("r1");

    expect(history.map((v) => v.maxClass)).toEqual(["D0", "D2"]);
    expect(history[0]).toMatchObject({ registrationId: "r1", setBy: "admin-2", liveCheckRef: '{"tokenVersion":4}', evidence: null, createdAt: "2026-10-08T10:01:00.000Z" });
    expect(history[1]).toMatchObject({ setBy: "admin", evidence: { providers: [{ id: "anthropic", tenantDpa: { reference: "DPA-1" } }] }, createdAt: "2026-10-08T10:00:00.000Z" });
    expect(history[0]!.id).not.toBe(history[1]!.id);
  });

  it("history is append-only: UPDATE and DELETE raise", () => {
    const { repo, control, version } = setup();
    repo.append(version("D0"));

    expect(() => control.prepare("UPDATE tenant_ai_limit_versions SET max_class = 'D2'").run()).toThrow("tenant_ai_limit_versions is append-only");
    expect(() => control.prepare("DELETE FROM tenant_ai_limit_versions").run()).toThrow("tenant_ai_limit_versions is append-only");
    expect(repo.current("r1")).toBe("D0");
  });

  it("refuses a pharmacy or an identity that does not exist", () => {
    const { repo, version } = setup();
    expect(() => repo.append(version("D0", { registrationId: "nope" }))).toThrow(/FOREIGN KEY/);
    expect(() => repo.append(version("D0", { setBy: "nobody" }))).toThrow(/FOREIGN KEY/);
    expect(repo.history("r1")).toEqual([]);
  });

  describe("change (read, decide and append in one transaction)", () => {
    const change = (repo: TenantAiLimitRepository, maxClass: "D0" | "D1" | "D2", onRaise: () => Record<string, unknown> | null = () => null) =>
      repo.change({ registrationId: "r1", maxClass, setBy: "admin", liveCheckRef: "ref" }, onRaise);

    it("lowering, and keeping the same class, append without asking for evidence", () => {
      const { repo } = setup();
      repo.append({ registrationId: "r1", maxClass: "D2", setBy: "admin", liveCheckRef: "ref", evidence: null });
      const asked: string[] = [];

      expect(change(repo, "D1", () => (asked.push("D1"), null))).toEqual({ ok: true });
      expect(change(repo, "D1", () => (asked.push("D1 again"), null))).toEqual({ ok: true });
      expect(change(repo, "D0", () => (asked.push("D0"), null))).toEqual({ ok: true });

      expect(asked).toEqual([]);
      expect(repo.history("r1").map((v) => [v.maxClass, v.evidence])).toEqual([["D0", null], ["D1", null], ["D1", null], ["D2", null]]);
    });

    it("raising appends with the evidence it was given", () => {
      const { repo } = setup();
      repo.append({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "ref", evidence: null });

      expect(change(repo, "D2", () => ({ providers: ["anthropic"] }))).toEqual({ ok: true });

      expect(repo.current("r1")).toBe("D2");
      expect(repo.history("r1")[0]).toMatchObject({ maxClass: "D2", setBy: "admin", liveCheckRef: "ref", evidence: { providers: ["anthropic"] } });
    });

    it("raising without evidence appends nothing and says what the limit still is", () => {
      const { repo } = setup();
      repo.append({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "ref", evidence: null });

      expect(change(repo, "D1")).toEqual({ ok: false, reason: "prerequisites_missing", current: "D0" });

      expect(repo.history("r1")).toHaveLength(1);
      expect(repo.current("r1")).toBe("D0");
    });

    it("a pharmacy with no row is at D1: D1 is not a raise there, D2 is", () => {
      const { repo } = setup();
      expect(change(repo, "D2")).toEqual({ ok: false, reason: "prerequisites_missing", current: "D1" });
      expect(change(repo, "D1")).toEqual({ ok: true });
      expect(change(repo, "D0")).toEqual({ ok: true });
    });

    describe("expectedCurrent (the class the person was looking at)", () => {
      const withExpected = (repo: TenantAiLimitRepository, maxClass: "D0" | "D1" | "D2", expectedCurrent: "D0" | "D1" | "D2", onRaise: () => Record<string, unknown> | null = () => null) =>
        repo.change({ registrationId: "r1", maxClass, setBy: "admin", liveCheckRef: "ref", expectedCurrent }, onRaise);

      it("is written when it matches the newest row, and a pharmacy with no row matches D1", () => {
        const { repo } = setup();
        expect(withExpected(repo, "D0", "D1")).toEqual({ ok: true });
        expect(withExpected(repo, "D1", "D0", () => ({ providers: [] }))).toEqual({ ok: true });
        expect(repo.history("r1").map((v) => v.maxClass)).toEqual(["D1", "D0"]);
      });

      it("a mismatch writes nothing and says what the limit is now, before a raise is even considered", () => {
        const { repo } = setup();
        repo.append({ registrationId: "r1", maxClass: "D0", setBy: "admin-2", liveCheckRef: "ref", evidence: null });
        let asked = false;

        // The person saw D2 and wants D1 (a lowering from what they saw); another admin has since set D0.
        expect(withExpected(repo, "D1", "D2")).toEqual({ ok: false, reason: "limit_changed", current: "D0" });
        expect(withExpected(repo, "D2", "D1", () => ((asked = true), { providers: [] }))).toEqual({ ok: false, reason: "limit_changed", current: "D0" });

        expect(asked).toBe(false);
        expect(repo.history("r1")).toHaveLength(1);
      });
    });

    it("reads the row, decides and writes inside one write transaction, so a second connection cannot slip a write in between", () => {
      const { repo, path, control } = setup();
      repo.append({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "ref", evidence: null });
      const rival = openControlDb(path);
      closers.push(() => rival.close());
      rival.pragma("busy_timeout = 0");
      const rivalRepo = new TenantAiLimitRepository(rival);
      let inTransaction = false;
      let rivalError: unknown;

      // While the first admin's raise is being decided, a second admin's write is locked out.
      const raised = change(repo, "D2", () => {
        inTransaction = control.inTransaction;
        try {
          rivalRepo.append({ registrationId: "r1", maxClass: "D0", setBy: "admin-2", liveCheckRef: "rival", evidence: null });
        } catch (error) {
          rivalError = error;
        }
        return { providers: ["anthropic"] };
      });

      expect(raised).toEqual({ ok: true });
      expect(inTransaction).toBe(true);
      expect(rivalError).toMatchObject({ code: "SQLITE_BUSY" });
      // Afterwards the second admin decides against the raise, not against the row it would have read before.
      expect(rivalRepo.current("r1")).toBe("D2");
      expect(rivalRepo.change({ registrationId: "r1", maxClass: "D1", setBy: "admin-2", liveCheckRef: "rival" }, () => null)).toEqual({ ok: true });
      expect(repo.history("r1").map((v) => [v.maxClass, v.setBy])).toEqual([["D1", "admin-2"], ["D2", "admin"], ["D0", "admin"]]);
    });

    // Spec 9.4, owner decision 2026-10-14: a lowering authorised from the cached snapshot while ImpressoRx is unreachable.
    describe("authorised from the cached snapshot", () => {
      const cached = { membershipId: "m1" };
      const pending = (control: ReturnType<typeof setup>["control"]) =>
        control.prepare("SELECT version_id, membership_id, created_at, rechecked_at, outcome FROM tenant_ai_limit_rechecks ORDER BY rowid").all();

      it("writes a strict lowering together with a pending re-check for the membership", () => {
        const { repo, control, version } = setup();
        repo.append(version("D2"));

        expect(repo.change({ registrationId: "r1", maxClass: "D1", setBy: "admin", liveCheckRef: "cached", cachedSnapshot: cached }, () => ({ never: true }))).toEqual({ ok: true });

        const [newest] = repo.history("r1");
        expect(newest).toMatchObject({ maxClass: "D1", liveCheckRef: "cached", evidence: null });
        expect(pending(control)).toEqual([{ version_id: newest!.id, membership_id: "m1", created_at: "2026-10-08T10:00:00.000Z", rechecked_at: null, outcome: null }]);
      });

      it.each([
        ["keeping the same class", "D1" as const],
        ["a raise", "D2" as const],
      ])("refuses %s with live_check_required, writing nothing and never asking for evidence", (_name, maxClass) => {
        const { repo, control, version } = setup();
        repo.append(version("D1"));
        let asked = false;

        const result = repo.change({ registrationId: "r1", maxClass, setBy: "admin", liveCheckRef: "cached", cachedSnapshot: cached }, () => {
          asked = true;
          return { would: "allow" };
        });

        expect(result).toEqual({ ok: false, reason: "live_check_required", current: "D1" });
        expect(asked).toBe(false);
        expect(repo.history("r1")).toHaveLength(1);
        expect(pending(control)).toEqual([]);
      });

      it("a pharmacy with no row is at D1: D0 is a lowering there, D1 is not", () => {
        const { repo } = setup();
        expect(repo.change({ registrationId: "r1", maxClass: "D1", setBy: "admin", liveCheckRef: "c", cachedSnapshot: cached }, () => null)).toMatchObject({ reason: "live_check_required" });
        expect(repo.change({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "c", cachedSnapshot: cached }, () => null)).toEqual({ ok: true });
      });

      it("expectedCurrent still applies first", () => {
        const { repo, version } = setup();
        repo.append(version("D2"));
        expect(repo.change({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "c", expectedCurrent: "D1", cachedSnapshot: cached }, () => null)).toEqual({
          ok: false,
          reason: "limit_changed",
          current: "D2",
        });
      });

      it("a change made with the live check leaves no re-check", () => {
        const { repo, control, version } = setup();
        repo.append(version("D2"));
        repo.change({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "live" }, () => null);
        expect(pending(control)).toEqual([]);
      });
    });
  });

  describe("resolveRechecks (the next snapshot ImpressoRx delivers for the membership)", () => {
    const lowerFromCache = (repo: TenantAiLimitRepository, membershipId: string, registrationId = "r1") =>
      repo.change({ registrationId, maxClass: "D0", setBy: "admin", liveCheckRef: "cached", cachedSnapshot: { membershipId } }, () => null);

    it("resolves each pending lowering of the membership once, recording whether the permission was still there", () => {
      const { repo, control, advance } = setup();
      lowerFromCache(repo, "m1");
      lowerFromCache(repo, "m2", "r2");
      advance(60_000);

      const resolved = repo.resolveRechecks("m1", false);

      expect(resolved).toEqual([{ versionId: repo.history("r1")[0]!.id, registrationId: "r1", maxClass: "D0" }]);
      expect(control.prepare("SELECT membership_id, rechecked_at, outcome FROM tenant_ai_limit_rechecks ORDER BY rowid").all()).toEqual([
        { membership_id: "m1", rechecked_at: "2026-10-08T10:01:00.000Z", outcome: "permission_lost" },
        { membership_id: "m2", rechecked_at: null, outcome: null },
      ]);
      expect(repo.resolveRechecks("m1", false)).toEqual([]);
      expect(repo.resolveRechecks("m2", true)).toHaveLength(1);
      expect(control.prepare("SELECT outcome FROM tenant_ai_limit_rechecks WHERE membership_id = 'm2'").get()).toEqual({ outcome: "confirmed" });
    });

    it("never changes the limit: the lowered class stays", () => {
      const { repo } = setup();
      lowerFromCache(repo, "m1");
      repo.resolveRechecks("m1", false);
      expect(repo.current("r1")).toBe("D0");
    });

    it("answers nothing for a membership with no pending lowering", () => {
      const { repo } = setup();
      expect(repo.resolveRechecks("m1", true)).toEqual([]);
    });
  });
});
