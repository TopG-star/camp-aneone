# Phase 3: Orchestrator and application flows (Tasks 9–11)

Read first: spec §7.2–7.4 (transitions, retry, sweeper), §10 (flows). Global constraints in [README.md](README.md) apply. Everything here is additive: no existing caller changes until Phase 4.

---

### Task 9: Orchestrator — request and advance

**Files:**
- Create: `packages/application/src/actions/orchestrator/types.ts`
- Create: `packages/application/src/actions/orchestrator/shared.ts`
- Create: `packages/application/src/actions/orchestrator/request-action.ts`
- Create: `packages/application/src/actions/orchestrator/advance.ts`
- Create: `packages/application/src/actions/orchestrator/index.ts` (partial; completed in Task 10)
- Create: `packages/application/src/actions/__tests__/in-memory-repos.ts`
- Create: `packages/application/src/actions/__tests__/orchestrator-harness.ts`
- Modify: `packages/application/src/actions/index.ts`
- Test: `packages/application/src/actions/orchestrator/advance.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 6 (`ActionInstanceRepository`, `ActionConfigRepository`, `clampPolicy`, `decide`, `isStricter`, `ActionRegistry`, definition contract, `fromExternalError`, `retryKey`, `canonicalJson`).
- Produces:
  - `ActionNotifier { awaitingApproval(instance, description): Promise<void>; rollbackFailed(instance, description): Promise<void> }`
  - `OrchestratorDeps { registry; repo; configRepo; capabilities(userId): ActionCapabilities; notifier; logger; clock(): Date; newId(): string }`
  - `ActionRequest { type: string; input: unknown; actor: ActorContext; initiator: string; keyContext: KeyContext; evidence: EvidenceItem[]; resourceRef: string | null; retryOf?: { id: string; attemptNumber: number; idempotencyKey: string } }`
  - `RequestOutcome = { kind: "created" | "duplicate"; instance: ActionInstance } | { kind: "refused"; reason: "unknown_type" | "invalid_input" | "scope_mismatch"; issues: string[] }`
  - `ActionOperationError extends Error { code: "not_found" | "not_allowed" | "conflict" }`
  - `effectivePolicyFor(deps, scope, ownerId, def): ClampResult`
  - `describeInstance(def, instance): string`
  - `createActionOrchestrator(deps): ActionOrchestrator` with (after this task) `requestAction(req): Promise<RequestOutcome>`, `advance(ownerId, actionId): Promise<ActionInstance>`

- [ ] **Step 1: Write the in-memory repositories (test support)**

`packages/application/src/actions/__tests__/in-memory-repos.ts`:

```ts
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

  markUndoStarted(actionId: string, at: string): void {
    this.instances.get(actionId)!.undoStartedAt = at;
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
```

- [ ] **Step 2: Write the harness (test support)**

`packages/application/src/actions/__tests__/orchestrator-harness.ts`:

```ts
import { vi } from "vitest";
import { z } from "zod";
import { personalActor, type Logger } from "@oneon/domain";
import { createActionRegistry } from "../registry.js";
import { createActionOrchestrator } from "../orchestrator/index.js";
import type { ActionDefinition, AnyActionDefinition } from "../definition.js";
import type { ActionRequest } from "../orchestrator/types.js";
import { InMemoryActionRepo, InMemoryConfigRepo } from "./in-memory-repos.js";
import { fakeReaders, fakeWriters } from "./fakes.js";

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

const FLOOR = {
  risk: "L1" as const,
  approval: { mode: "auto" as const, thresholds: {} },
  requiredPermissions: [],
  approverRoles: ["owner"],
  expiryHours: 24,
};

/** A controllable definition; override any member per test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function probeDefinition(overrides: Partial<ActionDefinition<any, any>> = {}): AnyActionDefinition {
  return {
    type: "probe",
    version: "1",
    scope: "personal",
    label: "Probe",
    description: "Test action",
    inputSchema: z.object({ n: z.number() }).strict(),
    effects: { reads: [], writes: [] },
    floor: FLOOR,
    defaults: { ...FLOOR, enabled: true },
    thresholdMetrics: {},
    rollbackClass: "reversible",
    recoveryThresholdMs: 60_000,
    executionTimeoutMs: 1_000,
    disableWarning: null,
    unavailableReason: null,
    consequenceKeys: ["metrics"],
    idempotencyKey: (input: { n: number }, ctx) => (ctx.source === "chat" ? `chat:${ctx.turnId}:${input.n}` : `rule:${ctx.resourceId}`),
    preconditions: async () => [],
    resolve: async () => ({ ok: true, resolved: { metrics: {} } }),
    riskFor: (_r, floor) => floor,
    describe: (_r, input: { n: number }) => `Probe ${input.n}`,
    execute: async () => ({ kind: "succeeded", result: { done: true }, undoData: { token: "t" } }),
    postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: true }] }),
    undo: {
      preconditions: async () => [{ id: "unchanged_since", failureCode: "changed_since", passed: true }],
      execute: async () => ({ kind: "succeeded", result: {}, undoData: null }),
      verify: async () => [{ id: "undone", passed: true }],
      warning: () => null,
    },
    ...overrides,
  };
}

export function harness(definitions: AnyActionDefinition[] = [probeDefinition()]) {
  let now = new Date("2026-10-01T12:00:00.000Z");
  const clock = () => now;
  const repo = new InMemoryActionRepo(clock);
  const configRepo = new InMemoryConfigRepo(clock);
  const notifier = {
    awaitingApproval: vi.fn().mockResolvedValue(undefined),
    rollbackFailed: vi.fn().mockResolvedValue(undefined),
  };
  let ids = 0;
  const orchestrator = createActionOrchestrator({
    registry: createActionRegistry(definitions),
    repo,
    configRepo,
    capabilities: () => ({ readers: fakeReaders(), writers: fakeWriters() }),
    notifier,
    logger: silentLogger,
    clock,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return {
    orchestrator,
    repo,
    configRepo,
    notifier,
    advanceClock: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

export function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    type: "probe",
    input: { n: 1 },
    actor: personalActor("u1"),
    initiator: "rule:test",
    keyContext: { source: "rule", resourceId: "r1" },
    evidence: [],
    resourceRef: null,
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing orchestrator tests**

`packages/application/src/actions/orchestrator/advance.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ExternalCallError, personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";

async function created(h: ReturnType<typeof harness>, overrides = {}) {
  const outcome = await h.orchestrator.requestAction(request(overrides));
  if (outcome.kind === "refused") throw new Error(`refused: ${outcome.reason}`);
  return outcome.instance;
}

describe("requestAction", () => {
  it("runs an auto action through to completed", async () => {
    const h = harness();
    const instance = await created(h);
    expect(instance.status).toBe("completed");
    expect(h.repo.trail(instance.id)).toEqual(["proposed", "validating", "approved", "executing", "verifying", "completed"]);
    expect(instance.result).toEqual({ done: true });
    expect(instance.undo).toEqual({ token: "t" });
    expect(instance.executorRequestId).toBe("00000000000040008000000000000001");
  });

  it("returns the existing instance for a duplicate and records nothing", async () => {
    const h = harness();
    const first = await created(h);
    const before = h.repo.events.length;
    const second = await h.orchestrator.requestAction(request());
    expect(second).toMatchObject({ kind: "duplicate", instance: { id: first.id, status: "completed" } });
    expect(h.repo.events.length).toBe(before);
  });

  it.each([
    ["an unregistered type", request({ type: "create_purchase_order" }), "unknown_type"],
    ["invalid input", request({ input: { n: "one" } }), "invalid_input"],
    ["unknown keys", request({ input: { n: 1, tenantId: "t1" } }), "invalid_input"],
    ["a scope mismatch", request({ actor: { ...personalActor("u1"), scope: "tenant", tenantId: "t1" } }), "scope_mismatch"],
  ])("refuses %s without creating an instance", async (_name, req, reason) => {
    const h = harness();
    const outcome = await h.orchestrator.requestAction(req);
    expect(outcome).toMatchObject({ kind: "refused", reason });
    expect(h.repo.instances.size).toBe(0);
  });

  it("reports invalid input issues the AI can act on", async () => {
    const outcome = await harness().orchestrator.requestAction(request({ input: {} }));
    expect(outcome).toEqual({ kind: "refused", reason: "invalid_input", issues: ["n: Required"] });
  });
});

describe("advance: validation", () => {
  it("stops at awaiting_approval and notifies", async () => {
    const def = probeDefinition({ defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } });
    const h = harness([def]);
    const instance = await created(h);
    expect(instance.status).toBe("awaiting_approval");
    expect(h.notifier.awaitingApproval).toHaveBeenCalledWith(expect.objectContaining({ id: instance.id }), "Probe 1");
  });

  it("rejects when there is no executor", async () => {
    const instance = await created(harness([probeDefinition({ execute: null, unavailableReason: "needs Gmail modify access (gmail.modify)" })]));
    expect(instance.status).toBe("rejected");
    expect(instance.decision).toMatchObject({ outcome: "refuse", reasons: [{ code: "executor_unavailable" }] });
  });

  it("cancels on an obsolete precondition and fails on a blocking one", async () => {
    const obsolete = await created(harness([probeDefinition({ preconditions: async () => [{ id: "deadline_open", kind: "obsolete", passed: false }] })]));
    expect(obsolete).toMatchObject({ status: "cancelled", error: { code: "deadline_open", stage: "validation" } });
    const blocking = await created(harness([probeDefinition({ preconditions: async () => [{ id: "calendar_connected", kind: "blocking", passed: false }] })]));
    expect(blocking).toMatchObject({ status: "failed", error: { code: "calendar_connected", stage: "validation" } });
  });

  it("stays in validating when preconditions cannot be read", async () => {
    const instance = await created(harness([probeDefinition({ preconditions: async () => { throw new Error("Google down"); } })]));
    expect(instance.status).toBe("validating");
  });

  it("fails when resolve fails", async () => {
    const instance = await created(
      harness([probeDefinition({ resolve: async () => ({ ok: false, error: { code: "event_not_found", message: "gone", stage: "validation" } }) })]),
    );
    expect(instance).toMatchObject({ status: "failed", error: { code: "event_not_found" } });
  });
});

describe("advance: execution and verification", () => {
  it("fails on a definite executor failure", async () => {
    const instance = await created(harness([probeDefinition({ execute: async () => ({ kind: "definite_failure", code: "changed_since", message: "412" }) })]));
    expect(instance).toMatchObject({ status: "failed", error: { code: "changed_since", stage: "execution" } });
  });

  it("verifies an unknown outcome and completes when the effect exists", async () => {
    const instance = await created(harness([probeDefinition({ execute: async () => ({ kind: "unknown", code: "timeout", message: "slow" }) })]));
    expect(instance.status).toBe("completed");
    expect(instance.error).toBeNull();
  });

  it("treats a thrown error as unknown, then fails if the effect is absent", async () => {
    const instance = await created(
      harness([
        probeDefinition({
          execute: async () => { throw new TypeError("socket hang up"); },
          postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: false }] }),
        }),
      ]),
    );
    expect(instance).toMatchObject({ status: "failed", error: { code: "effect_absent", stage: "verification" } });
  });

  it("maps ExternalCallError outcomes", async () => {
    const instance = await created(harness([probeDefinition({ execute: async () => { throw new ExternalCallError("definite", "rejected_by_google", "400"); } })]));
    expect(instance).toMatchObject({ status: "failed", error: { code: "rejected_by_google" } });
  });

  it("times out to unknown and verifies", async () => {
    const instance = await created(harness([probeDefinition({ executionTimeoutMs: 10, execute: () => new Promise(() => {}) })]));
    expect(instance.status).toBe("completed");
  });

  it("reports a partial result", async () => {
    const instance = await created(
      harness([
        probeDefinition({
          postconditions: async () => ({ effectCheckId: "effect", checks: [{ id: "effect", passed: true }, { id: "attendees_match", passed: false }] }),
        }),
      ]),
    );
    expect(instance).toMatchObject({ status: "partially_completed", error: { code: "checks_failed" } });
  });

  it("stays in verifying when the outcome cannot be read", async () => {
    const instance = await created(harness([probeDefinition({ postconditions: async () => { throw new Error("Google down"); } })]));
    expect(instance.status).toBe("verifying");
  });
});

describe("advance: re-check before execution", () => {
  it("fails with changed_since_approval when consequences changed", async () => {
    let calls = 0;
    const instance = await created(
      harness([probeDefinition({ resolve: async () => ({ ok: true, resolved: { metrics: { others_involved: calls++ } } }) })]),
    );
    expect(instance).toMatchObject({ status: "failed", error: { code: "changed_since_approval", stage: "recheck" } });
  });

  it("fails with approval_required_now when policy became stricter", async () => {
    // The definition saves a stricter config between validation and the pre-execution re-check.
    const holder: { save?: () => void } = {};
    let calls = 0;
    const def = probeDefinition({
      resolve: async () => {
        if (calls++ === 1) holder.save?.();
        return { ok: true, resolved: { metrics: {} } };
      },
    });
    const h = harness([def]);
    holder.save = () =>
      h.configRepo.save({ scope: "personal", ownerId: "u1", actionType: "probe", configJson: '{"approval":{"mode":"always"}}', changedBy: "u1" });
    const outcome = await h.orchestrator.requestAction(request());
    if (outcome.kind === "refused") throw new Error();
    expect(outcome.instance).toMatchObject({ status: "failed", error: { code: "approval_required_now", stage: "recheck" } });
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd packages/application && npx vitest run src/actions/orchestrator`
Expected: FAIL, orchestrator modules missing.

- [ ] **Step 5: Write `types.ts` and `shared.ts`**

```ts
// orchestrator/types.ts
import type {
  ActionCapabilities,
  ActionConfigRepository,
  ActionInstance,
  ActionInstanceRepository,
  ActorContext,
  EvidenceItem,
  Logger,
} from "@oneon/domain";
import type { ActionRegistry } from "../registry.js";
import type { KeyContext } from "../definition.js";

/** Side channel (spec §10.7): messages about actions, never actions themselves. */
export interface ActionNotifier {
  awaitingApproval(instance: ActionInstance, description: string): Promise<void>;
  rollbackFailed(instance: ActionInstance, description: string): Promise<void>;
}

export interface OrchestratorDeps {
  registry: ActionRegistry;
  repo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  /** Readers and writers for the user the action runs for. Built by the composition root. */
  capabilities(userId: string): ActionCapabilities;
  notifier: ActionNotifier;
  logger: Logger;
  clock(): Date;
  newId(): string;
}

export interface ActionRequest {
  type: string;
  input: unknown;
  actor: ActorContext;
  initiator: string;
  keyContext: KeyContext;
  evidence: EvidenceItem[];
  resourceRef: string | null;
  retryOf?: { id: string; attemptNumber: number; idempotencyKey: string };
}

export type RequestOutcome =
  | { kind: "created" | "duplicate"; instance: ActionInstance }
  | { kind: "refused"; reason: "unknown_type" | "invalid_input" | "scope_mismatch"; issues: string[] };

export class ActionOperationError extends Error {
  constructor(readonly code: "not_found" | "not_allowed" | "conflict", message: string) {
    super(message);
    this.name = "ActionOperationError";
  }
}
```

```ts
// orchestrator/shared.ts
import {
  personalActor,
  type ActionInstance,
  type ActorContext,
  type ActorRef,
  type InstancePatch,
  type JsonObject,
  type LifecycleStatus,
} from "@oneon/domain";
import { clampPolicy, type ClampResult, type PolicyDecision } from "../policy/index.js";
import type { AnyActionDefinition } from "../definition.js";
import { canonicalJson } from "../idempotency.js";
import type { OrchestratorDeps } from "./types.js";

export const SYSTEM: ActorRef = { kind: "system" };
export const POLICY: ActorRef = { kind: "policy" };
export const SWEEPER: ActorRef = { kind: "sweeper" };

export function actorForInstance(instance: ActionInstance): ActorContext {
  if (instance.scope === "personal") return personalActor(instance.userId);
  throw new Error("Tenant-scope actions are not supported until sub-project B");
}

export function effectivePolicyFor(
  deps: OrchestratorDeps,
  scope: ActionInstance["scope"],
  ownerId: string,
  def: AnyActionDefinition,
): ClampResult {
  const stored = deps.configRepo.get(scope, ownerId, def.type);
  const result = clampPolicy({
    floor: def.floor,
    defaults: def.defaults,
    storedJson: stored?.configJson ?? null,
    declaredMetrics: Object.keys(def.thresholdMetrics),
    executorAvailable: def.execute !== null,
  });
  if (result.clamped.length > 0) {
    deps.logger.warn("Action config looser than its floor; using the floor", { actionType: def.type, ownerId, fields: result.clamped });
  }
  if (result.rejected) {
    deps.logger.warn("Action config rejected; using defaults", { actionType: def.type, ownerId, reason: result.rejected });
  }
  return result;
}

export function move(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  to: LifecycleStatus,
  actor: ActorRef,
  data: JsonObject = {},
  patch?: InstancePatch,
): ActionInstance {
  return deps.repo.appendTransition({ actionId: instance.id, expectedStatus: instance.status, toStatus: to, actor, data, patch });
}

export function decisionOf(instance: ActionInstance): PolicyDecision | null {
  return instance.decision as unknown as PolicyDecision | null;
}

export function consequencesDiffer(keys: readonly string[], approved: JsonObject | null, current: JsonObject): boolean {
  return keys.some((k) => canonicalJson(approved?.[k] ?? null) !== canonicalJson(current[k] ?? null));
}

export function describeInstance(def: AnyActionDefinition, instance: Pick<ActionInstance, "resolved" | "input">): string {
  if (!instance.resolved) return def.label;
  try {
    return def.describe(instance.resolved, instance.input);
  } catch {
    return def.label;
  }
}

export async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function quietly(deps: OrchestratorDeps, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    deps.logger.error(`Failed to send ${what}`, { error: error instanceof Error ? error.message : String(error) });
  }
}
```

- [ ] **Step 6: Write `request-action.ts`**

```ts
import type { ActionInstance, ActorRef } from "@oneon/domain";
import { retryKey } from "../idempotency.js";
import type { ActionRequest, OrchestratorDeps, RequestOutcome } from "./types.js";

