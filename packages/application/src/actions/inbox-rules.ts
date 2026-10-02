import type { Classification, Deadline, EvidenceItem, InboundItem } from "@oneon/domain";
import type { ActionRequest } from "./orchestrator/types.js";

export const URGENT_PRIORITY_THRESHOLD = 2;
export const DEADLINE_CONFIDENCE_THRESHOLD = 0.7;

type RuleRequest = Omit<ActionRequest, "actor">;

/** Spec §9.7 and §9.9: rules propose, the registry and policy decide. */
export function deriveInboxActionRequests(input: {
  classification: Classification;
  item: InboundItem;
  deadlines: Deadline[];
  now: Date;
}): RuleRequest[] {
  const { classification: c, item, deadlines, now } = input;
  const asOf = now.toISOString();
  const classificationEvidence: EvidenceItem = {
    kind: "classification",
    source: "oneon:classifier",
    asOf,
    data: { category: c.category, priority: c.priority, summary: c.summary, model: c.model, promptVersion: c.promptVersion },
  };
  const emailEvidence: EvidenceItem = {
    kind: "email",
    source: item.source,
    asOf,
    data: { from: item.from, subject: item.subject, receivedAt: item.receivedAt },
  };
  const rule = (ruleId: string, condition: string, values: Record<string, unknown>): EvidenceItem => ({
    kind: "rule",
    source: "oneon:inbox-rules",
    asOf,
    data: { ruleId, condition, values },
  });
  const forEmail = (type: string, ruleId: string, condition: string, values: Record<string, unknown>, actionInput: Record<string, unknown>): RuleRequest => ({
    type,
    input: actionInput,
    initiator: `rule:${ruleId}`,
    keyContext: { source: "rule", resourceId: item.id },
    evidence: [rule(ruleId, condition, values), classificationEvidence, emailEvidence],
    resourceRef: `inbound_item:${item.id}`,
  });

  const requests: RuleRequest[] = [];

  if (c.priority <= URGENT_PRIORITY_THRESHOLD) {
    requests.push(
      forEmail("notify", "inbox.urgent_notify", `priority <= ${URGENT_PRIORITY_THRESHOLD}`, { priority: c.priority }, {
        inboundItemId: item.id,
        title: `Urgent: ${item.subject}`,
        body: c.summary,
        deepLink: `/items/${item.id}`,
      }),
    );
  }

  for (const d of deadlines) {
    if (d.confidence < DEADLINE_CONFIDENCE_THRESHOLD) continue;
    requests.push({
      type: "create_reminder",
      input: { deadlineId: d.id, inboundItemId: item.id },
      initiator: "rule:inbox.deadline_reminder",
      keyContext: { source: "rule", resourceId: d.id },
      evidence: [
        rule("inbox.deadline_reminder", `confidence >= ${DEADLINE_CONFIDENCE_THRESHOLD}`, { confidence: d.confidence }),
        { kind: "deadline", source: "oneon:classifier", asOf, data: { description: d.description, dueDate: d.dueDate, confidence: d.confidence, model: c.model } },
        emailEvidence,
      ],
      resourceRef: `deadline:${d.id}`,
    });
  }

  if (c.followUpNeeded) {
    requests.push(forEmail("draft_reply", "inbox.follow_up_draft", "followUpNeeded", { followUpNeeded: true }, {
      inboundItemId: item.id, reason: "follow_up_needed", summary: c.summary, from: item.from,
    }));
  }
  if (c.category === "spam") {
    requests.push(forEmail("archive", "inbox.spam_archive", "category = spam", { category: c.category }, {
      inboundItemId: item.id, reason: "spam_classification",
    }));
  }
  if (c.category === "newsletter" && c.priority >= 4) {
    requests.push(forEmail("label", "inbox.newsletter_label", "category = newsletter and priority >= 4", { category: c.category, priority: c.priority }, {
      inboundItemId: item.id, label: "newsletter", reason: "newsletter_low_priority",
    }));
  }
  return requests;
}
