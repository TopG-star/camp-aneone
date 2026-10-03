# Phase 4: Server (Tasks 12–16)

Read first: spec §10.2–10.8, §11, §13 (API shapes the UI relies on), §15 (migration and rollout). Global constraints in [README.md](README.md) apply. From Task 13 onward the old `action_log` code paths are gone at runtime; Task 16 removes their last source files.

---

### Task 12: Wire actions into the container and startup

**Files:**
- Create: `packages/agent-server/src/actions-wiring.ts`
- Modify: `packages/agent-server/src/container.ts`
- Modify: `packages/agent-server/src/index.ts`
- Test: `packages/agent-server/src/container.test.ts` (add cases)

**Interfaces:**
- Consumes: Tasks 1–11; `InAppNotificationAdapter.deliver`; `SqliteDeadlineRepository.findById`; container's `createGoogleTokenProvider`.
- Produces:
  - `createActionsModule(deps: ActionsWiringDeps): ActionsModule` with `ActionsModule { orchestrator: ActionOrchestrator; registry: ActionRegistry; instanceRepo: ActionInstanceRepository; configRepo: ActionConfigRepository; legacyRepo: LegacyActionRepository; capabilitiesFor(userId: string): ActionCapabilities }`
  - `AppContainer.actions: ActionsModule`; `AppContainer.notificationWriter: NotificationWriter`
  - `runActionStartupTasks(container, logger): Promise<void>` (exported from `actions-wiring.ts`)

- [ ] **Step 1: Write the failing container tests**

Add to `packages/agent-server/src/container.test.ts`, reusing the file's env stubbing (extract the existing `vi.stubEnv` lines into a `stubEnv()` helper at the top of the file and call it from every test):

```ts
import { personalActor } from "@oneon/domain";

it("delivers exactly one in-app notification for a notify action", async () => {
  stubEnv();
  const container = createContainer(loadEnv());
  try {
    container.userRepo!.upsert({ id: "user-A", email: "alice@test.com" });
    const outcome = await container.actions.orchestrator.requestAction({
      type: "notify",
      input: { inboundItemId: "i1", title: "Urgent: Q4", body: "Needs numbers", deepLink: "/items/i1" },
      actor: personalActor("user-A"),
      initiator: "rule:inbox.urgent_notify",
      keyContext: { source: "rule", resourceId: "i1" },
      evidence: [],
      resourceRef: "inbound_item:i1",
    });
    expect(outcome).toMatchObject({ kind: "created", instance: { status: "completed" } });
    expect(container.notificationRepo.findAll({ userId: "user-A" })).toHaveLength(1);
  } finally {
    container.shutdown();
  }
});

it("gives executors a calendar writer only for users with a Google token", () => {
  stubEnv();
  const container = createContainer(loadEnv());
  try {
    container.userRepo!.upsert({ id: "user-A", email: "alice@test.com" });
    container.userRepo!.upsert({ id: "user-B", email: "bob@test.com" });
    container.oauthTokenRepo!.upsert({
      provider: "google", userId: "user-A", accessToken: "a", refreshToken: "r", tokenType: "bearer",
      scope: "openid email", expiresAt: "2099-01-01T00:00:00.000Z", providerEmail: "alice@test.com",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(container.actions.capabilitiesFor("user-A").writers.calendar).not.toBeNull();
    expect(container.actions.capabilitiesFor("user-A").readers.identity.googleEmail).toBe("alice@test.com");
    expect(container.actions.capabilitiesFor("user-B").writers.calendar).toBeNull();
  } finally {
    container.shutdown();
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/agent-server && npx vitest run src/container.test.ts`
Expected: FAIL, `container.actions` is undefined.

- [ ] **Step 3: Write `actions-wiring.ts`**

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  evaluateNotificationSuppression,
  type ActionCapabilities,
  type ActionConfigRepository,
  type ActionInstanceRepository,
  type CalendarReader,
  type CalendarWriter,
  type Deadline,
  type LegacyActionRepository,
  type Logger,
  type NotificationPort,
  type NotificationRepository,
  type NotificationWriter,
  type OAuthTokenRepository,
  type PreferenceRepository,
} from "@oneon/domain";
import {
  createActionDefinitions,
  createActionNotifier,
  createActionOrchestrator,
  createActionRegistry,
  importLegacyProposals,
  type ActionOrchestrator,
  type ActionRegistry,
} from "@oneon/application";
import {
  GCalHttpClient,
  GoogleCalendarAdapter,
  SqliteActionConfigRepository,
  SqliteActionInstanceRepository,
  SqliteLegacyActionRepository,
  TTLCache,
  runActionDriftCheck,
  type TokenProvider,
} from "@oneon/infrastructure";

export interface ActionsWiringDeps {
  db: Database.Database;
  publicUrl: string;
  calendarId: string;
  calendarCacheTtlMs: number;
  oauthTokenRepo: OAuthTokenRepository | null;
  deadlines: { findById(id: string): Deadline | null };
  notificationRepo: NotificationRepository;
  preferenceRepo: PreferenceRepository;
  notificationPort: NotificationPort;
  notificationWriter: NotificationWriter;
  createGoogleTokenProvider(userId: string): TokenProvider | null;
  logger: Logger;
}

export interface ActionsModule {
  orchestrator: ActionOrchestrator;
  registry: ActionRegistry;
  instanceRepo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  legacyRepo: LegacyActionRepository;
  capabilitiesFor(userId: string): ActionCapabilities;
}

/** The only place outside infrastructure that holds a CalendarWriter (spec §5, Task 15 test). */
export function createActionsModule(deps: ActionsWiringDeps): ActionsModule {
  const registry = createActionRegistry(createActionDefinitions());
  const instanceRepo = new SqliteActionInstanceRepository(deps.db);
  const configRepo = new SqliteActionConfigRepository(deps.db);
  const legacyRepo = new SqliteLegacyActionRepository(deps.db);
  const calendars = new Map<string, GoogleCalendarAdapter>();

  function calendarFor(userId: string): GoogleCalendarAdapter | null {
    const cached = calendars.get(userId);
    if (cached) return cached;
    const tokenProvider = deps.createGoogleTokenProvider(userId);
    if (!tokenProvider) return null;
    const adapter = new GoogleCalendarAdapter({
      client: new GCalHttpClient(tokenProvider),
      calendarId: deps.calendarId,
      cache: new TTLCache(),
      cacheTtlMs: deps.calendarCacheTtlMs,
    });
    calendars.set(userId, adapter);
    return adapter;
  }

  function capabilitiesFor(userId: string): ActionCapabilities {
    const calendar = calendarFor(userId);
    const reader: CalendarReader | null = calendar;
    const writer: CalendarWriter | null = calendar;
    return {
      readers: {
        calendar: reader,
        deadlines: deps.deadlines,
        notifications: {
          isSuppressed: (uid, eventType, now) =>
            evaluateNotificationSuppression(deps.preferenceRepo, uid, eventType, now, (m, meta) => deps.logger.warn(m, meta)),
          findById: (id) => deps.notificationRepo.findById(id),
        },
        identity: { googleEmail: deps.oauthTokenRepo?.get("google", userId)?.providerEmail ?? null },
        links: { inboundItem: (id) => `${deps.publicUrl}/items/${id}` },
      },
      writers: { calendar: writer, notifications: deps.notificationWriter },
    };
  }

  const orchestrator = createActionOrchestrator({
    registry,
    repo: instanceRepo,
    configRepo,
    capabilities: capabilitiesFor,
    notifier: createActionNotifier(deps.notificationPort, deps.logger),
    logger: deps.logger,
    clock: () => new Date(),
    newId: randomUUID,
  });

  return { orchestrator, registry, instanceRepo, configRepo, legacyRepo, capabilitiesFor };
}

/** Spec §8.4, §8.6, §7.4: drift check, one-time legacy import, then recovery for every user. */
export async function runActionStartupTasks(
  container: { db: Database.Database; actions: ActionsModule; userRepo: { list(): Array<{ id: string }> } | null },
  logger: Logger,
): Promise<void> {
  const repaired = runActionDriftCheck(container.db, logger);
  if (repaired > 0) logger.warn("Repaired action projections at startup", { repaired });
  const userIds = container.userRepo?.list().map((u) => u.id) ?? [];
  await importLegacyProposals({
    legacyRepo: container.actions.legacyRepo,
    requestAction: container.actions.orchestrator.requestAction,
    userIds,
    logger,
  });
  for (const userId of userIds) {
    await container.actions.orchestrator.sweep(userId);
    await container.actions.orchestrator.expireStale(userId);
  }
}
```

- [ ] **Step 4: Build the notification writer and the actions module in the container**

In `container.ts`:

1. Keep the concrete deadline repository: change `const deadlineRepo = new SqliteDeadlineRepository(db);` so the variable keeps its class type (it already does; just make sure nothing narrows it to `DeadlineRepository` before it is passed below).
2. Replace the notification block's first lines and push branch so the in-app adapter and web-push adapter stay reachable:

```ts
  const inAppNotifications = new InAppNotificationAdapter({ notificationRepo, preferenceRepo, logger });
  const inAppNotificationPort: NotificationPort = inAppNotifications;
  let webPushNotifications: WebPushNotificationAdapter | null = null;

  let notificationPort: NotificationPort = inAppNotificationPort;

  if (env.FEATURE_PUSH_NOTIFICATIONS) {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
      const webPush = new WebPushNotificationAdapter({
        pushSubscriptionRepo,
        preferenceRepo,
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateKey: env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT,
        logger,
      });
      webPushNotifications = webPush;
      notificationPort = {
        async send(notification): Promise<void> {
          await inAppNotificationPort.send(notification);
          await webPush.send(notification);
        },
      };
      logger.info("Notifications: ✓ in-app + web-push mode");
    } else {
      // unchanged warning + info lines
    }
  } else {
    logger.info("Notifications: ✓ in-app mode");
  }

  // The notify executor needs to know what happened; web push stays best effort.
  const notificationWriter: NotificationWriter = {
    async deliver(notification) {
      const result = await inAppNotifications.deliver(notification);
      if (result.status === "delivered" && webPushNotifications) {
        await webPushNotifications.send(notification).catch((error: unknown) =>
          logger.warn("Web push delivery failed", { error: error instanceof Error ? error.message : String(error) }),
        );
      }
      return result;
    },
  };
