import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  assertRowTenant,
  ActionNotFoundError,
  LifecycleTransitionError,
  TransitionConflictError,
  isAllowedTransition,
  type ActionEvent,
  type ActionInstance,
  type ActionInstanceRepository,
  type ActorRef,
  type ContextDb,
  type CreateInstanceResult,
  type InstanceListFilter,
  type InstancePatch,
  type JsonObject,
  type LifecycleStatus,
  type NewActionInstance,
  type NoteRequest,
  type TransitionRequest,
} from "@oneon/domain";
import { rawDb } from "../context-db-gate.js";

interface InstanceRow {
  id: string;
  scope: "personal" | "tenant";
  owner_id: string;
  user_id: string;
  tenant_id: string | null;
  location_ids_json: string;
  action_type: string;
  definition_version: string;
  status: LifecycleStatus;
  initiator: string;
  initiator_user_id: string | null;
  input_json: string;
  resolved_json: string | null;
  evidence_json: string;
  decision_json: string | null;
  result_json: string | null;
  error_json: string | null;
  undo_json: string | null;
  idempotency_key: string;
  retry_of: string | null;
  attempt_number: number;
  executor_request_id: string | null;
  execution_started_at: string | null;
  last_heartbeat_at: string | null;
  undo_started_at: string | null;
  resource_ref: string | null;
  last_event_seq: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  tenant_id: string | null;
  action_id: string;
  seq: number;
  from_status: LifecycleStatus | null;
  to_status: LifecycleStatus;
  actor_json: string;
  data_json: string;
  created_at: string;
}

const PATCH_COLUMNS: Record<keyof InstancePatch, { column: string; json: boolean }> = {
  resolved: { column: "resolved_json", json: true },
  decision: { column: "decision_json", json: true },
  result: { column: "result_json", json: true },
  error: { column: "error_json", json: true },
  undo: { column: "undo_json", json: true },
  executorRequestId: { column: "executor_request_id", json: false },
  executionStartedAt: { column: "execution_started_at", json: false },
};

const parse = <T>(json: string | null): T | null => (json === null ? null : (JSON.parse(json) as T));

