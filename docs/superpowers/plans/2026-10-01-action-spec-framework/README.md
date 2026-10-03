# Action Spec Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Oneon's status-only `action_log` with the Action Spec framework: code-defined action definitions, database policy clamped to a code floor, a 15-status lifecycle projected from an immutable event log, real execution with verification and version-checked undo for `notify`, `create_reminder` and chat's two calendar writes, and the Action Center / Settings → Actions UI for the product owner's visual review.

**Architecture:** Clean architecture as today (ADR-002). `domain` gets the lifecycle, instance/event types, repository and capability ports. `application` gets policy (pure functions), the registry, the 10 definitions and the orchestrator (request → validate → approve → execute → verify → undo, plus sweeper and expiry). `infrastructure` gets SQLite repositories behind migration 014 and the calendar reader/writer. `agent-server` wires capabilities per user and exposes the API. `dashboard` renders it.

**Tech Stack:** TypeScript 5.7, Node 20, pnpm 9 workspace, better-sqlite3 (SQLite, production too), zod 3, Express 4, vitest 3, supertest, Next.js + Tailwind (dashboard), SWR.

**Spec:** [`docs/superpowers/specs/2026-10-01-action-spec-framework-design.md`](../../specs/2026-10-01-action-spec-framework-design.md). Executors read the spec section a task cites before starting the task.

## Phases and tasks

| Phase | File | Tasks |
|---|---|---|
| 1. Domain and storage | [phase-1-domain-and-storage.md](phase-1-domain-and-storage.md) | 1 domain types and lifecycle · 2 notification suppression and writer · 3 SQLite storage (migration 014 + repositories) · 4 calendar reader/writer |
| 2. Policy and definitions | [phase-2-policy-and-definitions.md](phase-2-policy-and-definitions.md) | 5 policy functions · 6 definition contract, registry, unavailable definitions · 7 `notify` + `create_reminder` · 8 calendar definitions |
| 3. Orchestrator | [phase-3-orchestrator.md](phase-3-orchestrator.md) | 9 request + advance · 10 decisions, undo, expiry, sweeper, notifier · 11 inbox rules, legacy import, chat action tools |
| 4. Server | [phase-4-server.md](phase-4-server.md) | 12 container wiring and startup · 13 processing cycle switch, env flags retired · 14 contracts + actions API · 15 consumers, chat tool swap, architecture tests · 16 ADR-011, PRD, MVP1 code removal |
| 5. Dashboard | [phase-5-dashboard.md](phase-5-dashboard.md) | 17 UI helpers · 18 Action Center · 19 Settings → Actions · 20 chat chips, Today, browser review |

Tasks run in order. Each task ends with the full repository test suite green and one commit. Phases 1–3 are additive (nothing existing changes behaviour); the switch-over happens in Task 13, after Task 12 has wired the framework into the server. Between Task 3 (which renames `action_log`) and Task 13, the old action paths fail at runtime; do not deploy mid-plan.

## Global Constraints

- Work on branch `feat/action-spec-framework`, created from `feat/actions-human-readable-context-slice` at commit `46b6535` or later.
- Commit messages: conventional commits (`feat(actions): …`, `test(actions): …`), ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Build order matters.** `application` and `infrastructure` tests resolve `@oneon/domain` from `packages/domain/dist`; `agent-server` resolves sibling packages from `src`; the dashboard transpiles `@oneon/contracts` from `dist`. After changing `domain`, run `pnpm --filter @oneon/domain build` before testing dependents. Before any `typecheck`, run `pnpm -r run build`.
- Every task ends with: `pnpm -r run build && pnpm -r run typecheck && pnpm test` all passing (baseline before this plan: 1,135 tests).
- `domain` keeps zero runtime dependencies and imports only relative paths inside `domain` (ADR-002; enforced by a test in Task 15).
- Lifecycle statuses, exactly these 15, stored lowercase: `proposed`, `validating`, `awaiting_approval`, `approved`, `executing`, `verifying`, `completed`, `partially_completed`, `rejected`, `expired`, `cancelled`, `failed`, `rolling_back`, `rolled_back`, `rollback_failed`.
- Risk tiers: `L0` < `L1` < `L2` < `L3` < `L4`. Approval modes: `auto` < `above_threshold` < `always`.
- Default recovery threshold: 5 minutes (300 000 ms). Approval expiry: `notify` and `create_reminder` 168 hours; calendar actions 24 hours.
- Inbox rule thresholds: `notify` when priority ≤ 2; `create_reminder` when deadline confidence ≥ 0.7.
- Idempotency keys: `email:<inboundItemId>`, `deadline:<deadlineId>`, `chat:<userMessageId>:<sha256 of canonical JSON input>`, retries `<root key>:retry:<n>`.
- Unavailable reasons, verbatim: `needs Gmail modify access (gmail.modify)`, `needs Gmail compose access (gmail.compose)`, `needs Gmail send access (gmail.send)`.
- Legacy banner, verbatim: `MVP1 actions changed status only; nothing was executed.`
- `notify` disable warning, verbatim: `Turning this off stops urgent-email notifications.`
- Undo texts, verbatim: `Can be undone` / `Can be undone if nobody has changed it since` / `This action cannot be automatically reversed.`
- Trigger messages, verbatim: `action_events is append-only`, `action_log_legacy is read-only`, `action_definition_config_history is append-only`.
- Every action input schema is a strict zod object (unknown keys rejected) and contains no `tenantId`, `tenant`, `ownerId` or `userId` key.
- Executors never receive a repository. Status changes only through `ActionInstanceRepository.appendTransition`.