export function createRequestAction(
  deps: OrchestratorDeps,
  advance: (ownerId: string, actionId: string) => Promise<ActionInstance>,
) {
  return async function requestAction(req: ActionRequest): Promise<RequestOutcome> {
    if (!deps.registry.has(req.type)) {
      deps.logger.warn("Refused an unregistered action type", { type: req.type, initiator: req.initiator });
      return { kind: "refused", reason: "unknown_type", issues: [`"${req.type}" is not an action Oneon can take.`] };
    }
    const def = deps.registry.get(req.type);
    if (def.scope !== req.actor.scope) {
      return { kind: "refused", reason: "scope_mismatch", issues: [`${req.type} is a ${def.scope} action.`] };
    }
    const parsed = def.inputSchema.safeParse(req.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
      deps.logger.warn("Refused invalid action input", { type: req.type, initiator: req.initiator, issues });
      return { kind: "refused", reason: "invalid_input", issues };
    }

    const ownerId = req.actor.scope === "personal" ? req.actor.userId : req.actor.tenantId!;
    const idempotencyKey = req.retryOf
      ? retryKey(req.retryOf.idempotencyKey, req.retryOf.attemptNumber)
      : def.idempotencyKey(parsed.data, req.keyContext);
    const actor: ActorRef = req.initiator === "user" ? { kind: "user", userId: req.actor.userId } : { kind: "system" };

    const { instance, created } = deps.repo.create(
      {
        id: deps.newId(),
        scope: def.scope,
        ownerId,
        userId: req.actor.userId,
        tenantId: req.actor.tenantId,
        locationIds: req.actor.scope === "personal" ? [] : req.actor.locationIds,
        actionType: def.type,
        definitionVersion: def.version,
        initiator: req.initiator,
        initiatorUserId: req.initiator === "user" ? req.actor.userId : null,
        input: parsed.data,
        evidence: req.evidence,
        idempotencyKey,
        retryOf: req.retryOf?.id ?? null,
        attemptNumber: req.retryOf ? req.retryOf.attemptNumber + 1 : 1,
        resourceRef: req.resourceRef,
      },
      actor,
      { initiator: req.initiator },
    );
    if (!created) return { kind: "duplicate", instance };
    return { kind: "created", instance: await advance(ownerId, instance.id) };
  };
}
```

- [ ] **Step 7: Write `advance.ts`**

```ts
import {
  ActionNotFoundError,
  TransitionConflictError,
  maxRisk,
  type ActionCapabilities,
  type ActionInstance,
  type ActorContext,
  type JsonObject,
} from "@oneon/domain";
import { decide, isStricter } from "../policy/index.js";
import type { AnyActionDefinition, ExecutionOutcome, PreconditionResult, Resolved } from "../definition.js";
import { fromExternalError } from "../definitions/outcomes.js";
import {
  POLICY,
  SYSTEM,
  actorForInstance,
  consequencesDiffer,
  decisionOf,
  effectivePolicyFor,
  move,
  quietly,
  withTimeout,
} from "./shared.js";
import type { OrchestratorDeps } from "./types.js";

