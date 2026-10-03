# Phase 1: Domain and storage (Tasks 1–4)

Read first: spec §4 (rules), §7 (lifecycle), §8 (storage), §9.6 (port changes). Global constraints in [README.md](README.md) apply to every task.

---

### Task 1: Domain lifecycle, types, errors and ports

Adds the vocabulary every later task uses. Nothing existing changes behaviour: `CalendarPort`, `NotificationPort` and `DeadlineRepository` keep their current members (the old calendar write methods are removed in Task 13).

**Files:**
- Create: `packages/domain/src/actions/lifecycle.ts`
- Create: `packages/domain/src/actions/types.ts`
- Create: `packages/domain/src/actions/errors.ts`
- Create: `packages/domain/src/actions/repository.port.ts`
- Create: `packages/domain/src/actions/capabilities.ts`
- Create: `packages/domain/src/actions/index.ts`
- Modify: `packages/domain/src/ports/calendar.port.ts`
- Modify: `packages/domain/src/ports/notification.port.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/actions/lifecycle.test.ts`

**Interfaces:**
- Consumes: existing `Deadline`, `Notification`, `CalendarEvent` from `packages/domain/src/entities.ts` / `ports`.
- Produces (exported from `@oneon/domain`):
  - `LIFECYCLE_STATUSES`, `type LifecycleStatus`, `ALLOWED_TRANSITIONS`, `isAllowedTransition(from, to): boolean`, `IN_PROGRESS_STATUSES`, `isLifecycleStatus(v: string): v is LifecycleStatus`
  - `RISK_TIERS`, `type RiskTier`, `maxRisk(a, b): RiskTier`, `type ActionScope`, `ActorContext`, `personalActor(userId): ActorContext`, `ActorRef`, `EvidenceItem`, `CheckResult`, `ActionError`, `ActionErrorStage`, `JsonObject`, `ActionInstance`, `ActionEvent`
  - `ActionNotFoundError`, `TransitionConflictError`, `LifecycleTransitionError`, `ExternalCallError`
  - `NewActionInstance`, `CreateInstanceResult`, `InstancePatch`, `TransitionRequest`, `InstanceListFilter`, `ActionInstanceRepository`, `ActionConfigRecord`, `ActionConfigHistoryEntry`, `ActionConfigRepository`, `LegacyActionRow`, `LegacyActionRepository`
  - `SuppressionReason`, `ActionReaders`, `ActionWriters`, `ActionCapabilities`
  - `CalendarReader`, `CalendarWriter`, `CalendarEventDraft`, `CalendarSendUpdates`; `CalendarEvent` gains optional `etag`, `updated`
  - `NotificationSendResult`, `NotificationWriter`

- [ ] **Step 1: Write the failing lifecycle test**

`packages/domain/src/actions/lifecycle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LIFECYCLE_STATUSES,
  isAllowedTransition,
  isLifecycleStatus,
  type LifecycleStatus,
} from "./lifecycle.js";

// Spec §7.2, written out by hand so the test does not reuse the code's table.
const ALLOWED: Array<[LifecycleStatus, LifecycleStatus]> = [
  ["proposed", "validating"],
  ["proposed", "cancelled"],
  ["validating", "awaiting_approval"],
  ["validating", "approved"],
  ["validating", "rejected"],
  ["validating", "failed"],
  ["validating", "cancelled"],
  ["awaiting_approval", "approved"],
  ["awaiting_approval", "rejected"],
  ["awaiting_approval", "expired"],
  ["awaiting_approval", "cancelled"],
  ["approved", "executing"],
  ["approved", "failed"],
  ["approved", "cancelled"],
  ["executing", "verifying"],
  ["executing", "failed"],
  ["verifying", "completed"],
  ["verifying", "partially_completed"],
  ["verifying", "failed"],
  ["completed", "rolling_back"],
  ["partially_completed", "rolling_back"],
  ["rolling_back", "rolled_back"],
  ["rolling_back", "rollback_failed"],
];

describe("action lifecycle", () => {
  it("has exactly the 15 statuses from the spec", () => {
    expect([...LIFECYCLE_STATUSES].sort()).toEqual(
      [
        "approved", "awaiting_approval", "cancelled", "completed", "executing",
        "expired", "failed", "partially_completed", "proposed", "rejected",
        "rollback_failed", "rolled_back", "rolling_back", "validating", "verifying",
      ],
    );
  });

  it("allows the 23 transitions in §7.2 and refuses the other 202 ordered pairs", () => {
    let allowedCount = 0;
    for (const from of LIFECYCLE_STATUSES) {
      for (const to of LIFECYCLE_STATUSES) {
        const expected = ALLOWED.some(([f, t]) => f === from && t === to);
        if (expected) allowedCount++;
        expect(isAllowedTransition(from, to), `${from} → ${to}`).toBe(expected);
      }
    }
    expect(allowedCount).toBe(23);
  });

  it("recognises status strings", () => {
    expect(isLifecycleStatus("rolling_back")).toBe(true);
    expect(isLifecycleStatus("executed")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/domain && npx vitest run src/actions/lifecycle.test.ts`
Expected: FAIL, cannot resolve `./lifecycle.js`.

- [ ] **Step 3: Write `lifecycle.ts`**

```ts
// Spec §7.1–7.2. Statuses are stored lowercase; an `executing` action has had its executor called.

export const LIFECYCLE_STATUSES = [
  "proposed",
  "validating",
  "awaiting_approval",
  "approved",
  "executing",
  "verifying",
  "completed",
  "partially_completed",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Readonly<Record<LifecycleStatus, readonly LifecycleStatus[]>> = {
  proposed: ["validating", "cancelled"],
  validating: ["awaiting_approval", "approved", "rejected", "failed", "cancelled"],
  awaiting_approval: ["approved", "rejected", "expired", "cancelled"],
  approved: ["executing", "failed", "cancelled"],
  executing: ["verifying", "failed"],
  verifying: ["completed", "partially_completed", "failed"],
  completed: ["rolling_back"],
  partially_completed: ["rolling_back"],
  rejected: [],
  expired: [],
  cancelled: [],
  failed: [],
  rolling_back: ["rolled_back", "rollback_failed"],
  rolled_back: [],
  rollback_failed: [],
};

export const IN_PROGRESS_STATUSES: readonly LifecycleStatus[] = [
  "proposed",
  "validating",
  "approved",
  "executing",
  "verifying",
  "rolling_back",
];

export function isAllowedTransition(from: LifecycleStatus, to: LifecycleStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isLifecycleStatus(value: string): value is LifecycleStatus {
  return (LIFECYCLE_STATUSES as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Write `types.ts`**

```ts
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
```

- [ ] **Step 5: Write `errors.ts`**

```ts
export class ActionNotFoundError extends Error {
  constructor(readonly actionId: string) {
    super(`Action not found: ${actionId}`);
    this.name = "ActionNotFoundError";
  }
}

/** The action's status changed since the caller read it (spec §8.3: double-click Approve gets 409). */
export class TransitionConflictError extends Error {
  constructor(readonly actionId: string, readonly expected: string, readonly actual: string) {
    super(`Action ${actionId} is ${actual}, expected ${expected}`);
    this.name = "TransitionConflictError";
  }
}

export class LifecycleTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Transition not allowed: ${from} → ${to}`);
    this.name = "LifecycleTransitionError";
  }
}

/**
 * Thrown by adapters that call external systems. `definite` guarantees nothing changed;
 * `unknown` means it may have (spec §10.4). Never retried by the HTTP retry helper.
 */
export class ExternalCallError extends Error {
  readonly retryable = false;

  constructor(readonly outcome: "definite" | "unknown", readonly code: string, message: string) {
    super(message);
    this.name = "ExternalCallError";
  }
}
```

- [ ] **Step 6: Write `repository.port.ts`**