## Review Focus

Inputs the spec implies but no other test pins. Each line's test is added in the owning task.

1. **Chat sends a time without a UTC offset** (`"2026-10-07T10:00:00"`). Expected: refused as invalid input with a message asking for an offset, so the AI retries with one; never silently scheduled in server time. Test: Task 8.
2. **The owner's own address appears as an attendee in different casing** (`Alice@Test.com` vs token email `alice@test.com`). Expected: not counted as another person, so no approval is forced. Test: Task 8.
3. **Google returns a deleted event with `status: "cancelled"`** from `events.get`. Expected: treated as not found, so undo verification succeeds. Test: Task 4.
4. **Legacy rows with `user_id` NULL or an unregistered type (`classify`)**. Expected: the import skips them without failing startup; they stay in the legacy table. Test: Task 11.
5. **The AI repeats an attendee** (`["a@x.com", "A@x.com"]`). Expected: de-duplicated case-insensitively before counting people and before writing to Google. Test: Task 8.

## File map

| Path | Responsibility | Task |
|---|---|---|
| `packages/domain/src/actions/lifecycle.ts` | the 15 statuses, allowed transitions | 1 |
| `packages/domain/src/actions/types.ts` | risk tiers, scope, actor, evidence, checks, instance, event | 1 |
| `packages/domain/src/actions/errors.ts` | `ActionNotFoundError`, `TransitionConflictError`, `LifecycleTransitionError`, `ExternalCallError` | 1 |
| `packages/domain/src/actions/repository.port.ts` | instance, config and legacy repository ports | 1 |
| `packages/domain/src/actions/capabilities.ts` | readers/writers handed to definitions | 1 |
| `packages/domain/src/ports/calendar.port.ts` | adds `CalendarReader`, `CalendarWriter`, `etag`/`updated`; `CalendarPort` trimmed to reads | 1, 15 |
| `packages/domain/src/ports/notification.port.ts` | adds `NotificationWriter`, `NotificationSendResult` | 1 |
| `packages/domain/src/notification-suppression.ts` | shared quiet-hours / type-toggle check | 2 |
| `packages/infrastructure/src/database/migrations/014_action_spec_framework.sql` | new tables, triggers, legacy rename | 3 |
| `packages/infrastructure/src/database/repositories/sqlite-action-instance.repository.ts` | instances + events, `appendTransition` | 3 |
| `packages/infrastructure/src/database/repositories/sqlite-action-config.repository.ts` | config + history | 3 |
| `packages/infrastructure/src/database/repositories/sqlite-legacy-action.repository.ts` | read-only legacy rows + import map | 3 |
| `packages/infrastructure/src/database/action-drift-check.ts` | projection/event consistency check | 3 |
| `packages/infrastructure/src/calendar/*` | `getEvent`, writer methods, error mapping | 4 |
| `packages/application/src/actions/policy/*` | `clampPolicy`, `validateConfigWrite`, `decide`, permissions, operations, reasons | 5 |
| `packages/application/src/actions/definition.ts` | `ActionDefinition` contract | 6 |
| `packages/application/src/actions/registry.ts` | registry + typed errors | 6 |
| `packages/application/src/actions/idempotency.ts` | key builders | 6 |
| `packages/application/src/actions/definitions/*.ts` | the 10 definitions | 6–8 |
| `packages/application/src/actions/orchestrator/*.ts` | request, advance, decisions, undo, sweeper | 9–10 |
| `packages/application/src/actions/inbox-rules.ts` | rule → action requests | 11 |
| `packages/application/src/actions/legacy-import.ts` | one-time legacy import | 11 |
| `packages/application/src/actions/chat-action-tools.ts` | chat calendar tools that request actions | 11 |
| `packages/agent-server/src/actions-wiring.ts` | per-user capabilities, orchestrator, startup tasks | 12 |
| `packages/agent-server/src/routes/actions.route.ts` | actions API (rewritten) | 14 |
| `packages/agent-server/src/routes/action-definitions.route.ts` | Settings → Actions API | 14 |
| `packages/contracts/src/actions.contract.ts` | API schemas, status groups | 14, 18 |
| `packages/agent-server/src/architecture.test.ts` | boundary tests | 15 |
| `docs/adr/011-action-spec-framework.md` | supersedes ADR-006 | 16 |
| `packages/dashboard/src/lib/action-ui.ts` | pure UI helpers | 17 |
| `packages/dashboard/src/app/actions/page.tsx` + `src/components/actions/*` | Action Center | 18 |
| `packages/dashboard/src/components/settings/actions-settings.tsx` | Settings → Actions | 19 |
