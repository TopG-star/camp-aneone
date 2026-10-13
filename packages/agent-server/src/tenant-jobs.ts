import type { Logger } from "@oneon/domain";
import { forEachTenant, rawDb, type ControlDb, type ForEachTenantDeps, type ForEachTenantResult } from "@oneon/infrastructure";

// The runner lives beside the gate (infrastructure) so the backup, which also lives there, can use it; the jobs here use it from the server.
export { forEachTenant };

export interface RollupMetrics {
  modelCalls: number;
  modelDenials: number;
  actionsByStatus: Record<string, number>;
  activeGrants: number;
}

export interface TenantJobDeps extends ForEachTenantDeps {
  control: ControlDb;
}

/** The ISO timestamps that bound a UTC day. */
function dayBounds(day: string): { from: string; to: string } {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { from: start.toISOString(), to: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString() };
}

/**
 * Writes one `tenant_rollups` row per active tenant for the UTC `day`, upserted on (tenant_id, day) so a rerun replaces it. Counts only:
 * model calls and denials decided that day, actions created that day by their current status, and grants active now.
 */
export async function writeRollups(deps: TenantJobDeps, day: string): Promise<ForEachTenantResult> {
  const { from, to } = dayBounds(day);
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const upsert = deps.control.prepare(
    `INSERT INTO tenant_rollups (tenant_id, day, metrics_json) VALUES (?, ?, ?)
     ON CONFLICT (tenant_id, day) DO UPDATE SET metrics_json = excluded.metrics_json`,
  );
  return forEachTenant(deps, async (db, _deadline, registration) => {
    const raw = rawDb(db);
    const calls = raw
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(decision = 'deny'), 0) AS denials
         FROM model_call_decisions WHERE tenant_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(db.tenantId, from, to) as { calls: number; denials: number };
    const byStatus = raw
      .prepare("SELECT status, COUNT(*) AS n FROM action_instances WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY status")
      .all(db.tenantId, from, to) as Array<{ status: string; n: number }>;
    const grants = deps.control
      .prepare("SELECT COUNT(*) AS n FROM delegation_grants WHERE tenant_registration_id = ? AND status = 'active' AND absolute_expires_at > ? AND (idle_expires_at IS NULL OR idle_expires_at > ?)")
      .get(registration.id, nowIso, nowIso) as { n: number };
    const metrics: RollupMetrics = {
      modelCalls: calls.calls,
      modelDenials: calls.denials,
      actionsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
      activeGrants: grants.n,
    };
    upsert.run(registration.tenantId, day, JSON.stringify(metrics));
  });
}

/** Each tenant's most recent rollup. Reads the control database only. */
export function latestRollups(control: ControlDb): Array<{ tenantId: string; day: string; metrics: RollupMetrics }> {
  const rows = control
    .prepare(
      `SELECT r.tenant_id, r.day, r.metrics_json FROM tenant_rollups r
       WHERE r.day = (SELECT MAX(day) FROM tenant_rollups WHERE tenant_id = r.tenant_id) ORDER BY r.tenant_id`,
    )
    .all() as Array<{ tenant_id: string; day: string; metrics_json: string }>;
  return rows.map((r) => ({ tenantId: r.tenant_id, day: r.day, metrics: JSON.parse(r.metrics_json) as RollupMetrics }));
}

export interface DanglingGrant {
  grantId: string;
  actionId: string;
  tenantId: string;
}

/**
 * Finds active action grants whose action no longer exists in the tenant file. Each is logged at error with `alert: "link_check"` (the
 * operator alert; there is no other channel yet). Grants are never deleted here. A tenant that is refused or fails is logged the same way,
 * and a failure throws after every tenant was tried, so the nightly job retries instead of marking the day done.
 */
export async function checkLinks(deps: TenantJobDeps & { logger: Logger }): Promise<DanglingGrant[]> {
  const grants = deps.control.prepare(
    "SELECT id, action_id FROM delegation_grants WHERE tenant_registration_id = ? AND kind = 'action' AND status = 'active' AND action_id IS NOT NULL",
  );
  const dangling: DanglingGrant[] = [];
  const result = await forEachTenant(deps, async (db, _deadline, registration) => {
    const exists = rawDb(db).prepare("SELECT 1 FROM action_instances WHERE id = ? AND tenant_id = ?");
    for (const grant of grants.all(registration.id) as Array<{ id: string; action_id: string }>) {
      if (exists.get(grant.action_id, db.tenantId) !== undefined) continue;
      const found = { grantId: grant.id, actionId: grant.action_id, tenantId: registration.tenantId };
      dangling.push(found);
      deps.logger.error("action grant points at an action that no longer exists", { alert: "link_check", ...found });
    }
  });
  for (const { registrationId, code } of result.refused) {
    deps.logger.error("link check could not open a tenant", { alert: "link_check", registrationId, code });
  }
  for (const registrationId of result.failed) {
    deps.logger.error("link check failed for a tenant", { alert: "link_check", registrationId, error: result.errors[registrationId] });
  }
  if (result.failed.length > 0) throw new Error(`link check failed for ${result.failed.length} tenant(s)`);
  return dangling;
}