```ts
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
  markUndoStarted(actionId: string, at: string): void;
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
```

- [ ] **Step 7: Extend the calendar and notification ports**

In `packages/domain/src/ports/calendar.port.ts`, add two optional fields to `CalendarEvent` (after `location`) and append the new interfaces. Leave `CalendarPort` exactly as it is.

```ts
  location: string | null;
  /** Google's version tag; present on events read through CalendarReader.getEvent. */
  etag?: string | null;
  /** Last-modified timestamp from Google. */
  updated?: string | null;
}
```

```ts
export type CalendarSendUpdates = "all" | "none";

/** An event as Oneon writes it; Google assigns etag and updated. */
export type CalendarEventDraft = Omit<CalendarEvent, "id" | "etag" | "updated">;

export interface CalendarReader {
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  searchEvents(query: string, timeMin?: string, timeMax?: string): Promise<CalendarEvent[]>;
  /** Returns null when the event does not exist or has been cancelled. */
  getEvent(id: string): Promise<CalendarEvent | null>;
}

/**
 * Only action executors receive a CalendarWriter (spec §5, enforced in Task 16).
 * Errors are ExternalCallError with a definite or unknown outcome.
 */
export interface CalendarWriter {
  create(
    event: CalendarEventDraft,
    options: { eventId: string; sendUpdates: CalendarSendUpdates },
  ): Promise<CalendarEvent>;
  update(
    id: string,
    changes: Partial<CalendarEventDraft>,
    options: { ifMatch: string; sendUpdates: CalendarSendUpdates },
  ): Promise<CalendarEvent>;
  remove(id: string, options: { ifMatch: string; sendUpdates: CalendarSendUpdates }): Promise<void>;
}
```

Append to `packages/domain/src/ports/notification.port.ts`:

```ts
export type NotificationSendResult =
  | { status: "delivered"; notificationId: string }
  | { status: "suppressed"; reason: "quiet_hours" | "type_disabled" };

/** Used by the notify executor; reports what happened instead of returning void. */
export interface NotificationWriter {
  deliver(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId: string;
  }): Promise<NotificationSendResult>;
}
```

- [ ] **Step 8: Write `capabilities.ts` and `actions/index.ts`**

`packages/domain/src/actions/capabilities.ts`:

```ts
import type { Deadline, Notification } from "../entities.js";
import type { CalendarReader, CalendarWriter } from "../ports/calendar.port.js";
import type { NotificationWriter } from "../ports/notification.port.js";

export type SuppressionReason = "quiet_hours" | "type_disabled";

/** Read-only access handed to preconditions, resolve and verification. */
export interface ActionReaders {
  calendar: CalendarReader | null;
  deadlines: { findById(id: string): Deadline | null };
  notifications: {
    isSuppressed(userId: string, eventType: string, now: Date): SuppressionReason | null;
    findById(id: string): Notification | null;
  };
  identity: { googleEmail: string | null };
  links: { inboundItem(id: string): string };
}

/** Write access; only executors receive it. */
export interface ActionWriters {
  calendar: CalendarWriter | null;
  notifications: NotificationWriter | null;
}

export interface ActionCapabilities {
  readers: ActionReaders;
  writers: ActionWriters;
}
```

`packages/domain/src/actions/index.ts`:

```ts
export * from "./lifecycle.js";
export * from "./types.js";
export * from "./errors.js";
export * from "./repository.port.js";
export * from "./capabilities.js";
```

In `packages/domain/src/index.ts` add after the `user-scoped-preferences` line:

```ts
export * from "./actions/index.js";
```

- [ ] **Step 9: Run tests, build and typecheck**

Run: `cd packages/domain && npx vitest run src/actions/lifecycle.test.ts`
Expected: PASS (3 tests).
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: all green; 1,138 tests.

- [ ] **Step 10: Commit**

```bash
git add packages/domain
git commit -m "feat(actions): add lifecycle, instance types and ports to domain" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared notification suppression and the notification writer

Moves the quiet-hours / type-toggle check out of `InAppNotificationAdapter` into one domain function, so `notify`'s precondition and the adapter cannot disagree (spec §9.6), and adds `deliver()` returning the new notification's ID.

**Files:**
- Create: `packages/domain/src/notification-suppression.ts`
- Test: `packages/domain/src/notification-suppression.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/enums.ts` (new notification type)
- Modify: `packages/infrastructure/src/notifications/in-app-notification-adapter.ts`
- Test: `packages/infrastructure/src/notifications/__tests__/in-app-notification-adapter.test.ts` (add cases)

**Interfaces:**
- Consumes: `PreferenceRepository`, `getUserScopedPreference` (domain); `NotificationWriter`, `NotificationSendResult`, `SuppressionReason` (Task 1).
- Produces:
  - `evaluateNotificationSuppression(prefs: PreferenceRepository, userId: string | null, eventType: string, now: Date, onInvalid?: (message: string, meta: Record<string, unknown>) => void): SuppressionReason | null`
  - `NotificationEventType.ActionRollbackFailed = "action_rollback_failed"`
  - `InAppNotificationAdapter implements NotificationPort, NotificationWriter` with `deliver(...)`.

- [ ] **Step 1: Write the failing domain test**

`packages/domain/src/notification-suppression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { PreferenceRepository, Preference } from "./index.js";
import { evaluateNotificationSuppression } from "./notification-suppression.js";

function prefs(values: Record<string, string>): PreferenceRepository {
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
      return { key, value, updatedAt: "2026-10-01T00:00:00.000Z" } as Preference;
    },
    getAll: () => [],
    delete: (key) => {
      delete values[key];
    },
  };
}

// 2026-10-01T23:30:00Z is 23:30 in UTC.
const LATE = new Date("2026-10-01T23:30:00.000Z");
const NOON = new Date("2026-10-01T12:00:00.000Z");