```

3. After `createGoogleTokenProvider` is defined and before the `return`, build the module:

```ts
  const actions = createActionsModule({
    db,
    publicUrl: env.PUBLIC_URL,
    calendarId: env.CALENDAR_ID,
    calendarCacheTtlMs: env.CALENDAR_CACHE_TTL_MS,
    oauthTokenRepo,
    deadlines: deadlineRepo,
    notificationRepo,
    preferenceRepo,
    notificationPort,
    notificationWriter,
    createGoogleTokenProvider,
    logger,
  });
```

4. Add `actions` and `notificationWriter` to the returned object, and to `AppContainer`:

```ts
  // ── Actions (spec: Action Spec framework) ─────────────────
  actions: ActionsModule;
  notificationWriter: NotificationWriter;
```

with imports `import { createActionsModule, type ActionsModule } from "./actions-wiring.js";` and `NotificationWriter` from `@oneon/domain`.

- [ ] **Step 5: Run startup tasks and per-user recovery**

In `index.ts`, after the container is created and routes are registered, before `app.listen`:

```ts
import { runActionStartupTasks } from "./actions-wiring.js";

void runActionStartupTasks(container, logger).catch((error: unknown) =>
  logger.error("Action startup tasks failed", { error: error instanceof Error ? error.message : String(error) }),
);
```

At the end of `userCycleRunner` (after the processing cycle call), add:

```ts
    await container.actions.orchestrator.sweep(userId);
    await container.actions.orchestrator.expireStale(userId);
```

- [ ] **Step 6: Run tests, build, typecheck**

Run: `cd packages/agent-server && npx vitest run src/container.test.ts`
Expected: PASS (existing Gmail-marker test plus the two new ones).
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-server/src
git commit -m "feat(actions): wire the action framework into the container and startup" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Route the processing cycle through actions and retire the env flags

Spec §9.9 (one urgent-notification path) and §15.1.

**Files:**
- Modify: `packages/application/src/usecases/run-processing-cycle.ts`
- Modify: `packages/application/src/usecases/run-processing-cycle.test.ts`
- Delete: `packages/application/src/usecases/propose-actions.ts`, `propose-actions.test.ts`, `execute-action.ts`, `execute-action.test.ts`, `transition-action-status.ts`, `transition-action-status.test.ts`
- Modify: `packages/application/src/usecases/index.ts` (drop their exports)
- Modify: `packages/agent-server/src/config/env.ts`, `packages/agent-server/src/index.ts`, `packages/agent-server/src/routes/index.ts`
- Test: `packages/agent-server/src/config/env.test.ts` (create)

**Interfaces:**
- Consumes: `deriveInboxActionRequests`, `ActionRequest`, `RequestOutcome` (Task 11), `container.actions.orchestrator.requestAction` (Task 12).
- Produces: `RunProcessingCycleDeps` without `actionLogRepo` / `featureAutoExecute`, with `requestAction(req: ActionRequest): Promise<RequestOutcome>` and optional `clock?: () => Date`; `RETIRED_ENV_VARS`, `retiredEnvWarnings(source): string[]`.

- [ ] **Step 1: Write the failing cycle tests**

In `run-processing-cycle.test.ts`, change `createDeps` to drop `actionLogRepo` and `featureAutoExecute` and add:

```ts
    requestAction: vi.fn(async (req: ActionRequest): Promise<RequestOutcome> => ({
      kind: "created",
      instance: { id: `a-${req.type}`, status: req.type === "notify" ? "completed" : "awaiting_approval" } as ActionInstance,
    })),
```

(import `ActionRequest`, `RequestOutcome` from `../actions/orchestrator/types.js` and `ActionInstance` from `@oneon/domain`).

Delete these tests, whose subject no longer exists in the cycle: "auto-executes actions when featureAutoExecute is true", "does NOT auto-execute when featureAutoExecute is false", "sends urgent_item notification when classification priority <= 2", "does NOT send urgent_item notification for low-priority items", "sends action_proposed notification for approval_required actions". Rename "survives proposeActions errors and continues" to "survives a failing action request and continues", making its `requestAction` reject once. Update "classifies items and proposes actions for classified results" to assert on `requestAction` calls instead of `actionLogRepo.create`. Then add:

```ts
  it("requests notify for priority ≤ 2 and sends no direct urgent notification", async () => {
    const deps = createDeps();
    // arrange one unclassified item whose LLM classification returns priority 1 (use the file's existing item/LLM helpers)
    const summary = await runProcessingCycle(deps, OPTIONS);
    const types = (deps.requestAction as ReturnType<typeof vi.fn>).mock.calls.map(([req]) => req.type);
    expect(types).toContain("notify");
    const directUrgent = (deps.notificationPort!.send as ReturnType<typeof vi.fn>).mock.calls.filter(([n]) => n.eventType === "urgent_item");
    expect(directUrgent).toHaveLength(0);
    expect(summary.notificationsSent).toBe(1);
    expect(summary.actionsAutoExecuted).toBe(1);
  });

  it("passes the user as a personal actor", async () => {
    const deps = createDeps();
    // arrange the same priority-1 item as the previous test, so at least one request is made
    await runProcessingCycle(deps, OPTIONS);
    const [req] = (deps.requestAction as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(req.actor).toEqual({ userId: deps.userId, scope: "personal", tenantId: null, roles: ["owner"], permissions: [], locationIds: [] });
  });

  it("counts refused requests as action errors", async () => {
    const deps = createDeps();
    // arrange the same priority-1 item as above
    (deps.requestAction as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "refused", reason: "invalid_input", issues: ["x"] });
    const summary = await runProcessingCycle(deps, OPTIONS);
    expect(summary.actionErrors).toBeGreaterThan(0);
    expect(summary.actionsProposed).toBe(0);
  });
```

(`OPTIONS` is the options object the file already passes; if it is inlined, extract it.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/application && npx vitest run src/usecases/run-processing-cycle.test.ts`
Expected: FAIL (cycle still calls `proposeActions` and sends direct urgent notifications).

- [ ] **Step 3: Rewrite the action part of the cycle**

In `run-processing-cycle.ts`:
- Replace `actionLogRepo: ActionLogRepository;` and `featureAutoExecute: boolean;` in `RunProcessingCycleDeps` with:

```ts
  /** Every action goes through the registry and policy (spec §9.9). */
  requestAction(req: ActionRequest): Promise<RequestOutcome>;
  clock?: () => Date;
```

- Delete the "Notification: urgent item" block, the "Step 2: Propose actions" block, the "Step 3: Auto-execute" block and the "Notification: approval-required actions" block, and put in their place:

```ts
      // ── Step 2: Request actions; notify is the only urgent-notification path ──
      try {
        const deadlines = deps.deadlineRepo.findByInboundItemId(item.id);
        const now = (deps.clock ?? (() => new Date()))();
        for (const request of deriveInboxActionRequests({ classification, item, deadlines, now })) {
          const outcome = await deps.requestAction({ ...request, actor: personalActor(deps.userId) });
          if (outcome.kind === "refused") {
            summary.actionErrors++;
            logger.warn("Action request refused", { itemId: item.id, type: request.type, reason: outcome.reason, issues: outcome.issues });
            continue;
          }
          if (outcome.kind !== "created") continue;
          summary.actionsProposed++;
          if (outcome.instance.status === "completed") {
            summary.actionsAutoExecuted++;
            if (request.type === "notify") summary.notificationsSent++;
          }
        }
      } catch (error) {
        summary.actionErrors++;
        logger.error("Action request failed", {
          itemId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
```

- Update imports: remove `ActionLogRepository`, `proposeActions`, `executeAction`, and `evaluateReminderPriorityPolicy` if no longer used; add:

```ts
import { personalActor } from "@oneon/domain";
import { deriveInboxActionRequests } from "../actions/inbox-rules.js";
import type { ActionRequest, RequestOutcome } from "../actions/orchestrator/types.js";
```

- Update the doc comment's steps 2–3 to: "2. For each newly classified item, request actions from the inbox rules; the orchestrator validates, authorizes and executes them."

- [ ] **Step 4: Delete the MVP1 action modules**

