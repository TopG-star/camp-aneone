import type { LifecycleStatus } from "./lifecycle.js";

export const RISK_TIERS = ["L0", "L1", "L2", "L3", "L4"] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export function maxRisk(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_TIERS.indexOf(a) >= RISK_TIERS.indexOf(b) ? a : b;
}

export type ActionScope = "personal" | "tenant";

export type JsonObject = Record<string, unknown>;

/** Who is acting, built only by the server from the session (spec §4.2 R5). */
export interface ActorContext {
  userId: string;
  scope: ActionScope;
  tenantId: string | null;
  roles: string[];
  permissions: string[];
  locationIds: string[];
}

export function personalActor(userId: string): ActorContext {
  return { userId, scope: "personal", tenantId: null, roles: ["owner"], permissions: [], locationIds: [] };
}

/** What a current membership gives an actor (structurally the control database's Membership). */
export interface MembershipLike {
  role: string;
  permissions: string[];
  locationIds: string[];
}

/** A staff member acting in one pharmacy. Permissions are namespaced so they cannot collide with Oneon's own. */
export function tenantActor(m: { identityId: string; tenantId: string; role: string; permissions: string[]; locationIds: string[] }): ActorContext {
  return {
    userId: m.identityId,
    scope: "tenant",
    tenantId: m.tenantId,
    roles: [m.role],
    permissions: m.permissions.map((p) => "impressorx:" + p),
    locationIds: m.locationIds,
  };
}

/** Recorded on every event. */
export interface ActorRef {
  kind: "user" | "policy" | "system" | "sweeper";
  userId?: string;
}

export interface EvidenceItem {
  kind: string;
  source: string;
  asOf: string;
  data: JsonObject;
}

export interface CheckResult {
  id: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
}

export type ActionErrorStage = "validation" | "recheck" | "execution" | "verification" | "undo";

export interface ActionError {
  code: string;
  message: string;
  stage: ActionErrorStage;
}

export interface ActionInstance {
  id: string;
  scope: ActionScope;
  ownerId: string;
  userId: string;
  tenantId: string | null;
  locationIds: string[];
  actionType: string;
  definitionVersion: string;
  status: LifecycleStatus;
  initiator: string;
  initiatorUserId: string | null;
  input: JsonObject;
  resolved: JsonObject | null;
  evidence: EvidenceItem[];
  decision: JsonObject | null;
  result: JsonObject | null;
  error: ActionError | null;
  undo: JsonObject | null;
  idempotencyKey: string;
  retryOf: string | null;
  attemptNumber: number;
  executorRequestId: string | null;
  executionStartedAt: string | null;
  lastHeartbeatAt: string | null;
  undoStartedAt: string | null;
  resourceRef: string | null;
  /** The model call that proposed this action (model_call_decisions.call_id in the same file), or null when it was created any other way. */
  modelCallId: string | null;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActionEvent {
  id: string;
  actionId: string;
  seq: number;
  fromStatus: LifecycleStatus | null;
  toStatus: LifecycleStatus;
  actor: ActorRef;
  data: JsonObject;
  createdAt: string;
}
