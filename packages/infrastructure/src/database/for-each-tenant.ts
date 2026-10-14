import type { Logger, TenantDb } from "@oneon/domain";
import { TenantRefusedError, type TenantLease } from "./context-db-gate.js";
import type { TenantRegistration } from "./control/tenant-registration-repository.js";

export const DEFAULT_JOB_BUDGET_MS = 2000;

export interface ForEachTenantDeps {
  /** The gate (or anything that leases a tenant file by registration id). */
  gate: { lease(registrationId: string): TenantLease };
  registrations: { listActive(): TenantRegistration[] };
  /**
   * Backups only: visit these registrations (active and suspended ones) instead of the active ones, each opened with this lease (the
   * gate's maintenance lease), never a request path's.
   */
  maintenance?: { list(): TenantRegistration[]; lease(registrationId: string): TenantLease };
  logger?: Logger;
  now?: () => number;
}

export interface ForEachTenantResult {
  /** Registrations whose function ran to the end. */
  visited: string[];
  /** Registrations that failed to open (other than a refusal) or whose function threw. */
  failed: string[];
  /** The error message of each failed registration. */
  errors: Record<string, string>;
  /** Registrations the gate refused to open with a typed refusal. */
  refused: Array<{ registrationId: string; code: TenantRefusedError["code"] }>;
}

/**
 * Runs `fn` for every active tenant (or, with `maintenance`, every tenant it lists), in order, with one file leased at a time (released in `finally`). The budget is cooperative:
 * `fn` gets `deadline = now + budgetMs` and is never aborted; an overrun is logged at warn. A tenant that throws is recorded and the
 * loop goes on; a tenant the gate refuses is recorded as refused, not failed.
 */
export async function forEachTenant(
  deps: ForEachTenantDeps,
  fn: (db: TenantDb, deadline: number, registration: TenantRegistration) => Promise<void>,
  opts: { budgetMs?: number } = {},
): Promise<ForEachTenantResult> {
  const now = deps.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? DEFAULT_JOB_BUDGET_MS;
  const result: ForEachTenantResult = { visited: [], failed: [], errors: {}, refused: [] };
  const list = deps.maintenance ? deps.maintenance.list() : deps.registrations.listActive();
  const open = deps.maintenance ? (id: string) => deps.maintenance!.lease(id) : (id: string) => deps.gate.lease(id);
  for (const registration of list) {
    let lease: TenantLease;
    try {
      lease = open(registration.id);
    } catch (error) {
      if (error instanceof TenantRefusedError) {
        result.refused.push({ registrationId: registration.id, code: error.code });
      } else {
        recordFailure(result, registration.id, error);
      }
      continue;
    }
    try {
      const deadline = now() + budgetMs;
      await fn(lease.db, deadline, registration);
      result.visited.push(registration.id);
      if (now() > deadline) deps.logger?.warn("tenant job overran its budget", { registrationId: registration.id, budgetMs });
    } catch (error) {
      recordFailure(result, registration.id, error);
    } finally {
      lease.release();
    }
  }
  return result;
}

function recordFailure(result: ForEachTenantResult, registrationId: string, error: unknown): void {
  result.failed.push(registrationId);
  result.errors[registrationId] = error instanceof Error ? error.message : String(error);
}