```bash
git rm packages/application/src/usecases/propose-actions.ts packages/application/src/usecases/propose-actions.test.ts \
       packages/application/src/usecases/execute-action.ts packages/application/src/usecases/execute-action.test.ts \
       packages/application/src/usecases/transition-action-status.ts packages/application/src/usecases/transition-action-status.test.ts
```

Remove their `export { … } from "./propose-actions.js"` / `execute-action.js` / `transition-action-status.js` blocks from `usecases/index.ts`. Run `grep -rn "proposeActions\|executeAction\|assertValidTransition\|ACTION_RISK_LEVELS" packages/*/src` and fix any remaining reference.

- [ ] **Step 5: Retire the flags (with a failing test first)**

`packages/agent-server/src/config/env.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { retiredEnvWarnings } from "./env.js";

describe("retiredEnvWarnings", () => {
  it("warns for each retired variable that is still set", () => {
    expect(retiredEnvWarnings({ FEATURE_AUTO_EXECUTE: "true", PORT: "4000" })).toEqual([
      "FEATURE_AUTO_EXECUTE is retired; per-action settings now live in Settings → Actions.",
    ]);
    expect(retiredEnvWarnings({})).toEqual([]);
  });
});
```

In `env.ts`, delete the `FEATURE_AUTO_EXECUTE` and `FEATURE_MANUAL_EXECUTE_REQUIRED` schema entries and add:

```ts
export const RETIRED_ENV_VARS = ["FEATURE_AUTO_EXECUTE", "FEATURE_MANUAL_EXECUTE_REQUIRED"] as const;

/** Spec §15.1: retired flags are ignored; say so instead of silently dropping them. */
export function retiredEnvWarnings(source: Record<string, string | undefined>): string[] {
  return RETIRED_ENV_VARS.filter((name) => source[name] !== undefined).map(
    (name) => `${name} is retired; per-action settings now live in Settings → Actions.`,
  );
}
```

In `index.ts`: remove `autoExecute: env.FEATURE_AUTO_EXECUTE,` from the startup log, replace `featureAutoExecute: env.FEATURE_AUTO_EXECUTE,` and `actionLogRepo: container.actionLogRepo,` in the `runProcessingCycle` deps with `requestAction: container.actions.orchestrator.requestAction,`, and after `loadEnv()` add:

```ts
for (const message of retiredEnvWarnings(process.env)) logger.warn(message);
```

In `routes/index.ts`, remove `manualExecuteRequired: env.FEATURE_MANUAL_EXECUTE_REQUIRED,` from the actions router deps.

Run `grep -rn "FEATURE_AUTO_EXECUTE\|FEATURE_MANUAL_EXECUTE_REQUIRED" --exclude-dir=node_modules --exclude-dir=dist .` from the repo root and remove remaining mentions in docs (`docs/SETUP_ENV.md`, `docker-compose.yml`, `.env.example` if present), replacing any explanation with "Per-action approval settings live in Settings → Actions."

- [ ] **Step 6: Run tests, build, typecheck**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add -A packages docs docker-compose.yml
git commit -m "feat(actions): route the processing cycle through the action framework" -m "Removes the direct urgent notification (notify is now the only path) and retires FEATURE_AUTO_EXECUTE and FEATURE_MANUAL_EXECUTE_REQUIRED." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Contracts and the actions / action-definitions API

Spec §11 and §13. The dashboard keeps compiling against the old contract names until Task 18, so the new schemas are added beside them.

**Files:**
- Modify: `packages/contracts/src/actions.contract.ts` (add new schemas; keep old ones, marked deprecated)
- Modify: `packages/contracts/src/chat.contract.ts` (add `actions`)
- Create: `packages/agent-server/src/routes/action-views.ts`
- Rewrite: `packages/agent-server/src/routes/actions.route.ts`
- Create: `packages/agent-server/src/routes/action-definitions.route.ts`
- Modify: `packages/agent-server/src/routes/index.ts`
- Rewrite: `packages/agent-server/src/routes/actions.route.test.ts`
- Test: `packages/agent-server/src/routes/action-definitions.route.test.ts`
- Create: `packages/agent-server/src/routes/__tests__/actions-test-app.ts` (shared test setup)

**Interfaces:**
- Consumes: Tasks 1–12.
- Produces (contracts):
  - `LIFECYCLE_STATUS_VALUES`, `ActionStatusValueSchema`, `STATUS_GROUPS`, `type StatusGroup`, `groupOf(status): StatusGroup`
  - `ActionViewQuerySchema`, `ActionViewSchema`, `type ActionView`, `ActionViewListResponseSchema`, `ActionEventViewSchema`, `LegacyActionViewSchema`, `LegacyActionListResponseSchema`, `LEGACY_BANNER`, `ActionDefinitionViewSchema`, `type ActionDefinitionView`, `ActionDefinitionsResponseSchema`, `ActionConfigWriteSchema`, `ChatActionRefSchema`
- Produces (server): `toActionView(instance, ctx): ActionView`, `createActionsRouter(deps: ActionsRouteDeps)`, `createActionDefinitionsRouter(deps: ActionDefinitionsRouteDeps)`

- [ ] **Step 1: Add the contracts**

Append to `packages/contracts/src/actions.contract.ts` (add `/** @deprecated Removed in Task 18. */` above each existing export):

```ts
// ── Action Spec framework (spec §11, §13) ────────────────────

export const LIFECYCLE_STATUS_VALUES = [
  "proposed", "validating", "awaiting_approval", "approved", "executing", "verifying",
  "completed", "partially_completed", "rejected", "expired", "cancelled", "failed",
  "rolling_back", "rolled_back", "rollback_failed",
] as const;
export const ActionStatusValueSchema = z.enum(LIFECYCLE_STATUS_VALUES);
export type ActionStatusValue = z.infer<typeof ActionStatusValueSchema>;

/** Spec §13.1: each status in exactly one group; the group sets the colour. */
export const STATUS_GROUPS = {
  needs_you: ["awaiting_approval"],
  in_progress: ["proposed", "validating", "approved", "executing", "verifying", "rolling_back"],
  done: ["completed", "rolled_back"],
  problem: ["failed", "partially_completed", "rollback_failed"],
  closed: ["rejected", "expired", "cancelled"],
} as const satisfies Record<string, readonly ActionStatusValue[]>;
export type StatusGroup = keyof typeof STATUS_GROUPS;
export const STATUS_GROUP_VALUES = Object.keys(STATUS_GROUPS) as StatusGroup[];

export function groupOf(status: ActionStatusValue): StatusGroup {
  return STATUS_GROUP_VALUES.find((g) => (STATUS_GROUPS[g] as readonly string[]).includes(status))!;
}

export const ActionViewQuerySchema = OffsetPaginationQuerySchema.extend({
  group: z.enum(["needs_you", "in_progress", "done", "problem", "closed"]).optional(),
  status: ActionStatusValueSchema.optional(),
});

const EvidenceItemSchema = z.object({ kind: z.string(), source: z.string(), asOf: z.string(), data: z.record(z.unknown()) });
const CheckResultSchema = z.object({ id: z.string(), passed: z.boolean(), expected: z.unknown().optional(), actual: z.unknown().optional() });
const OperationSchema = z.enum(["approve", "reject", "cancel", "undo", "retry"]);

export const ActionEventViewSchema = z.object({
  seq: z.number(),
  fromStatus: ActionStatusValueSchema.nullable(),
  toStatus: ActionStatusValueSchema,
  actor: z.object({ kind: z.enum(["user", "policy", "system", "sweeper"]), userId: z.string().optional() }),
  data: z.record(z.unknown()),
  createdAt: z.string(),
});

export const ActionViewSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  label: z.string(),
  status: ActionStatusValueSchema,
  group: z.enum(["needs_you", "in_progress", "done", "problem", "closed"]),
  risk: z.string(),
  origin: z.object({ kind: z.enum(["rule", "chat", "user", "schedule"]), label: z.string(), excerpt: z.string().nullable() }),
  description: z.string(),
  evidence: z.array(EvidenceItemSchema),
  decision: z.object({ outcome: z.enum(["refuse", "needs_approval", "auto"]), reasons: z.array(z.object({ code: z.string(), text: z.string() })) }).nullable(),
  checks: z.array(CheckResultSchema),
  undo: z.object({ rollbackClass: z.enum(["reversible", "conditional", "irreversible"]), text: z.string(), warning: z.string().nullable() }),
  error: z.object({ code: z.string(), message: z.string(), stage: z.string() }).nullable(),
  allowedOperations: z.array(OperationSchema),
  retryOf: z.string().nullable(),
  attemptNumber: z.number(),
  resourceRef: z.string().nullable(),
  verifyingSince: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  timeline: z.array(ActionEventViewSchema),
});
export type ActionView = z.infer<typeof ActionViewSchema>;

export const ActionViewListResponseSchema = z.object({ actions: z.array(ActionViewSchema), pagination: OffsetPaginationMetaSchema });
export type ActionViewListResponse = z.infer<typeof ActionViewListResponseSchema>;

export const LEGACY_BANNER = "MVP1 actions changed status only; nothing was executed.";
export const LegacyActionViewSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  status: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export const LegacyActionListResponseSchema = z.object({
  actions: z.array(LegacyActionViewSchema),
  pagination: OffsetPaginationMetaSchema,
  banner: z.literal(LEGACY_BANNER),
});
export type LegacyActionListResponse = z.infer<typeof LegacyActionListResponseSchema>;

export const ActionDefinitionViewSchema = z.object({
  type: z.string(),
  label: z.string(),
  description: z.string(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  rollbackClass: z.enum(["reversible", "conditional", "irreversible"]),
  risk: z.object({ floor: z.string(), effective: z.string() }),
  approval: z.object({ mode: z.enum(["auto", "above_threshold", "always"]), options: z.array(z.object({ mode: z.enum(["auto", "above_threshold", "always"]), label: z.string() })) }),
  expiryHours: z.number(),
  enabled: z.boolean(),
  disableWarning: z.string().nullable(),
  flags: z.object({ clamped: z.array(z.string()), rejected: z.string().nullable() }),
  lastChange: z.object({ changedBy: z.string(), changedAt: z.string() }).nullable(),
});
export type ActionDefinitionView = z.infer<typeof ActionDefinitionViewSchema>;
export const ActionDefinitionsResponseSchema = z.object({ definitions: z.array(ActionDefinitionViewSchema) });
export type ActionDefinitionsResponse = z.infer<typeof ActionDefinitionsResponseSchema>;

export const ActionConfigWriteSchema = z
  .object({ enabled: z.boolean().optional(), approvalMode: z.enum(["auto", "above_threshold", "always"]).optional() })
  .strict();
export type ActionConfigWrite = z.infer<typeof ActionConfigWriteSchema>;
```

