# Action Spec framework: design (sub-project A)

**Status:** Draft, awaiting product-owner review of this written spec
**Date:** 2026-10-01
**Scope:** Oneon only (`camp-aneone`). No ImpressoRx changes.
**Source:** [Oneon Action Spec](2026-10-01-action-spec-source.md), the product owner's original spec
**Supersedes, once implemented:** ADR-006's status rule (replaced by ADR-011, see §15.3)
**Approved in review:** Sections 1–6 and amendments A1–A8, 2026-10-01. §18 lists the
consistency fixes made while writing this document.

---

## 1. Summary

Oneon gains a formal Action Spec layer between intent and execution.

- **Code defines** each action type: input schema, checks, executor, verification, undo.
- **The database configures** its policy (enabled, risk, approval, thresholds, permissions, expiry),
  and the configuration can never be looser than a floor declared in code.
- **Every action is an instance** whose current state is a projection of an append-only event
  history.

This build proves the framework on Oneon's own actions. Four have real executors (`notify`,
`create_reminder`, `create_calendar_event`, `update_calendar_event`), and six Gmail actions are
registered but unavailable. Every instance is tenant-aware, so the ImpressoRx tenant link
(sub-project B) and the first ERP action (sub-project C) plug in without changing these contracts.
When this ships, the product owner reviews the UI in the browser (§16) before the next step is
chosen.

## 2. Context and decisions already made

### 2.1 What exists today

| Area | Today |
|---|---|
| Actions | `action_log` table; 9 types; 2 risk levels (`auto`, `approval_required`); 5 statuses |
| Execution | a status change only; nothing happens outside Oneon |
| History | `updateStatus` overwrites status, result and error in place; a retried failure loses its error |
| ADR-006 | says "no rows are ever updated in place" and then chooses "a status field update" — a self-contradiction; the code follows the second |
| Gmail access | read-only scopes; Oneon cannot archive, label, delete, draft, send or forward |
| Chat | `create_calendar_event` and `update_calendar_event` write to Google Calendar directly, with no approval and no record |
| Notifications | the pipeline sends its own "Urgent: …" notification for priority ≤ 2, separately from the `notify` action, which does nothing |
| Parked work | `stash@{0}` holds an executor/rollback WIP. This design supersedes it; the stash stays parked |

### 2.2 Decisions (2026-10-01)

1. Oneon's ERP users are **tenant staff**. Anyone with a staff account at an ImpressoRx business
   gets Oneon for that business; there is no vendor route around this.
2. Oneon stays **standalone software** that integrates with ImpressoRx; it is not embedded in it.
3. Tenants, roles and locations are **enforced**, not merely reserved. Tenant security and privacy
   come first.
4. The work splits into sub-projects: **A** this framework; **B** the tenant link (both repos);
   **C** the first ERP action end to end. A comes first, followed by a visual review of the UI.
5. The proving set is the inbox actions plus chat's two calendar writes.
6. The approach is the hybrid in §4: code defines, the database configures.

## 3. Goals and non-goals

**Goals**

| # | Goal |
|---|---|
| G1 | An action type exists only if it is registered in code |
| G2 | Configuration can tighten a definition but never loosen it past its code floor |
| G3 | A 15-status, forward-only lifecycle whose history is immutable |
| G4 | Real execution, with verification and honest undo, for four actions |
| G5 | Chat-requested actions go through the registry instead of writing directly |
| G6 | Tenant-ready contracts: scope, owner, tenant, locations, actor |
| G7 | Action Center and Settings → Actions UI, ready for visual review |
| G8 | The architectural rules are enforced by tests, not by convention |

**Non-goals (this build)**: the ImpressoRx link, tenant memberships, ERP actions, action plans,
business-profile parameters, Gmail write access, a job queue, editable threshold numbers,
approvals across different people.

## 4. Principles and trust model

> **LLM proposes. Code defines. Database configures. Policy authorizes. Executor changes the world.
> Event log remembers.**

### 4.1 Trust order

| Question | Decided by | Never by |
|---|---|---|
| Does this action type exist? | the code registry | the database, the AI, request input |
| How does it work (schema, checks, executor, undo)? | code | the database, the AI |
| What are its policy settings? | database config, clamped to the code floor | the AI |
| Who is acting, for whom, in which tenant? | the signed-in session | the AI, request body |
| What should be done (type and input)? | the AI or a rule proposes; code schema and preconditions validate | — |
| Is it allowed, and does it need approval? | the policy function | the AI |

The code floor is the only hard limit. A tenant override (sub-project B) is database config like
any other: looser or stricter than the default, never past the floor. For tenant data, the
external system's own authorization (ImpressoRx) outranks everything in Oneon (§12).

### 4.2 Rules

| # | Rule | Enforced by |
|---|---|---|
| R1 | Registration is the gate: unknown types are refused and logged | registry lookup; typed error |
| R2 | Config can tighten but not loosen past the floor | `clampPolicy` on every read; 422 on writes (§6) |
| R3 | The AI and rules supply only type and input; Oneon fills in everything else | strict input schemas; architecture test (§14) |
| R4 | Every status change goes through `appendTransition`, which appends an event and updates the instance in one transaction | repository API has no other status writer; executors never receive the repository |
| R5 | The tenant comes only from the signed-in session, never from user or AI input (the rule from ImpressoRx ADR-001 §3.5) | server-built actor context; no identity keys in input schemas |

### 4.3 Actor

Every instance records:

- **`initiator`**: `user` (via UI or chat), `rule:<id>`, or `schedule:<job>`. Action plans would
  later add `action:<parent>`.
- **`onBehalfOf`**: the real person whose authority is used. Never the AI.
- **`approver`**: recorded on the approval event (`policy` for automatic approvals).

