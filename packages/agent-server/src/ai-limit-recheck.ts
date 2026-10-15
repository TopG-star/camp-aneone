import type { Logger } from "@oneon/domain";
import type { TenantAiLimitRepository } from "@oneon/infrastructure";
import { DailyJob } from "./background-loop.js";

/** The ImpressoRx permission code (raw, as the snapshot carries it) that lets a person manage Oneon for their pharmacy. */
export const MANAGE_ONEON = "settings.oneon";

/** A lowering from the cached snapshot still pending after this long is reported by the daily pass (spec 9.4). */
export const RECHECK_OVERDUE_MS = 24 * 60 * 60 * 1000;

/**
 * Spec 9.4 (owner decisions 2026-10-14 and 2026-10-15): a lowering of a pharmacy's AI limit authorised from the cached snapshot, while
 * ImpressoRx was unreachable, is resolved once, by the first of:
 * - a snapshot ImpressoRx delivers for that membership (`afterSnapshot`, wired to the client's onSnapshot after the snapshot is applied):
 *   confirmed only if it lists settings.oneon and leaves the membership active; a snapshot that leads to suspension is a loss;
 * - the membership's access ending here (`accessEnded`, wired to the client's onAccessRevoked): a remote 401 that suspends or revokes
 *   the membership (its grants are revoked on that path) or a local revoke. Always a loss.
 * A loss is logged at error level with alert ai_limit_lowered_without_permission; the lowered limit stays. Nothing here throws, so a
 * failure cannot fail the ImpressoRx call or the revoke that triggered it; a re-check that could not be recorded stays pending.
 */
export function createAiLimitRecheck(deps: { limits: Pick<TenantAiLimitRepository, "resolveRechecks">; logger: Logger }) {
  const resolve = (membershipId: string, stillPermitted: boolean, trigger: string): void => {
    try {
      for (const r of deps.limits.resolveRechecks(membershipId, stillPermitted)) {
        const fields = { membershipId, registrationId: r.registrationId, versionId: r.versionId, maxClass: r.maxClass, trigger };
        if (stillPermitted) deps.logger.info("AI limit lowering from the cached snapshot confirmed by ImpressoRx", fields);
        else deps.logger.error("AI limit was lowered from the cached snapshot by someone ImpressoRx no longer lets manage Oneon", { alert: "ai_limit_lowered_without_permission", ...fields });
      }
    } catch (error) {
      deps.logger.error("AI limit re-check could not be made; it stays pending", { membershipId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return {
    afterSnapshot(membershipId: string, permissions: string[], membershipActive: boolean): void {
      resolve(membershipId, membershipActive && permissions.includes(MANAGE_ONEON), membershipActive ? "snapshot" : "snapshot_suspended");
    },
    accessEnded(membershipId: string, reason: string): void {
      resolve(membershipId, false, reason);
    },
  };
}

/**
 * The daily pass (spec 9.4, owner decision 2026-10-15): an alert, at error level with alert ai_limit_recheck_overdue, for every lowering
 * from the cached snapshot still pending more than 24 h after it was made. It resolves nothing, so it alerts again each day until a
 * re-check does. Answers how many it alerted on.
 */
export function alertOverdueRechecks(deps: { limits: Pick<TenantAiLimitRepository, "overdueRechecks">; logger: Logger; now: Date }): number {
  const overdue = deps.limits.overdueRechecks(new Date(deps.now.getTime() - RECHECK_OVERDUE_MS));
  for (const r of overdue) {
    deps.logger.error("AI limit lowering from the cached snapshot is still not re-checked after 24 h", {
      alert: "ai_limit_recheck_overdue",
      membershipId: r.membershipId,
      registrationId: r.registrationId,
      versionId: r.versionId,
      maxClass: r.maxClass,
      pendingSince: r.createdAt,
    });
  }
  return overdue.length;
}

export function overdueRecheckJob(limits: Pick<TenantAiLimitRepository, "overdueRechecks">, logger: Logger, now?: () => Date): DailyJob {
  return new DailyJob({ name: "AI limit re-check overdue", run: async (at) => void alertOverdueRechecks({ limits, logger, now: at }), logger, now });
}