export function createAdvance(deps: OrchestratorDeps) {
  return async function advance(ownerId: string, actionId: string): Promise<ActionInstance> {
    let instance = deps.repo.findById(ownerId, actionId);
    if (!instance) throw new ActionNotFoundError(actionId);
    const def = deps.registry.get(instance.actionType);
    const caps = deps.capabilities(instance.userId);
    const actor = actorForInstance(instance);

    for (let step = 0; step < 10; step++) {
      const before = instance.status;
      try {
        switch (instance.status) {
          case "proposed":
            instance = move(deps, instance, "validating", SYSTEM);
            break;
          case "validating":
            instance = await validate(deps, instance, def, caps, actor);
            break;
          case "approved":
            instance = await executeApproved(deps, instance, def, caps, actor);
            break;
          case "verifying":
            instance = await verify(deps, instance, def, caps);
            break;
          default:
            return instance;
        }
      } catch (error) {
        // Someone else (a person or the sweeper) moved the action first; their transition stands.
        if (error instanceof TransitionConflictError) return deps.repo.findById(ownerId, actionId)!;
        throw error;
      }
      if (instance.status === before) return instance;
    }
    return instance;
  };
}

function splitFailures(checks: PreconditionResult[]) {
  const failed = checks.filter((c) => !c.passed);
  return { obsolete: failed.find((c) => c.kind === "obsolete"), blocking: failed.find((c) => c.kind === "blocking") };
}

