# ADR-011: Action Spec Framework and Lifecycle

## Status: Accepted

## Date: 2026-10-01

## Supersedes: ADR-006 (Append-Only Audit Log for Action Lifecycle)

## Context

ADR-006 required that `action_log` rows never be updated, then chose "a status field update
with timestamps". The code followed the second statement: `updateStatus` overwrote status,
result and error in place, so a failure that later succeeded on retry could lose its error record.
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
   type and input; the user's identity comes only from the signed-in session, and input schemas
   may not contain identity or tenant keys (architecture test). Tenant actions are reserved, not
   built; when sub-project B adds them, ImpressoRx's authorization will be final.
3. **Lifecycle.** Fifteen statuses: proposed, validating, awaiting_approval, approved,
   executing, verifying, completed, partially_completed, rejected, expired, cancelled, failed,
   rolling_back, rolled_back, rollback_failed. Transitions are forward-only; retrying creates a
   new linked action. An unknown executor outcome goes to verification, never to failed.
4. **Storage.** `action_events` is the authoritative history; SQLite triggers abort any UPDATE
   or DELETE. `action_instances` is an explicitly mutable projection. Its status changes only
   through one transactional method that checks the expected status; heartbeat and undo-start
   timestamps are written by dedicated methods that cannot change status. A drift check compares
   each instance's status and last event sequence with its latest event and rebuilds those two
   fields from events. `action_log` is renamed `action_log_legacy` and locked the same way.
5. **Idempotency** uses explicit keys unique per (scope, owner, type, key), replacing the
   (resource_id, action_type) check.
6. **Retention.** Keep everything. Revisit when tenant-scale ERP volume arrives or the database
   passes 1 GB.

## Consequences

**Easier:** a complete, tamper-resistant audit trail; every action explains its origin,
evidence, policy decision and checks; undo is verified and refused when the target changed
since; ERP actions are designed to plug into the same contract (sub-project C, not built).

**Harder:** more tables and code paths; every new action type needs a definition with checks
and tests; the config UI must never offer values looser than the floor.
