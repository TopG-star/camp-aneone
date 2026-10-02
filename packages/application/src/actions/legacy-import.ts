import { personalActor, type LegacyActionRepository, type LegacyActionRow, type Logger } from "@oneon/domain";
import type { ActionRequest, RequestOutcome } from "./orchestrator/types.js";

type Payload = Record<string, unknown>;

/**
 * Spec §8.6. Legacy proposals that can be validated for real are imported. `notify` is
 * deliberately absent: the pipeline already sent those notifications at the time.
 */
const LEGACY_RULES: Record<string, { initiator: string; build(row: LegacyActionRow, p: Payload): Record<string, unknown> | null }> = {
  create_reminder: {
    initiator: "rule:inbox.deadline_reminder",
    build: (row, p) => (typeof p.inboundItemId === "string" ? { deadlineId: row.resourceId, inboundItemId: p.inboundItemId } : null),
  },
  archive: {
    initiator: "rule:inbox.spam_archive",
    build: (row, p) => ({ inboundItemId: row.resourceId, reason: String(p.reason ?? "spam_classification") }),
  },
  label: {
    initiator: "rule:inbox.newsletter_label",
    build: (row, p) => ({ inboundItemId: row.resourceId, label: String(p.label ?? "newsletter"), reason: String(p.reason ?? "newsletter_low_priority") }),
  },
  draft_reply: {
    initiator: "rule:inbox.follow_up_draft",
    build: (row, p) => ({ inboundItemId: row.resourceId, reason: String(p.reason ?? "follow_up_needed"), summary: String(p.summary ?? ""), from: String(p.from ?? "") }),
  },
};

function parsePayload(json: string): Payload {
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};
  } catch {
    return {};
  }
}

export async function importLegacyProposals(deps: {
  legacyRepo: LegacyActionRepository;
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  userIds: string[];
  logger: Logger;
}): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  for (const userId of deps.userIds) {
    for (const row of deps.legacyRepo.listUnimportedProposed(userId)) {
      const rule = LEGACY_RULES[row.actionType];
      const payload = parsePayload(row.payloadJson);
      const input = rule?.build(row, payload) ?? null;
      if (!rule || !input) {
        skipped++;
        continue;
      }
      const outcome = await deps.requestAction({
        type: row.actionType,
        input,
        actor: personalActor(userId),
        initiator: rule.initiator,
        keyContext: { source: "rule", resourceId: row.resourceId },
        evidence: [{ kind: "legacy_action", source: "action_log_legacy", asOf: row.createdAt, data: { legacyId: row.id, createdAt: row.createdAt, payload } }],
        resourceRef: row.actionType === "create_reminder" ? `deadline:${row.resourceId}` : `inbound_item:${row.resourceId}`,
      });
      if (outcome.kind === "refused") {
        deps.logger.warn("Legacy proposal not imported", { legacyId: row.id, reason: outcome.reason, issues: outcome.issues });
        skipped++;
        continue;
      }
      deps.legacyRepo.recordImport(row.id, outcome.instance.id);
      imported++;
    }
  }
  deps.logger.info("Legacy action import finished", { imported, skipped });
  return { imported, skipped };
}
