import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TenantAiLimitRepository, openControlDb } from "@oneon/infrastructure";
import { alertOverdueRechecks, overdueRecheckJob } from "./ai-limit-recheck.js";

// Spec 9.4, owner decision 2026-10-15 (Q2): a daily pass alerts on any cached-snapshot lowering still pending after more than 24 h.
describe("the daily pass over pending AI limit re-checks", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ai-limit-recheck-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('admin', 'active', 'now')").run();
    control
      .prepare(
        "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES ('irx', 'r1', 't1', 'acme', 'Acme', 'https://x', 'r1.db', 'active', 'admin', 'now')",
      )
      .run();
    let now = Date.parse("2026-10-08T10:00:00.000Z");
    const limits = new TenantAiLimitRepository(control, () => new Date(now));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const lower = (membershipId: string) =>
      limits.change({ registrationId: "r1", maxClass: "D0", setBy: "admin", liveCheckRef: "cached", cachedSnapshot: { membershipId } }, () => null);
    const overdue = () => logger.error.mock.calls.filter(([, f]) => (f as { alert?: string }).alert === "ai_limit_recheck_overdue");
    return { limits, logger, lower, overdue, at: (iso: string) => (now = Date.parse(iso)) };
  }

  it("alerts once per lowering pending for more than 24 h, and not for one 24 h old or younger, or one already resolved", () => {
    const s = setup();
    s.lower("m-old"); // 2026-10-08T10:00
    s.at("2026-10-08T12:00:00.000Z");
    s.lower("m-young");
    s.lower("m-resolved");
    s.limits.resolveRechecks("m-resolved", true);

    expect(alertOverdueRechecks({ limits: s.limits, logger: s.logger, now: new Date("2026-10-09T10:00:00.000Z") })).toBe(0); // exactly 24 h
    expect(alertOverdueRechecks({ limits: s.limits, logger: s.logger, now: new Date("2026-10-09T11:00:00.000Z") })).toBe(1);

    expect(s.overdue()).toEqual([
      [expect.any(String), { alert: "ai_limit_recheck_overdue", membershipId: "m-old", registrationId: "r1", versionId: expect.any(String), maxClass: "D0", pendingSince: "2026-10-08T10:00:00.000Z" }],
    ]);
  });

  it("a pending lowering stays pending: the pass alerts again the next day until a re-check resolves it", () => {
    const s = setup();
    s.lower("m1");

    alertOverdueRechecks({ limits: s.limits, logger: s.logger, now: new Date("2026-10-09T11:00:00.000Z") });
    alertOverdueRechecks({ limits: s.limits, logger: s.logger, now: new Date("2026-10-10T11:00:00.000Z") });
    s.limits.resolveRechecks("m1", false);
    alertOverdueRechecks({ limits: s.limits, logger: s.logger, now: new Date("2026-10-11T11:00:00.000Z") });

    expect(s.overdue()).toHaveLength(2);
  });

  it("runs as a DailyJob", async () => {
    const s = setup();
    s.lower("m1");
    const job = overdueRecheckJob(s.limits, s.logger, () => new Date("2026-10-09T11:00:00.000Z"));

    await job.tick();
    await job.tick(); // once per UTC day

    expect(s.overdue()).toHaveLength(1);
  });
});