In `chat.contract.ts`:

```ts
export const ChatActionRefSchema = z.object({
  id: z.string(),
  actionType: z.string(),
  label: z.string(),
  status: z.string(),
});
export type ChatActionRef = z.infer<typeof ChatActionRefSchema>;
```

and add `actions: z.array(ChatActionRefSchema).default([]),` to `ChatResponseSchema`.

- [ ] **Step 2: Write the shared test app**

`packages/agent-server/src/routes/__tests__/actions-test-app.ts` — a real SQLite database, the real registry and orchestrator, and fake readers/writers:

```ts
import express from "express";
import { ExternalCallError, type CalendarEvent, type Deadline, type Logger } from "@oneon/domain";
import { createActionDefinitions, createActionOrchestrator, createActionRegistry } from "@oneon/application";
import {
  SqliteActionConfigRepository,
  SqliteActionInstanceRepository,
  SqliteLegacyActionRepository,
  createDatabase,
  runMigrations,
} from "@oneon/infrastructure";
import { createActionsRouter } from "../actions.route.js";
import { createActionDefinitionsRouter } from "../action-definitions.route.js";

export const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export function buildActionsTestApp(options: { createDelayMs?: number } = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.prepare("INSERT INTO users (id, email) VALUES ('user-A','a@test.com'), ('user-B','b@test.com')").run();

  const events = new Map<string, CalendarEvent>();
  let version = 1;
  const deadlines = new Map<string, Deadline>();
  const calendar = {
    listEvents: async () => [...events.values()],
    searchEvents: async () => [...events.values()],
    getEvent: async (id: string) => events.get(id) ?? null,
    async create(e: Omit<CalendarEvent, "id">, o: { eventId: string }) {
      if (options.createDelayMs) await new Promise((r) => setTimeout(r, options.createDelayMs));
      const created = { ...e, id: o.eventId, etag: `"v${version++}"` } as CalendarEvent;
      events.set(created.id, created);
      return created;
    },
    async update(id: string, c: Partial<CalendarEvent>, o: { ifMatch: string }) {
      const cur = events.get(id);
      if (!cur) throw new ExternalCallError("definite", "not_found", "missing");
      if (cur.etag !== o.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      const next = { ...cur, ...c, etag: `"v${version++}"` };
      events.set(id, next);
      return next;
    },
    async remove(id: string, o: { ifMatch: string }) {
      const cur = events.get(id);
      if (!cur) throw new ExternalCallError("definite", "not_found", "missing");
      if (cur.etag !== o.ifMatch) throw new ExternalCallError("definite", "changed_since", "412");
      events.delete(id);
    },
  };

  const registry = createActionRegistry(createActionDefinitions());
  const instanceRepo = new SqliteActionInstanceRepository(db);
  const configRepo = new SqliteActionConfigRepository(db);
  const legacyRepo = new SqliteLegacyActionRepository(db);
  const orchestrator = createActionOrchestrator({
    registry,
    repo: instanceRepo,
    configRepo,
    capabilities: () => ({
      readers: {
        calendar,
        deadlines: { findById: (id) => deadlines.get(id) ?? null },
        notifications: { isSuppressed: () => null, findById: () => null },
        identity: { googleEmail: "a@test.com" },
        links: { inboundItem: (id) => `https://oneon.test/items/${id}` },
      },
      writers: { calendar, notifications: null },
    }),
    notifier: { awaitingApproval: async () => {}, rollbackFailed: async () => {} },
    logger,
    clock: () => new Date("2026-10-01T12:00:00.000Z"),
    newId: () => crypto.randomUUID(),
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = (req.headers["x-test-user"] as string) ?? "user-A";
    next();
  });
  app.use("/api/actions", createActionsRouter({ orchestrator, registry, instanceRepo, configRepo, legacyRepo, logger }));
  app.use("/api/action-definitions", createActionDefinitionsRouter({ registry, configRepo, logger }));

  return { app, db, orchestrator, instanceRepo, configRepo, events, deadlines };
}
```

- [ ] **Step 3: Write the failing route tests**

`actions.route.test.ts` (replaces the old file):

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { personalActor } from "@oneon/domain";
import { buildActionsTestApp } from "./__tests__/actions-test-app.js";

const reminderDeadline = { id: "d1", userId: "user-A", inboundItemId: "i1", dueDate: "2026-10-07T17:00:00Z", description: "Submit Q4", confidence: 0.9, status: "open" as const, createdAt: "", updatedAt: "" };

async function proposeReminder(t: ReturnType<typeof buildActionsTestApp>) {
  t.deadlines.set("d1", reminderDeadline);
  const o = await t.orchestrator.requestAction({
    type: "create_reminder", input: { deadlineId: "d1", inboundItemId: "i1" }, actor: personalActor("user-A"),
    initiator: "rule:inbox.deadline_reminder", keyContext: { source: "rule", resourceId: "d1" }, evidence: [], resourceRef: "deadline:d1",
  });
  if (o.kind === "refused") throw new Error();
  return o.instance;
}

describe("GET /api/actions", () => {
  it("lists by group with views the UI can render", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const res = await request(t.app).get("/api/actions?group=needs_you");
    expect(res.status).toBe(200);
    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0]).toMatchObject({
      id: a.id,
      label: "Create reminder",
      status: "awaiting_approval",
      group: "needs_you",
      origin: { kind: "rule", label: "Inbox rule · deadline reminder" },
      description: 'Add an all-day reminder "Due: Submit Q4" on 7 Oct 2026 to your calendar.',
      allowedOperations: ["approve", "reject", "cancel"],
      undo: { rollbackClass: "reversible", text: "Can be undone" },
    });
    expect(res.body.actions[0].decision.reasons[0].text).toBe("Create reminder is set to always ask before running.");
    expect(res.body.actions[0].timeline.map((e: { toStatus: string }) => e.toStatus)).toEqual(["proposed", "validating", "awaiting_approval"]);
  });

  it("hides another user's action (404)", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    expect((await request(t.app).get(`/api/actions/${a.id}`).set("x-test-user", "user-B")).status).toBe(404);
    expect((await request(t.app).post(`/api/actions/${a.id}/approve`).set("x-test-user", "user-B")).status).toBe(404);
  });
});

describe("operations", () => {
  it("approves to completed, refuses a second approve with 409, then undoes", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    const approved = await request(t.app).post(`/api/actions/${a.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "completed", allowedOperations: ["undo"] });
    expect(t.events.size).toBe(1);
    expect((await request(t.app).post(`/api/actions/${a.id}/approve`)).status).toBe(409);
    const undone = await request(t.app).post(`/api/actions/${a.id}/undo`);
    expect(undone.body.status).toBe("rolled_back");
    expect(t.events.size).toBe(0);
  });

  it("rejects and cancels", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    expect((await request(t.app).post(`/api/actions/${a.id}/reject`).send({ reason: "not now" })).body.status).toBe("rejected");
  });

  it("returns 403 for an operation policy does not allow", async () => {
    const t = buildActionsTestApp();
    const a = await proposeReminder(t);
    await request(t.app).post(`/api/actions/${a.id}/reject`);
    expect((await request(t.app).post(`/api/actions/${a.id}/retry`)).status).toBe(403);
  });

  it("keeps executing after the client disconnects", async () => {
    const t = buildActionsTestApp({ createDelayMs: 100 });
    const a = await proposeReminder(t);
    await request(t.app).post(`/api/actions/${a.id}/approve`).timeout(10).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.instanceRepo.findById("user-A", a.id)!.status).toBe("completed");
  });

  it("lets concurrent approve and cancel settle on one outcome, never a 500", async () => {
    const t = buildActionsTestApp({ createDelayMs: 20 });
    const a = await proposeReminder(t);
    const [r1, r2] = await Promise.all([
      request(t.app).post(`/api/actions/${a.id}/approve`),
      request(t.app).post(`/api/actions/${a.id}/cancel`),
    ]);
    expect([r1.status, r2.status].every((s) => s === 200 || s === 409)).toBe(true);
    const trail = t.instanceRepo.listEvents("user-A", a.id).map((e) => e.toStatus);
    // Either the cancel landed before execution started, or execution ran and the cancel was refused.
    expect(trail.includes("cancelled") && trail.includes("executing")).toBe(false);
    expect(["completed", "cancelled"]).toContain(t.instanceRepo.findById("user-A", a.id)!.status);
  });
});

