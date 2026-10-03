import {
  ActionNotFoundError,
  LifecycleTransitionError,
  TransitionConflictError,
  isAllowedTransition,
  type ActionConfigHistoryEntry,
  type ActionConfigRecord,
  type ActionConfigRepository,
  type ActionEvent,
  type ActionInstance,
  type ActionInstanceRepository,
  type ActionScope,
  type ActorRef,
  type CreateInstanceResult,
  type InstanceListFilter,
  type JsonObject,
  type NewActionInstance,
  type TransitionRequest,
} from "@oneon/domain";

const clone = <T>(v: T): T => structuredClone(v);

/** Same contract as SqliteActionInstanceRepository, in memory. */
export class InMemoryActionRepo implements ActionInstanceRepository {
  readonly instances = new Map<string, ActionInstance>();
  readonly events: ActionEvent[] = [];

  constructor(private readonly clock: () => Date) {}

  create(n: NewActionInstance, actor: ActorRef, data: JsonObject = {}): CreateInstanceResult {
    const existing = [...this.instances.values()].find(
      (i) => i.scope === n.scope && i.ownerId === n.ownerId && i.actionType === n.actionType && i.idempotencyKey === n.idempotencyKey,
    );
    if (existing) return { instance: clone(existing), created: false };
    const now = this.clock().toISOString();
    const instance: ActionInstance = {
      ...clone(n),
      status: "proposed",
      resolved: null,
      decision: null,
      result: null,
      error: null,
      undo: null,
      executorRequestId: null,
      executionStartedAt: null,
      lastHeartbeatAt: null,
      undoStartedAt: null,
      lastEventSeq: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(n.id, instance);
    this.events.push({ id: `e${this.events.length + 1}`, actionId: n.id, seq: 1, fromStatus: null, toStatus: "proposed", actor, data, createdAt: now });
    return { instance: clone(instance), created: true };
  }

  findById(ownerId: string, id: string): ActionInstance | null {
    const i = this.instances.get(id);
    return i && i.ownerId === ownerId ? clone(i) : null;
  }

  list(ownerId: string, filter: InstanceListFilter = {}): ActionInstance[] {
    return [...this.instances.values()]
      .filter((i) => i.ownerId === ownerId)
      .filter((i) => !filter.statuses?.length || filter.statuses.includes(i.status))
      .filter((i) => !filter.resourceRef || i.resourceRef === filter.resourceRef)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(filter.offset ?? 0, (filter.offset ?? 0) + (filter.limit ?? 50))
      .map(clone);
  }

  count(ownerId: string, filter: Omit<InstanceListFilter, "limit" | "offset"> = {}): number {
    return this.list(ownerId, { ...filter, limit: Number.MAX_SAFE_INTEGER }).length;
  }

  listEvents(ownerId: string, actionId: string): ActionEvent[] {
    const i = this.instances.get(actionId);
    if (!i || i.ownerId !== ownerId) return [];
    return this.events.filter((e) => e.actionId === actionId).map(clone);
  }

  appendTransition(req: TransitionRequest): ActionInstance {
    const i = this.instances.get(req.actionId);
    if (!i) throw new ActionNotFoundError(req.actionId);
    if (i.status !== req.expectedStatus) throw new TransitionConflictError(req.actionId, req.expectedStatus, i.status);
    if (!isAllowedTransition(req.expectedStatus, req.toStatus)) throw new LifecycleTransitionError(req.expectedStatus, req.toStatus);
    const now = this.clock().toISOString();
    const seq = i.lastEventSeq + 1;
    this.events.push({ id: `e${this.events.length + 1}`, actionId: i.id, seq, fromStatus: i.status, toStatus: req.toStatus, actor: req.actor, data: req.data ?? {}, createdAt: now });
    Object.assign(i, clone(req.patch ?? {}), { status: req.toStatus, lastEventSeq: seq, updatedAt: now });
    return clone(i);
  }

  recordHeartbeat(actionId: string, at: string): void {
    this.instances.get(actionId)!.lastHeartbeatAt = at;
  }

  markUndoStarted(actionId: string, at: string): boolean {
    const instance = this.instances.get(actionId)!;
    if (instance.undoStartedAt !== null) return false;
    instance.undoStartedAt = at;
    return true;
  }

  trail(actionId: string): string[] {
    return this.events.filter((e) => e.actionId === actionId).map((e) => e.toStatus);
  }
}

export class InMemoryConfigRepo implements ActionConfigRepository {
  readonly rows = new Map<string, ActionConfigRecord>();
  readonly historyRows: ActionConfigHistoryEntry[] = [];

  constructor(private readonly clock: () => Date) {}

  private key = (scope: ActionScope, ownerId: string, type: string) => `${scope}|${ownerId}|${type}`;

  get(scope: ActionScope, ownerId: string, actionType: string): ActionConfigRecord | null {
    return this.rows.get(this.key(scope, ownerId, actionType)) ?? null;
  }

  list(scope: ActionScope, ownerId: string): ActionConfigRecord[] {
    return [...this.rows.values()].filter((r) => r.scope === scope && r.ownerId === ownerId);
  }

  save(input: { scope: ActionScope; ownerId: string; actionType: string; configJson: string; changedBy: string }): ActionConfigRecord {
    const previous = this.get(input.scope, input.ownerId, input.actionType);
    const now = this.clock().toISOString();
    const record: ActionConfigRecord = { scope: input.scope, ownerId: input.ownerId, actionType: input.actionType, configJson: input.configJson, updatedBy: input.changedBy, updatedAt: now };
    this.rows.set(this.key(input.scope, input.ownerId, input.actionType), record);
    this.historyRows.unshift({ id: `h${this.historyRows.length + 1}`, scope: input.scope, ownerId: input.ownerId, actionType: input.actionType, oldJson: previous?.configJson ?? null, newJson: input.configJson, changedBy: input.changedBy, changedAt: now });
    return record;
  }

  history(scope: ActionScope, ownerId: string, actionType: string, limit: number): ActionConfigHistoryEntry[] {
    return this.historyRows.filter((h) => h.scope === scope && h.ownerId === ownerId && h.actionType === actionType).slice(0, limit);
  }
}