function mapInstance(r: InstanceRow): ActionInstance {
  return {
    id: r.id,
    scope: r.scope,
    ownerId: r.owner_id,
    userId: r.user_id,
    tenantId: r.tenant_id,
    locationIds: JSON.parse(r.location_ids_json) as string[],
    actionType: r.action_type,
    definitionVersion: r.definition_version,
    status: r.status,
    initiator: r.initiator,
    initiatorUserId: r.initiator_user_id,
    input: JSON.parse(r.input_json) as JsonObject,
    resolved: parse(r.resolved_json),
    evidence: JSON.parse(r.evidence_json),
    decision: parse(r.decision_json),
    result: parse(r.result_json),
    error: parse(r.error_json),
    undo: parse(r.undo_json),
    idempotencyKey: r.idempotency_key,
    retryOf: r.retry_of,
    attemptNumber: r.attempt_number,
    executorRequestId: r.executor_request_id,
    executionStartedAt: r.execution_started_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    undoStartedAt: r.undo_started_at,
    resourceRef: r.resource_ref,
    lastEventSeq: r.last_event_seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapEvent(r: EventRow): ActionEvent {
  return {
    id: r.id,
    actionId: r.action_id,
    seq: r.seq,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actor: JSON.parse(r.actor_json) as ActorRef,
    data: JSON.parse(r.data_json) as JsonObject,
    createdAt: r.created_at,
  };
}

export class SqliteActionInstanceRepository implements ActionInstanceRepository {
  private readonly db: Database.Database;

  constructor(
    private readonly context: ContextDb,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = rawDb(context);
  }

  private tenantId(): string | null {
    return this.context.kind === "tenant" ? this.context.tenantId : null;
  }

  private instance(row: InstanceRow): ActionInstance {
    assertRowTenant(this.context, row.tenant_id, "action_instances");
    return mapInstance(row);
  }

  private event(row: EventRow): ActionEvent {
    assertRowTenant(this.context, row.tenant_id, "action_events");
    return mapEvent(row);
  }

  create(instance: NewActionInstance, actor: ActorRef, data: JsonObject = {}): CreateInstanceResult {
    return this.db.transaction((): CreateInstanceResult => {
      const existing = this.db
        .prepare(
          "SELECT * FROM action_instances WHERE scope = ? AND owner_id = ? AND action_type = ? AND idempotency_key = ?",
        )
        .get(instance.scope, instance.ownerId, instance.actionType, instance.idempotencyKey) as InstanceRow | undefined;
      if (existing) return { instance: this.instance(existing), created: false };

      const now = this.clock().toISOString();
      this.db
        .prepare(
          `INSERT INTO action_instances (
             id, scope, owner_id, user_id, tenant_id, location_ids_json, action_type, definition_version,
             status, initiator, initiator_user_id, input_json, evidence_json, idempotency_key,
             retry_of, attempt_number, resource_ref, last_event_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          instance.id,
          instance.scope,
          instance.ownerId,
          instance.userId,
          this.tenantId(),
          JSON.stringify(instance.locationIds),
          instance.actionType,
          instance.definitionVersion,
          instance.initiator,
          instance.initiatorUserId,
          JSON.stringify(instance.input),
          JSON.stringify(instance.evidence),
          instance.idempotencyKey,
          instance.retryOf,
          instance.attemptNumber,
          instance.resourceRef,
          now,
          now,
        );
      this.insertEvent(instance.id, 1, null, "proposed", actor, data, now);
      return { instance: this.mustFind(instance.id), created: true };
    })();
  }

  findById(ownerId: string, id: string): ActionInstance | null {
    const row = this.db
      .prepare("SELECT * FROM action_instances WHERE id = ? AND owner_id = ?")
      .get(id, ownerId) as InstanceRow | undefined;
    return row ? this.instance(row) : null;
  }

  list(ownerId: string, filter: InstanceListFilter = {}): ActionInstance[] {
    const { where, params } = this.where(ownerId, filter);
    const rows = this.db
      .prepare(`SELECT * FROM action_instances WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as InstanceRow[];
    return rows.map((r) => this.instance(r));
  }

  count(ownerId: string, filter: Omit<InstanceListFilter, "limit" | "offset"> = {}): number {
    const { where, params } = this.where(ownerId, filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM action_instances WHERE ${where}`).get(...params) as {
      n: number;
    };
    return row.n;
  }

  listEvents(ownerId: string, actionId: string): ActionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM action_events e
         JOIN action_instances i ON i.id = e.action_id
         WHERE i.owner_id = ? AND e.action_id = ?
         ORDER BY e.seq`,
      )
      .all(ownerId, actionId) as EventRow[];
    return rows.map((r) => this.event(r));
  }

  appendTransition(request: TransitionRequest): ActionInstance {
    return this.db.transaction((): ActionInstance => {
      const row = this.db.prepare("SELECT * FROM action_instances WHERE id = ?").get(request.actionId) as
        | InstanceRow
        | undefined;
      if (!row) throw new ActionNotFoundError(request.actionId);
      assertRowTenant(this.context, row.tenant_id, "action_instances");
      if (row.status !== request.expectedStatus) {
        throw new TransitionConflictError(request.actionId, request.expectedStatus, row.status);
      }
      if (!isAllowedTransition(request.expectedStatus, request.toStatus)) {
        throw new LifecycleTransitionError(request.expectedStatus, request.toStatus);
      }

      const seq = row.last_event_seq + 1;
      const now = this.clock().toISOString();
      this.insertEvent(row.id, seq, row.status, request.toStatus, request.actor, request.data ?? {}, now);

      const sets = ["status = ?", "last_event_seq = ?", "updated_at = ?"];
      const params: unknown[] = [request.toStatus, seq, now];
      for (const [key, spec] of Object.entries(PATCH_COLUMNS) as Array<[keyof InstancePatch, { column: string; json: boolean }]>) {
        if (request.patch && key in request.patch) {
          const value = request.patch[key];
          sets.push(`${spec.column} = ?`);
          params.push(value === null || value === undefined ? null : spec.json ? JSON.stringify(value) : value);
        }
      }
      this.db.prepare(`UPDATE action_instances SET ${sets.join(", ")} WHERE id = ?`).run(...params, row.id);
      return this.mustFind(row.id);
    })();
  }

  recordNote(request: NoteRequest): void {
    this.db.transaction((): void => {
      const row = this.db.prepare("SELECT * FROM action_instances WHERE id = ?").get(request.actionId) as InstanceRow | undefined;
      if (!row) throw new ActionNotFoundError(request.actionId);
      assertRowTenant(this.context, row.tenant_id, "action_instances");
      if (row.status !== request.expectedStatus) throw new TransitionConflictError(request.actionId, request.expectedStatus, row.status);
      const seq = row.last_event_seq + 1;
      this.insertEvent(row.id, seq, row.status, row.status, request.actor, request.data ?? {}, this.clock().toISOString());
      this.db.prepare("UPDATE action_instances SET last_event_seq = ? WHERE id = ?").run(seq, row.id);
    })();
  }

  approvedAt(actionId: string): string | null {
    // The first such event is the approval; later events that leave the status at approved are notes.
    const row = this.db
      .prepare("SELECT tenant_id, created_at FROM action_events WHERE action_id = ? AND to_status = 'approved' ORDER BY seq LIMIT 1")
      .get(actionId) as { tenant_id: string | null; created_at: string } | undefined;
    if (!row) return null;
    assertRowTenant(this.context, row.tenant_id, "action_events");
    return row.created_at;
  }

  recordHeartbeat(actionId: string, at: string): void {
    this.db.prepare("UPDATE action_instances SET last_heartbeat_at = ? WHERE id = ?").run(at, actionId);
  }

  markUndoStarted(actionId: string, at: string): boolean {
    const result = this.db
      .prepare("UPDATE action_instances SET undo_started_at = ? WHERE id = ? AND undo_started_at IS NULL")
      .run(at, actionId);
    return result.changes === 1;
  }

  private where(ownerId: string, filter: Omit<InstanceListFilter, "limit" | "offset">) {
    const clauses = ["owner_id = ?"];
    const params: unknown[] = [ownerId];
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    if (filter.resourceRef) {
      clauses.push("resource_ref = ?");
      params.push(filter.resourceRef);
    }
    return { where: clauses.join(" AND "), params };
  }

  private insertEvent(
    actionId: string,
    seq: number,
    from: LifecycleStatus | null,
    to: LifecycleStatus,
    actor: ActorRef,
    data: JsonObject,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO action_events (id, action_id, seq, from_status, to_status, actor_json, data_json, created_at, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), actionId, seq, from, to, JSON.stringify(actor), JSON.stringify(data), at, this.tenantId());
  }

  private mustFind(id: string): ActionInstance {
    const row = this.db.prepare("SELECT * FROM action_instances WHERE id = ?").get(id) as InstanceRow | undefined;
    if (!row) throw new ActionNotFoundError(id);
    return this.instance(row);
  }
}