The AI is never an actor. A chat request has initiator `user`, with the model recorded as evidence.
The AI influences inbox rules only through classification, and that classification (model, category,
priority) is recorded as evidence.

## 5. Architecture

| Layer | Package / location | Holds |
|---|---|---|
| LLM proposes | chat agent loop; inbox rules | type + input only |
| Code defines | `application/src/actions/` (registry, `definitions/`) | schema, effects, preconditions, `resolve`, `describe`, executor, postconditions, undo, evidence, keys, floor and defaults |
| Database configures | `action_definition_configs` (+ history) | stored policy per (scope, owner, type) |
| Policy authorizes | `application/src/actions/policy` | `clampPolicy`, `decide`, `canApprove`, `allowedOperations` (all pure) |
| Executor changes the world | each definition's executor, given writer ports | the only code that changes an external system on a user's behalf |
| Event log remembers | `action_events` + `action_instances` | immutable history + current-state projection |

- **domain** gains the types (`ActionDefinition`, `ActionInstance`, `ActionEvent`, statuses, risk
  levels, actor, evidence, check results) and the repository ports. It keeps zero dependencies.
- **application** gains the registry (same pattern as the chat `ToolRegistry`: definitions are
  registered at startup under name and version; any other lookup throws a typed error), the
  definitions, the policy functions and the orchestrator use cases (§10).
- **infrastructure** gains the SQLite repositories and the calendar-client changes (§9.6), and the
  notification adapter change.
- **agent-server** gains the routes (§11), container wiring, startup checks and sweeper scheduling.
- **dashboard** gains the new Action Center, Settings → Actions and the chat chip (§13).
- **contracts** gains the API schemas.

**The executor boundary.** Executors are the only code that changes an external system on a user's
behalf. Gmail polling, LLM calls and the deadline notifier are not actions and stay outside.
Mechanism: the calendar port splits into a reader and a writer; only executors receive the writer,
injected by the composition root; an architecture test fails if anything other than executor
modules, the implementing adapter or the composition root imports the writer type. Chat's calendar
tools lose their direct write.

## 6. Policy and the safety floor

### 6.1 Policy fields

Each definition declares a **floor** (what config can never loosen) and a **default** (the initial
config value). A behavior that must never happen is a floor; a sensible starting point that may
reasonably change is a default.

| Field | Values | Stricter means | Effective value |
|---|---|---|---|
| `risk` | L0 < L1 < L2 < L3 < L4 | higher | max(config, floor) |
| `approval.mode` | `auto` < `above_threshold` < `always` | later in that order | max(config, floor) |
| `approval.thresholds` | metric → limit; auto-run allowed only while the metric ≤ limit (every threshold uses this direction) | lower limit | min(config, floor) per metric; metrics must be declared by the definition |
| `requiredPermissions` | set | more | config ∪ floor |
| `approverRoles` | set | fewer | config ∩ floor; an empty result rejects the row |
| `expiryHours` | hours awaiting approval | shorter | min(config, floor) |
| `enabled` | on/off | off | on only if config is on and the definition's executor is available |

### 6.2 `clampPolicy`

`clampPolicy(floor, stored ?? codeDefault) → { policy, clamped: Field[], rejected?: Reason }` is a
pure function applied field by field.

- **Writes:** the config API refuses any value past the floor with HTTP 422 and field-level errors.
  A looser value is never stored through the app.
- **Reads:** every read clamps anyway, because a code change can raise a floor under an old row, or
  a row can be edited by hand. A clamped field is logged and flagged in Settings; the stored row
  stays as it is until the owner saves a valid value.
- **Rejection:** a row that fails to parse, names an unregistered type, uses an undeclared
  threshold metric or ends with no approver roles is rejected whole. The default (clamped) applies,
  and the rejection is logged and flagged.

### 6.3 Policy functions (pure, deterministic, time passed in)

- `decide({ definition, policy, actor, resolved, now })` → `{ outcome: "refuse" | "needs_approval" | "auto", reasons, approverRoles, risk }`.
  Refusal reasons: `disabled`, `executor_unavailable`, `missing_permission`, `scope_mismatch`.
  Approval reasons: `mode_always`, `threshold_exceeded {metric, value, limit}`.
- `canApprove(actor, instance, policy)`: personal scope → the actor is the owner.
- `allowedOperations(viewer, instance, policy)` (§11.2).

## 7. Lifecycle

### 7.1 Statuses (canonical list: 15)

Stored as lowercase snake_case; shown in prose in capitals.

| Status | Meaning | UI group |
|---|---|---|
| `proposed` | request accepted (registered type, valid input, new key); nothing checked yet | In progress |
| `validating` | preconditions, `resolve` and policy are being evaluated | In progress |
| `awaiting_approval` | waiting for a person | Needs you |
| `approved` | approved by a person or by policy; executor not yet called | In progress |
| `executing` | the executor has been called | In progress |
| `verifying` | checking whether the effect happened | In progress |
| `completed` | effect verified | Done |
| `partially_completed` | effect exists; at least one other postcondition failed | Problem |
| `rejected` | refused by policy or by a person | Closed |
| `expired` | nobody approved within the window | Closed |
| `cancelled` | withdrawn, or no longer applicable | Closed |
| `failed` | could not be done; **no effect** | Problem |
| `rolling_back` | undo in progress | In progress |
| `rolled_back` | undo verified | Done |
| `rollback_failed` | undo refused, failed or interrupted; the effect may remain | Problem |

Final: `rejected`, `expired`, `cancelled`, `failed`, `rolled_back`, `rollback_failed`.
Settled but undoable: `completed`, `partially_completed`.

### 7.2 Transitions

Any pair not listed is refused. All 225 ordered pairs are tested (§14).

