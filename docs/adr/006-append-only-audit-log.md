# ADR-006: Append-Only Audit Log for Action Lifecycle

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-Aneone's agent autonomously proposes and (for low-risk items) executes actions on the
user's behalf: archiving emails, creating draft replies, setting reminders, and (with
approval) deleting messages or sending emails. For an autonomous system acting on
sensitive data, auditability is not optional — the user must be able to trace exactly what
the agent proposed, when, what it executed, and what the result was.

## Decision

The `action_log` table follows an **append-only, event-sourced pattern**:

1. **No rows are ever updated in place or deleted.** Each state transition is recorded as
   either: (a) a new row with the same resource_id (full event sourcing), or (b) a status
   field update with timestamps (simplified event sourcing). We choose option (b) for MVP1
   simplicity, with the hard rule that status can only move forward:
   `Proposed → Approved → Executed` or `Proposed → Rejected` or `Executed → RolledBack`.

2. Every action log entry stores:
   - `action_type` — what operation (archive, delete, draft_reply, notify, etc.)
   - `resource_id` — which inbound item this acts on
   - `status` — current lifecycle state
   - `risk_level` — whether auto-executed or approval-required
   - `payload_json` — the action parameters
   - `result_json` — what happened after execution
   - `error_json` — what went wrong if execution failed
   - `rollback_json` — data needed to undo (for destructive actions)
   - `created_at` — when the entry was first created

3. Idempotency check: before proposing, query for any existing entry with the same
   `(resource_id, action_type)`. If found, return null (no duplicate proposal).

## Consequences

**Easier:**
- Complete audit trail: "Alfred proposed archiving email X at 09:15, I approved at 09:20,
  it executed at 09:20, result: success"
- Debugging: if an action fails, the error is persisted alongside the action
- Rollback: destructive actions store enough data to reverse them
- Trust: the user can verify the agent never does something unexpected

**Harder:**
- Table grows indefinitely (acceptable for single-user; thousands of rows per month)
- Can't "fix" a bad row — must append a correction
- Slightly more complex queries for current state (need to check latest status)

## Alternatives Considered

1. **Mutable status with updated_at** — simpler queries but loses the audit trail. If a row
   is updated from Proposed to Executed, there's no record of when it was approved. Rejected.

2. **Full event sourcing (separate events table)** — purest approach where every transition
   is its own row. More complex to query current state. Overkill for MVP1. Can migrate to
   this if needed. Rejected for now.

3. **No audit log (just execute and forget)** — unacceptable for an autonomous system acting
   on email. Rejected outright.