async function validate(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  def: AnyActionDefinition,
  caps: ActionCapabilities,
  actor: ActorContext,
): Promise<ActionInstance> {
  const ctx = { input: instance.input, actor, readers: caps.readers, now: deps.clock() };
  let checks: PreconditionResult[];
  try {
    checks = await def.preconditions(ctx);
  } catch (error) {
    deps.logger.warn("Preconditions could not be evaluated; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  const { obsolete, blocking } = splitFailures(checks);
  if (obsolete) {
    return move(deps, instance, "cancelled", SYSTEM, { checks, reason: obsolete.id }, {
      error: { code: obsolete.id, message: `No longer applicable: ${obsolete.id}`, stage: "validation" },
    });
  }
  if (blocking) {
    return move(deps, instance, "failed", SYSTEM, { checks }, {
      error: { code: blocking.id, message: `Precondition not met: ${blocking.id}`, stage: "validation" },
    });
  }

  let resolved;
  try {
    resolved = await def.resolve(ctx);
  } catch (error) {
    deps.logger.warn("Resolve could not read current state; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  if (!resolved.ok) return move(deps, instance, "failed", SYSTEM, { checks }, { error: resolved.error });

  const { policy } = effectivePolicyFor(deps, instance.scope, instance.ownerId, def);
  const risk = maxRisk(def.riskFor(resolved.resolved, policy.risk), policy.risk);
  const decision = decide({
    scope: def.scope,
    executorAvailable: def.execute !== null,
    policy,
    actor,
    metrics: resolved.resolved.metrics,
    risk,
    now: deps.clock(),
  });
  const patch = { resolved: resolved.resolved, decision: decision as unknown as JsonObject };
  const data = { checks, decision } as unknown as JsonObject;

  if (decision.outcome === "refuse") return move(deps, instance, "rejected", POLICY, data, patch);
  if (decision.outcome === "needs_approval") {
    const waiting = move(deps, instance, "awaiting_approval", POLICY, data, patch);
    await quietly(deps, "approval notification", () =>
      deps.notifier.awaitingApproval(waiting, def.describe(resolved.resolved, instance.input)),
    );
    return waiting;
  }
  return move(deps, instance, "approved", POLICY, data, patch);
}

async function executeApproved(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  def: AnyActionDefinition,
  caps: ActionCapabilities,
  actor: ActorContext,
): Promise<ActionInstance> {
  const now = deps.clock();
  const ctx = { input: instance.input, actor, readers: caps.readers, now };

  let checks: PreconditionResult[];
  try {
    checks = await def.preconditions(ctx);
  } catch (error) {
    deps.logger.warn("Re-check could not be evaluated; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  const { obsolete, blocking } = splitFailures(checks);
  if (obsolete) {
    return move(deps, instance, "cancelled", SYSTEM, { checks, reason: obsolete.id }, {
      error: { code: obsolete.id, message: `No longer applicable: ${obsolete.id}`, stage: "recheck" },
    });
  }
  if (blocking) {
    return move(deps, instance, "failed", SYSTEM, { checks }, {
      error: { code: blocking.id, message: `Precondition not met: ${blocking.id}`, stage: "recheck" },
    });
  }

  let current;
  try {
    current = await def.resolve(ctx);
  } catch (error) {
    deps.logger.warn("Re-check could not read current state; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  if (!current.ok) return move(deps, instance, "failed", SYSTEM, { checks }, { error: { ...current.error, stage: "recheck" } });

  const approved = instance.resolved as Resolved;
  if (consequencesDiffer(def.consequenceKeys, approved, current.resolved)) {
    return move(deps, instance, "failed", SYSTEM, { checks, approved, current: current.resolved } as unknown as JsonObject, {
      error: { code: "changed_since_approval", message: "What this action would do changed after it was approved.", stage: "recheck" },
    });
  }

  const { policy } = effectivePolicyFor(deps, instance.scope, instance.ownerId, def);
  const decision = decide({
    scope: def.scope,
    executorAvailable: def.execute !== null,
    policy,
    actor,
    metrics: current.resolved.metrics,
    risk: maxRisk(def.riskFor(current.resolved, policy.risk), policy.risk),
    now,
  });
  const recorded = decisionOf(instance)?.outcome ?? "auto";
  if (isStricter(decision.outcome, recorded) || !def.execute) {
    const refused = decision.outcome === "refuse" || !def.execute;
    return move(deps, instance, "failed", SYSTEM, { decision } as unknown as JsonObject, {
      error: {
        code: refused ? "policy_refused_now" : "approval_required_now",
        message: refused ? "Policy no longer allows this action." : "This action now needs approval.",
        stage: "recheck",
      },
    });
  }

  const executorRequestId = instance.id.replace(/-/g, "");
  const executing = move(deps, instance, "executing", SYSTEM, { checks } as unknown as JsonObject, {
    executionStartedAt: now.toISOString(),
    executorRequestId,
  });

  let outcome: ExecutionOutcome;
  try {
    outcome = await withTimeout(
      def.execute({
        instanceId: executing.id,
        input: executing.input,
        resolved: approved,
        actor,
        executorRequestId,
        writers: caps.writers,
        heartbeat: () => deps.repo.recordHeartbeat(executing.id, deps.clock().toISOString()),
        now,
      }),
      def.executionTimeoutMs,
      () => ({ kind: "unknown", code: "timeout", message: `No response within ${def.executionTimeoutMs} ms` }),
    );
  } catch (error) {
    outcome = fromExternalError(error);
  }

  if (outcome.kind === "succeeded") {
    return move(deps, executing, "verifying", SYSTEM, { outcome: "succeeded" }, { result: outcome.result, undo: outcome.undoData, error: null });
  }
  if (outcome.kind === "unknown") {
    return move(deps, executing, "verifying", SYSTEM, { outcome: "unknown", code: outcome.code }, {
      error: { code: outcome.code, message: outcome.message, stage: "execution" },
    });
  }
  return move(deps, executing, "failed", SYSTEM, { outcome: "definite_failure", code: outcome.code }, {
    error: { code: outcome.code, message: outcome.message, stage: "execution" },
  });
}

async function verify(
  deps: OrchestratorDeps,
  instance: ActionInstance,
  def: AnyActionDefinition,
  caps: ActionCapabilities,
): Promise<ActionInstance> {
  if (!def.postconditions) {
    return move(deps, instance, "failed", SYSTEM, {}, { error: { code: "no_verification", message: "This action cannot be verified.", stage: "verification" } });
  }
  let verification;
  try {
    verification = await def.postconditions({
      input: instance.input,
      resolved: instance.resolved,
      result: instance.result,
      executorRequestId: instance.executorRequestId ?? instance.id.replace(/-/g, ""),
      readers: caps.readers,
    });
  } catch (error) {
    deps.logger.warn("Verification could not read the outcome; the sweeper will retry", { actionId: instance.id, error: String(error) });
    return instance;
  }
  const { checks, effectCheckId } = verification;
  const effect = checks.find((c) => c.id === effectCheckId);
  const data = { checks } as unknown as JsonObject;
  if (!effect?.passed) {
    return move(deps, instance, "failed", SYSTEM, data, {
      error: { code: "effect_absent", message: "The change was not found after execution.", stage: "verification" },
    });
  }
  if (checks.every((c) => c.passed)) return move(deps, instance, "completed", SYSTEM, data, { error: null });
  const failedIds = checks.filter((c) => !c.passed).map((c) => c.id).join(", ");
  return move(deps, instance, "partially_completed", SYSTEM, data, {
    error: { code: "checks_failed", message: `Some checks failed: ${failedIds}`, stage: "verification" },
  });
}
```

- [ ] **Step 8: Write the orchestrator index (first half)**

```ts
// orchestrator/index.ts
import type { ActionInstance } from "@oneon/domain";
import { createAdvance } from "./advance.js";
import { createRequestAction } from "./request-action.js";
import type { ActionRequest, OrchestratorDeps, RequestOutcome } from "./types.js";

export * from "./types.js";
export { effectivePolicyFor, describeInstance } from "./shared.js";

export interface ActionOrchestrator {
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  advance(ownerId: string, actionId: string): Promise<ActionInstance>;
}

export function createActionOrchestrator(deps: OrchestratorDeps): ActionOrchestrator {
  const advance = createAdvance(deps);
  const requestAction = createRequestAction(deps, advance);
  return { requestAction, advance };
}
```

Add to `packages/application/src/actions/index.ts`:

```ts
export * from "./orchestrator/index.js";
```

- [ ] **Step 9: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions/orchestrator`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 10: Commit**

```bash
git add packages/application/src/actions
git commit -m "feat(actions): add orchestrator request and advance pipeline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Orchestrator — decisions, undo, expiry, sweeper, notifier

**Files:**
- Create: `packages/application/src/actions/orchestrator/decisions.ts`
- Create: `packages/application/src/actions/orchestrator/undo.ts`
- Create: `packages/application/src/actions/orchestrator/sweeper.ts`
- Create: `packages/application/src/actions/notifier.ts`
- Modify: `packages/application/src/actions/orchestrator/index.ts`, `packages/application/src/actions/index.ts`
- Test: `packages/application/src/actions/orchestrator/decisions.test.ts`
- Test: `packages/application/src/actions/orchestrator/undo.test.ts`
- Test: `packages/application/src/actions/orchestrator/sweeper.test.ts`
- Test: `packages/application/src/actions/notifier.test.ts`

**Interfaces:**
- Consumes: Task 9.
- Produces — `ActionOrchestrator` gains:
  - `approve(actor: ActorContext, actionId: string): Promise<ActionInstance>`
  - `reject(actor, actionId, reason?: string): Promise<ActionInstance>`
  - `cancel(actor, actionId, reason?: string): Promise<ActionInstance>`
  - `retry(actor, actionId): Promise<RequestOutcome>`
  - `requestUndo(actor, actionId): Promise<ActionInstance>`
  - `sweep(ownerId): Promise<{ recovered: number }>`
  - `expireStale(ownerId): Promise<number>`
  - all operations throw `ActionOperationError` (`not_found`, `not_allowed`, `conflict`)
- `createActionNotifier(port: NotificationPort, logger: Logger): ActionNotifier`

- [ ] **Step 1: Write the failing tests**

`decisions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import { ActionOperationError } from "./types.js";

const askFirst = () => probeDefinition({ defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } });

async function waiting(h: ReturnType<typeof harness>) {
  const o = await h.orchestrator.requestAction(request());
  if (o.kind === "refused") throw new Error();
  return o.instance;
}

describe("approve / reject / cancel", () => {
  it("approves and runs to completion", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    const done = await h.orchestrator.approve(personalActor("u1"), w.id);
    expect(done.status).toBe("completed");
    expect(h.repo.events.find((e) => e.toStatus === "approved")!.actor).toEqual({ kind: "user", userId: "u1" });
  });

  it("refuses a second approve as a conflict", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    await h.orchestrator.approve(personalActor("u1"), w.id);
    await expect(h.orchestrator.approve(personalActor("u1"), w.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("hides another user's action", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    await expect(h.orchestrator.approve(personalActor("u2"), w.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects instead of approving when policy now refuses", async () => {
    const h = harness([askFirst()]);
    const w = await waiting(h);
    h.configRepo.save({ scope: "personal", ownerId: "u1", actionType: "probe", configJson: '{"enabled":false}', changedBy: "u1" });
    const after = await h.orchestrator.approve(personalActor("u1"), w.id);
    expect(after.status).toBe("rejected");
    expect(h.repo.events.at(-1)!.actor).toEqual({ kind: "policy" });
  });

  it("rejects and cancels with a reason", async () => {
    const h = harness([askFirst()]);
    const a = await waiting(h);
    expect((await h.orchestrator.reject(personalActor("u1"), a.id, "not now")).status).toBe("rejected");
    const b = await h.orchestrator.requestAction(request({ keyContext: { source: "rule", resourceId: "r2" } }));
    if (b.kind === "refused") throw new Error();
    expect((await h.orchestrator.cancel(personalActor("u1"), b.instance.id)).status).toBe("cancelled");
  });

  it("refuses to cancel a completed action", async () => {
    const h = harness();
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    await expect(h.orchestrator.cancel(personalActor("u1"), o.instance.id)).rejects.toBeInstanceOf(ActionOperationError);
  });
});

describe("retry", () => {
  it("creates a linked attempt with a suffixed key, and retries of retries use the root key", async () => {
    let fail = true;
    const h = harness([probeDefinition({ execute: async () => (fail ? { kind: "definite_failure", code: "x", message: "x" } : { kind: "succeeded", result: {}, undoData: null }) })]);
    const first = await h.orchestrator.requestAction(request());
    if (first.kind === "refused") throw new Error();
    expect(first.instance.status).toBe("failed");

    const second = await h.orchestrator.retry(personalActor("u1"), first.instance.id);
    if (second.kind === "refused") throw new Error();
    expect(second.instance).toMatchObject({ retryOf: first.instance.id, attemptNumber: 2, idempotencyKey: "rule:r1:retry:1", status: "failed" });

    fail = false;
    const third = await h.orchestrator.retry(personalActor("u1"), second.instance.id);
    if (third.kind === "refused") throw new Error();
    expect(third.instance).toMatchObject({ attemptNumber: 3, idempotencyKey: "rule:r1:retry:2", status: "completed" });
  });

  it("is not allowed on a completed action", async () => {
    const h = harness();
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    await expect(h.orchestrator.retry(personalActor("u1"), o.instance.id)).rejects.toMatchObject({ code: "not_allowed" });
  });
});
```

`undo.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";
import type { UndoSpec } from "../definition.js";

const baseUndo = probeDefinition().undo!;
const withUndo = (undo: Partial<UndoSpec<unknown, never>>) => probeDefinition({ undo: { ...baseUndo, ...undo } });

async function completed(h: ReturnType<typeof harness>) {
  const o = await h.orchestrator.requestAction(request());
  if (o.kind === "refused" || o.instance.status !== "completed") throw new Error("setup");
  return o.instance;
}

describe("requestUndo", () => {
  it("rolls back when the undo is verified", async () => {
    const h = harness();
    const c = await completed(h);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), c.id);
    expect(after.status).toBe("rolled_back");
    expect(h.repo.trail(c.id).slice(-2)).toEqual(["rolling_back", "rolled_back"]);
  });

  it("fails and notifies when the target changed since", async () => {
    const h = harness([withUndo({ preconditions: async () => [{ id: "unchanged_since", failureCode: "changed_since", passed: false }] })]);
    const c = await completed(h);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), c.id);
    expect(after).toMatchObject({ status: "rollback_failed", error: { code: "changed_since", stage: "undo" } });
    expect(h.notifier.rollbackFailed).toHaveBeenCalledOnce();
  });

  it("fails on a definite undo failure", async () => {
    const h = harness([withUndo({ execute: async () => ({ kind: "definite_failure", code: "not_found", message: "gone" }) })]);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), (await completed(h)).id);
    expect(after).toMatchObject({ status: "rollback_failed", error: { code: "not_found" } });
  });

  it("stays rolling back on an unknown undo outcome", async () => {
    const h = harness([withUndo({ execute: async () => ({ kind: "unknown", code: "timeout", message: "slow" }) })]);
    const c = await completed(h);
    const after = await h.orchestrator.requestUndo(personalActor("u1"), c.id);
    expect(after.status).toBe("rolling_back");
    expect(after.undoStartedAt).not.toBeNull();
  });

  it("refuses irreversible actions", async () => {
    const h = harness([probeDefinition({ rollbackClass: "irreversible", undo: null })]);
    await expect(h.orchestrator.requestUndo(personalActor("u1"), (await completed(h)).id)).rejects.toMatchObject({
      code: "not_allowed",
      message: "This action cannot be automatically reversed.",
    });
  });
});
```

`sweeper.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { personalActor } from "@oneon/domain";
import { harness, probeDefinition, request } from "../__tests__/orchestrator-harness.js";

const MIN = 60_000;

describe("sweep", () => {
  it("leaves fresh in-progress actions alone and honours each definition's threshold", async () => {
    const h = harness([probeDefinition({ recoveryThresholdMs: 10 * MIN, preconditions: async () => { throw new Error("down"); } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    expect(o.instance.status).toBe("validating");
    h.advanceClock(5 * MIN);
    expect(await h.orchestrator.sweep("u1")).toEqual({ recovered: 0 });
  });

  it("re-runs validation for an action stuck in validating", async () => {
    let down = true;
    const h = harness([probeDefinition({ preconditions: async () => { if (down) throw new Error("down"); return []; } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    down = false;
    h.advanceClock(2 * MIN);
    expect(await h.orchestrator.sweep("u1")).toEqual({ recovered: 1 });
    expect(h.repo.findById("u1", o.instance.id)!.status).toBe("completed");
  });

  it("moves a stuck proposed action through validating first", async () => {
    const h = harness();
    const { instance } = h.repo.create(
      { id: "a-p", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [], actionType: "probe", definitionVersion: "1", initiator: "rule:test", initiatorUserId: null, input: { n: 1 }, evidence: [], idempotencyKey: "rule:x", retryOf: null, attemptNumber: 1, resourceRef: null },
      { kind: "system" },
    );
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.trail(instance.id).slice(0, 3)).toEqual(["proposed", "validating", "approved"]);
  });

  it("verifies an action stuck in executing without re-running the executor", async () => {
    let executions = 0;
    const h = harness([probeDefinition({ execute: async () => { executions++; return { kind: "succeeded", result: {}, undoData: null }; } })]);
    // Simulate a crash after the executor was called: the action is left in executing.
    const { instance } = h.repo.create(
      { id: "a-e", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [], actionType: "probe", definitionVersion: "1", initiator: "rule:test", initiatorUserId: null, input: { n: 1 }, evidence: [], idempotencyKey: "rule:e", retryOf: null, attemptNumber: 1, resourceRef: null },
      { kind: "system" },
    );
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "proposed", toStatus: "validating", actor: { kind: "system" } });
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "validating", toStatus: "approved", actor: { kind: "policy" }, patch: { resolved: { metrics: {} }, decision: { outcome: "auto" } } });
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "approved", toStatus: "executing", actor: { kind: "system" }, patch: { executorRequestId: "ae" } });
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)!.status).toBe("completed");
    expect(h.repo.trail(instance.id).slice(-3)).toEqual(["executing", "verifying", "completed"]);
    expect(executions).toBe(0);
  });

  it("cancels an approved action whose approval went stale", async () => {
    const h = harness([probeDefinition({ preconditions: async () => { throw new Error("down"); } })]);
    const { instance } = h.repo.create(
      { id: "a-s", scope: "personal", ownerId: "u1", userId: "u1", tenantId: null, locationIds: [], actionType: "probe", definitionVersion: "1", initiator: "user", initiatorUserId: "u1", input: { n: 1 }, evidence: [], idempotencyKey: "k", retryOf: null, attemptNumber: 1, resourceRef: null },
      { kind: "user", userId: "u1" },
    );
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "proposed", toStatus: "validating", actor: { kind: "system" } });
    h.repo.appendTransition({ actionId: instance.id, expectedStatus: "validating", toStatus: "approved", actor: { kind: "policy" }, patch: { resolved: { metrics: {} }, decision: { outcome: "auto", policy: { expiryHours: 24 } } } });
    h.advanceClock(25 * 60 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", instance.id)).toMatchObject({ status: "cancelled" });
    expect(h.repo.events.at(-1)!.data).toEqual({ reason: "stale_approval" });
  });

  it("resumes an undo whose executor never ran, and fails one that was interrupted", async () => {
    const h = harness();
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    h.repo.appendTransition({ actionId: o.instance.id, expectedStatus: "completed", toStatus: "rolling_back", actor: { kind: "user", userId: "u1" } });
    h.advanceClock(2 * MIN);
    await h.orchestrator.sweep("u1");
    expect(h.repo.findById("u1", o.instance.id)!.status).toBe("rolled_back");

    const h2 = harness([probeDefinition({ undo: { ...probeDefinition().undo!, verify: async () => [{ id: "undone", passed: false }] } })]);
    const o2 = await h2.orchestrator.requestAction(request());
    if (o2.kind === "refused") throw new Error();
    h2.repo.appendTransition({ actionId: o2.instance.id, expectedStatus: "completed", toStatus: "rolling_back", actor: { kind: "user", userId: "u1" } });
    h2.repo.markUndoStarted(o2.instance.id, "2026-10-01T12:00:00.000Z");
    h2.advanceClock(2 * MIN);
    await h2.orchestrator.sweep("u1");
    expect(h2.repo.findById("u1", o2.instance.id)).toMatchObject({ status: "rollback_failed", error: { code: "interrupted" } });
  });
});

describe("expireStale", () => {
  it("expires approvals past their window without notifying", async () => {
    const h = harness([probeDefinition({ defaults: { ...probeDefinition().defaults, approval: { mode: "always", thresholds: {} } } })]);
    const o = await h.orchestrator.requestAction(request());
    if (o.kind === "refused") throw new Error();
    h.notifier.awaitingApproval.mockClear();
    h.advanceClock(23 * 60 * MIN);
    expect(await h.orchestrator.expireStale("u1")).toBe(0);
    h.advanceClock(2 * 60 * MIN);
    expect(await h.orchestrator.expireStale("u1")).toBe(1);
    expect(h.repo.findById("u1", o.instance.id)!.status).toBe("expired");
    expect(h.notifier.awaitingApproval).not.toHaveBeenCalled();
    expect(h.notifier.rollbackFailed).not.toHaveBeenCalled();
    void personalActor;
  });
});
```

`notifier.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { ActionInstance } from "@oneon/domain";
import { createActionNotifier } from "./notifier.js";
import { silentLogger } from "./__tests__/orchestrator-harness.js";

const instance = { id: "a1", userId: "u1", actionType: "create_reminder" } as ActionInstance;

describe("createActionNotifier", () => {
  it("sends an approval notification with a deep link", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await createActionNotifier({ send }, silentLogger).awaitingApproval(instance, 'Add an all-day reminder "Due: Q4" on 7 Oct 2026 to your calendar.');
    expect(send).toHaveBeenCalledWith({
      eventType: "action_proposed",
      title: "Action needs your approval",
      body: 'Add an all-day reminder "Due: Q4" on 7 Oct 2026 to your calendar.',
      deepLink: "/actions#action-a1",
      userId: "u1",
    });
  });

  it("sends a rollback-failed notification", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await createActionNotifier({ send }, silentLogger).rollbackFailed(instance, "Undo of reminder");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ eventType: "action_rollback_failed", title: "Undo failed — needs a manual fix" }));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/application && npx vitest run src/actions`
Expected: FAIL (`approve` etc. not functions; `notifier.js` missing).

- [ ] **Step 3: Write `decisions.ts`**

```ts
import {
  LifecycleTransitionError,
  TransitionConflictError,
  maxRisk,
  type ActionInstance,
  type ActorContext,
  type JsonObject,
} from "@oneon/domain";
import { canAct, canApprove, decide } from "../policy/index.js";
import type { AnyActionDefinition } from "../definition.js";
import { POLICY, effectivePolicyFor, move } from "./shared.js";
import { ActionOperationError, type ActionRequest, type OrchestratorDeps, type RequestOutcome } from "./types.js";

const CANCELLABLE = new Set(["proposed", "validating", "awaiting_approval", "approved"]);

export function loadOwned(deps: OrchestratorDeps, actor: ActorContext, actionId: string) {
  const ownerId = actor.scope === "personal" ? actor.userId : actor.tenantId ?? "";
  const instance = deps.repo.findById(ownerId, actionId);
  if (!instance) throw new ActionOperationError("not_found", "Action not found");
  const def: AnyActionDefinition = deps.registry.get(instance.actionType);
  return { instance, def, ownerId, policy: effectivePolicyFor(deps, instance.scope, ownerId, def).policy };
}

export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof TransitionConflictError || error instanceof LifecycleTransitionError) {
      throw new ActionOperationError("conflict", "This action has changed. Reload and try again.");
    }
    throw error;
  }
}