| From | To | When | Recorded actor |
|---|---|---|---|
| — | `proposed` | `requestAction` accepts the request | initiator |
| `proposed` | `validating` | immediately | system |
| `proposed` | `cancelled` | owner withdraws; target gone | owner / system |
| `validating` | `awaiting_approval` | preconditions pass, `resolve` succeeds, `decide` = needs approval | policy |
| `validating` | `approved` | `decide` = auto | policy |
| `validating` | `rejected` | `decide` = refuse | policy |
| `validating` | `failed` | a blocking precondition or `resolve` fails | system |
| `validating` | `cancelled` | an obsolete precondition fails; owner withdraws; target gone | system / owner |
| `awaiting_approval` | `approved` | a permitted approver approves; `decide` re-run does not refuse | approver |
| `awaiting_approval` | `rejected` | approver rejects; or `decide` re-run refuses | approver / policy |
| `awaiting_approval` | `expired` | the approval window passes | system |
| `awaiting_approval` | `cancelled` | owner withdraws; obsolete; target gone | owner / system |
| `approved` | `executing` | the re-check (§10.2) passes and the executor is called | system |
| `approved` | `failed` | re-check: blocking failure, `changed_since_approval` or `approval_required_now` | system |
| `approved` | `cancelled` | re-check: obsolete; owner withdraws; stale approval | system / owner |
| `executing` | `verifying` | executor succeeded, **or the outcome is unknown** | system |
| `executing` | `failed` | executor reports a definite failure | system |
| `verifying` | `completed` | all postconditions pass | system |
| `verifying` | `partially_completed` | the effect check passes; another fails | system |
| `verifying` | `failed` | the effect check fails | system |
| `completed`, `partially_completed` | `rolling_back` | owner requests undo; rollback class is reversible or conditional | owner |
| `rolling_back` | `rolled_back` | undo verified | system |
| `rolling_back` | `rollback_failed` | undo refused (precondition), definite failure, unverified, or interrupted | system |

Rules that fall out of the table:

- **Unknown outcomes go to verification, never to `failed`.** A timeout means "we don't know".
- **A malformed request never becomes an instance.** An unregistered type or invalid input is
  returned to the caller (the AI can correct itself) and logged.
- **`executing` strictly means the executor was called.** All pre-execution checks happen while
  `approved`, so crash recovery can tell "might have run" from "did not run".
- **`failed` always means no effect.**

### 7.3 Retry

A `failed` or `expired` action is never reopened. "Try again" creates a **new** instance with
`retry_of` = original, key `<original key>:retry:<n>`, and `attempt_number` = n + 1. It runs the
whole pipeline again, including approval if policy requires it. This replaces PRD FR-034.

### 7.4 Crash recovery (sweeper)

Runs at startup and on every background cycle. "Stuck" means older than the definition's
`recoveryThreshold` (default 5 minutes), measured from the later of the last event and
`last_heartbeat_at`.

| Stuck in | Recovery |
|---|---|
| `proposed` | transition to `validating`, then validate as normal |
| `validating` | re-run validation and continue by result |
| `approved` | if less than the effective `expiryHours` has passed since the approval event: run the re-check and execute; otherwise → `cancelled` (`stale_approval`) |
| `executing` | → `verifying` and verify. **Never re-run the executor.** |
| `verifying` | re-run verification; if Google cannot be read, stay and retry next cycle |
| `rolling_back`, undo executor not yet called (`undo_started_at` empty) | resume: undo preconditions → undo executor → undo verification |
| `rolling_back`, undo executor called | verify the undo → `rolled_back`, or `rollback_failed` (`interrupted`) |
| `awaiting_approval` past expiry | → `expired` |

Every recovery step goes through `appendTransition` with the expected status, so a sweeper step
that races a person's action has no effect if the person's transition commits first (and vice versa).

## 8. Storage (SQLite, ADR-003)

Oneon runs SQLite in production. The triggers below ship in the same migrations that run there.

### 8.1 `action_instances` (current-state projection, mutable)

| Column | Notes |
|---|---|
| `id` | UUID |
| `scope` | `personal` \| `tenant` |
| `owner_id`, `user_id`, `tenant_id` | CHECK: personal ⇒ `tenant_id` NULL and `owner_id` = `user_id`; tenant ⇒ `tenant_id` NOT NULL and `owner_id` = `tenant_id`. `user_id` = on-behalf-of person |
| `location_ids_json` | JSON array; `[]` for personal actions |
| `action_type`, `definition_version` | |
| `status` | CHECK: one of the 15 |
| `initiator`, `initiator_user_id` | |
| `input_json` | validated input |
| `resolved_json` | output of `resolve` (§9.2) |
| `evidence_json` | list of evidence items (§9.4) |
| `decision_json` | latest policy decision, including the effective-policy snapshot |
| `result_json`, `error_json`, `undo_json` | latest values |
| `idempotency_key` | UNIQUE (`scope`, `owner_id`, `action_type`, `idempotency_key`) |
| `retry_of`, `attempt_number` | retry lineage |
| `executor_request_id` | ID sent to the external system as its idempotency key |
| `execution_started_at`, `last_heartbeat_at`, `undo_started_at` | recovery evidence |
| `resource_ref` | e.g. `inbound_item:<id>`, `deadline:<id>`, `calendar_event:<id>` |
| `last_event_seq`, `created_at`, `updated_at` | |

Indexes: (`owner_id`, `status`, `created_at`), (`resource_ref`).

### 8.2 `action_events` (authoritative history, immutable)

