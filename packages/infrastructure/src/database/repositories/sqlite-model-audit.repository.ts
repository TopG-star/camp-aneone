import type Database from "better-sqlite3";
import type { ModelAuditRepository, ModelDecisionRecord, ModelOutcomeRecord } from "@oneon/application";

type Row = {
  id: string;
  call_id: string;
  created_at: string;
  context_kind: "personal" | "tenant";
  identity_id: string;
  tenant_id: string | null;
  membership_id: string | null;
  purpose: string;
  channel: string | null;
  provider: string;
  model: string | null;
  effective_limit: ModelDecisionRecord["effectiveLimit"];
  layers_json: string;
  decision: "allow" | "deny";
  deny_reason: ModelDecisionRecord["denyReason"];
  released_json: string;
  withheld_json: string;
  placeholder_count: number;
  scanner_d3: number;
  scanner_d4: number;
  alert: number;
  policy_fingerprint: string;
  input_fingerprint: string | null;
  key_version: number;
  o_created_at: string | null;
  status: ModelOutcomeRecord["status"] | null;
  block_reason: string | null;
  attempts: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  checks_json: string;
  output_fingerprint: string | null;
  o_key_version: number;
};

function mapDecision(r: Row): ModelDecisionRecord {
  return {
    id: r.id,
    callId: r.call_id,
    createdAt: r.created_at,
    contextKind: r.context_kind,
    identityId: r.identity_id,
    tenantId: r.tenant_id,
    membershipId: r.membership_id,
    purpose: r.purpose,
    channel: r.channel,
    provider: r.provider,
    model: r.model,
    effectiveLimit: r.effective_limit,
    layers: JSON.parse(r.layers_json),
    decision: r.decision,
    denyReason: r.deny_reason,
    released: JSON.parse(r.released_json),
    withheld: JSON.parse(r.withheld_json),
    placeholderCount: r.placeholder_count,
    scannerHits: { D3: r.scanner_d3, D4: r.scanner_d4 },
    alert: r.alert === 1,
    policyFingerprint: r.policy_fingerprint,
    inputFingerprint: r.input_fingerprint,
    keyVersion: r.key_version,
  };
}

function mapOutcome(r: Row): ModelOutcomeRecord | null {
  if (r.status === null) return null;
  return {
    callId: r.call_id,
    createdAt: r.o_created_at as string,
    status: r.status,
    blockReason: r.block_reason,
    attempts: r.attempts,
    latencyMs: r.latency_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    checks: JSON.parse(r.checks_json),
    outputFingerprint: r.output_fingerprint,
    keyVersion: r.o_key_version,
  };
}

export class SqliteModelAuditRepository implements ModelAuditRepository {
  constructor(private readonly db: Database.Database) {}

  recordDecision(r: ModelDecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_call_decisions (id, call_id, created_at, context_kind, identity_id, tenant_id, membership_id, purpose, channel, provider, model,
           effective_limit, layers_json, decision, deny_reason, released_json, withheld_json, placeholder_count, scanner_d3, scanner_d4, alert,
           policy_fingerprint, input_fingerprint, key_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id, r.callId, r.createdAt, r.contextKind, r.identityId, r.tenantId, r.membershipId, r.purpose, r.channel, r.provider, r.model,
        r.effectiveLimit, JSON.stringify(r.layers), r.decision, r.denyReason, JSON.stringify(r.released), JSON.stringify(r.withheld),
        r.placeholderCount, r.scannerHits.D3, r.scannerHits.D4, r.alert ? 1 : 0, r.policyFingerprint, r.inputFingerprint, r.keyVersion,
      );
  }

  recordOutcome(r: ModelOutcomeRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_call_outcomes (call_id, created_at, status, block_reason, attempts, latency_ms, input_tokens, output_tokens, checks_json,
           output_fingerprint, key_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.callId, r.createdAt, r.status, r.blockReason, r.attempts, r.latencyMs, r.inputTokens, r.outputTokens, JSON.stringify(r.checks), r.outputFingerprint, r.keyVersion);
  }

  listRecentForIdentity(identityId: string, limit: number): Array<{ decision: ModelDecisionRecord; outcome: ModelOutcomeRecord | null }> {
    const rows = this.db
      .prepare(
        `SELECT d.*, o.created_at AS o_created_at, o.status, o.block_reason, o.attempts, o.latency_ms, o.input_tokens, o.output_tokens,
                o.checks_json, o.output_fingerprint, o.key_version AS o_key_version
         FROM model_call_decisions d LEFT JOIN model_call_outcomes o ON o.call_id = d.call_id
         WHERE d.identity_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
      )
      .all(identityId, limit) as Row[];
    return rows.map((r) => ({ decision: mapDecision(r), outcome: mapOutcome(r) }));
  }
}