export function createDecisions(
  deps: OrchestratorDeps,
  advance: (ownerId: string, actionId: string) => Promise<ActionInstance>,
  requestAction: (req: ActionRequest) => Promise<RequestOutcome>,
) {
  async function approve(actor: ActorContext, actionId: string): Promise<ActionInstance> {
    const { instance, def, ownerId, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "awaiting_approval") throw new ActionOperationError("conflict", `Cannot approve an action that is ${instance.status}.`);
    if (!canApprove(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't approve this action.");
    const resolved = instance.resolved ?? { metrics: {} };
    const decision = decide({
      scope: def.scope,
      executorAvailable: def.execute !== null,
      policy,
      actor,
      metrics: (resolved as { metrics: Record<string, number> }).metrics,
      risk: maxRisk(def.riskFor(resolved, policy.risk), policy.risk),
      now: deps.clock(),
    });
    const recorded = decision as unknown as JsonObject;
    if (decision.outcome === "refuse") {
      return guard(() => move(deps, instance, "rejected", POLICY, { decision: recorded, attemptedBy: actor.userId }, { decision: recorded }));
    }
    const approved = guard(() =>
      move(deps, instance, "approved", { kind: "user", userId: actor.userId }, { decision: recorded }, { decision: recorded }),
    );
    return advance(ownerId, approved.id);
  }

  async function reject(actor: ActorContext, actionId: string, reason?: string): Promise<ActionInstance> {
    const { instance, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "awaiting_approval") throw new ActionOperationError("conflict", `Cannot reject an action that is ${instance.status}.`);
    if (!canApprove(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't reject this action.");
    return guard(() => move(deps, instance, "rejected", { kind: "user", userId: actor.userId }, { reason: reason ?? null }));
  }

  async function cancel(actor: ActorContext, actionId: string, reason = "withdrawn_by_owner"): Promise<ActionInstance> {
    const { instance, policy } = loadOwned(deps, actor, actionId);
    if (!CANCELLABLE.has(instance.status)) throw new ActionOperationError("conflict", `Cannot cancel an action that is ${instance.status}.`);
    if (!canAct(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't cancel this action.");
    return guard(() => move(deps, instance, "cancelled", { kind: "user", userId: actor.userId }, { reason }));
  }

  async function retry(actor: ActorContext, actionId: string): Promise<RequestOutcome> {
    const { instance, def, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "failed" && instance.status !== "expired") {
      throw new ActionOperationError("not_allowed", "Only failed or expired actions can be tried again.");
    }
    if (!def.execute || !policy.enabled || !canAct(actor, instance, policy)) {
      throw new ActionOperationError("not_allowed", "This action can't be tried again.");
    }
    return requestAction({
      type: instance.actionType,
      input: instance.input,
      actor,
      initiator: "user",
      keyContext: { source: "rule", resourceId: instance.resourceRef ?? instance.id },
      evidence: [
        ...instance.evidence,
        { kind: "retry_of", source: "oneon", asOf: deps.clock().toISOString(), data: { actionId: instance.id, previousError: instance.error } },
      ],
      resourceRef: instance.resourceRef,
      retryOf: { id: instance.id, attemptNumber: instance.attemptNumber, idempotencyKey: instance.idempotencyKey },
    });
  }

  return { approve, reject, cancel, retry };
}
```

- [ ] **Step 4: Write `undo.ts`**

```ts
import type { ActionInstance, ActorContext, CheckResult, JsonObject } from "@oneon/domain";
import { canAct } from "../policy/index.js";
import type { AnyActionDefinition, ExecutionOutcome, UndoContext } from "../definition.js";
import { fromExternalError } from "../definitions/outcomes.js";
import { guard, loadOwned } from "./decisions.js";
import { SYSTEM, describeInstance, move, quietly, withTimeout } from "./shared.js";
import { ActionOperationError, type OrchestratorDeps } from "./types.js";

export function createUndo(deps: OrchestratorDeps) {
  const reload = (instance: ActionInstance) => deps.repo.findById(instance.ownerId, instance.id)!;

  async function fail(instance: ActionInstance, def: AnyActionDefinition, code: string, message: string, data: JsonObject) {
    const failed = move(deps, reload(instance), "rollback_failed", SYSTEM, data, { error: { code, message, stage: "undo" } });
    await quietly(deps, "rollback failure notification", () =>
      deps.notifier.rollbackFailed(failed, `Undo of: ${describeInstance(def, failed)}`),
    );
    return failed;
  }

  /** Spec §10.6 and §7.4. Never retried automatically. */
  async function continueUndo(instance: ActionInstance): Promise<ActionInstance> {
    const def = deps.registry.get(instance.actionType);
    if (!def.undo || !instance.undo) return fail(instance, def, "nothing_to_undo", "Nothing was recorded to undo this action.", {});
    const caps = deps.capabilities(instance.userId);
    const ctx: UndoContext<unknown, never> = {
      input: instance.input,
      resolved: instance.resolved as never,
      result: instance.result,
      undo: instance.undo,
      readers: caps.readers,
      writers: caps.writers,
    };
    const wasStarted = instance.undoStartedAt !== null;

    if (!wasStarted) {
      let checks;
      try {
        checks = await def.undo.preconditions(ctx);
      } catch (error) {
        deps.logger.warn("Undo preconditions could not be read; the sweeper will retry", { actionId: instance.id, error: String(error) });
        return instance;
      }
      const refused = checks.find((c) => !c.passed);
      if (refused) {
        return fail(instance, def, refused.failureCode, `Undo refused: ${refused.failureCode}`, { checks } as unknown as JsonObject);
      }
      deps.repo.markUndoStarted(instance.id, deps.clock().toISOString());
      let outcome: ExecutionOutcome;
      try {
        outcome = await withTimeout(def.undo.execute(ctx), def.executionTimeoutMs, () => ({
          kind: "unknown",
          code: "timeout",
          message: `No response within ${def.executionTimeoutMs} ms`,
        }));
      } catch (error) {
        outcome = fromExternalError(error);
      }
      if (outcome.kind === "definite_failure") return fail(instance, def, outcome.code, outcome.message, { outcome: outcome.kind });
      if (outcome.kind === "unknown") {
        deps.logger.warn("Undo outcome unknown; the sweeper will verify", { actionId: instance.id, code: outcome.code });
        return reload(instance);
      }
    }

    let checks: CheckResult[];
    try {
      checks = await def.undo.verify(ctx);
    } catch (error) {
      deps.logger.warn("Undo verification could not read the outcome; the sweeper will retry", { actionId: instance.id, error: String(error) });
      return reload(instance);
    }
    if (checks.every((c) => c.passed)) {
      return move(deps, reload(instance), "rolled_back", SYSTEM, { checks } as unknown as JsonObject, { error: null });
    }
    return wasStarted
      ? fail(instance, def, "interrupted", "The undo was interrupted and could not be confirmed.", { checks } as unknown as JsonObject)
      : fail(instance, def, "undo_unverified", "The undo could not be confirmed.", { checks } as unknown as JsonObject);
  }

  async function requestUndo(actor: ActorContext, actionId: string): Promise<ActionInstance> {
    const { instance, def, policy } = loadOwned(deps, actor, actionId);
    if (instance.status !== "completed" && instance.status !== "partially_completed") {
      throw new ActionOperationError("conflict", `Cannot undo an action that is ${instance.status}.`);
    }
    if (def.rollbackClass === "irreversible" || !def.undo) {
      throw new ActionOperationError("not_allowed", "This action cannot be automatically reversed.");
    }
    if (!canAct(actor, instance, policy)) throw new ActionOperationError("not_allowed", "You can't undo this action.");
    if (!instance.undo) throw new ActionOperationError("not_allowed", "Nothing was recorded to undo this action.");
    const rolling = guard(() => move(deps, instance, "rolling_back", { kind: "user", userId: actor.userId }, { requestedBy: actor.userId }));
    return continueUndo(rolling);
  }

  return { requestUndo, continueUndo };
}
```

- [ ] **Step 5: Write `sweeper.ts`**

```ts
import { IN_PROGRESS_STATUSES, TransitionConflictError, type ActionInstance } from "@oneon/domain";
import type { AnyActionDefinition } from "../definition.js";
import { SWEEPER, SYSTEM, decisionOf, effectivePolicyFor, move } from "./shared.js";
import type { OrchestratorDeps } from "./types.js";

const HOUR = 3_600_000;

export function createSweeper(
  deps: OrchestratorDeps,
  advance: (ownerId: string, actionId: string) => Promise<ActionInstance>,
  continueUndo: (instance: ActionInstance) => Promise<ActionInstance>,
) {
  const expiryHoursOf = (instance: ActionInstance, def: AnyActionDefinition) =>
    decisionOf(instance)?.policy?.expiryHours ?? effectivePolicyFor(deps, instance.scope, instance.ownerId, def).policy.expiryHours;

  async function recover(instance: ActionInstance, def: AnyActionDefinition, now: number): Promise<void> {
    switch (instance.status) {
      case "proposed":
      case "validating":
      case "verifying":
        await advance(instance.ownerId, instance.id);
        return;
      case "approved":
        if (now - Date.parse(instance.updatedAt) > expiryHoursOf(instance, def) * HOUR) {
          move(deps, instance, "cancelled", SWEEPER, { reason: "stale_approval" });
          return;
        }
        await advance(instance.ownerId, instance.id);
        return;
      case "executing":
        // Never re-run the executor; verification decides (spec §7.4).
        move(deps, instance, "verifying", SWEEPER, { reason: "recovered_after_interruption" });
        await advance(instance.ownerId, instance.id);
        return;
      case "rolling_back":
        await continueUndo(instance);
        return;
      default:
        return;
    }
  }

  async function sweep(ownerId: string): Promise<{ recovered: number }> {
    const now = deps.clock().getTime();
    let recovered = 0;
    for (const instance of deps.repo.list(ownerId, { statuses: IN_PROGRESS_STATUSES, limit: 500 })) {
      if (!deps.registry.has(instance.actionType)) continue;
      const def = deps.registry.get(instance.actionType);
      const lastActivity = Math.max(Date.parse(instance.updatedAt), instance.lastHeartbeatAt ? Date.parse(instance.lastHeartbeatAt) : 0);
      if (now - lastActivity < def.recoveryThresholdMs) continue;
      try {
        await recover(instance, def, now);
        recovered++;
      } catch (error) {
        if (error instanceof TransitionConflictError) continue; // someone else moved it first
        deps.logger.error("Action recovery failed", { actionId: instance.id, status: instance.status, error: String(error) });
      }
    }
    return { recovered };
  }

  async function expireStale(ownerId: string): Promise<number> {
    const now = deps.clock().getTime();
    let expired = 0;
    for (const instance of deps.repo.list(ownerId, { statuses: ["awaiting_approval"], limit: 500 })) {
      if (!deps.registry.has(instance.actionType)) continue;
      const hours = expiryHoursOf(instance, deps.registry.get(instance.actionType));
      if (now - Date.parse(instance.updatedAt) <= hours * HOUR) continue;
      try {
        move(deps, instance, "expired", SYSTEM, { expiryHours: hours });
        expired++;
      } catch (error) {
        if (!(error instanceof TransitionConflictError)) throw error;
      }
    }
    return expired;
  }

  return { sweep, expireStale };
}
```

- [ ] **Step 6: Write `notifier.ts` and complete the orchestrator index**

```ts
// actions/notifier.ts
import { NotificationEventType, type ActionInstance, type Logger, type NotificationPort } from "@oneon/domain";
import type { ActionNotifier } from "./orchestrator/types.js";

export function createActionNotifier(port: Pick<NotificationPort, "send">, logger: Logger): ActionNotifier {
  return {
    async awaitingApproval(instance: ActionInstance, description: string) {
      await port.send({
        eventType: NotificationEventType.ActionProposed,
        title: "Action needs your approval",
        body: description,
        deepLink: `/actions#action-${instance.id}`,
        userId: instance.userId,
      });
      logger.debug("Approval notification sent", { actionId: instance.id });
    },
    async rollbackFailed(instance: ActionInstance, description: string) {
      await port.send({
        eventType: NotificationEventType.ActionRollbackFailed,
        title: "Undo failed — needs a manual fix",
        body: description,
        deepLink: `/actions#action-${instance.id}`,
        userId: instance.userId,
      });
    },
  };
}
```

Replace `orchestrator/index.ts` with:

```ts
import type { ActionInstance, ActorContext } from "@oneon/domain";
import { createAdvance } from "./advance.js";
import { createDecisions } from "./decisions.js";
import { createRequestAction } from "./request-action.js";
import { createSweeper } from "./sweeper.js";
import { createUndo } from "./undo.js";
import type { ActionRequest, OrchestratorDeps, RequestOutcome } from "./types.js";

export * from "./types.js";
export { effectivePolicyFor, describeInstance } from "./shared.js";

export interface ActionOrchestrator {
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  advance(ownerId: string, actionId: string): Promise<ActionInstance>;
  approve(actor: ActorContext, actionId: string): Promise<ActionInstance>;
  reject(actor: ActorContext, actionId: string, reason?: string): Promise<ActionInstance>;
  cancel(actor: ActorContext, actionId: string, reason?: string): Promise<ActionInstance>;
  retry(actor: ActorContext, actionId: string): Promise<RequestOutcome>;
  requestUndo(actor: ActorContext, actionId: string): Promise<ActionInstance>;
  sweep(ownerId: string): Promise<{ recovered: number }>;
  expireStale(ownerId: string): Promise<number>;
}

export function createActionOrchestrator(deps: OrchestratorDeps): ActionOrchestrator {
  const advance = createAdvance(deps);
  const requestAction = createRequestAction(deps, advance);
  const { requestUndo, continueUndo } = createUndo(deps);
  const { approve, reject, cancel, retry } = createDecisions(deps, advance, requestAction);
  const { sweep, expireStale } = createSweeper(deps, advance, continueUndo);
  return { requestAction, advance, approve, reject, cancel, retry, requestUndo, sweep, expireStale };
}
```

Add to `actions/index.ts`:

```ts
export { createActionNotifier } from "./notifier.js";
```

- [ ] **Step 7: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/actions
git commit -m "feat(actions): add approval, undo, retry, expiry and recovery" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Inbox rules, legacy import and chat action tools

Three small application modules that feed `requestAction`. Nothing calls them until Phase 4.

**Files:**
- Create: `packages/application/src/actions/inbox-rules.ts`
- Create: `packages/application/src/actions/legacy-import.ts`
- Create: `packages/application/src/actions/chat-action-tools.ts`
- Modify: `packages/application/src/usecases/run-intent-loop.ts` (inject `turnId`, `turnExcerpt`)
- Modify: `packages/application/src/usecases/send-chat-message.ts` (pass `turnId`; return `actions`)
- Modify: `packages/application/src/actions/index.ts`
- Test: `packages/application/src/actions/inbox-rules.test.ts`
- Test: `packages/application/src/actions/legacy-import.test.ts`
- Test: `packages/application/src/actions/chat-action-tools.test.ts`
- Test: `packages/application/src/usecases/send-chat-message.test.ts` (add one case; update any exact tool-parameter expectations)

**Interfaces:**
- Consumes: Tasks 9–10; `ToolDefinition`, `ToolResult` (`tools/tool-registry.ts`); `Classification`, `InboundItem`, `Deadline`, `LegacyActionRepository`.
- Produces:
  - `URGENT_PRIORITY_THRESHOLD = 2`, `DEADLINE_CONFIDENCE_THRESHOLD = 0.7`
  - `deriveInboxActionRequests(input: { classification; item; deadlines; now: Date }): Array<Omit<ActionRequest, "actor">>`
  - `importLegacyProposals(deps: { legacyRepo: LegacyActionRepository; requestAction(req: ActionRequest): Promise<RequestOutcome>; userIds: string[]; logger: Logger }): Promise<{ imported: number; skipped: number }>`
  - `ChatActionRef { id; actionType; label; status: LifecycleStatus }`
  - `createChatActionTools(deps: { requestAction; registry: ActionRegistry; aiModel: string; clock(): Date }): ToolDefinition[]` (tools `create_calendar_event`, `update_calendar_event`)
  - `RunIntentLoopInput.turnId?: string`; `SendChatMessageResult.actions: ChatActionRef[]`

- [ ] **Step 1: Write the failing inbox-rules test**

```ts
// inbox-rules.test.ts
import { describe, it, expect } from "vitest";
import type { Classification, Deadline, InboundItem } from "@oneon/domain";
import { deriveInboxActionRequests } from "./inbox-rules.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const item = { id: "i1", from: "boss@co.com", subject: "Q4 numbers", receivedAt: "2026-10-01T11:00:00Z", source: "gmail" } as InboundItem;
const cls = (over: Partial<Classification> = {}) =>
  ({ category: "work", priority: 3, summary: "Needs numbers", followUpNeeded: false, model: "claude-haiku", promptVersion: "v1", ...over }) as Classification;
const dl = (over: Partial<Deadline> = {}) => ({ id: "d1", confidence: 0.9, dueDate: "2026-10-07T17:00:00Z", description: "Send Q4", ...over }) as Deadline;

const types = (reqs: ReturnType<typeof deriveInboxActionRequests>) => reqs.map((r) => r.type);

describe("deriveInboxActionRequests", () => {
  it("requests notify only at priority ≤ 2", () => {
    expect(types(deriveInboxActionRequests({ classification: cls({ priority: 2 }), item, deadlines: [], now: NOW }))).toEqual(["notify"]);
    expect(types(deriveInboxActionRequests({ classification: cls({ priority: 3, category: "urgent" }), item, deadlines: [], now: NOW }))).toEqual([]);
  });

  it("builds notify with today's title, link, evidence and key context", () => {
    const [notify] = deriveInboxActionRequests({ classification: cls({ priority: 1 }), item, deadlines: [], now: NOW });
    expect(notify).toMatchObject({
      type: "notify",
      input: { inboundItemId: "i1", title: "Urgent: Q4 numbers", body: "Needs numbers", deepLink: "/items/i1" },
      initiator: "rule:inbox.urgent_notify",
      keyContext: { source: "rule", resourceId: "i1" },
      resourceRef: "inbound_item:i1",
    });
    expect(notify.evidence.map((e) => e.kind)).toEqual(["rule", "classification", "email"]);
    expect(notify.evidence[0].data).toEqual({ ruleId: "inbox.urgent_notify", condition: "priority <= 2", values: { priority: 1 } });
  });

  it("requests a reminder per deadline at confidence ≥ 0.7", () => {
    const reqs = deriveInboxActionRequests({ classification: cls(), item, deadlines: [dl(), dl({ id: "d2", confidence: 0.69 })], now: NOW });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ type: "create_reminder", input: { deadlineId: "d1", inboundItemId: "i1" }, resourceRef: "deadline:d1" });
  });

  it("keeps the Gmail proposals", () => {
    expect(types(deriveInboxActionRequests({ classification: cls({ category: "spam" }), item, deadlines: [], now: NOW }))).toEqual(["archive"]);
    expect(types(deriveInboxActionRequests({ classification: cls({ category: "newsletter", priority: 4 }), item, deadlines: [], now: NOW }))).toEqual(["label"]);
    expect(types(deriveInboxActionRequests({ classification: cls({ followUpNeeded: true }), item, deadlines: [], now: NOW }))).toEqual(["draft_reply"]);
  });
});
```

- [ ] **Step 2: Write `inbox-rules.ts`**

```ts
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
```

- [ ] **Step 3: Write the failing legacy-import test**

```ts
// legacy-import.test.ts
import { describe, it, expect, vi } from "vitest";
import type { LegacyActionRepository, LegacyActionRow } from "@oneon/domain";
import { importLegacyProposals } from "./legacy-import.js";
import { silentLogger } from "./__tests__/orchestrator-harness.js";

const row = (over: Partial<LegacyActionRow>): LegacyActionRow => ({
  id: "l1", userId: "u1", resourceId: "i1", actionType: "archive", riskLevel: "approval_required",
  status: "proposed", payloadJson: '{"reason":"spam_classification"}', resultJson: null, errorJson: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...over,
});

function legacyRepo(rows: LegacyActionRow[]) {
  const imported: Array<[string, string]> = [];
  const repo: LegacyActionRepository = {
    listForUser: () => [],
    countForUser: () => 0,
    listUnimportedProposed: (userId) => rows.filter((r) => r.userId === userId),
    recordImport: (legacyId, actionId) => imported.push([legacyId, actionId]),
  };
  return { repo, imported };
}

describe("importLegacyProposals", () => {
  it("imports supported proposals and records the mapping", async () => {
    const { repo, imported } = legacyRepo([
      row({ id: "l1" }),
      row({ id: "l2", actionType: "create_reminder", resourceId: "d1", payloadJson: '{"inboundItemId":"i9"}' }),
    ]);
    const requestAction = vi.fn(async (req) => ({ kind: "created" as const, instance: { id: `new-${req.type}` } as never }));
    const result = await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: silentLogger });
    expect(result).toEqual({ imported: 2, skipped: 0 });
    expect(imported).toEqual([["l1", "new-archive"], ["l2", "new-create_reminder"]]);
    expect(requestAction.mock.calls[1][0]).toMatchObject({
      type: "create_reminder",
      input: { deadlineId: "d1", inboundItemId: "i9" },
      initiator: "rule:inbox.deadline_reminder",
      resourceRef: "deadline:d1",
    });
    expect(requestAction.mock.calls[0][0].evidence[0]).toMatchObject({ kind: "legacy_action", data: { legacyId: "l1" } });
  });

  it("never re-runs notify, skips unknown types and leaves other users' rows alone (Review Focus 4)", async () => {
    const { repo, imported } = legacyRepo([
      row({ id: "n1", actionType: "notify" }),
      row({ id: "c1", actionType: "classify" }),
      row({ id: "x1", userId: null }),
      row({ id: "bad", payloadJson: "not json" }),
    ]);
    const requestAction = vi.fn(async () => ({ kind: "created" as const, instance: { id: "new" } as never }));
    const result = await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: silentLogger });
    expect(result).toEqual({ imported: 1, skipped: 2 });
    expect(imported).toEqual([["bad", "new"]]);
  });

  it("skips a refused request without recording it", async () => {
    const { repo, imported } = legacyRepo([row({ id: "l1" })]);
    const requestAction = vi.fn(async () => ({ kind: "refused" as const, reason: "invalid_input" as const, issues: ["x"] }));
    expect(await importLegacyProposals({ legacyRepo: repo, requestAction, userIds: ["u1"], logger: silentLogger })).toEqual({ imported: 0, skipped: 1 });
    expect(imported).toEqual([]);
  });
});
```

(The `bad` row imports because a malformed payload falls back to the rule's defaults — archive only needs the item id.)

- [ ] **Step 4: Write `legacy-import.ts`**

```ts
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
```

- [ ] **Step 5: Write the failing chat-tool tests**

```ts
// chat-action-tools.test.ts
import { describe, it, expect, vi } from "vitest";
import type { ActionInstance } from "@oneon/domain";
import { createChatActionTools } from "./chat-action-tools.js";
import { createActionRegistry } from "./registry.js";
import { createActionDefinitions } from "./definitions/index.js";
import type { RequestOutcome } from "./orchestrator/types.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const registry = createActionRegistry(createActionDefinitions());
const instance = (over: Partial<ActionInstance>) =>
  ({ id: "a1", actionType: "create_calendar_event", status: "completed", input: {}, resolved: null, error: null, decision: null, ...over }) as ActionInstance;

