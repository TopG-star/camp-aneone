import type { Logger } from "@oneon/domain";
import type { TenantAiLimitRepository } from "@oneon/infrastructure";

/** The ImpressoRx permission code (raw, as the snapshot carries it) that lets a person manage Oneon for their pharmacy. */
export const MANAGE_ONEON = "settings.oneon";

/**
 * Spec 9.4 (owner decision 2026-10-14): a lowering of a pharmacy's AI limit authorised from the cached snapshot, while ImpressoRx was
 * unreachable, is checked again the next time ImpressoRx delivers a snapshot for that membership (a live check, a refresh, a new hand-off
 * or a token exchange: every snapshot goes through the client's onSnapshot). If the person no longer has settings.oneon, an operator alert
 * is logged at error level; the lowered limit stays. Called after the snapshot is applied. It never throws, so a failure here cannot fail
 * the ImpressoRx call that brought the snapshot; a re-check that could not be recorded stays pending for the next snapshot.
 */
export function createAiLimitRecheck(deps: { limits: Pick<TenantAiLimitRepository, "resolveRechecks">; logger: Logger }) {
  return (membershipId: string, permissions: string[]): void => {
    try {
      const stillPermitted = permissions.includes(MANAGE_ONEON);
      for (const r of deps.limits.resolveRechecks(membershipId, stillPermitted)) {
        const fields = { membershipId, registrationId: r.registrationId, versionId: r.versionId, maxClass: r.maxClass };
        if (stillPermitted) deps.logger.info("AI limit lowering from the cached snapshot confirmed by ImpressoRx", fields);
        else deps.logger.error("AI limit was lowered from the cached snapshot by someone ImpressoRx no longer lets manage Oneon", { alert: "ai_limit_lowered_without_permission", ...fields });
      }
    } catch (error) {
      deps.logger.error("AI limit re-check could not be made; it stays pending", { membershipId, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
