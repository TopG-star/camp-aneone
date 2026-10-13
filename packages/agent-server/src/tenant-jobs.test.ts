import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ContextDbGate, TenantRefusedError, TenantRegistrationRepository, ensureIdentityAnchor, openControlDb, rawDb } from "@oneon/infrastructure";
import { checkLinks, forEachTenant, latestRollups, writeRollups } from "./tenant-jobs.js";

const NOW = "2026-10-08T00:00:00.000Z";
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe("tenant jobs", () => {
  const dirs: string[] = [];
  const closers: Array<() => void> = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function setup(tenants = 2) {
    const dir = mkdtempSync(join(tmpdir(), "tenant-jobs-"));
    dirs.push(dir);
    const control = openControlDb(join(dir, "control.db"));
    control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('op', 'active', ?)").run(NOW);
    const gate = new ContextDbGate({ control, personalPath: join(dir, "personal.db"), tenantDir: join(dir, "tenants") });
    closers.push(
      () => gate.close(),
      () => control.close(),
    );
    for (let n = 1; n <= tenants; n++) {
      control
        .prepare(
          "INSERT INTO tenant_registrations (id, tenant_id, tenant_slug, display_name, origin, file_name, status, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'P', 'https://x.example', ?, 'active', 'op', ?)",
        )
        .run(`reg-${n}`, `t-${n}`, `s-${n}`, `${randomUUID()}.db`, NOW);
      gate.createTenantFile(`reg-${n}`, `t-${n}`);
    }
    return { dir, control, gate, registrations: new TenantRegistrationRepository(control) };
  }
  type Setup = ReturnType<typeof setup>;

  /** A gate that refuses reg-1 with a typed refusal and is otherwise the real one. */
  const refusing = (gate: ContextDbGate) =>
    ({
      lease: (id: string) => {
        if (id === "reg-1") throw new TenantRefusedError("tenant_unavailable");
        return gate.lease(id);
      },
    }) as unknown as ContextDbGate;

  describe("forEachTenant", () => {
    it("continues after a tenant throws", async () => {
      const { gate, registrations } = setup(3);
      const seen: string[] = [];
      const result = await forEachTenant({ gate, registrations }, async (db) => {
        seen.push(db.tenantId);
        if (db.tenantId === "t-2") throw new Error("boom");
      });
      expect(seen).toEqual(["t-1", "t-2", "t-3"]);
      expect(result.visited).toEqual(["reg-1", "reg-3"]);
      expect(result.failed).toEqual(["reg-2"]);
      expect(result.errors).toEqual({ "reg-2": "boom" });
      expect(result.refused).toEqual([]);
    });

    it("passes a deadline of now + budget, 2000 ms by default", async () => {
      const { gate, registrations } = setup(1);
      const deadlines: number[] = [];
      await forEachTenant({ gate, registrations, now: () => 10_000 }, async (_db, deadline) => void deadlines.push(deadline));
      await forEachTenant({ gate, registrations, now: () => 10_000 }, async (_db, deadline) => void deadlines.push(deadline), { budgetMs: 600_000 });
      expect(deadlines).toEqual([12_000, 610_000]);
    });

    it("reports a typed refusal as refused, not failed", async () => {
      const { gate, registrations } = setup(2);
      const result = await forEachTenant({ gate: refusing(gate), registrations }, async () => {});
      expect(result.refused).toEqual([{ registrationId: "reg-1", code: "tenant_unavailable" }]);
      expect(result.failed).toEqual([]);
      expect(result.visited).toEqual(["reg-2"]);
    });

    it("records a non-refusal open error as failed", async () => {
      const { registrations } = setup(1);
      const gate = {
        lease: () => {
          throw new Error("disk error");
        },
      };
      const result = await forEachTenant({ gate, registrations }, async () => {});
      expect(result.failed).toEqual(["reg-1"]);
      expect(result.refused).toEqual([]);
    });

    it("leases one file at a time and releases it even when the function throws", async () => {
      const { gate, registrations } = setup(2);
      let held = 0;
      let maxHeld = 0;
      const counting = {
        lease: (id: string) => {
          const lease = gate.lease(id);
          held += 1;
          maxHeld = Math.max(maxHeld, held);
          return {
            db: lease.db,
            release: () => {
              held -= 1;
              lease.release();
            },
          };
        },
      };
      await forEachTenant({ gate: counting, registrations }, async () => {
        throw new Error("x");
      });
      expect(maxHeld).toBe(1);
      expect(held).toBe(0);
    });

    it("never aborts a function that overruns its deadline; it logs a warning", async () => {
      const { gate, registrations } = setup(1);
      const log = logger();
      let clock = 0;
      let finished = false;
      const result = await forEachTenant({ gate, registrations, logger: log, now: () => clock }, async () => {
        clock += 5000;
        await Promise.resolve();
        finished = true;
      });
      expect(finished).toBe(true);
      expect(result.visited).toEqual(["reg-1"]);
      expect(log.warn).toHaveBeenCalledWith("tenant job overran its budget", expect.objectContaining({ registrationId: "reg-1" }));
    });
  });

  function seedTenant1(s: Setup) {
    const db = s.gate.openTenant("reg-1");
    ensureIdentityAnchor(db, "u1");
    const raw = rawDb(db);
    const action = raw.prepare(
      `INSERT INTO action_instances (id, scope, owner_id, user_id, tenant_id, action_type, definition_version, status, initiator, input_json, idempotency_key, created_at, updated_at)
       VALUES (?, 'tenant', 't-1', 'u1', 't-1', 'x', '1', ?, 'user', '{}', ?, ?, ?)`,
    );
    action.run("a1", "completed", "k1", "2026-10-09T10:00:00.000Z", "2026-10-09T10:00:00.000Z");
    action.run("a2", "completed", "k2", "2026-10-09T11:00:00.000Z", "2026-10-09T11:00:00.000Z");
    action.run("a3", "failed", "k3", "2026-10-09T23:59:59.999Z", "2026-10-09T23:59:59.999Z");
    action.run("a4", "failed", "k4", "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z"); // another day
    const decision = raw.prepare(
      `INSERT INTO model_call_decisions (id, call_id, created_at, context_kind, identity_id, tenant_id, purpose, provider, layers_json, decision, released_json, withheld_json, placeholder_count, scanner_d3, scanner_d4, alert, policy_fingerprint, key_version)
       VALUES (?, ?, ?, 'tenant', 'i1', 't-1', 'chat', 'p', '[]', ?, '[]', '[]', 0, 0, 0, 0, 'f', 1)`,
    );
    decision.run("d1", "c1", "2026-10-09T01:00:00.000Z", "allow");
    decision.run("d2", "c2", "2026-10-09T02:00:00.000Z", "deny");
    decision.run("d3", "c3", "2026-10-09T03:00:00.000Z", "allow");
    decision.run("d4", "c4", "2026-10-10T03:00:00.000Z", "allow"); // another day
    s.control.prepare("INSERT INTO identities (id, status, created_at) VALUES ('i1', 'active', ?)").run(NOW);
    s.control
      .prepare(
        "INSERT INTO memberships (id, identity_id, tenant_registration_id, external_user_id, role, permissions_json, location_ids_json, status, snapshot_at, created_at) VALUES ('m1', 'i1', 'reg-1', 'e1', 'r', '[]', '[]', 'active', ?, ?)",
      )
      .run(NOW, NOW);
  }

  function addGrant(s: Setup, id: string, opts: { status?: string; actionId?: string; expires?: string } = {}) {
    s.control
      .prepare(
        `INSERT INTO delegation_grants (id, identity_id, membership_id, tenant_registration_id, kind, scope_json, encrypted_value, wrapped_key, generation, status, action_id, created_at, absolute_expires_at)
         VALUES (?, 'i1', 'm1', 'reg-1', 'action', '[]', 'v', 'k', 1, ?, ?, ?, ?)`,
      )
      .run(id, opts.status ?? "active", opts.actionId ?? "a1", NOW, opts.expires ?? "2999-01-01T00:00:00.000Z");
  }

  const deps = (s: Setup) => ({ gate: s.gate, control: s.control, registrations: s.registrations, now: () => Date.parse("2026-10-10T01:00:00.000Z") });

  describe("writeRollups", () => {
    it("contains only the four numeric keys, with counts for that day", async () => {
      const s = setup();
      seedTenant1(s);
      addGrant(s, "g1");
      addGrant(s, "g2", { status: "revoked" });
      addGrant(s, "g3", { expires: "2026-10-01T00:00:00.000Z" }); // active status, but past its absolute expiry
      await writeRollups(deps(s), "2026-10-09");

      const rows = s.control.prepare("SELECT tenant_id, day, metrics_json FROM tenant_rollups ORDER BY tenant_id").all() as Array<{
        tenant_id: string;
        day: string;
        metrics_json: string;
      }>;
      expect(rows.map((r) => [r.tenant_id, r.day])).toEqual([
        ["t-1", "2026-10-09"],
        ["t-2", "2026-10-09"],
      ]);
      const m1 = JSON.parse(rows[0]!.metrics_json);
      expect(Object.keys(m1).sort()).toEqual(["actionsByStatus", "activeGrants", "modelCalls", "modelDenials"]);
      expect(m1).toEqual({ modelCalls: 3, modelDenials: 1, actionsByStatus: { completed: 2, failed: 1 }, activeGrants: 1 });
      expect(JSON.parse(rows[1]!.metrics_json)).toEqual({ modelCalls: 0, modelDenials: 0, actionsByStatus: {}, activeGrants: 0 });
      // Content-free: every leaf is a number; the only string keys are status names.
      const leaves = [m1.modelCalls, m1.modelDenials, m1.activeGrants, ...Object.values(m1.actionsByStatus)];
      expect(leaves.every((v) => typeof v === "number")).toBe(true);
    });

    it("is idempotent: a rerun replaces the day's row", async () => {
      const s = setup(1);
      seedTenant1(s);
      await writeRollups(deps(s), "2026-10-09");
      await writeRollups(deps(s), "2026-10-09");
      expect((s.control.prepare("SELECT COUNT(*) AS n FROM tenant_rollups").get() as { n: number }).n).toBe(1);
    });

    it("latestRollups returns each tenant's most recent day", async () => {
      const s = setup(1);
      await writeRollups(deps(s), "2026-10-08");
      await writeRollups(deps(s), "2026-10-09");
      expect(latestRollups(s.control)).toEqual([
        { tenantId: "t-1", day: "2026-10-09", metrics: { modelCalls: 0, modelDenials: 0, actionsByStatus: {}, activeGrants: 0 } },
      ]);
    });

    it("reports a refused tenant and writes no row for it", async () => {
      const s = setup(2);
      const result = await writeRollups({ ...deps(s), gate: refusing(s.gate) }, "2026-10-09");
      expect(result.refused).toEqual([{ registrationId: "reg-1", code: "tenant_unavailable" }]);
      expect((s.control.prepare("SELECT tenant_id FROM tenant_rollups").all() as Array<{ tenant_id: string }>).map((r) => r.tenant_id)).toEqual(["t-2"]);
    });
  });

  describe("checkLinks", () => {
    it("reports an action grant whose action is gone, raises an operator alert, and never deletes it", async () => {
      const s = setup(2);
      seedTenant1(s); // action a1 exists in reg-1
      addGrant(s, "ok", { actionId: "a1" });
      addGrant(s, "dangling", { actionId: "gone" });
      addGrant(s, "revoked", { actionId: "gone-too", status: "revoked" });
      const log = logger();
      const found = await checkLinks({ gate: s.gate, control: s.control, registrations: s.registrations, logger: log });
      expect(found).toEqual([{ grantId: "dangling", actionId: "gone", tenantId: "t-1" }]);
      expect(log.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ alert: "link_check", grantId: "dangling", actionId: "gone", tenantId: "t-1" }),
      );
      expect((s.control.prepare("SELECT COUNT(*) AS n FROM delegation_grants").get() as { n: number }).n).toBe(3);
    });

    it("raises no alert when every link holds", async () => {
      const s = setup(2);
      seedTenant1(s);
      addGrant(s, "ok", { actionId: "a1" });
      const log = logger();
      expect(await checkLinks({ gate: s.gate, control: s.control, registrations: s.registrations, logger: log })).toEqual([]);
      expect(log.error).not.toHaveBeenCalled();
    });
  });
});
