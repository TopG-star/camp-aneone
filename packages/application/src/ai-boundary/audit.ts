import type { CheckLog } from "./answer-check.js";
import type { ReleasedShapeEntry } from "./assemble.js";
import type { DenyReason, LayerSnapshot, WithheldItem } from "./decide.js";
import type { DataClass, ProviderId } from "./types.js";

export type { ProviderId } from "./types.js";

export interface ModelDecisionRecord {
  id: string;
  callId: string;
  createdAt: string;
  contextKind: "personal" | "tenant";
  identityId: string;
  tenantId: string | null;
  membershipId: string | null;
  purpose: string;
  channel: string | null;
  provider: string;
  model: string | null;
  effectiveLimit: DataClass | null;
  layers: LayerSnapshot;
  decision: "allow" | "deny";
  denyReason: DenyReason | null;
  released: ReleasedShapeEntry[];
  withheld: WithheldItem[];
  placeholderCount: number;
  scannerHits: { D3: number; D4: number };
  alert: boolean;
  policyFingerprint: string;
  inputFingerprint: string | null;
  keyVersion: number;
}

export interface ModelOutcomeRecord {
  callId: string;
  createdAt: string;
  status: "answered" | "blocked" | "failed";
  blockReason: string | null;
  attempts: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  checks: CheckLog;
  outputFingerprint: string | null;
  keyVersion: number;
}

export interface ModelAuditRepository {
  recordDecision(r: ModelDecisionRecord): void;
  recordOutcome(r: ModelOutcomeRecord): void;
  listRecentForIdentity(identityId: string, limit: number): Array<{ decision: ModelDecisionRecord; outcome: ModelOutcomeRecord | null }>;
}

export interface AiDataChoice {
  id: string;
  identityId: string;
  provider: ProviderId;
  maxClass: "D1" | "D2";
  decidedOn: string | null;
  note: string | null;
  confirmedAt: string;
}

export interface AiDataChoiceRepository {
  current(identityId: string, provider: ProviderId): AiDataChoice | null;
  record(c: Omit<AiDataChoice, "id">): AiDataChoice;
  history(identityId: string): AiDataChoice[];
}