describe("GET /api/actions/legacy", () => {
  it("returns read-only legacy rows with the banner", async () => {
    const t = buildActionsTestApp();
    t.db.prepare("INSERT INTO action_log_legacy (id, resource_id, action_type, risk_level, status, user_id, payload_json) VALUES ('l1','i1','archive','approval_required','executed','user-A','{\"reason\":\"spam\"}')").run();
    const res = await request(t.app).get("/api/actions/legacy");
    expect(res.body).toMatchObject({
      banner: "MVP1 actions changed status only; nothing was executed.",
      actions: [{ id: "l1", actionType: "archive", status: "executed", payload: { reason: "spam" } }],
    });
    expect(res.body.actions[0].allowedOperations).toBeUndefined();
  });
});
```

`action-definitions.route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildActionsTestApp } from "./__tests__/actions-test-app.js";

describe("action definitions API", () => {
  it("lists every definition with only floor-respecting options", async () => {
    const res = await request(buildActionsTestApp().app).get("/api/action-definitions");
    const byType = Object.fromEntries(res.body.definitions.map((d: { type: string }) => [d.type, d]));
    expect(Object.keys(byType)).toHaveLength(10);
    expect(byType.create_calendar_event.approval.options.map((o: { label: string }) => o.label)).toEqual([
      "Auto unless other people involved",
      "Always ask",
    ]);
    expect(byType.send).toMatchObject({ available: false, unavailableReason: "needs Gmail send access (gmail.send)" });
    expect(byType.notify.disableWarning).toBe("Turning this off stops urgent-email notifications.");
  });

  it("refuses a looser value with 422 and stores nothing", async () => {
    const t = buildActionsTestApp();
    const res = await request(t.app).put("/api/action-definitions/create_calendar_event/config").send({ approvalMode: "auto" });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe("approval.mode");
    expect(t.configRepo.get("personal", "user-A", "create_calendar_event")).toBeNull();
  });

  it("saves a valid change, keeps other fields and records who changed it", async () => {
    const t = buildActionsTestApp();
    await request(t.app).put("/api/action-definitions/create_reminder/config").send({ approvalMode: "auto" });
    const res = await request(t.app).put("/api/action-definitions/create_reminder/config").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approval: { mode: "auto" }, enabled: false, lastChange: { changedBy: "user-A" } });
    expect(t.configRepo.history("personal", "user-A", "create_reminder", 10)).toHaveLength(2);
  });

  it("refuses config for unavailable actions and unknown types", async () => {
    const t = buildActionsTestApp();
    expect((await request(t.app).put("/api/action-definitions/send/config").send({ enabled: false })).status).toBe(403);
    expect((await request(t.app).put("/api/action-definitions/nope/config").send({ enabled: false })).status).toBe(404);
  });

  it("flags a stored row that is looser than the floor", async () => {
    const t = buildActionsTestApp();
    t.configRepo.save({ scope: "personal", ownerId: "user-A", actionType: "create_calendar_event", configJson: '{"approval":{"mode":"auto"}}', changedBy: "sql" });
    const res = await request(t.app).get("/api/action-definitions");
    const def = res.body.definitions.find((d: { type: string }) => d.type === "create_calendar_event");
    expect(def).toMatchObject({ approval: { mode: "above_threshold" }, flags: { clamped: ["approval.mode"], rejected: null } });
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd packages/agent-server && npx vitest run src/routes/actions.route.test.ts src/routes/action-definitions.route.test.ts`
Expected: FAIL, modules missing / old router signature.

- [ ] **Step 5: Write `action-views.ts`**

```ts
import { groupOf, type ActionView } from "@oneon/contracts";
import type { ActionEvent, ActionInstance, ActorContext, CheckResult } from "@oneon/domain";
import {
  allowedOperations,
  describeInstance,
  describeReason,
  type ActionRegistry,
  type EffectivePolicy,
  type PolicyDecision,
} from "@oneon/application";

const RULE_LABELS: Record<string, string> = {
  "inbox.urgent_notify": "Inbox rule · urgent notify",
  "inbox.deadline_reminder": "Inbox rule · deadline reminder",
  "inbox.spam_archive": "Inbox rule · spam cleanup",
  "inbox.newsletter_label": "Inbox rule · newsletter label",
  "inbox.follow_up_draft": "Inbox rule · follow-up draft",
};

const UNDO_TEXT = {
  reversible: "Can be undone",
  conditional: "Can be undone if nobody has changed it since",
  irreversible: "This action cannot be automatically reversed.",
} as const;

function originOf(instance: ActionInstance): ActionView["origin"] {
  if (instance.initiator.startsWith("rule:")) {
    const id = instance.initiator.slice(5);
    return { kind: "rule", label: RULE_LABELS[id] ?? `Inbox rule · ${id}`, excerpt: null };
  }
  if (instance.initiator.startsWith("schedule:")) return { kind: "schedule", label: "Scheduled", excerpt: null };
  const chat = instance.evidence.find((e) => e.kind === "chat_turn");
  return chat
    ? { kind: "chat", label: "Requested in chat", excerpt: typeof chat.data.excerpt === "string" ? chat.data.excerpt : null }
    : { kind: "user", label: "Requested by you", excerpt: null };
}

function latestChecks(events: ActionEvent[]): CheckResult[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const checks = events[i].data.checks;
    if (Array.isArray(checks)) return checks as CheckResult[];
  }
  return [];
}

export function toActionView(
  instance: ActionInstance,
  ctx: { registry: ActionRegistry; events: ActionEvent[]; viewer: ActorContext; policy: EffectivePolicy },
): ActionView {
  const def = ctx.registry.get(instance.actionType);
  const decision = instance.decision as unknown as PolicyDecision | null;
  const settled = instance.status === "completed" || instance.status === "partially_completed";
  return {
    id: instance.id,
    actionType: instance.actionType,
    label: def.label,
    status: instance.status,
    group: groupOf(instance.status),
    risk: decision?.risk ?? def.floor.risk,
    origin: originOf(instance),
    description: describeInstance(def, instance),
    evidence: instance.evidence,
    decision: decision ? { outcome: decision.outcome, reasons: decision.reasons.map((r) => ({ code: r.code, text: describeReason(r, def) })) } : null,
    checks: latestChecks(ctx.events),
    undo: {
      rollbackClass: def.rollbackClass,
      text: UNDO_TEXT[def.rollbackClass],
      warning: settled && def.undo && instance.resolved ? def.undo.warning(instance.resolved) : null,
    },
    error: instance.error,
    allowedOperations: allowedOperations(ctx.viewer, instance, {
      policy: ctx.policy,
      rollbackClass: def.rollbackClass,
      hasUndo: def.undo !== null && instance.undo !== null,
      executorAvailable: def.execute !== null,
    }),
    retryOf: instance.retryOf,
    attemptNumber: instance.attemptNumber,
    resourceRef: instance.resourceRef,
    verifyingSince: instance.status === "verifying" ? instance.updatedAt : null,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    timeline: ctx.events.map((e) => ({ seq: e.seq, fromStatus: e.fromStatus, toStatus: e.toStatus, actor: e.actor, data: e.data, createdAt: e.createdAt })),
  };
}
```

- [ ] **Step 6: Write the routers**

`actions.route.ts` (full replacement):

```ts
import { Router, type Response } from "express";
import { ActionViewQuerySchema, LEGACY_BANNER, STATUS_GROUPS } from "@oneon/contracts";
import {
  personalActor,
  type ActionConfigRepository,
  type ActionInstance,
  type ActionInstanceRepository,
  type LegacyActionRepository,
  type Logger,
} from "@oneon/domain";
import {
  ActionOperationError,
  clampPolicy,
  type ActionOrchestrator,
  type ActionRegistry,
  type RequestOutcome,
} from "@oneon/application";
import { toActionView } from "./action-views.js";

export interface ActionsRouteDeps {
  orchestrator: ActionOrchestrator;
  registry: ActionRegistry;
  instanceRepo: ActionInstanceRepository;
  configRepo: ActionConfigRepository;
  legacyRepo: LegacyActionRepository;
  logger: Logger;
}

export function createActionsRouter(deps: ActionsRouteDeps): Router {
  const router = Router();

  const view = (userId: string, instance: ActionInstance) => {
    const def = deps.registry.get(instance.actionType);
    const stored = deps.configRepo.get(instance.scope, instance.ownerId, def.type);
    const { policy } = clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson: stored?.configJson ?? null,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });
    return toActionView(instance, {
      registry: deps.registry,
      events: deps.instanceRepo.listEvents(userId, instance.id),
      viewer: personalActor(userId),
      policy,
    });
  };

  const fail = (res: Response, error: unknown, context: Record<string, unknown>) => {
    if (error instanceof ActionOperationError) {
      const status = error.code === "not_found" ? 404 : error.code === "not_allowed" ? 403 : 409;
      res.status(status).json({ error: error.message });
      return;
    }
    deps.logger.error("Action request failed", { ...context, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Internal server error" });
  };

  router.get("/", (req, res) => {
    const parsed = ActionViewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters", details: parsed.error.format() });
      return;
    }
    const userId = req.userId!;
    const { limit, offset, status, group } = parsed.data;
    const statuses = status ? [status] : group ? [...STATUS_GROUPS[group]] : undefined;
    try {
      const actions = deps.instanceRepo.list(userId, { statuses, limit, offset }).map((i) => view(userId, i));
      const total = deps.instanceRepo.count(userId, { statuses });
      res.json({ actions, pagination: { limit, offset, total, hasMore: offset + limit < total } });
    } catch (error) {
      fail(res, error, { route: "list" });
    }
  });

  router.get("/legacy", (req, res) => {
    const userId = req.userId!;
    const limit = Math.min(Number(req.query.limit ?? 25) || 25, 100);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const rows = deps.legacyRepo.listForUser(userId, { limit, offset });
    const total = deps.legacyRepo.countForUser(userId);
    res.json({
      banner: LEGACY_BANNER,
      actions: rows.map((r) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(r.payloadJson) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        return { id: r.id, actionType: r.actionType, status: r.status, payload, createdAt: r.createdAt };
      }),
      pagination: { limit, offset, total, hasMore: offset + limit < total },
    });
  });

  router.get("/:id", (req, res) => {
    const userId = req.userId!;
    const instance = deps.instanceRepo.findById(userId, req.params.id);
    if (!instance) {
      res.status(404).json({ error: "Action not found" });
      return;
    }
    res.json(view(userId, instance));
  });

  router.get("/:id/events", (req, res) => {
    const userId = req.userId!;
    if (!deps.instanceRepo.findById(userId, req.params.id)) {
      res.status(404).json({ error: "Action not found" });
      return;
    }
    res.json({ events: deps.instanceRepo.listEvents(userId, req.params.id) });
  });

  type Op = "approve" | "reject" | "cancel" | "undo";
  const run: Record<Op, (userId: string, id: string, body: { reason?: unknown }) => Promise<ActionInstance>> = {
    approve: (u, id) => deps.orchestrator.approve(personalActor(u), id),
    reject: (u, id, b) => deps.orchestrator.reject(personalActor(u), id, typeof b.reason === "string" ? b.reason : undefined),
    cancel: (u, id) => deps.orchestrator.cancel(personalActor(u), id),
    undo: (u, id) => deps.orchestrator.requestUndo(personalActor(u), id),
  };
  for (const op of Object.keys(run) as Op[]) {
    router.post(`/:id/${op}`, async (req, res) => {
      const userId = req.userId!;
      try {
        // Execution never depends on this request's connection (spec §10.2).
        const instance = await run[op](userId, req.params.id, req.body ?? {});
        res.json(view(userId, instance));
      } catch (error) {
        fail(res, error, { route: op, actionId: req.params.id });
      }
    });
  }

  router.post("/:id/retry", async (req, res) => {
    const userId = req.userId!;
    try {
      const outcome: RequestOutcome = await deps.orchestrator.retry(personalActor(userId), req.params.id);
      if (outcome.kind === "refused") {
        res.status(422).json({ error: "Retry refused", issues: outcome.issues });
        return;
      }
      res.json(view(userId, outcome.instance));
    } catch (error) {
      fail(res, error, { route: "retry", actionId: req.params.id });
    }
  });

  return router;
}
```

`action-definitions.route.ts`:

```ts
import { Router } from "express";
import { ActionConfigWriteSchema, type ActionDefinitionView } from "@oneon/contracts";
import type { ActionConfigRepository, Logger } from "@oneon/domain";
import {
  approvalOptions,
  clampPolicy,
  validateConfigWrite,
  type ActionRegistry,
  type AnyActionDefinition,
} from "@oneon/application";