describe("evaluateNotificationSuppression", () => {
  it("returns type_disabled when the user turned the event type off", () => {
    const repo = prefs({ "user:u1:notification.enabled.urgent_item": "false" });
    expect(evaluateNotificationSuppression(repo, "u1", "urgent_item", NOON)).toBe("type_disabled");
  });

  it("returns quiet_hours inside an overnight window in the user's timezone", () => {
    const repo = prefs({
      "user:u1:notification.quiet_hours": JSON.stringify({ start: "22:00", end: "07:00" }),
      "user:u1:notification.timezone": "UTC",
    });
    expect(evaluateNotificationSuppression(repo, "u1", "urgent_item", LATE)).toBe("quiet_hours");
  });

  it("returns null outside quiet hours", () => {
    const repo = prefs({
      "user:u1:notification.quiet_hours": JSON.stringify({ start: "22:00", end: "07:00" }),
      "user:u1:notification.timezone": "UTC",
    });
    expect(evaluateNotificationSuppression(repo, "u1", "urgent_item", NOON)).toBeNull();
  });

  it("ignores malformed quiet hours and reports it", () => {
    const repo = prefs({ "user:u1:notification.quiet_hours": "not json" });
    const reported: string[] = [];
    expect(
      evaluateNotificationSuppression(repo, "u1", "urgent_item", NOON, (m) => reported.push(m)),
    ).toBeNull();
    expect(reported).toEqual(["Invalid quiet hours preference, ignoring"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/domain && npx vitest run src/notification-suppression.test.ts`
Expected: FAIL, cannot resolve `./notification-suppression.js`.

- [ ] **Step 3: Write `notification-suppression.ts`** (logic moved verbatim from the adapter's `isQuietHours` and toggle check)

```ts
import type { PreferenceRepository } from "./ports/preference-repository.port.js";
import type { SuppressionReason } from "./actions/capabilities.js";
import { getUserScopedPreference } from "./user-scoped-preferences.js";

type Report = (message: string, meta: Record<string, unknown>) => void;

function read(prefs: PreferenceRepository, userId: string | null, key: string): string | null {
  return userId ? getUserScopedPreference(prefs, userId, key) : prefs.get(key);
}

/**
 * Shared by the in-app adapter and notify's precondition, so they cannot disagree.
 * Type toggle: `notification.enabled.<eventType>` ("false" disables; default enabled).
 * Quiet hours: `notification.quiet_hours` = {"start":"HH:mm","end":"HH:mm"}, evaluated in
 * `notification.timezone`, falling back to server-local time.
 */
export function evaluateNotificationSuppression(
  prefs: PreferenceRepository,
  userId: string | null,
  eventType: string,
  now: Date,
  onInvalid: Report = () => {},
): SuppressionReason | null {
  if (read(prefs, userId, `notification.enabled.${eventType}`) === "false") {
    return "type_disabled";
  }
  return isQuietHours(prefs, userId, now, onInvalid) ? "quiet_hours" : null;
}

function isQuietHours(prefs: PreferenceRepository, userId: string | null, now: Date, onInvalid: Report): boolean {
  const quietHoursJson = read(prefs, userId, "notification.quiet_hours");
  if (!quietHoursJson) return false;

  try {
    const { start, end } = JSON.parse(quietHoursJson) as { start?: string; end?: string };
    if (!start || !end) return false;

    const tz = read(prefs, userId, "notification.timezone");
    let currentMinutes: number;
    if (tz) {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "numeric",
          hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
        const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        currentMinutes = hour * 60 + minute;
      } catch {
        onInvalid("Invalid notification.timezone, falling back to server time", { timezone: tz });
        currentMinutes = now.getHours() * 60 + now.getMinutes();
      }
    } else {
      currentMinutes = now.getHours() * 60 + now.getMinutes();
    }

    const [startH, startM] = start.split(":").map(Number);
    const [endH, endM] = end.split(":").map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } catch {
    onInvalid("Invalid quiet hours preference, ignoring", { raw: quietHoursJson });
    return false;
  }
}
```

(`% 24` handles `Intl` returning `24` for midnight in `hour12: false`.)

Add to `packages/domain/src/index.ts`:

```ts
export * from "./notification-suppression.js";
```

In `packages/domain/src/enums.ts`, extend `NotificationEventType`:

```ts
export const NotificationEventType = {
  UrgentItem: "urgent_item",
  DeadlineApproaching: "deadline_approaching",
  ActionProposed: "action_proposed",
  ActionExecuted: "action_executed",
  ActionRollbackFailed: "action_rollback_failed",
} as const;
```

- [ ] **Step 4: Run the domain test**

Run: `cd packages/domain && npx vitest run src/notification-suppression.test.ts`
Expected: PASS (4 tests). Then `pnpm --filter @oneon/domain build`.

- [ ] **Step 5: Write the failing adapter tests**

Add to `packages/infrastructure/src/notifications/__tests__/in-app-notification-adapter.test.ts` (reuse the file's existing repo/prefs mock helpers; if the file builds mocks inline, build them the same way):

```ts
describe("InAppNotificationAdapter.deliver", () => {
  it("returns the created notification's id", async () => {
    const created = { id: "n-1" };
    const notificationRepo = { create: vi.fn().mockReturnValue(created) } as unknown as NotificationRepository;
    const preferenceRepo = { get: vi.fn().mockReturnValue(null) } as unknown as PreferenceRepository;
    const adapter = new InAppNotificationAdapter({ notificationRepo, preferenceRepo, logger });

    await expect(
      adapter.deliver({ eventType: "urgent_item", title: "Urgent: Q4", body: "s", userId: "u1" }),
    ).resolves.toEqual({ status: "delivered", notificationId: "n-1" });
  });

  it("reports suppression instead of writing", async () => {
    const notificationRepo = { create: vi.fn() } as unknown as NotificationRepository;
    const preferenceRepo = {
      get: vi.fn((key: string) => (key === "user:u1:notification.enabled.urgent_item" ? "false" : null)),
    } as unknown as PreferenceRepository;
    const adapter = new InAppNotificationAdapter({ notificationRepo, preferenceRepo, logger });

    await expect(
      adapter.deliver({ eventType: "urgent_item", title: "t", body: "b", userId: "u1" }),
    ).resolves.toEqual({ status: "suppressed", reason: "type_disabled" });
    expect(notificationRepo.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd packages/infrastructure && npx vitest run src/notifications`
Expected: FAIL, `adapter.deliver is not a function`.

- [ ] **Step 7: Rewrite the adapter around `deliver`**

Replace the body of `InAppNotificationAdapter` (keep the constructor and fields) with:

```ts
export class InAppNotificationAdapter implements NotificationPort, NotificationWriter {
  // constructor and fields unchanged

  async send(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<void> {
    await this.write(notification);
  }

  async deliver(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId: string;
  }): Promise<NotificationSendResult> {
    return this.write(notification);
  }

  private async write(notification: {
    eventType: string;
    title: string;
    body: string;
    deepLink?: string;
    userId?: string | null;
  }): Promise<NotificationSendResult> {
    const userId = notification.userId ?? null;
    const suppressed = evaluateNotificationSuppression(
      this.preferenceRepo,
      userId,
      notification.eventType,
      new Date(),
      (message, meta) => this.logger.warn(message, meta),
    );
    if (suppressed) {
      this.logger.debug("Notification suppressed", { eventType: notification.eventType, reason: suppressed });
      return { status: "suppressed", reason: suppressed };
    }

    const created = this.notificationRepo.create({
      eventType: notification.eventType,
      title: notification.title,
      body: notification.body,
      deepLink: notification.deepLink ?? null,
      read: false,
      userId,
    });
    this.logger.info("Notification created", { id: created.id, eventType: notification.eventType });
    return { status: "delivered", notificationId: created.id };
  }
}
```

Update the imports at the top:

```ts
import type {
  NotificationPort,
  NotificationRepository,
  NotificationSendResult,
  NotificationWriter,
  PreferenceRepository,
  Logger,
} from "@oneon/domain";
import { evaluateNotificationSuppression } from "@oneon/domain";
```

Delete the private `isQuietHours` method and the `getUserScopedPreference` import.

- [ ] **Step 8: Run tests, build, typecheck**

Run: `cd packages/infrastructure && npx vitest run src/notifications`
Expected: PASS, including the existing quiet-hours tests (behaviour unchanged).
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add packages/domain packages/infrastructure/src/notifications
git commit -m "feat(notifications): share suppression check and report delivery results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: SQLite storage — migration 014 and repositories

Implements spec §8: new tables, immutability triggers, the single transition path, config with history, the locked legacy table, and the drift check.

**Files:**
- Create: `packages/infrastructure/src/database/migrations/014_action_spec_framework.sql`
- Modify: `packages/infrastructure/src/database/connection.ts` (register v14 + backfill check)
- Create: `packages/infrastructure/src/database/repositories/sqlite-action-instance.repository.ts`
- Create: `packages/infrastructure/src/database/repositories/sqlite-action-config.repository.ts`
- Create: `packages/infrastructure/src/database/repositories/sqlite-legacy-action.repository.ts`
- Create: `packages/infrastructure/src/database/action-drift-check.ts`
- Modify: `packages/infrastructure/src/database/repositories/index.ts`, `packages/infrastructure/src/database/index.ts`
- Test: `packages/infrastructure/src/database/action-storage.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 ports, `isAllowedTransition`, errors.
- Produces:
  - `new SqliteActionInstanceRepository(db, clock?: () => Date)` implements `ActionInstanceRepository`
  - `new SqliteActionConfigRepository(db, clock?)` implements `ActionConfigRepository`
  - `new SqliteLegacyActionRepository(db, clock?)` implements `LegacyActionRepository`
  - `runActionDriftCheck(db: Database.Database, logger: Logger): number` (number of repaired instances)

- [ ] **Step 1: Write the failing integration tests**

`packages/infrastructure/src/database/action-storage.integration.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import type { Logger, NewActionInstance } from "@oneon/domain";
import { TransitionConflictError, LifecycleTransitionError } from "@oneon/domain";
import { createDatabase, runMigrations } from "./connection.js";
import { SqliteActionInstanceRepository } from "./repositories/sqlite-action-instance.repository.js";
import { SqliteActionConfigRepository } from "./repositories/sqlite-action-config.repository.js";
import { SqliteLegacyActionRepository } from "./repositories/sqlite-legacy-action.repository.js";
import { runActionDriftCheck } from "./action-drift-check.js";

const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
const USER = { kind: "user" as const, userId: "user-A" };
const SYSTEM = { kind: "system" as const };

function newInstance(overrides: Partial<NewActionInstance> = {}): NewActionInstance {
  return {
    id: "act-1",
    scope: "personal",
    ownerId: "user-A",
    userId: "user-A",
    tenantId: null,
    locationIds: [],
    actionType: "notify",
    definitionVersion: "1",
    initiator: "rule:inbox.urgent_notify",
    initiatorUserId: null,
    input: { inboundItemId: "item-1" },
    evidence: [],
    idempotencyKey: "email:item-1",
    retryOf: null,
    attemptNumber: 1,
    resourceRef: "inbound_item:item-1",
    ...overrides,
  };
}

let db: Database.Database;
let repo: SqliteActionInstanceRepository;

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES (?, ?), (?, ?)").run("user-A", "a@test.com", "user-B", "b@test.com");
  repo = new SqliteActionInstanceRepository(db, () => new Date("2026-10-01T12:00:00.000Z"));
});

describe("migration 014", () => {
  it("renames action_log to a read-only legacy table", () => {
    db.prepare(
      "INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id) VALUES ('l1', 'item-1', 'archive', 'approval_required', 'proposed', 'user-A')",
    ).run();
    expect(() => db.prepare("UPDATE action_log_legacy SET status = 'rejected'").run()).toThrow(
      "action_log_legacy is read-only",
    );
    expect(() => db.prepare("DELETE FROM action_log_legacy").run()).toThrow("action_log_legacy is read-only");
    const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='action_log'").get();
    expect(legacyTable).toBeUndefined();
  });

  it("rejects a personal instance with a tenant and a tenant instance without one", () => {
    const insert = (scope: string, tenant: string | null, owner: string) =>
      db
        .prepare(
          `INSERT INTO action_instances (id, scope, owner_id, user_id, tenant_id, action_type, definition_version, status, initiator, input_json, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, 'user-A', ?, 'notify', '1', 'proposed', 'user', '{}', ?, 'now', 'now')`,
        )
        .run(`x-${scope}-${tenant}`, scope, owner, tenant, `k-${scope}-${tenant}`);
    expect(() => insert("personal", "t-1", "user-A")).toThrow(/CHECK constraint failed/);
    expect(() => insert("tenant", null, "user-A")).toThrow(/CHECK constraint failed/);
  });
});

describe("SqliteActionInstanceRepository", () => {
  it("creates a proposed instance with event 1", () => {
    const { instance, created } = repo.create(newInstance(), USER, { note: "x" });
    expect(created).toBe(true);
    expect(instance.status).toBe("proposed");
    expect(instance.lastEventSeq).toBe(1);
    const events = repo.listEvents("user-A", "act-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, fromStatus: null, toStatus: "proposed", actor: USER, data: { note: "x" } });
  });

  it("returns the existing instance for a duplicate key without a new event", () => {
    repo.create(newInstance(), USER);
    const second = repo.create(newInstance({ id: "act-2" }), USER);
    expect(second.created).toBe(false);
    expect(second.instance.id).toBe("act-1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM action_events").get()).toEqual({ n: 1 });
  });

  it("appends a transition and applies the patch", () => {
    repo.create(newInstance(), USER);
    repo.appendTransition({ actionId: "act-1", expectedStatus: "proposed", toStatus: "validating", actor: SYSTEM });
    const after = repo.appendTransition({
      actionId: "act-1",
      expectedStatus: "validating",
      toStatus: "approved",
      actor: { kind: "policy" },
      data: { decision: "auto" },
      patch: { resolved: { metrics: {} }, decision: { outcome: "auto" } },
    });
    expect(after).toMatchObject({ status: "approved", lastEventSeq: 3, resolved: { metrics: {} }, decision: { outcome: "auto" } });
    expect(repo.listEvents("user-A", "act-1").map((e) => e.toStatus)).toEqual(["proposed", "validating", "approved"]);
  });

  it("refuses a stale expected status and records nothing", () => {
    repo.create(newInstance(), USER);
    expect(() =>
      repo.appendTransition({ actionId: "act-1", expectedStatus: "validating", toStatus: "approved", actor: SYSTEM }),
    ).toThrow(TransitionConflictError);
    expect(repo.listEvents("user-A", "act-1")).toHaveLength(1);
  });

  it("refuses a transition the lifecycle does not allow", () => {
    repo.create(newInstance(), USER);
    expect(() =>
      repo.appendTransition({ actionId: "act-1", expectedStatus: "proposed", toStatus: "completed", actor: SYSTEM }),
    ).toThrow(LifecycleTransitionError);
  });

  it("makes events append-only", () => {
    repo.create(newInstance(), USER);
    expect(() => db.prepare("UPDATE action_events SET to_status = 'failed'").run()).toThrow("action_events is append-only");
    expect(() => db.prepare("DELETE FROM action_events").run()).toThrow("action_events is append-only");
  });

  it("never returns another owner's action or events", () => {
    repo.create(newInstance(), USER);
    expect(repo.findById("user-B", "act-1")).toBeNull();
    expect(repo.listEvents("user-B", "act-1")).toEqual([]);
    expect(repo.list("user-B")).toEqual([]);
    expect(repo.count("user-B")).toBe(0);
  });

  it("filters by status and resource", () => {
    repo.create(newInstance(), USER);
    repo.create(newInstance({ id: "act-2", idempotencyKey: "email:item-2", resourceRef: "inbound_item:item-2" }), USER);
    repo.appendTransition({ actionId: "act-2", expectedStatus: "proposed", toStatus: "cancelled", actor: USER });
    expect(repo.list("user-A", { statuses: ["cancelled"] }).map((i) => i.id)).toEqual(["act-2"]);
    expect(repo.list("user-A", { resourceRef: "inbound_item:item-1" }).map((i) => i.id)).toEqual(["act-1"]);
    expect(repo.count("user-A", { statuses: ["proposed", "cancelled"] })).toBe(2);
  });

  it("records heartbeats and undo starts without touching status or events", () => {
    repo.create(newInstance(), USER);
    repo.recordHeartbeat("act-1", "2026-10-01T12:01:00.000Z");
    repo.markUndoStarted("act-1", "2026-10-01T12:02:00.000Z");
    const after = repo.findById("user-A", "act-1")!;
    expect(after).toMatchObject({ status: "proposed", lastHeartbeatAt: "2026-10-01T12:01:00.000Z", undoStartedAt: "2026-10-01T12:02:00.000Z", lastEventSeq: 1 });
  });
});

describe("runActionDriftCheck", () => {
  it("rebuilds a drifted status from the events", () => {
    repo.create(newInstance(), USER);
    db.prepare("UPDATE action_instances SET status = 'completed' WHERE id = 'act-1'").run();
    expect(runActionDriftCheck(db, logger)).toBe(1);
    expect(repo.findById("user-A", "act-1")!.status).toBe("proposed");
    expect(runActionDriftCheck(db, logger)).toBe(0);
  });
});

describe("SqliteActionConfigRepository", () => {
  it("saves config and appends history that cannot be edited", () => {
    const config = new SqliteActionConfigRepository(db, () => new Date("2026-10-02T09:00:00.000Z"));
    config.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: '{"approval":{"mode":"auto"}}', changedBy: "user-A" });
    config.save({ scope: "personal", ownerId: "user-A", actionType: "create_reminder", configJson: '{"approval":{"mode":"always"}}', changedBy: "user-A" });
    expect(config.get("personal", "user-A", "create_reminder")).toMatchObject({ configJson: '{"approval":{"mode":"always"}}', updatedBy: "user-A" });
    const history = config.history("personal", "user-A", "create_reminder", 10);
    expect(history.map((h) => [h.oldJson, h.newJson])).toEqual([
      ['{"approval":{"mode":"auto"}}', '{"approval":{"mode":"always"}}'],
      [null, '{"approval":{"mode":"auto"}}'],
    ]);
    expect(() => db.prepare("DELETE FROM action_definition_config_history").run()).toThrow(
      "action_definition_config_history is append-only",
    );
  });
});

describe("SqliteLegacyActionRepository", () => {
  it("lists only rows that were not imported", () => {
    db.prepare(
      `INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id, created_at)
       VALUES ('l1','item-1','archive','approval_required','proposed','user-A','2026-09-01T00:00:00Z'),
              ('l2','item-2','notify','auto','executed','user-A','2026-09-02T00:00:00Z')`,
    ).run();
    const legacy = new SqliteLegacyActionRepository(db);
    expect(legacy.listUnimportedProposed("user-A").map((r) => r.id)).toEqual(["l1"]);
    repo.create(newInstance({ id: "act-9", actionType: "archive", idempotencyKey: "email:item-1" }), USER);
    legacy.recordImport("l1", "act-9");
    expect(legacy.listForUser("user-A", { limit: 10, offset: 0 }).map((r) => r.id)).toEqual(["l2"]);
    expect(legacy.countForUser("user-A")).toBe(1);
    expect(legacy.listUnimportedProposed("user-A")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/infrastructure && npx vitest run src/database/action-storage.integration.test.ts`
Expected: FAIL, cannot resolve the repository modules.

- [ ] **Step 3: Write migration 014**

`packages/infrastructure/src/database/migrations/014_action_spec_framework.sql`:

```sql
-- Migration 014: Action Spec framework (spec §8). Supersedes ADR-006's action_log.

ALTER TABLE action_log RENAME TO action_log_legacy;

CREATE TRIGGER IF NOT EXISTS action_log_legacy_no_update
BEFORE UPDATE ON action_log_legacy
BEGIN SELECT RAISE(ABORT, 'action_log_legacy is read-only'); END;

CREATE TRIGGER IF NOT EXISTS action_log_legacy_no_delete
BEFORE DELETE ON action_log_legacy
BEGIN SELECT RAISE(ABORT, 'action_log_legacy is read-only'); END;

CREATE TABLE IF NOT EXISTS action_instances (
  id                   TEXT PRIMARY KEY,
  scope                TEXT NOT NULL CHECK (scope IN ('personal', 'tenant')),
  owner_id             TEXT NOT NULL,
  user_id              TEXT NOT NULL REFERENCES users (id),
  tenant_id            TEXT,
  location_ids_json    TEXT NOT NULL DEFAULT '[]',
  action_type          TEXT NOT NULL,
  definition_version   TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN (
                         'proposed', 'validating', 'awaiting_approval', 'approved', 'executing',
                         'verifying', 'completed', 'partially_completed', 'rejected', 'expired',
                         'cancelled', 'failed', 'rolling_back', 'rolled_back', 'rollback_failed')),
  initiator            TEXT NOT NULL,
  initiator_user_id    TEXT,
  input_json           TEXT NOT NULL,
  resolved_json        TEXT,
  evidence_json        TEXT NOT NULL DEFAULT '[]',
  decision_json        TEXT,
  result_json          TEXT,
  error_json           TEXT,
  undo_json            TEXT,
  idempotency_key      TEXT NOT NULL,
  retry_of             TEXT REFERENCES action_instances (id),
  attempt_number       INTEGER NOT NULL DEFAULT 1,
  executor_request_id  TEXT,
  execution_started_at TEXT,
  last_heartbeat_at    TEXT,
  undo_started_at      TEXT,
  resource_ref         TEXT,
  last_event_seq       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (
    (scope = 'personal' AND tenant_id IS NULL AND owner_id = user_id)
    OR (scope = 'tenant' AND tenant_id IS NOT NULL AND owner_id = tenant_id)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_action_instances_key
  ON action_instances (scope, owner_id, action_type, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_action_instances_owner_status
  ON action_instances (owner_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_action_instances_resource
  ON action_instances (resource_ref);

CREATE TABLE IF NOT EXISTS action_events (
  id          TEXT PRIMARY KEY,
  action_id   TEXT NOT NULL REFERENCES action_instances (id),
  seq         INTEGER NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_json  TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (action_id, seq)
);

CREATE TRIGGER IF NOT EXISTS action_events_no_update
BEFORE UPDATE ON action_events
BEGIN SELECT RAISE(ABORT, 'action_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS action_events_no_delete
BEFORE DELETE ON action_events
BEGIN SELECT RAISE(ABORT, 'action_events is append-only'); END;

CREATE TABLE IF NOT EXISTS action_definition_configs (
  scope       TEXT NOT NULL CHECK (scope IN ('personal', 'tenant')),
  owner_id    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (scope, owner_id, action_type)
);

CREATE TABLE IF NOT EXISTS action_definition_config_history (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  owner_id    TEXT NOT NULL,
  action_type TEXT NOT NULL,
  old_json    TEXT,
  new_json    TEXT NOT NULL,
  changed_by  TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_config_history_lookup
  ON action_definition_config_history (scope, owner_id, action_type, changed_at);

CREATE TRIGGER IF NOT EXISTS action_config_history_no_update
BEFORE UPDATE ON action_definition_config_history
BEGIN SELECT RAISE(ABORT, 'action_definition_config_history is append-only'); END;

CREATE TRIGGER IF NOT EXISTS action_config_history_no_delete
BEFORE DELETE ON action_definition_config_history
BEGIN SELECT RAISE(ABORT, 'action_definition_config_history is append-only'); END;

CREATE TABLE IF NOT EXISTS action_legacy_imports (
  legacy_id   TEXT PRIMARY KEY REFERENCES action_log_legacy (id),
  action_id   TEXT NOT NULL REFERENCES action_instances (id),
  imported_at TEXT NOT NULL
);
```

In `connection.ts`, add to the `migrations` array:

```ts
    { version: 14, name: "action_spec_framework", file: "014_action_spec_framework.sql" },
```

and to `migrationAlreadyAppliedInSchema`:

```ts
    case 14:
      return (
        hasTable(db, "action_instances") &&
        hasTable(db, "action_events") &&
        hasTable(db, "action_log_legacy") &&
        !hasTable(db, "action_log")
      );
```

- [ ] **Step 4: Write `sqlite-action-instance.repository.ts`**

```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  ActionNotFoundError,
  LifecycleTransitionError,
  TransitionConflictError,
  isAllowedTransition,
  type ActionEvent,
  type ActionInstance,
  type ActionInstanceRepository,
  type ActorRef,
  type CreateInstanceResult,
  type InstanceListFilter,
  type InstancePatch,
  type JsonObject,
  type LifecycleStatus,
  type NewActionInstance,
  type TransitionRequest,
} from "@oneon/domain";

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
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  create(instance: NewActionInstance, actor: ActorRef, data: JsonObject = {}): CreateInstanceResult {
    return this.db.transaction((): CreateInstanceResult => {
      const existing = this.db
        .prepare(
          "SELECT * FROM action_instances WHERE scope = ? AND owner_id = ? AND action_type = ? AND idempotency_key = ?",
        )
        .get(instance.scope, instance.ownerId, instance.actionType, instance.idempotencyKey) as InstanceRow | undefined;
      if (existing) return { instance: mapInstance(existing), created: false };

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
          instance.tenantId,
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
    return row ? mapInstance(row) : null;
  }

  list(ownerId: string, filter: InstanceListFilter = {}): ActionInstance[] {
    const { where, params } = this.where(ownerId, filter);
    const rows = this.db
      .prepare(`SELECT * FROM action_instances WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as InstanceRow[];
    return rows.map(mapInstance);
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
    return rows.map(mapEvent);
  }

  appendTransition(request: TransitionRequest): ActionInstance {
    return this.db.transaction((): ActionInstance => {
      const row = this.db.prepare("SELECT * FROM action_instances WHERE id = ?").get(request.actionId) as
        | InstanceRow
        | undefined;
      if (!row) throw new ActionNotFoundError(request.actionId);
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

  recordHeartbeat(actionId: string, at: string): void {
    this.db.prepare("UPDATE action_instances SET last_heartbeat_at = ? WHERE id = ?").run(at, actionId);
  }

  markUndoStarted(actionId: string, at: string): void {
    this.db.prepare("UPDATE action_instances SET undo_started_at = ? WHERE id = ?").run(at, actionId);
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
        `INSERT INTO action_events (id, action_id, seq, from_status, to_status, actor_json, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), actionId, seq, from, to, JSON.stringify(actor), JSON.stringify(data), at);
  }

  private mustFind(id: string): ActionInstance {
    const row = this.db.prepare("SELECT * FROM action_instances WHERE id = ?").get(id) as InstanceRow | undefined;
    if (!row) throw new ActionNotFoundError(id);
    return mapInstance(row);
  }
}
```

- [ ] **Step 5: Write the config and legacy repositories**

`sqlite-action-config.repository.ts`:

```ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  ActionConfigHistoryEntry,
  ActionConfigRecord,
  ActionConfigRepository,
  ActionScope,
} from "@oneon/domain";

interface ConfigRow {
  scope: ActionScope;
  owner_id: string;
  action_type: string;
  config_json: string;
  updated_by: string;
  updated_at: string;
}

interface HistoryRow {
  id: string;
  scope: ActionScope;
  owner_id: string;
  action_type: string;
  old_json: string | null;
  new_json: string;
  changed_by: string;
  changed_at: string;
}

const mapConfig = (r: ConfigRow): ActionConfigRecord => ({
  scope: r.scope,
  ownerId: r.owner_id,
  actionType: r.action_type,
  configJson: r.config_json,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

export class SqliteActionConfigRepository implements ActionConfigRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get(scope: ActionScope, ownerId: string, actionType: string): ActionConfigRecord | null {
    const row = this.db
      .prepare("SELECT * FROM action_definition_configs WHERE scope = ? AND owner_id = ? AND action_type = ?")
      .get(scope, ownerId, actionType) as ConfigRow | undefined;
    return row ? mapConfig(row) : null;
  }

  list(scope: ActionScope, ownerId: string): ActionConfigRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM action_definition_configs WHERE scope = ? AND owner_id = ? ORDER BY action_type")
      .all(scope, ownerId) as ConfigRow[];
    return rows.map(mapConfig);
  }

  save(input: { scope: ActionScope; ownerId: string; actionType: string; configJson: string; changedBy: string }): ActionConfigRecord {
    return this.db.transaction((): ActionConfigRecord => {
      const previous = this.get(input.scope, input.ownerId, input.actionType);
      const now = this.clock().toISOString();
      this.db
        .prepare(
          `INSERT INTO action_definition_configs (scope, owner_id, action_type, config_json, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (scope, owner_id, action_type)
           DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(input.scope, input.ownerId, input.actionType, input.configJson, input.changedBy, now);
      this.db
        .prepare(
          `INSERT INTO action_definition_config_history (id, scope, owner_id, action_type, old_json, new_json, changed_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), input.scope, input.ownerId, input.actionType, previous?.configJson ?? null, input.configJson, input.changedBy, now);
      return this.get(input.scope, input.ownerId, input.actionType)!;
    })();
  }

  history(scope: ActionScope, ownerId: string, actionType: string, limit: number): ActionConfigHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM action_definition_config_history
         WHERE scope = ? AND owner_id = ? AND action_type = ?
         ORDER BY changed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(scope, ownerId, actionType, limit) as HistoryRow[];
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      ownerId: r.owner_id,
      actionType: r.action_type,
      oldJson: r.old_json,
      newJson: r.new_json,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }
}
```

(The config test saves twice with the same clock value; `rowid DESC` keeps newest first.)

`sqlite-legacy-action.repository.ts`:

```ts
import type Database from "better-sqlite3";
import type { LegacyActionRepository, LegacyActionRow } from "@oneon/domain";

interface Row {
  id: string;
  user_id: string | null;
  resource_id: string;
  action_type: string;
  risk_level: string;
  status: string;
  payload_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

const map = (r: Row): LegacyActionRow => ({
  id: r.id,
  userId: r.user_id,
  resourceId: r.resource_id,
  actionType: r.action_type,
  riskLevel: r.risk_level,
  status: r.status,
  payloadJson: r.payload_json,
  resultJson: r.result_json,
  errorJson: r.error_json,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const NOT_IMPORTED = `FROM action_log_legacy l
  LEFT JOIN action_legacy_imports m ON m.legacy_id = l.id
  WHERE l.user_id = ? AND m.legacy_id IS NULL`;

export class SqliteLegacyActionRepository implements LegacyActionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  listForUser(userId: string, options: { limit: number; offset: number }): LegacyActionRow[] {
    const rows = this.db
      .prepare(`SELECT l.* ${NOT_IMPORTED} ORDER BY l.created_at DESC LIMIT ? OFFSET ?`)
      .all(userId, options.limit, options.offset) as Row[];
    return rows.map(map);
  }

  countForUser(userId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n ${NOT_IMPORTED}`).get(userId) as { n: number }).n;
  }

  listUnimportedProposed(userId: string): LegacyActionRow[] {
    const rows = this.db
      .prepare(`SELECT l.* ${NOT_IMPORTED} AND l.status = 'proposed' ORDER BY l.created_at ASC`)
      .all(userId) as Row[];
    return rows.map(map);
  }

  recordImport(legacyId: string, actionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO action_legacy_imports (legacy_id, action_id, imported_at) VALUES (?, ?, ?)")
      .run(legacyId, actionId, this.clock().toISOString());
  }
}
```

- [ ] **Step 6: Write the drift check**

`packages/infrastructure/src/database/action-drift-check.ts`:

```ts
import type Database from "better-sqlite3";
import type { Logger } from "@oneon/domain";

interface DriftRow {
  id: string;
  status: string;
  last_event_seq: number;
  event_status: string;
  event_seq: number;
}

/** Spec §8.4: events are authoritative; a projection that disagrees is rebuilt from them. */
export function runActionDriftCheck(db: Database.Database, logger: Logger): number {
  const drifted = db
    .prepare(
      `SELECT i.id, i.status, i.last_event_seq, e.to_status AS event_status, e.seq AS event_seq
       FROM action_instances i
       JOIN action_events e ON e.action_id = i.id
         AND e.seq = (SELECT MAX(seq) FROM action_events WHERE action_id = i.id)
       WHERE i.status <> e.to_status OR i.last_event_seq <> e.seq`,
    )
    .all() as DriftRow[];

  const repair = db.prepare("UPDATE action_instances SET status = ?, last_event_seq = ? WHERE id = ?");
  for (const row of drifted) {
    logger.error("Action projection drifted from its event log; rebuilding from events", {
      actionId: row.id,
      projectedStatus: row.status,
      eventStatus: row.event_status,
      projectedSeq: row.last_event_seq,
      eventSeq: row.event_seq,
    });
    repair.run(row.event_status, row.event_seq, row.id);
  }
  return drifted.length;
}
```

- [ ] **Step 7: Export the new modules**

Append to `packages/infrastructure/src/database/repositories/index.ts`:

```ts
export { SqliteActionInstanceRepository } from "./sqlite-action-instance.repository.js";
export { SqliteActionConfigRepository } from "./sqlite-action-config.repository.js";
export { SqliteLegacyActionRepository } from "./sqlite-legacy-action.repository.js";
```

Append to `packages/infrastructure/src/database/index.ts`:

```ts
export { runActionDriftCheck } from "./action-drift-check.js";
```

`SqliteActionLogRepository` stays exported until Task 17; it now points at a table that no longer exists, but nothing calls it at runtime after Task 14.

- [ ] **Step 8: Run tests, build, typecheck**

Run: `cd packages/infrastructure && npx vitest run src/database/action-storage.integration.test.ts`
Expected: PASS (16 tests).
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green. The agent-server `container.test.ts` builds a real container on `:memory:`; it still passes because nothing reads `action_log` during that test.

- [ ] **Step 9: Commit**

```bash
git add packages/infrastructure/src/database
git commit -m "feat(actions): add migration 014 and SQLite action repositories" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Calendar reader/writer and deadline lookup

Implements spec §9.6 and the Google response table in §10.4.

**Files:**
- Modify: `packages/infrastructure/src/calendar/calendar.types.ts` (add `etag`)
- Modify: `packages/infrastructure/src/calendar/gcal-http-client.ts`
- Modify: `packages/infrastructure/src/calendar/google-calendar-adapter.ts`
- Modify: `packages/infrastructure/src/http/fetch-with-retry.ts`
- Modify: `packages/infrastructure/src/database/repositories/sqlite-deadline.repository.ts` (`findById` public)
- Test: `packages/infrastructure/src/calendar/__tests__/google-calendar-writer.test.ts`
- Test: `packages/infrastructure/src/http/__tests__/fetch-with-retry.test.ts` (add case; create the folder if the existing test lives elsewhere — check `ls packages/infrastructure/src/http`)

**Interfaces:**
- Consumes: `CalendarReader`, `CalendarWriter`, `ExternalCallError` (Task 1).
- Produces:
  - `GCalApiError extends Error { status: number }` (exported from `calendar/index.ts`)
  - `GCalHttpClient.getEvent(calendarId, id): Promise<GCalEventResource | null>`; `insertEvent(calendarId, body, options: { sendUpdates })`; `patchEvent(calendarId, id, body, options: { ifMatch, sendUpdates })`; `deleteEvent(calendarId, id, options: { ifMatch, sendUpdates })`
  - `GoogleCalendarAdapter implements CalendarPort, CalendarReader, CalendarWriter` with `getEvent`, `create`, `update`, `remove`
  - `SqliteDeadlineRepository.findById(id): Deadline | null` (public; not added to the port)

- [ ] **Step 1: Write the failing adapter tests**

`packages/infrastructure/src/calendar/__tests__/google-calendar-writer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExternalCallError } from "@oneon/domain";
import { GCalHttpClient } from "../gcal-http-client.js";
import { GoogleCalendarAdapter } from "../google-calendar-adapter.js";
import { TTLCache } from "../../cache/ttl-cache.js";

const tokenProvider = { getAccessToken: vi.fn().mockResolvedValue("tok") };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function adapter() {
  return new GoogleCalendarAdapter({
    client: new GCalHttpClient(tokenProvider),
    calendarId: "test-cal",
    cache: new TTLCache(),
    cacheTtlMs: 1000,
  });
}

const EVENT = {
  id: "abc123",
  etag: '"v1"',
  updated: "2026-10-01T10:00:00.000Z",
  summary: "Call with Ama",
  start: { dateTime: "2026-10-07T10:00:00Z" },
  end: { dateTime: "2026-10-07T10:30:00Z" },
  attendees: [{ email: "ama@example.com" }],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GoogleCalendarAdapter reader", () => {
  it("returns the event with its version", async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await expect(adapter().getEvent("abc123")).resolves.toMatchObject({ id: "abc123", etag: '"v1"', title: "Call with Ama" });
  });

  it("returns null for 404 and 410", async () => {
    fetchMock.mockResolvedValueOnce(json(404, {})).mockResolvedValueOnce(json(410, {}));
    await expect(adapter().getEvent("x")).resolves.toBeNull();
    await expect(adapter().getEvent("x")).resolves.toBeNull();
  });

  it("treats a cancelled event as gone (Review Focus 3)", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...EVENT, status: "cancelled" }));
    await expect(adapter().getEvent("abc123")).resolves.toBeNull();
  });
});

describe("GoogleCalendarAdapter writer", () => {
  it("creates with the client-chosen id and explicit sendUpdates", async () => {
    fetchMock.mockResolvedValueOnce(json(200, EVENT));
    await adapter().create(
      { title: "Call with Ama", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", allDay: false, description: null, attendees: ["ama@example.com"], location: null },
      { eventId: "abc123", sendUpdates: "all" },
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get("sendUpdates")).toBe("all");
    expect(JSON.parse(init.body as string)).toMatchObject({ id: "abc123", summary: "Call with Ama" });
  });

  it("sends If-Match on update and remove", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...EVENT, etag: '"v2"' })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await adapter().update("abc123", { title: "New" }, { ifMatch: '"v1"', sendUpdates: "none" });
    await adapter().remove("abc123", { ifMatch: '"v2"', sendUpdates: "all" });
    const [, patchInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((patchInit.headers as Record<string, string>)["If-Match"]).toBe('"v1"');
    expect(deleteInit.method).toBe("DELETE");
    expect((deleteInit.headers as Record<string, string>)["If-Match"]).toBe('"v2"');
    expect(new URL(deleteUrl).searchParams.get("sendUpdates")).toBe("all");
  });

  it.each([
    [409, "unknown", "already_exists"],
    [412, "definite", "changed_since"],
    [400, "definite", "rejected_by_google"],
    [403, "definite", "rejected_by_google"],
    [404, "definite", "not_found"],
    [429, "unknown", "google_unavailable"],
    [503, "unknown", "google_unavailable"],
  ])("maps HTTP %i on create to %s / %s without retrying", async (status, outcome, code) => {
    fetchMock.mockResolvedValue(json(status, { error: { message: "x" } }));
    const error = await adapter()
      .create(
        { title: "t", start: "2026-10-07T10:00:00Z", end: "2026-10-07T11:00:00Z", allDay: false, description: null, attendees: [], location: null },
        { eventId: "abc123", sendUpdates: "none" },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalCallError);
    expect(error).toMatchObject({ outcome, code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to unknown", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const error = await adapter().remove("abc123", { ifMatch: '"v1"', sendUpdates: "none" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "unknown", code: "google_unreachable" });
  });

  it("maps a token refresh failure to a definite auth failure", async () => {
    tokenProvider.getAccessToken.mockRejectedValueOnce(new Error("Token refresh failed"));
    const error = await adapter().remove("abc123", { ifMatch: '"v1"', sendUpdates: "none" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: "definite", code: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

Add to the fetch-with-retry tests (in whichever file currently tests `fetchWithRetry`):

```ts
it("does not retry an error marked retryable: false", async () => {
  const error = Object.assign(new Error("auth"), { retryable: false });
  const fn = vi.fn().mockRejectedValue(error);
  await expect(fetchWithRetry(fn, { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toBe(error);
  expect(fn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/infrastructure && npx vitest run src/calendar src/http`
Expected: FAIL (`getEvent`/`create` not functions; retry test calls `fn` 4 times).

- [ ] **Step 3: Respect `retryable: false` in `fetchWithRetry`**

In `packages/infrastructure/src/http/fetch-with-retry.ts`, change `isRetryableError`:

```ts
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return false; // Timeout — don't retry
  }
  if (typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === false) {
    return false; // Caller marked it final (e.g. ExternalCallError)
  }
  return true; // Network errors — retry
}
```

- [ ] **Step 4: Extend the HTTP client**

In `calendar.types.ts`, add to `GCalEventResource`: `etag?: string;` and to `GCalEventWriteBody`: `id?: string;`.

In `gcal-http-client.ts`:

```ts
import { ExternalCallError } from "@oneon/domain";

export class GCalApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Google Calendar API error ${status}: ${body}`);
    this.name = "GCalApiError";
  }
}

type SendUpdates = "all" | "none";
```

Add methods to `GCalHttpClient`:

```ts
  async getEvent(calendarId: string, eventId: string): Promise<GCalEventResource | null> {
    try {
      const response = await this.request(this.eventUrl(calendarId, eventId));
      return (await response.json()) as GCalEventResource;
    } catch (error) {
      if (error instanceof GCalApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  async insertEvent(
    calendarId: string,
    body: GCalEventWriteBody,
    options: { sendUpdates: SendUpdates } = { sendUpdates: "none" },
  ): Promise<GCalEventResource> {
    const url = new URL(`${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("sendUpdates", options.sendUpdates);
    const response = await this.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      { retry: false },
    );
    return (await response.json()) as GCalEventResource;
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    body: Partial<GCalEventWriteBody>,
    options?: { ifMatch?: string; sendUpdates?: SendUpdates },
  ): Promise<GCalEventResource> {
    const url = this.eventUrl(calendarId, eventId);
    if (options?.sendUpdates) url.searchParams.set("sendUpdates", options.sendUpdates);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.ifMatch) headers["If-Match"] = options.ifMatch;
    const response = await this.request(
      url,
      { method: "PATCH", headers, body: JSON.stringify(body) },
      { retry: !options?.ifMatch },
    );
    return (await response.json()) as GCalEventResource;
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    options: { ifMatch: string; sendUpdates: SendUpdates },
  ): Promise<void> {
    const url = this.eventUrl(calendarId, eventId);
    url.searchParams.set("sendUpdates", options.sendUpdates);
    await this.request(url, { method: "DELETE", headers: { "If-Match": options.ifMatch } }, { retry: false });
  }

  private eventUrl(calendarId: string, eventId: string): URL {
    return new URL(`${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  }
```

The existing two-argument `patchEvent` callers keep working (third argument optional; without `ifMatch` the old retrying behaviour is kept). The existing `insertEvent(calendarId, body)` callers keep working through the default.

Replace `request` so token failures are final and writes can skip retries:

```ts
  private async request(url: URL, init?: RequestInit, options: { retry: boolean } = { retry: true }): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const attempt = async (): Promise<Response> => {
      let token: string;
      try {
        token = await this.tokenProvider.getAccessToken();
      } catch (error) {
        throw new ExternalCallError(
          "definite",
          "auth",
          `Google token unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return fetch(url.toString(), {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init?.headers },
        signal: controller.signal,
      });
    };

    try {
      const response = options.retry ? await fetchWithRetry(attempt) : await attempt();
      if (!response.ok) {
        throw new GCalApiError(response.status, await response.text());
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
```

- [ ] **Step 5: Implement reader and writer in the adapter**

In `google-calendar-adapter.ts`, change the class line and add methods:

```ts
import type {
  CalendarPort,
  CalendarEvent,
  CalendarReader,
  CalendarWriter,
  CalendarEventDraft,
  CalendarSendUpdates,
} from "@oneon/domain";
import { ExternalCallError } from "@oneon/domain";
import { GCalApiError, type GCalHttpClient } from "./gcal-http-client.js";

export class GoogleCalendarAdapter implements CalendarPort, CalendarReader, CalendarWriter {
  // ...existing members unchanged...

  async getEvent(id: string): Promise<CalendarEvent | null> {
    const resource = await this.client.getEvent(this.calendarId, id).catch(mapReadError);
    if (!resource || resource.status === "cancelled") return null;
    return mapToDomain(resource);
  }

  async create(
    event: CalendarEventDraft,
    options: { eventId: string; sendUpdates: CalendarSendUpdates },
  ): Promise<CalendarEvent> {
    const body = { ...mapToWriteBody(event), id: options.eventId };
    const created = await this.client
      .insertEvent(this.calendarId, body, { sendUpdates: options.sendUpdates })
      .catch((error: unknown) => mapWriteError(error, "create"));
    this.cache.invalidateByPrefix(this.cachePrefix);
    return mapToDomain(created);
  }

  async update(
    id: string,
    changes: Partial<CalendarEventDraft>,
    options: { ifMatch: string; sendUpdates: CalendarSendUpdates },
  ): Promise<CalendarEvent> {
    const updated = await this.client
      .patchEvent(this.calendarId, id, mapToPartialWriteBody(changes), options)
      .catch((error: unknown) => mapWriteError(error, "update"));
    this.cache.invalidateByPrefix(this.cachePrefix);
    return mapToDomain(updated);
  }

  async remove(id: string, options: { ifMatch: string; sendUpdates: CalendarSendUpdates }): Promise<void> {
    await this.client.deleteEvent(this.calendarId, id, options).catch((error: unknown) => mapWriteError(error, "remove"));
    this.cache.invalidateByPrefix(this.cachePrefix);
  }
}
```

Add `etag` and `updated` to `mapToDomain`:

```ts
    location: resource.location ?? null,
    etag: resource.etag ?? null,
    updated: resource.updated ?? null,
  };
```

Add the error mappers (module-private):

```ts
// Spec §10.4. Reads surface unknown failures as-is; writes classify every failure.
function mapReadError(error: unknown): never {
  if (error instanceof ExternalCallError) throw error;
  if (error instanceof GCalApiError) {
    throw new ExternalCallError(error.status >= 500 || error.status === 429 ? "unknown" : "definite", "read_failed", error.message);
  }
  throw new ExternalCallError("unknown", "google_unreachable", error instanceof Error ? error.message : String(error));
}

function mapWriteError(error: unknown, op: "create" | "update" | "remove"): never {
  if (error instanceof ExternalCallError) throw error;
  if (error instanceof GCalApiError) {
    if (op === "create" && error.status === 409) throw new ExternalCallError("unknown", "already_exists", error.message);
    if (error.status === 412) throw new ExternalCallError("definite", "changed_since", error.message);
    if (error.status === 404 || error.status === 410) throw new ExternalCallError("definite", "not_found", error.message);
    if (error.status === 429 || error.status >= 500) throw new ExternalCallError("unknown", "google_unavailable", error.message);
    throw new ExternalCallError("definite", "rejected_by_google", error.message);
  }
  throw new ExternalCallError("unknown", "google_unreachable", error instanceof Error ? error.message : String(error));
}
```

Export `GCalApiError` from `calendar/index.ts`:

```ts
export { GCalHttpClient, GCalApiError, type ListEventsOptions } from "./gcal-http-client.js";
```

- [ ] **Step 6: Make `SqliteDeadlineRepository.findById` public**

In `sqlite-deadline.repository.ts`, change `private findById(id: string): Deadline | null` to `findById(id: string): Deadline | null`.

- [ ] **Step 7: Run tests, build, typecheck**

Run: `cd packages/infrastructure && npx vitest run src/calendar src/http`
Expected: PASS. `insertEvent` now always adds `?sendUpdates=none` (or the given value); if an existing test in `__tests__/gcal-http-client.test.ts` asserts the exact insert URL, update that expectation to include the parameter — that is the intended change, not a regression.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add packages/infrastructure/src/calendar packages/infrastructure/src/http packages/infrastructure/src/database/repositories/sqlite-deadline.repository.ts
git commit -m "feat(calendar): add versioned reads and idempotent, classified writes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
