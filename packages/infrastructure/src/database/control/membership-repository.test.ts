import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControlDb } from "./open-control-db.js";
import { SqliteIdentityRepository } from "./identity-repository.js";
import { MembershipRepository } from "./membership-repository.js";
import { UsedHandoffJti } from "./used-handoff-jti.js";

describe("membership repository and hand-off jti store", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "membership-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    closers.push(() => control.close());
    const identities = new SqliteIdentityRepository(control);
    const a = identities.createWithLogin({ kind: "impressorx", subject: "r1:s1" }).id;
    const b = identities.createWithLogin({ kind: "impressorx", subject: "r1:s2" }).id;
    control
      .prepare(
        "INSERT INTO tenant_registrations (impressorx_tenant_id, id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (lower(hex(randomblob(16))), 'r1', 't1', 'slug', 'Name', 'https://x', 'f.db', 'active', ?, 'now')",
      )
      .run(a);
    let now = Date.parse("2026-10-08T10:00:00Z");
    return { control, a, b, repo: new MembershipRepository(control, () => new Date(now)), advance: (ms: number) => (now += ms) };
  }

  const input = (identityId: string, role = "manager") => ({ identityId, tenantRegistrationId: "r1", externalUserId: "s1", role });

  it("creates an active membership with an empty snapshot, then reuses it and takes the new role", () => {
    const { repo, a } = setup();
    const first = repo.upsertFromHandoff(input(a));
    expect(first).toMatchObject({ identityId: a, externalUserId: "s1", role: "manager", status: "active", permissions: [], locationIds: [] });
    expect(first.snapshotAt).toBe(new Date(0).toISOString());

    const second = repo.upsertFromHandoff(input(a, "owner"));
    expect(second.id).toBe(first.id);
    expect(second.role).toBe("owner");
  });

  it("never takes a membership over from another identity", () => {
    const { repo, a, b } = setup();
    repo.upsertFromHandoff(input(a));
    expect(() => repo.upsertFromHandoff(input(b))).toThrow();
    expect(repo.listActiveForIdentity(b)).toEqual([]);
  });

  it("applySnapshot stores the snapshot and maps the tenant status, ignoring case", () => {
    const { repo, a } = setup();
    const m = repo.upsertFromHandoff(input(a));
    repo.applySnapshot(m.id, { role: "staff", permissions: ["p"], locationIds: ["l"], tenantStatus: "Disabled" });
    expect(repo.findById(m.id)).toMatchObject({ role: "staff", permissions: ["p"], locationIds: ["l"], status: "suspended", snapshotAt: "2026-10-08T10:00:00.000Z" });
    expect(repo.listActiveForIdentity(a)).toEqual([]);

    repo.applySnapshot(m.id, { role: "staff", permissions: [], locationIds: [], tenantStatus: "Active" });
    expect(repo.findById(m.id)!.status).toBe("active");
    expect(repo.listActiveForIdentity(a)).toHaveLength(1);
  });

  it("a revoked membership is not reactivated by a snapshot or a hand-off", () => {
    const { repo, a } = setup();
    const m = repo.upsertFromHandoff(input(a));
    repo.setStatus(m.id, "revoked");
    repo.applySnapshot(m.id, { role: "staff", permissions: [], locationIds: [], tenantStatus: "active" });
    repo.upsertFromHandoff(input(a));
    expect(repo.findById(m.id)!.status).toBe("revoked");
  });

  it("consumes a jti once and forgets expired ones", () => {
    const { control } = setup();
    let now = Date.parse("2026-10-08T10:00:00Z");
    const store = new UsedHandoffJti(control, () => new Date(now));
    const expiresAt = new Date(now + 90_000).toISOString();

    expect(store.consume("j1", expiresAt)).toBe(true);
    expect(store.consume("j1", expiresAt)).toBe(false);
    now += 120_000;
    expect(store.consume("j2", new Date(now + 90_000).toISOString())).toBe(true);
    expect(control.prepare("SELECT jti FROM used_handoff_jti").all()).toEqual([{ jti: "j2" }]);
  });
});
