import type { AiDataChoice, AiDataChoiceRepository, ModelAuditRepository, ModelDecisionRecord, ModelOutcomeRecord } from "../audit.js";
import type { ProviderId } from "../types.js";

export class InMemoryModelAudit implements ModelAuditRepository {
  readonly decisions: ModelDecisionRecord[] = [];
  readonly outcomes: ModelOutcomeRecord[] = [];
  recordDecision(r: ModelDecisionRecord) {
    this.decisions.push(r);
  }
  recordOutcome(r: ModelOutcomeRecord) {
    this.outcomes.push(r);
  }
  listRecentForIdentity(identityId: string, limit: number) {
    return this.decisions
      .filter((d) => d.identityId === identityId)
      .reverse()
      .slice(0, limit)
      .map((decision) => ({ decision, outcome: this.outcomes.find((o) => o.callId === decision.callId) ?? null }));
  }
}

export class InMemoryChoices implements AiDataChoiceRepository {
  readonly rows: AiDataChoice[] = [];
  current(identityId: string, provider: ProviderId) {
    return [...this.rows].reverse().find((r) => r.identityId === identityId && r.provider === provider) ?? null;
  }
  record(c: Omit<AiDataChoice, "id">) {
    const row = { ...c, id: `choice-${this.rows.length + 1}` };
    this.rows.push(row);
    return row;
  }
  history(identityId: string) {
    return this.rows.filter((r) => r.identityId === identityId);
  }
}
