import type { LifecycleStatus } from "./lifecycle.js";
import type {
  ActionError,
  ActionEvent,
  ActionInstance,
  ActionScope,
  ActorRef,
  EvidenceItem,
  JsonObject,
} from "./types.js";

export interface NewActionInstance {
  id: string;
  scope: ActionScope;
  ownerId: string;
  userId: string;
  tenantId: string | null;
  locationIds: string[];
  actionType: string;
  definitionVersion: string;
  initiator: string;
  initiatorUserId: string | null;
  input: JsonObject;
  evidence: EvidenceItem[];
  idempotencyKey: string;
  retryOf: string | null;
  attemptNumber: number;
  resourceRef: string | null;
}

export interface CreateInstanceResult {
  instance: ActionInstance;
  created: boolean;
}

/** Columns a transition may set alongside the status. Absent keys are left unchanged. */
export interface InstancePatch {
  resolved?: JsonObject | null;
  decision?: JsonObject | null;
  result?: JsonObject | null;
  error?: ActionError | null;
  undo?: JsonObject | null;
  executorRequestId?: string | null;
  executionStartedAt?: string | null;
}

export interface TransitionRequest {
  actionId: string;
  expectedStatus: LifecycleStatus;
  toStatus: LifecycleStatus;
  actor: ActorRef;
  data?: JsonObject;
  patch?: InstancePatch;
}

export interface InstanceListFilter {
  statuses?: readonly LifecycleStatus[];
  resourceRef?: string;
  limit?: number;
  offset?: number;
}

/** Every read takes an owner; there is no unscoped read (spec §8.3 invariant 4). */
export interface ActionInstanceRepository {
  /** Inserts the instance as `proposed` with event 1, or returns the existing instance for the same key. */
  create(instance: NewActionInstance, actor: ActorRef, data?: JsonObject): CreateInstanceResult;
  findById(ownerId: string, id: string): ActionInstance | null;
  list(ownerId: string, filter?: InstanceListFilter): ActionInstance[];
  count(ownerId: string, filter?: Omit<InstanceListFilter, "limit" | "offset">): number;
  listEvents(ownerId: string, actionId: string): ActionEvent[];
  /** The only way to change a status (spec §8.3 invariant 2). */
  appendTransition(request: TransitionRequest): ActionInstance;
  recordHeartbeat(actionId: string, at: string): void;
  /** Compare-and-set: records the time only if no undo start is recorded; true when this call set it. */
  markUndoStarted(actionId: string, at: string): boolean;
}

export interface ActionConfigRecord {
  scope: ActionScope;
  ownerId: string;
  actionType: string;
  configJson: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ActionConfigHistoryEntry {
  id: string;
  scope: ActionScope;
  ownerId: string;
  actionType: string;
  oldJson: string | null;
  newJson: string;
  changedBy: string;
  changedAt: string;
}

export interface ActionConfigRepository {
  get(scope: ActionScope, ownerId: string, actionType: string): ActionConfigRecord | null;
  list(scope: ActionScope, ownerId: string): ActionConfigRecord[];
  /** Upserts the config row and appends a history row in one transaction. */
  save(input: {
    scope: ActionScope;
    ownerId: string;
    actionType: string;
    configJson: string;
    changedBy: string;
  }): ActionConfigRecord;
  history(scope: ActionScope, ownerId: string, actionType: string, limit: number): ActionConfigHistoryEntry[];
}

export interface LegacyActionRow {
  id: string;
  userId: string | null;
  resourceId: string;
  actionType: string;
  riskLevel: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyActionRepository {
  /** Rows not imported into the new pipeline, newest first. */
  listForUser(userId: string, options: { limit: number; offset: number }): LegacyActionRow[];
  countForUser(userId: string): number;
  listUnimportedProposed(userId: string): LegacyActionRow[];
  recordImport(legacyId: string, actionId: string): void;
}