| Column | Notes |
|---|---|
| `id` | UUID |
| `action_id` | FK → `action_instances` |
| `seq` | 1, 2, 3 … per action; UNIQUE (`action_id`, `seq`) |
| `from_status`, `to_status` | `from_status` NULL for the first event |
| `actor_json` | `{ kind: "user" \| "policy" \| "system" \| "sweeper", userId? }` |
| `data_json` | check results, policy decision + snapshot, executor result, verification results, reasons |
| `created_at` | |

Triggers `BEFORE UPDATE` and `BEFORE DELETE` abort with "action_events is append-only".

### 8.3 Invariants

1. `action_instances.status` is a materialized projection; `action_events` is the authoritative
   history.
2. The only way to change a status is `appendTransition(actionId, expectedStatus, toStatus, actor, data)`:
   begin transaction → check current status = `expectedStatus` → check the pair is allowed →
   insert the event with the next `seq` → update the instance → commit. A double-click on Approve
   gets 409 on the second click.
3. No executor receives the repository. Heartbeats and execution timestamps are written by the
   orchestrator through dedicated repository methods that cannot change `status`.
4. Every read method on the instance repository requires an owner; there is no unscoped list or find.

### 8.4 Drift check

Compares each instance's `status` and `last_event_seq` with its highest-`seq` event. Runs at startup
and in tests. On a mismatch: log an error naming the action, and rebuild `status` and
`last_event_seq` from the events (events are authoritative).

Notifications are messages, not state: a notification about a proposal stays as sent after the
action changes. The Today page's pending count reads `action_instances`, like the Action Center, so
they cannot disagree.

### 8.5 Configuration

| Table | Columns | Mutable? |
|---|---|---|
| `action_definition_configs` | PK (`scope`, `owner_id`, `action_type`); `config_json`; `updated_by`; `updated_at` | yes |
| `action_definition_config_history` | `id`; `scope`; `owner_id`; `action_type`; `old_json` (nullable); `new_json`; `changed_by`; `changed_at` | no (same triggers) |

### 8.6 Legacy `action_log`

- `action_log` is renamed `action_log_legacy` and locked with the same triggers.
- A one-time, idempotent startup import turns legacy `proposed` rows into new instances through
  `requestAction`. Each gets a `legacy_action` evidence item, and the mapping is recorded in
  `action_legacy_imports (legacy_id, action_id)`. They then run through the real pipeline.
- **Exception:** legacy `proposed` rows of type `notify` are not imported. The pipeline already sent
  those urgent notifications at the time; re-running them would send stale duplicates.
- Every legacy row that was not imported stays visible in the read-only Legacy view, with the
  banner "MVP1 actions changed status only; nothing was executed." Legacy `executed` rows are never
  shown as completed.

### 8.7 Retention

Keep everything. Inbox actions run to a few thousand a month at about six events each. ADR-011
records this as a decision, to revisit when ERP actions bring tenant-scale volume or the database
passes 1 GB.

## 9. Definitions

### 9.1 What every definition declares

| Part | Notes |
|---|---|
| `type`, `version` (`1`), `scope` | all 10 are `personal` |
| label, description | for the UI |
| `inputSchema` | zod, **strict** (unknown keys rejected); bad input never becomes an instance |
| `effects` | reads / writes |
| policy floor + default | §6.1 |
| threshold metrics | declared metrics with a human label (e.g. "other people involved") |
| `riskFor(resolved)` | may raise risk above the floor for a given input; never lowers it |
| `preconditions` | read-only; each tagged **blocking** (→ `failed`) or **obsolete** (→ `cancelled`) |
| `resolve` | §9.2 |
| `describe(resolved)` | plain-language sentence including consequences |
| `executor` or `unavailable: <reason>` | §10.4 |
| `postconditions` | read-only; one is marked as the **effect check** |
| undo | rollback class; undo preconditions, executor, postconditions; data captured at execution |
| evidence builder | §9.4 |
| idempotency key builder | §9.5 |
| `recoveryThreshold` | default 5 minutes |
| `disableWarning` | what turning the definition off stops (shown in Settings) |

### 9.2 `resolve`

Runs in `validating` after preconditions. It reads current state through reader ports and returns
the **resolved input**: everything derived from current state that changes consequences
(`sendUpdates`, the people involved, threshold metric values) plus anything the executor needs.
`describe`, `riskFor` and `decide` all work from the resolved input, and it is stored on the
instance and the decision event.

At execution, `resolve` runs again (§10.2). If anything that changes consequences differs from what
was approved, the instance goes to `failed` with `changed_since_approval`. **Oneon executes exactly
what was approved, or nothing.**

### 9.3 Risk scale

| Level | Meaning | In this build |
|---|---|---|
| L0 Read | changes nothing | unused; reads are chat tools, not actions |
| L1 Low | changes only the owner's own data, reversibly | yes |
| L2 Business | involves other people or shared resources | yes, when anyone else is on a calendar event |
| L3 Consequential | irreversible, or affects money, stock or legal records | Gmail actions, pre-declared |
| L4 Restricted | changes permissions, access or security | unused; reserved for tenant admin actions |

### 9.4 Evidence

A list of `{ kind, source, asOf, data }`. Kinds in this build: `email`, `classification`,
`deadline`, `chat_turn`, `rule`, `calendar_event`, `legacy_action`. ERP evidence later uses the
same shape, e.g. `{ kind: "stock_level", source: "impressorx:bernova", asOf, data }`. The
classifier records no rationale, so a classification's summary is the closest thing.

### 9.5 Idempotency keys

| Source | Key |
|---|---|
| inbox rule, email-based (`notify`, `archive`, `label`, `draft_reply`) | `email:<inboundItemId>` |
| inbox rule, deadline-based (`create_reminder`) | `deadline:<deadlineId>` |
| chat | `chat:<userMessageId>:<sha256 of canonical JSON input>` (keys sorted, no whitespace) |
| retry | `<original key>:retry:<n>` |