function tools(outcome: RequestOutcome) {
  const requestAction = vi.fn().mockResolvedValue(outcome);
  const [create, update] = createChatActionTools({ requestAction, registry, aiModel: "claude-test", clock: () => NOW });
  return { create, update, requestAction };
}

const args = { title: "Call", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00", userId: "u1", turnId: "msg-1", turnExcerpt: "set up a call" };

describe("chat action tools", () => {
  it("requests the action with server-supplied identity and chat evidence", async () => {
    const { create, requestAction } = tools({ kind: "created", instance: instance({}) });
    await create.execute(create.inputSchema.parse(args));
    expect(requestAction).toHaveBeenCalledWith({
      type: "create_calendar_event",
      input: { title: "Call", start: "2026-10-07T10:00:00+00:00", end: "2026-10-07T10:30:00+00:00" },
      actor: expect.objectContaining({ userId: "u1", scope: "personal" }),
      initiator: "user",
      keyContext: { source: "chat", turnId: "msg-1" },
      evidence: [{ kind: "chat_turn", source: "chat", asOf: "2026-10-01T12:00:00.000Z", data: { turnId: "msg-1", excerpt: "set up a call", model: "claude-test" } }],
      resourceRef: null,
    });
  });

  it("never lets the AI pick the user", async () => {
    const { create, requestAction } = tools({ kind: "created", instance: instance({}) });
    // run-intent-loop spreads server fields last, so an AI-supplied userId is overwritten before this point
    await create.execute(create.inputSchema.parse({ ...args, userId: "u1" }));
    expect(requestAction.mock.calls[0][0].actor.userId).toBe("u1");
  });

  it.each([
    [instance({ status: "awaiting_approval" }), /^Waiting for your approval in Action Center\. Do not describe this action as done\./],
    [instance({ status: "completed" }), /^Completed: /],
    [instance({ status: "verifying" }), /^Sent to Google; couldn't confirm yet\./],
    [instance({ status: "failed", error: { code: "calendar_connected", message: "Precondition not met: calendar_connected", stage: "validation" } }), /^Not done \(failed\): Precondition not met: calendar_connected/],
  ])("tells the AI the truth for %#", async (inst, pattern) => {
    const { create } = tools({ kind: "created", instance: inst });
    const result = await create.execute(create.inputSchema.parse(args));
    expect(result.summary).toMatch(pattern);
    expect(result.data).toMatchObject({ action: { id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: inst.status } });
  });

  it("reports duplicates and refusals", async () => {
    const dup = tools({ kind: "duplicate", instance: instance({ status: "awaiting_approval" }) });
    expect((await dup.create.execute(dup.create.inputSchema.parse(args))).summary).toMatch(/^Already requested in this turn: awaiting_approval\./);
    const bad = tools({ kind: "refused", reason: "invalid_input", issues: ["start: Use an ISO-8601 date-time with a UTC offset"] });
    expect((await bad.create.execute(bad.create.inputSchema.parse(args))).summary).toBe(
      "Not created. Fix these inputs and try again: start: Use an ISO-8601 date-time with a UTC offset",
    );
  });

  it("refuses without a signed-in session", async () => {
    const { create, requestAction } = tools({ kind: "created", instance: instance({}) });
    const result = await create.execute(create.inputSchema.parse({ title: "x" }));
    expect(result.summary).toBe("This tool needs a signed-in chat session.");
    expect(requestAction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Write `chat-action-tools.ts`**

```ts
import { z } from "zod";
import { personalActor, type ActionInstance, type LifecycleStatus } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "../tools/tool-registry.js";
import type { ActionRegistry } from "./registry.js";
import { describeReason, type PolicyDecision } from "./policy/index.js";
import { describeInstance } from "./orchestrator/shared.js";
import type { ActionRequest, RequestOutcome } from "./orchestrator/types.js";

export interface ChatActionRef {
  id: string;
  actionType: string;
  label: string;
  status: LifecycleStatus;
}

export interface ChatActionToolDeps {
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  registry: ActionRegistry;
  aiModel: string;
  clock(): Date;
}

// Server-injected by run-intent-loop after the AI's parameters, so the AI cannot set them.
const serverFields = z
  .object({
    userId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    turnExcerpt: z.string().optional(),
  })
  .passthrough();

function statusSummary(deps: ChatActionToolDeps, instance: ActionInstance): string {
  const def = deps.registry.get(instance.actionType);
  const what = describeInstance(def, instance);
  switch (instance.status) {
    case "completed":
      return `Completed: ${what}`;
    case "awaiting_approval":
      return `Waiting for your approval in Action Center. Do not describe this action as done. Planned: ${what}`;
    case "verifying":
      return "Sent to Google; couldn't confirm yet. Oneon will check again automatically; see Action Center.";
    case "rejected": {
      const decision = instance.decision as unknown as PolicyDecision | null;
      const reason = decision?.reasons[0] ? describeReason(decision.reasons[0], def) : "rejected";
      return `Not done (rejected): ${reason}`;
    }
    case "failed":
    case "cancelled":
      return `Not done (${instance.status}): ${instance.error?.message ?? instance.status}`;
    default:
      return `In progress (${instance.status}); see Action Center.`;
  }
}

function makeTool(deps: ChatActionToolDeps, type: string, description: string): ToolDefinition {
  return {
    name: type,
    version: "2.0.0",
    description,
    inputSchema: serverFields,
    async execute(validatedInput: unknown): Promise<ToolResult> {
      const { userId, turnId, turnExcerpt, ...actionInput } = validatedInput as z.infer<typeof serverFields>;
      if (!userId || !turnId) return { data: null, summary: "This tool needs a signed-in chat session." };

      const outcome = await deps.requestAction({
        type,
        input: actionInput,
        actor: personalActor(userId),
        initiator: "user",
        keyContext: { source: "chat", turnId },
        evidence: [
          {
            kind: "chat_turn",
            source: "chat",
            asOf: deps.clock().toISOString(),
            data: { turnId, excerpt: turnExcerpt ?? null, model: deps.aiModel },
          },
        ],
        resourceRef: null,
      });

      if (outcome.kind === "refused") {
        return {
          data: { refused: outcome.reason, issues: outcome.issues },
          summary:
            outcome.reason === "invalid_input"
              ? `Not created. Fix these inputs and try again: ${outcome.issues.join("; ")}`
              : `Not created: ${outcome.issues.join("; ")}`,
        };
      }

      const def = deps.registry.get(outcome.instance.actionType);
      const action: ChatActionRef = { id: outcome.instance.id, actionType: def.type, label: def.label, status: outcome.instance.status };
      const summary = statusSummary(deps, outcome.instance);
      return {
        data: { action },
        summary: outcome.kind === "duplicate" ? `Already requested in this turn: ${outcome.instance.status}. ${summary}` : summary,
      };
    },
  };
}

/** Chat's calendar tools: they request actions instead of writing (spec §10.3). */
export function createChatActionTools(deps: ChatActionToolDeps): ToolDefinition[] {
  return [
    makeTool(
      deps,
      "create_calendar_event",
      "Request a Google Calendar event: title, start and end as ISO-8601 with a UTC offset, optional description, attendees (emails) and location. Inviting other people needs the user's approval; report the returned status truthfully.",
    ),
    makeTool(
      deps,
      "update_calendar_event",
      "Request a change to an existing Google Calendar event: eventId plus any of title, start, end (ISO-8601 with offset), description, attendees, location. Changes involving other people need approval; report the returned status truthfully.",
    ),
  ];
}
```

- [ ] **Step 7: Inject the turn into tool calls and return actions from chat**

In `run-intent-loop.ts`, add to `RunIntentLoopInput`:

```ts
  /** The persisted user message ID for this turn; injected into tool calls for idempotency. */
  turnId?: string;
```

Destructure it with the other inputs and replace the parameter construction:

```ts
        const executionParameters = {
          ...intent.parameters,
          ...(userId ? { userId } : {}),
          ...(turnId ? { turnId, turnExcerpt: userMessage.slice(0, 280) } : {}),
        };
```

In `send-chat-message.ts`:
- pass `turnId: userMsg.id` in the `runIntentLoop` input;
- add `actions: ChatActionRef[]` to `SendChatMessageResult` (import the type from `../actions/chat-action-tools.js`);
- after the loop, collect them:

```ts
    actions = loopResult.toolCalls
      .map((tc) => (tc.result?.data as { action?: ChatActionRef } | null | undefined)?.action)
      .filter((a): a is ChatActionRef => !!a);
```

  declaring `let actions: ChatActionRef[] = [];` before the `if (canRunLoop)` block and returning `actions` in the result object.

Add a test to `send-chat-message.test.ts` using the file's existing fakes: register a fake tool whose `execute` returns `{ data: { action: { id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" } }, summary: "Waiting…" }`, make the fake intent extractor call it once, and assert `result.actions` equals `[{ id: "a1", actionType: "create_calendar_event", label: "Create calendar event", status: "awaiting_approval" }]` and that the tool received `turnId` equal to `result.userMessageId`.

If existing tests in `run-intent-loop.test.ts` or `send-chat-message.test.ts` assert the exact parameters a tool received, extend those expectations with `turnId`/`turnExcerpt` only where the test passes a `turnId`; tests that pass none are unchanged.

- [ ] **Step 8: Export the modules**

Append to `actions/index.ts`:

```ts
export * from "./inbox-rules.js";
export { importLegacyProposals } from "./legacy-import.js";
export { createChatActionTools, type ChatActionRef, type ChatActionToolDeps } from "./chat-action-tools.js";
```

- [ ] **Step 9: Run tests, build, typecheck**

Run: `cd packages/application && npx vitest run src/actions src/usecases/send-chat-message.test.ts src/usecases/run-intent-loop.test.ts`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green. The chat route test in agent-server ignores the new `actions` field until Task 15.

- [ ] **Step 10: Commit**

```bash
git add packages/application/src
git commit -m "feat(actions): add inbox rules, legacy import and chat action tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