export interface ActionDefinitionsRouteDeps {
  registry: ActionRegistry;
  configRepo: ActionConfigRepository;
  logger: Logger;
}

export function createActionDefinitionsRouter(deps: ActionDefinitionsRouteDeps): Router {
  const router = Router();

  const toView = (userId: string, def: AnyActionDefinition): ActionDefinitionView => {
    const stored = deps.configRepo.get("personal", userId, def.type);
    const clamp = clampPolicy({
      floor: def.floor,
      defaults: def.defaults,
      storedJson: stored?.configJson ?? null,
      declaredMetrics: Object.keys(def.thresholdMetrics),
      executorAvailable: def.execute !== null,
    });
    const last = deps.configRepo.history("personal", userId, def.type, 1)[0];
    const labels = Object.fromEntries(Object.entries(def.thresholdMetrics).map(([k, m]) => [k, m.label]));
    return {
      type: def.type,
      label: def.label,
      description: def.description,
      available: def.execute !== null,
      unavailableReason: def.unavailableReason,
      rollbackClass: def.rollbackClass,
      risk: { floor: def.floor.risk, effective: clamp.policy.risk },
      approval: { mode: clamp.policy.approval.mode, options: approvalOptions(def.floor, labels) },
      expiryHours: clamp.policy.expiryHours,
      enabled: clamp.policy.enabled,
      disableWarning: def.disableWarning,
      flags: { clamped: clamp.clamped, rejected: clamp.rejected },
      lastChange: last ? { changedBy: last.changedBy, changedAt: last.changedAt } : null,
    };
  };

  router.get("/", (req, res) => {
    const userId = req.userId!;
    res.json({ definitions: deps.registry.list().map((d) => toView(userId, d)) });
  });

  router.put("/:type/config", (req, res) => {
    const userId = req.userId!;
    if (!deps.registry.has(req.params.type)) {
      res.status(404).json({ error: "Unknown action type" });
      return;
    }
    const def = deps.registry.get(req.params.type);
    if (def.execute === null) {
      res.status(403).json({ error: "This action is not available yet." });
      return;
    }
    const body = ActionConfigWriteSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(422).json({ errors: body.error.issues.map((i) => ({ field: i.path.join(".") || "(body)", message: i.message })) });
      return;
    }

    let existing: Record<string, unknown> = {};
    try {
      const stored = deps.configRepo.get("personal", userId, def.type);
      if (stored) existing = JSON.parse(stored.configJson) as Record<string, unknown>;
    } catch {
      existing = {};
    }
    const next: Record<string, unknown> = { ...existing };
    if (body.data.enabled !== undefined) next.enabled = body.data.enabled;
    if (body.data.approvalMode !== undefined) {
      next.approval =
        body.data.approvalMode === "above_threshold"
          ? { mode: "above_threshold", thresholds: def.floor.approval.thresholds }
          : { mode: body.data.approvalMode };
    }

    const validated = validateConfigWrite({ floor: def.floor, declaredMetrics: Object.keys(def.thresholdMetrics), body: next });
    if (!validated.ok) {
      res.status(422).json({ errors: validated.errors });
      return;
    }
    deps.configRepo.save({ scope: "personal", ownerId: userId, actionType: def.type, configJson: validated.configJson, changedBy: userId });
    deps.logger.info("Action config changed", { userId, actionType: def.type, config: validated.configJson });
    res.json(toView(userId, def));
  });

  return router;
}
```

- [ ] **Step 7: Register the routers**

In `routes/index.ts`, replace the actions router registration with:

```ts
  app.use(
    "/api/actions",
    ...userAuth,
    createActionsRouter({
      orchestrator: container.actions.orchestrator,
      registry: container.actions.registry,
      instanceRepo: container.actions.instanceRepo,
      configRepo: container.actions.configRepo,
      legacyRepo: container.actions.legacyRepo,
      logger: actionsLogger,
    }),
  );
  app.use(
    "/api/action-definitions",
    ...userAuth,
    createActionDefinitionsRouter({
      registry: container.actions.registry,
      configRepo: container.actions.configRepo,
      logger: actionsLogger,
    }),
  );
  actionsLogger.info("Actions routes registered at /api/actions and /api/action-definitions");
```

- [ ] **Step 8: Run tests, build, typecheck**

Run: `cd packages/agent-server && npx vitest run src/routes`
Expected: PASS.
Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts packages/agent-server/src/routes
git commit -m "feat(actions): add the actions and action-definitions API" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Switch every consumer; swap chat tools; architecture tests

**Files:**
- Modify: `packages/agent-server/src/routes/index.ts` (chat tools, list_pending_actions, daily briefing)
- Modify: `packages/agent-server/src/routes/chat.route.ts` (+ test), `today.route.ts` (+ test), `inbox.route.ts` (+ test), `cycle.route.ts` (+ test)
- Modify: `packages/contracts/src/inbox.contract.ts`
- Modify: `packages/application/src/tools/list-pending-actions.ts` (+ test), `daily-briefing.ts` (+ test), `packages/application/src/usecases/generate-daily-briefing.ts` (+ test)
- Delete: `packages/application/src/tools/create-calendar-event.ts`, `create-calendar-event.test.ts`, `update-calendar-event.ts`, `update-calendar-event.test.ts` (and their exports in `tools/index.ts`)
- Modify: `packages/domain/src/ports/calendar.port.ts` (remove `createEvent`/`updateEvent` from `CalendarPort`)
- Modify: `packages/infrastructure/src/calendar/google-calendar-adapter.ts` (+ test: remove the old `createEvent`/`updateEvent`)
- Create: `packages/agent-server/src/architecture.test.ts`

**Interfaces:**
- Consumes: `container.actions`; `createChatActionTools`.
- Produces: `CalendarPort` = reader shape `{ listEvents; searchEvents }`; `PendingActionSummary { actionType; resourceId; riskLevel }`; `GenerateDailyBriefingDeps.listPendingActions(): PendingActionSummary[]`.

- [ ] **Step 1: Write the failing architecture test**

`packages/agent-server/src/architecture.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const posix = (p: string) => p.split(sep).join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g;