- **Duplicates:** no new instance and no new event. The caller gets the existing instance and its
  status. A chat tool reports "Already requested in this turn: <status>".
- **Deadline IDs are stable.** Deadlines are written in the same transaction as the email's
  classification, and `classifications.inbound_item_id` is UNIQUE. A second extraction rolls back
  entirely, so each deadline ID is created exactly once. Gmail messages are immutable.
- **External idempotency:** the calendar executors send the instance ID (hyphens removed, which is
  valid Google base32hex) as the event ID. Google rejects a second insert with the same ID.

### 9.6 Port changes

- **Calendar reader:** `listEvents`, `searchEvents`, new `getEvent(id)`. `CalendarEvent` gains
  `etag` and `updated`.
- **Calendar writer:** `createEvent` with a client-chosen ID; `updateEvent` and new `deleteEvent`
  send `If-Match: <etag>`; every call sets `sendUpdates` explicitly.
- **Notifications:** `send` returns the new notification's ID, or `suppressed: quiet_hours` /
  `suppressed: type_disabled`. The suppression check moves into a shared read-only function used by
  both `notify`'s preconditions and the adapter.

### 9.7 The four definitions with real executors

| | `notify` | `create_reminder` | `create_calendar_event` | `update_calendar_event` |
|---|---|---|---|---|
| Proposed by | rule `inbox.urgent_notify`: priority ≤ 2 | rule `inbox.deadline_reminder`: confidence ≥ 0.7 | chat | chat |
| Effect | in-app notification (+ web push if configured) | all-day event on the due date, "Due: …", linking to the email; no attendees | creates the event | changes the event |
| Risk floor / default | L1 / L1 | L1 / L1 | L1 / L1; L2 if anyone else is on it | L1 / L1; L2 if anyone else is on it before or after |
| Approval floor / default | auto / auto | auto / **always** | `above_threshold`: `others_involved` ≤ 0 / same | `above_threshold`: `others_involved` ≤ 0, counted before **and** after the change / same |
| `resolve` produces | — | event body | event body; people involved; `sendUpdates` | current event, previous values, `etag`; people before ∪ after; `sendUpdates` |
| `sendUpdates` | — | `none` | `all` if attendees, else `none` | `all` if time, place or attendees change on an event that has attendees before or after the change; otherwise `none` |
| Preconditions | *obsolete:* type turned off; quiet hours | *blocking:* calendar connected. *obsolete:* deadline done or dismissed; due date passed | *blocking:* calendar connected | *blocking:* calendar connected; event exists |
| Postconditions (effect check first) | notification with the returned ID exists | event exists by ID; all-day on due date; title matches | event exists by ID; fields match (wrong attendees → `partially_completed`) | changed fields match |
| Rollback class | irreversible | reversible | reversible | conditional |
| Undo | — | delete with `If-Match` = version after | delete with `If-Match`; undo confirmation warns "Google will email cancellations to …" | restore previous values with `If-Match` |
| Undo data | — | event ID, version after | event ID, version after | previous values, version before, version after |
| Undo refused or failed | — | `rollback_failed`: `changed_since` or `not_found` | same | same |
| Evidence | rule + the values that triggered it; classification summary, model, prompt version; sender, subject, received time | deadline text, date, confidence, model; sender, subject | chat turn (ID, excerpt); model; the AI's input | chat turn; model; the event before |
| Key | `email:<id>` | `deadline:<id>` | chat | chat |
| Expiry → `expired` | 7 days | 7 days | 24 hours | 24 hours |
| `disableWarning` | "Turning this off stops urgent-email notifications." | — | — | — |

- **`others_involved`** is the number of attendee addresses other than the owner's own Google
  account (for updates: the union of attendees before and after the change). Its human label in
  Settings is "other people involved". The floor (limit 0) means any other person on the event
  requires approval.
- **Why `create_reminder` defaults to approval:** it touches only the owner's calendar and is fully
  reversible, so running automatically is never unsafe (floor `auto`). The default is approval so a
  new user doesn't find their calendar filling up unannounced; they can switch to auto.
- **Inviting people:** the floor requires approval whenever anyone else would be on the event,
  because invitation emails cannot be unsent even though the event can be deleted.
- **Every undo is version-checked,** including deletes: undoing an event that someone edited after
  Oneon wrote it would destroy their edit.
- **Expiry is silent:** the approval notification was already sent.

### 9.8 Six registered but unavailable

Policy refuses them (`executor_unavailable`), so they appear as `rejected` with the reason. The inbox
rules still propose `archive` (spam), `label` (newsletters) and `draft_reply` (follow-ups).

| Type | Unavailable because | Risk floor | Approval floor | Rollback class (declared now, built later) |
|---|---|---|---|---|
| `archive` | needs Gmail modify access (`gmail.modify`) | L1 | auto | reversible: back to Inbox |
| `label` | needs Gmail modify access (`gmail.modify`) | L1 | auto | reversible: remove the label |
| `draft_reply` | needs Gmail compose access (`gmail.compose`) | L1 | auto | reversible: delete the draft; refused if sent or edited |
| `delete` | needs Gmail modify access (`gmail.modify`) | L3 | always | irreversible |
| `send` | needs Gmail send access (`gmail.send`) | L3 | always | irreversible |
| `forward` | needs Gmail send access (`gmail.send`) | L3 | always | irreversible |

No undo code exists for these yet. How an Oneon draft is marked, and its executor, are designed when
compose access is added.

**`classify` is removed.** Classification is pipeline work, not an action taken on the user's
behalf, and nothing proposes it.

### 9.9 Urgent notifications: one path

`notify` becomes the only path for urgent notifications. The pipeline's direct "Urgent: …" send is
removed. Rule 1 narrows from "urgent category or priority ≤ 2" to **priority ≤ 2**, exactly who is
notified today.

## 10. Flows

### 10.1 Entry points (application layer)

| Operation | Caller | Does |
|---|---|---|
| `requestAction` | inbox rules, chat tools, legacy import | registry lookup → schema parse → key → duplicate check → instance + `proposed` event → `advance` |
| `advance` | after any decision; sweeper | every automatic step until a person is needed or a final status is reached |
| `approve`, `reject` | Action Center | `canApprove` + `decide` re-run, then `approved` + `advance`, or `rejected` |
| `cancel` | Action Center; system | → `cancelled` with a reason |
| `requestUndo` | Action Center | → `rolling_back`, then §10.6 |
| `retry` | Action Center (`failed`, `expired`) | new instance (§7.3) |
| `expireStale`, `sweep` | background cycle | §7.4 |

### 10.2 `advance`

```text
proposed → validating
  preconditions               obsolete → cancelled · blocking → failed
  resolve                     failure → failed
  decide (snapshot stored)    refuse → rejected · needs_approval → awaiting_approval (stop) · auto → approved
approved — re-check before calling the executor:
  preconditions               obsolete → cancelled · blocking → failed
  resolve again               consequences differ from approved → failed (changed_since_approval)
  decide again                stricter than recorded → failed (approval_required_now)
approved → executing          execution_started_at, executor_request_id recorded
  executor (10.4)             succeeded / unknown → verifying · definite failure → failed
verifying
  postconditions (10.5)       all pass → completed · effect ok, other fails → partially_completed · effect absent → failed
```

Execution runs inline: in the processing cycle for rule-proposed actions, in the chat request for
chat actions, and in the approval request after an approval. There is no job queue; the sweeper
covers crashes.

**Execution does not depend on the HTTP request.** The executor's abort signal comes only from the
definition's timeout, never from the client connection. A client that disconnects does not stop an
action; the result is recorded and appears on reload.

### 10.3 Chat path

Chat's calendar tools call `requestAction` (initiator = signed-in user; chat turn and model as
evidence) and wait for the automatic part of `advance`. The tool then returns a truthful status:

| Status | The AI is told |
|---|---|
| `completed` | done, with event details |
| `awaiting_approval` | waiting for approval in Action Center; the tool instructions forbid describing it as done |
| `rejected`, `failed`, `cancelled` | the reason |
| `verifying` | "sent to Google; couldn't confirm yet" |
| duplicate | the existing status |

The chat API response also returns the actions requested in that turn (ID, label, status) for the
chat chip (§13.3).

### 10.4 Executor contract

```ts
execute(ctx) → { kind: "succeeded", result, undoData, externalRefs }
             | { kind: "definite_failure", code, message }   // guaranteed nothing changed
             | { kind: "unknown", error }                    // may have changed
```

`ctx` holds the instance ID, the resolved input, `executorRequestId`, an abort signal with the
definition's timeout, a `heartbeat()` callback, and only the writers the definition declares.
Unexpected exceptions count as `unknown`.

| Google response | Outcome |
|---|---|
| 2xx | succeeded |
| 409 on insert with our client-chosen ID | unknown → verify |
| 412 (`If-Match` failed) | definite failure (`changed_since`) |
| 400, 401, 403, 404; token refresh failed before sending | definite failure |
| 429, 5xx, timeout, network error | unknown → verify |

### 10.5 Verification

Postconditions return `{ id, passed, expected, actual }` per check; all are stored on the event. The
effect check decides `failed` vs the rest. If verification cannot read Google, the action stays in
`verifying`; the sweeper retries each cycle and the UI shows "Couldn't confirm yet; Oneon will check
again automatically (last checked …)". There is no automatic final status for this case, because
`failed` would be false if the effect exists.

### 10.6 Undo

Offered only on `completed` / `partially_completed`, for rollback classes other than irreversible,
to someone permitted to run the original action.

```text
completed/partially_completed → rolling_back (requester recorded)
  undo preconditions (version check)       refused → rollback_failed (changed_since / not_found)
  undo_started_at recorded; undo executor  definite failure → rollback_failed · unknown → stay (sweeper)
  undo postconditions                      verified → rolled_back · not verified → rollback_failed
```

Undo never runs automatically and is never retried automatically. `rollback_failed` triggers a
notification, and the UI states what is left to fix by hand.

### 10.7 Notifications about actions (side channel, not actions)

- On entering `awaiting_approval`: "Action requires approval" (replaces the pipeline's existing
  `action_proposed` send).
- On `rollback_failed`: a new `action_rollback_failed` notification type.

Both are sent after the transition commits and respect the per-type toggles and quiet hours. No
notification on expiry.

### 10.8 Configuration writes

`PUT /api/action-definitions/:type/config` validates every field against the floor (422 with
field-level errors), writes the config row and appends a history row in one transaction. Personal
config is keyed by (owner, type); only the owner can write it.

## 11. API

### 11.1 Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/actions` | filters: group, status (all 15); paginated; owner-scoped |
| GET | `/api/actions/:id` | definition summary, resolved input, `describe` text, evidence, decision, checks, undo availability, `allowedOperations` |
| GET | `/api/actions/:id/events` | timeline |
| POST | `/api/actions/:id/approve` \| `/reject` \| `/cancel` \| `/undo` \| `/retry` | 409 on a stale expected status; 404 for another owner's action |
| GET | `/api/actions/legacy` | read-only legacy rows |
| GET | `/api/action-definitions` | floor, stored config, effective policy, flags, availability, offered options |
| PUT | `/api/action-definitions/:type/config` | §10.8 |