describe("architecture", () => {
  it("domain imports only relative paths inside domain", () => {
    const domainSrc = join(ROOT, "domain", "src");
    const offenders: string[] = [];
    for (const file of sourceFiles(domainSrc)) {
      for (const [, spec] of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const inside = spec.startsWith(".") && resolve(dirname(file), spec).startsWith(domainSrc);
        if (!inside) offenders.push(`${posix(relative(ROOT, file))} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only executors, the calendar adapter and the wiring import CalendarWriter", () => {
    const allowed = [
      /^domain\/src\/ports\/calendar\.port\.ts$/,
      /^domain\/src\/actions\/capabilities\.ts$/,
      /^application\/src\/actions\/definitions\//,
      /^application\/src\/actions\/__tests__\//,
      /^infrastructure\/src\/calendar\//,
      /^agent-server\/src\/actions-wiring\.ts$/,
      /\.test\.ts$/,
    ];
    const offenders = ["domain", "application", "infrastructure", "agent-server"]
      .flatMap((pkg) => sourceFiles(join(ROOT, pkg, "src")))
      .filter((f) => /import[^;]*\bCalendarWriter\b[^;]*from/.test(readFileSync(f, "utf8")))
      .map((f) => posix(relative(ROOT, f)))
      .filter((p) => !allowed.some((re) => re.test(p)));
    expect(offenders).toEqual([]);
  });

  it("executors never import the instance repository", () => {
    const offenders = sourceFiles(join(ROOT, "application", "src", "actions", "definitions"))
      .filter((f) => /\bActionInstanceRepository\b/.test(readFileSync(f, "utf8")))
      .map((f) => posix(relative(ROOT, f)));
    expect(offenders).toEqual([]);
  });

  it("chat tools never construct or receive a calendar writer", () => {
    const routes = readFileSync(join(ROOT, "agent-server", "src", "routes", "index.ts"), "utf8");
    expect(routes).not.toMatch(/createCreateCalendarEventTool|createUpdateCalendarEventTool/);
    expect(readFileSync(join(ROOT, "application", "src", "actions", "chat-action-tools.ts"), "utf8")).not.toMatch(/CalendarWriter|writers/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/agent-server && npx vitest run src/architecture.test.ts`
Expected: FAIL on the last case (routes still register the old calendar tools). If the domain-import case fails, fix the offending import in domain (it must be relative).

- [ ] **Step 3: Swap the chat calendar tools**

In `routes/index.ts`, delete the two `createCreateCalendarEventTool` / `createUpdateCalendarEventTool` registrations and their imports, and register the action tools (outside the `if (container.calendarPort)` block, so the honest "calendar not connected" failure reaches the user):

```ts
    const aiModel =
      env.LLM_PROVIDER === "deepseek"
        ? `deepseek:${env.DEEPSEEK_CLASSIFIER_MODEL ?? "unknown"}`
        : `anthropic:${env.LLM_CLASSIFIER_MODEL}`;
    for (const tool of createChatActionTools({
      requestAction: container.actions.orchestrator.requestAction,
      registry: container.actions.registry,
      aiModel,
      clock: () => new Date(),
    })) {
      toolRegistry.register(tool);
    }
```

Delete `packages/application/src/tools/create-calendar-event.ts`, `update-calendar-event.ts` and their tests, and their exports in `tools/index.ts`.

- [ ] **Step 4: Trim `CalendarPort` to the reader shape**

In `calendar.port.ts`, change `CalendarPort` to:

```ts
/** Read access used by chat tools, Today and the briefing. Writes go through CalendarWriter. */
export interface CalendarPort {
  listEvents(timeMin: string, timeMax: string): Promise<CalendarEvent[]>;
  searchEvents(query: string, timeMin?: string, timeMax?: string): Promise<CalendarEvent[]>;
}
```

In `google-calendar-adapter.ts`, delete the old `createEvent` and `updateEvent` methods; delete their cases from `__tests__/google-calendar-adapter.test.ts`. Run `grep -rn "\.createEvent(\|\.updateEvent(" packages/*/src` and remove any remaining caller or mock member.

- [ ] **Step 5: Switch `list_pending_actions` and the daily briefing (tests first)**

In `list-pending-actions.test.ts`, replace the `actionLogRepo` fake with an `InMemoryActionRepo` instance (import from `../actions/__tests__/in-memory-repos.js`) seeded with one `awaiting_approval` instance for `u1` and one for `u2`, and assert:

```ts
  it("lists the signed-in user's actions awaiting approval", async () => {
    const result = await tool.execute(tool.inputSchema.parse({ userId: "u1" }));
    expect(result.data).toEqual([expect.objectContaining({ id: "a-u1", label: "Create reminder", status: "awaiting_approval" })]);
    expect(result.summary).toBe("Found 1 action awaiting approval.");
  });

  it("returns nothing without a session", async () => {
    expect((await tool.execute(tool.inputSchema.parse({}))).data).toEqual([]);
  });
```

Then rewrite `list-pending-actions.ts`:

```ts
import { z } from "zod";
import { LIFECYCLE_STATUSES, type ActionInstanceRepository } from "@oneon/domain";
import type { ToolDefinition, ToolResult } from "./tool-registry.js";
import type { ActionRegistry } from "../actions/registry.js";
import { describeInstance } from "../actions/orchestrator/shared.js";

export const listPendingActionsSchema = z.object({
  status: z.enum(LIFECYCLE_STATUSES).optional().default("awaiting_approval"),
  limit: z.number().int().min(1).max(50).optional().default(20),
  userId: z.string().trim().min(1).optional(),
});

export interface ListPendingActionsDeps {
  instanceRepo: ActionInstanceRepository;
  registry: ActionRegistry;
}

export function createListPendingActionsTool(deps: ListPendingActionsDeps): ToolDefinition {
  return {
    name: "list_pending_actions",
    version: "2.0.0",
    description: "List the user's actions in a status. Defaults to actions awaiting approval.",
    inputSchema: listPendingActionsSchema,
    execute(validatedInput: unknown): ToolResult {
      const input = validatedInput as z.infer<typeof listPendingActionsSchema>;
      if (!input.userId) return { data: [], summary: "Found 0 actions." };
      const actions = deps.instanceRepo.list(input.userId, { statuses: [input.status], limit: input.limit }).map((i) => {
        const def = deps.registry.get(i.actionType);
        return { id: i.id, actionType: i.actionType, label: def.label, status: i.status, description: describeInstance(def, i), createdAt: i.createdAt };
      });
      const noun = input.status === "awaiting_approval" ? "awaiting approval" : input.status;
      return { data: actions, summary: `Found ${actions.length} action${actions.length === 1 ? "" : "s"} ${noun}.` };
    },
  };
}
```

In `generate-daily-briefing.ts`: replace `actionLogRepo: ActionLogRepository;` with `listPendingActions(): PendingActionSummary[];`, change `pendingActions: ActionLogEntry[]` in `BriefingData` to `pendingActions: PendingActionSummary[]`, add

```ts
export interface PendingActionSummary {
  actionType: string;
  resourceId: string;
  riskLevel: string;
}
```

and replace `deps.actionLogRepo.findByStatus("proposed")` with `deps.listPendingActions()`. Update its test fakes to pass `listPendingActions: () => [{ actionType: "create_reminder", resourceId: "deadline:d1", riskLevel: "L1" }]` where they previously seeded proposed actions; the rendered line becomes `- create_reminder on deadline:d1 [L1]`.

In `daily-briefing.ts`: replace `actionLogRepo` in its deps with `instanceRepo: ActionInstanceRepository`, add `userId: z.string().trim().min(1).optional()` to `dailyBriefingSchema`, and build:

```ts
        listPendingActions: () =>
          input.userId
            ? deps.instanceRepo.list(input.userId, { statuses: ["awaiting_approval"], limit: 20 }).map((i) => ({
                actionType: i.actionType,
                resourceId: i.resourceRef ?? i.id,
                riskLevel: String((i.decision as { risk?: string } | null)?.risk ?? "L1"),
              }))
            : [],
```

Update `daily-briefing.test.ts` accordingly. In `routes/index.ts`, pass `instanceRepo: container.actions.instanceRepo, registry: container.actions.registry` to `createListPendingActionsTool` and `instanceRepo: container.actions.instanceRepo` to `createDailyBriefingTool`.

- [ ] **Step 6: Switch the routes**

- `chat.route.ts`: change the `actionLogRepo` dep to `instanceRepo?: Pick<ActionInstanceRepository, "count"> | null`, compute `pendingActionsCount: instanceRepo ? instanceRepo.count(userId, { statuses: ["awaiting_approval"] }) : 0`, and add `actions: result.actions,` to the 200 response. In its test, assert the response includes the `actions` array returned by the use case.
- `today.route.ts`: replace the two `actionLogRepo` calls with

```ts
      const waiting = instanceRepo.list(userId, { statuses: ["awaiting_approval"], limit: 10 });
      const pendingActions = waiting.map((i) => ({
        id: i.id,
        actionType: i.actionType,
        riskLevel: String((i.decision as { risk?: string } | null)?.risk ?? "L1"),
        resourceId: i.resourceRef ?? i.id,
      }));
      const pendingCount = instanceRepo.count(userId, { statuses: ["awaiting_approval"] });
```

  with `instanceRepo: ActionInstanceRepository` replacing `actionLogRepo` in `TodayRouteDeps`.
- `inbox.route.ts`: replace the related-actions lookup with `instanceRepo.list(userId, { resourceRef: \`inbound_item:${item.id}\` })`, mapping `{ id, actionType, riskLevel: decision?.risk ?? "L1", status, createdAt }`. In `inbox.contract.ts`, change that array's `riskLevel` to `z.string()` and `status` to `z.enum(LIFECYCLE_STATUS_VALUES)` (import from `./actions.contract.js`). Run `grep -rn "riskLevel" packages/dashboard/src` and make any inbox UI that compares against `"approval_required"` show the risk tier text instead.
- `cycle.route.ts`: replace the failed-action query with `instanceRepo.list(userId, { statuses: ["failed", "rollback_failed"], limit: limit * 5 })`, mapping `message` from `i.error?.message ?? "Action failed"` and keeping the existing `id: \`action-${i.id}-${i.updatedAt}\`` and `occurredAt: i.updatedAt` shape.
- In `routes/index.ts`, pass `instanceRepo: container.actions.instanceRepo` instead of `actionLogRepo: container.actionLogRepo` to the chat, today, inbox and cycle routers.

Update each route's test to build an `instanceRepo` fake (`list`/`count` `vi.fn()`s returning seeded instances) in place of the `actionLogRepo` fake; keep each test's assertions on the response shape.

- [ ] **Step 7: Run tests, build, typecheck**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green, including `architecture.test.ts`.
Run: `grep -rn "actionLogRepo" packages/*/src --include=*.ts | grep -v "container.ts"`
Expected: no output (the container field goes in Task 16).

- [ ] **Step 8: Commit**

```bash
git add -A packages
git commit -m "refactor(actions): move every consumer to the action framework" -m "Chat calendar tools now request actions; CalendarPort is read-only; adds architecture tests for the executor and domain boundaries." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: ADR-011, PRD, and removal of the MVP1 action log code

**Files:**
- Create: `docs/adr/011-action-spec-framework.md`
- Modify: `docs/adr/006-append-only-audit-log.md` (status line only)
- Modify: `docs/PRD.md`
- Delete: `packages/infrastructure/src/database/repositories/sqlite-action-log.repository.ts`
- Modify: `packages/infrastructure/src/database/repositories/index.ts`, `packages/infrastructure/src/database/repositories.integration.test.ts` (remove the `SqliteActionLogRepository` block and import)
- Delete: `packages/domain/src/ports/action-log-repository.port.ts`; modify `packages/domain/src/ports/index.ts`
- Modify: `packages/domain/src/entities.ts`, `packages/domain/src/enums.ts` (remove `ActionLogEntry`, `ActionType`, `RiskLevel`, `ActionStatus` once unreferenced)
- Modify: `packages/agent-server/src/container.ts` (remove `actionLogRepo`)

- [ ] **Step 1: Write ADR-011**

`docs/adr/011-action-spec-framework.md`:

```markdown
# ADR-011: Action Spec Framework and Lifecycle

## Status: Accepted

## Date: 2026-10-01

## Supersedes: ADR-006 (Append-Only Audit Log for Action Lifecycle)

## Context

ADR-006 required that `action_log` rows never be updated, then chose "a status field update
with timestamps". The code followed the second statement: `updateStatus` overwrote status,
result and error in place, so a failure that later succeeded on retry lost its error record.
Execution itself only changed a status. Oneon now executes real actions (notifications and
Google Calendar writes) and will act inside ImpressoRx tenants, which requires a typed action
contract, enforceable policy, verification and honest undo. Design:
`docs/superpowers/specs/2026-10-01-action-spec-framework-design.md`.

## Decision

1. **Code defines, the database configures.** Action types exist only in a code registry.
   Each definition declares its schema, preconditions, executor, postconditions, rollback
   class and a policy floor. Database configuration may tighten a definition but never loosen
   it past the floor: new writes past the floor are refused (HTTP 422); stored rows are clamped
   on every read and flagged.
2. **Trust order.** Code floor > database configuration > AI. The AI supplies only an action
   type and input; identity and tenant come only from the signed-in session. For tenant data,
   the external system's authorization (ImpressoRx) is final.
3. **Lifecycle.** Fifteen statuses: proposed, validating, awaiting_approval, approved,
   executing, verifying, completed, partially_completed, rejected, expired, cancelled, failed,
   rolling_back, rolled_back, rollback_failed. Transitions are forward-only; retrying creates a
   new linked action. An unknown executor outcome goes to verification, never to failed.
4. **Storage.** `action_events` is the authoritative history; SQLite triggers abort any UPDATE
   or DELETE. `action_instances` is an explicitly mutable projection, changed only by one
   transactional method that checks the expected status. A drift check rebuilds the projection
   from events. `action_log` is renamed `action_log_legacy` and locked the same way.
5. **Idempotency** uses explicit keys unique per (scope, owner, type, key), replacing the
   (resource_id, action_type) check.
6. **Retention.** Keep everything. Revisit when tenant-scale ERP volume arrives or the database
   passes 1 GB.

## Consequences

**Easier:** a complete, tamper-resistant audit trail; every action explains its origin,
evidence, policy decision and checks; undo is verified and refused when the target changed
since; ERP actions plug into the same contract.

**Harder:** more tables and code paths; every new action type needs a definition with checks
and tests; the config UI must never offer values looser than the floor.
```

In `docs/adr/006-append-only-audit-log.md`, change `## Status: Accepted` to `## Status: Superseded by ADR-011`.

- [ ] **Step 2: Update the PRD**

In `docs/PRD.md` §5.4, replace rows FR-026 to FR-034 with:

```markdown
| FR-026 | Inbox rules and chat request actions through the code registry; unregistered types are refused | P0 |
| FR-027 | Actions follow a 15-status forward-only lifecycle (see ADR-011) | P0 |
| FR-028 | Risk tiers L0–L4 and per-action approval policy, configurable but never looser than the code floor | P0 |
| FR-029 | Idempotent: one action per (scope, owner, type, idempotency key) | P0 |
| FR-030 | Every status change is an immutable event; the instance row is a projection | P0 |
| FR-031 | Undo is verified, version-checked, and refused for irreversible actions | P1 |
| FR-032 | Action Center shows origin, plan, evidence, policy reasons, checks and timeline; buttons follow policy | P0 |
| FR-033 | Actions whose policy outcome is auto run immediately after validation | P0 |
| FR-034 | Retrying a failed or expired action creates a new linked action | P1 |
```

In §7, replace the `action_log` row with:

```markdown
| `action_instances` | Current state of each action (projection) | Changed only through the transition repository |
| `action_events` | Immutable action history | UPDATE/DELETE abort by trigger |
| `action_definition_configs` | Per-owner action policy | Clamped to the code floor on read |
| `action_definition_config_history` | Who changed action policy, and how | Append-only by trigger |
| `action_log_legacy` | MVP1 action rows, read-only | UPDATE/DELETE abort by trigger |
```

In §8, under the table, add: "`create_calendar_event` and `update_calendar_event` request actions; they never write to Google directly." In §10, replace the "Multi-user / multi-tenant…" and "Pharmaceutical ERP…" bullets with: "Tenant linking and ERP actions — planned as Action Spec sub-projects B and C."

- [ ] **Step 3: Remove the MVP1 action log code**

```bash
git rm packages/infrastructure/src/database/repositories/sqlite-action-log.repository.ts packages/domain/src/ports/action-log-repository.port.ts
```

Remove the `SqliteActionLogRepository` export line, the `ActionLogRepository` export from `ports/index.ts`, the `actionLogRepo` field/construction in `container.ts` and `AppContainer`, and the `describe("SqliteActionLogRepository", …)` block plus import in `repositories.integration.test.ts`. Then:

Run: `grep -rn "ActionLogEntry\|ActionLogRepository\|\bActionStatus\b\|\bRiskLevel\b\|ActionType\." packages/*/src --include=*.ts`
For each symbol with no remaining reference outside `domain`, delete it from `entities.ts` / `enums.ts`. Keep any symbol that is still referenced (for example by contracts' deprecated schemas until Task 18) and note it in the commit message.

- [ ] **Step 4: Run tests, build, typecheck**

Run: `pnpm -r run build && pnpm -r run typecheck && pnpm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A docs packages
git commit -m "docs(actions): add ADR-011, update PRD, and remove the MVP1 action log" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