Removed: `POST /api/actions/:id/retry-execution`.

### 11.2 `allowedOperations`

Computed by policy for the viewer; the UI draws only these buttons.

| Operation | When |
|---|---|
| `approve`, `reject` | `awaiting_approval` and `canApprove` |
| `cancel` | `proposed`, `validating`, `awaiting_approval`, `approved`; viewer is the owner |
| `undo` | `completed` / `partially_completed`; class not irreversible; viewer permitted |
| `retry` | `failed` / `expired`; definition enabled and available; viewer permitted |
| none | legacy rows; every other case |

### 11.3 Consumers switched to the new tables

Chat's `list_pending_actions` tool, the Today page's pending count, the daily briefing and chat's
context stats all read `action_instances` (`awaiting_approval` for "pending").

## 12. Tenant-scope readiness

**Built now** (used only by personal actions): `scope`, `owner_id`, `tenant_id` with CHECK
constraints; `location_ids` as a list (a stock transfer touches two locations); `scope` declared per
definition, with `requestAction` refusing a mismatch; the server-built actor context;
`requiredPermissions` and `approverRoles` (personal: `[]` and `["owner"]`); config keyed by
(scope, owner, type); the generic evidence shape; owner-scoped reads.

**Mechanical tenant rule:** strict input schemas; an architecture test fails if any input schema
contains `tenantId`, `tenant`, `ownerId` or `userId`; owner and tenant come only from the actor
context.

**What sub-project B adds without changing these contracts:**

- `tenant_memberships`: tenant, role, ImpressoRx permission codes and locations per person, learned
  from ImpressoRx when they link their account.
- Tenant policy: required permissions ⊆ actor permissions; approvers from tenant roles; every entry
  in `location_ids` within the actor's scope.
- ImpressoRx is the final authority: Oneon's policy is a pre-check, and an ImpressoRx 403 is a
  definite failure ("refused by ImpressoRx").
- ERP executors receive a writer bound to exactly one tenant's credential, resolved from the session.
- Tenant admins write tenant config, clamped and recorded in history.

**Left to B's design:** one Oneon instance per tenant or one shared instance; whether approver ≠
initiator is required; membership freshness.

## 13. UI

### 13.1 Action Center (`/actions`)

Each status belongs to exactly one group, and the group sets the colour.

| Group | Colour | Statuses |
|---|---|---|
| Needs you | amber | `awaiting_approval` |
| In progress | blue | `proposed`, `validating`, `approved`, `executing`, `verifying`, `rolling_back` |
| Done | green | `completed`, `rolled_back` |
| Problem | red | `failed`, `partially_completed`, `rollback_failed` |
| Closed | grey | `rejected`, `expired`, `cancelled` |
| Legacy (MVP1) | grey | non-imported `action_log_legacy` rows; read-only, no buttons, banner |

A group is not a promise about buttons; buttons come only from `allowedOperations`.

Card panels, in order:

| Panel | Content |
|---|---|
| Header | label; status badge; risk badge (L1 or L2 in this build) |
| Origin | "Inbox rule · urgent notify" or "Requested in chat · '<excerpt>'" |
| What Oneon will do | `describe(resolved)`, including consequences ("Google will email the invitation to …") |
| Evidence | each item rendered by kind |
| Why approval or refusal | decision outcome and reasons; clamp flags |
| Checks | preconditions and postconditions: pass/fail, expected vs actual |
| Undo | "Can be undone" / "Can be undone if nobody has changed it since" / "This action cannot be automatically reversed." |
| Timeline | every event: status change, time, actor ("You", "Oneon policy", "Recovery") |

Buttons: Approve, Reject, Cancel, Undo, Try again. Undo opens a confirmation, including the
cancellation-email warning when attendees exist. A long `verifying` shows "Couldn't confirm yet;
Oneon will check again automatically (last checked …)". Deep links (`#action-<id>`) keep working.

### 13.2 Settings → Actions

One row per definition: name; Available, or Unavailable with the reason; risk (floor and effective);
approval mode; expiry; enable switch; last change ("changed by you, 2 Oct"). Approval options are the
modes at or above the floor, labelled by code:

| Definition | Floor | Options offered |
|---|---|---|
| `notify`, `create_reminder` | auto | Auto · Always ask |
| `create_calendar_event`, `update_calendar_event` | auto unless other people are involved | Auto unless other people are involved · Always ask |
| the six unavailable types | — | read-only row with the reason |

Options looser than the floor are not offered (no disabled options). No definition in this build has
an editable threshold number; the general rule (a number field capped at the floor's limit) applies
when one does. Turning a definition off shows its `disableWarning` before confirming. Flags appear
only from the read-time clamp (§6.2).

### 13.3 Chat and Today

- **Chat:** replies render as plain text, so a link would not be clickable. Under a reply, the chat
  page shows a chip per action requested in that turn ("Waiting for approval · Open" →
  `/actions#action-<id>`).
- **Today:** the existing pending-approvals count reads the new tables.

## 14. Testing

Test-first. All tests join the existing suite.

| Layer | Covers |
|---|---|
| Application unit | `decide` (table-driven); `clampPolicy` per field, each stricter direction, row rejection; **all 225 status pairs**; every `advance` branch, named: obsolete → cancelled, blocking → failed, refuse → rejected, needs approval, auto, `changed_since_approval`, `approval_required_now`, executor succeeded / definite / unknown, verification complete / partial / absent, verification unreadable stays `verifying`; undo: version mismatch, definite failure, unknown; retry keys; expiry (and that it sends no notification); each sweeper row, including per-definition thresholds and `undo_started_at`; duplicates create no event; each definition's preconditions, `resolve` (with fake readers: `sendUpdates`, people, risk), postconditions, `describe`, key; Google response → outcome mapping; **notify consolidation: a priority-1 email produces exactly one notification, from the `notify` action, and the pipeline makes no direct urgent send** |
| Infrastructure (real in-memory SQLite) | `appendTransition` atomicity and expected-status conflict; triggers abort UPDATE/DELETE on events, legacy and config history; unique idempotency index; scope/tenant/owner CHECKs; legacy rename, lock and import (including the `notify` exception); drift check detects and repairs an injected mismatch; calendar client: client-chosen ID, `If-Match`, `sendUpdates`, 409 and 412 mapping |
| Routes (supertest) | every endpoint; `allowedOperations` per status (none for legacy rows); 409 on double approve; 422 on looser config; **user B gets 404 for user A's action**; client disconnects mid-execution → action still reaches `completed`; approve racing a sweeper step on the same action → one wins, the other has no effect |
| Architecture | domain imports only relative paths within domain; the calendar writer type is imported only by executor modules, its adapter and the composition root; executors never import the instance repository; no identity keys in input schemas; every input schema is strict |
| Container | the executors receive the writer; chat tools do not |
| Dashboard | a chat turn with actions renders chips linking to them; status → group mapping |

## 15. Migration and rollout

### 15.1 Retired environment flags

| | Today, `FEATURE_AUTO_EXECUTE` off (default) | Today, on | After |
|---|---|---|---|
| `notify` | action does nothing; pipeline sends one notification | same | one notification, sent by the action |
| `create_reminder` | does nothing | does nothing (status only) | waits for approval; nothing happens until approved |
| chat calendar writes | write immediately, ignoring the flag | same | automatic only when nobody else is on the event; otherwise approval (stricter) |
| Gmail actions | do nothing | do nothing | refused |

`FEATURE_AUTO_EXECUTE` only ever changed statuses, so no deployment gains a new automatic external
effect, whichever value it had. Config is seeded from code defaults, not from the flag.
`FEATURE_MANUAL_EXECUTE_REQUIRED` (approval without execution) is replaced by the
approve-then-execute flow. Both variables are removed from the env schema; if either is still set,
startup logs a warning pointing to Settings → Actions. No tenants exist yet; every deployment is
personal scope.

### 15.2 Data migration

One SQL migration creates the new tables and triggers and renames and locks `action_log`. The legacy
import (§8.6) runs once at startup and is idempotent (keys + `action_legacy_imports`). It runs after
the container is built, because it uses the registry and orchestrator.

### 15.3 Documents

- **ADR-011 (new), "Action Spec framework and lifecycle":** supersedes ADR-006. It keeps
  forward-only and append-only intent; fixes the contradiction (events immutable by trigger,
  instances an explicit projection); replaces (resource, type) idempotency with keys; records the
  floor rule, the trust order, SQLite triggers and retention.
- **PRD:** FR-026 (rules propose through the registry), FR-027 (15-status lifecycle), FR-028 (risk
  L0–L4 and policy config), FR-029 (idempotency keys), FR-030 (immutable events + projection),
  FR-031 (rollback contract), FR-033 (auto outcome via policy), FR-034 (retry = new instance); §7
  data model; §8 note that calendar tools request actions; §10 out-of-scope list updated
  (multi-tenancy and ERP integration move to sub-projects B and C).

## 16. Browser review (after build)

Runs against a test calendar set via `CALENDAR_ID`, because scenarios 3–6 write events.

| # | Do | Expect |
|---|---|---|
| 1 | spam email arrives | `archive` in Closed: rejected, "needs Gmail modify access (`gmail.modify`)" |
| 2 | urgent email (priority ≤ 2) | `notify` completed; exactly one notification |
| 3a | email with a deadline → Approve | `create_reminder` completed; event in the test calendar |
| 3b | Undo it | rolled back; event gone |
| 4 | chat: "focus block tomorrow 9–11" | runs automatically → completed; chip says done |
| 5 | chat: "invite ama@… to a call Friday 3pm" | Needs you, with "Google will email the invitation to ama@…"; chip says waiting |
| 6 | edit a reminder event in Calendar, then Undo | Problem: rollback failed, "changed since" |
| 7 | Settings → Actions | reminders can switch to Auto; calendar rows offer no plain Auto; `send` read-only; change appears in history; turning off `notify` shows its warning |
| 8 | Legacy filter | old rows, banner, no buttons |
| 9 | any action | timeline shows every transition |

## 17. Out of scope, and open questions for sub-project B

Out of this build: tenant memberships, ImpressoRx linking, tenant-scope definitions, ERP executors,
approvals across different people, tenant config UI, action plans, business-profile parameters,
Gmail write access, a job queue.

For B to decide: deployment model (instance per tenant vs shared), four-eyes approval, membership
freshness, how staff link their ImpressoRx account, and how ImpressoRx records Oneon in its audit log
(its `AuditLog.actorType` currently has `User | System | Vendor`).

## 18. Consistency fixes made while writing this spec

These refine approved sections without changing their intent. Each is flagged so it can be checked.

1. **Pre-execution re-check moved into `approved`.** The approved Section 2 table had the re-check
   failing as `executing → failed` and had no path for an obsolete result at that point. Doing the
   re-check while still `approved` adds `approved → failed` and uses the existing
   `approved → cancelled`. `executing` then strictly means "the executor was called", which is what
   crash recovery relies on.
2. **`undo_started_at`** added, so the sweeper can resume an undo whose executor never ran, instead
   of failing it as interrupted.
3. **Legacy `notify` proposals are not imported** (§8.6). Re-running them would re-send old urgent
   notifications the pipeline already sent.
4. **`action_legacy_imports`** records which legacy rows became instances, so the Legacy view can
   show exactly the rows that were not imported.
