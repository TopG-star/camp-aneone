# Phase 5: unattended grants (both repos)

Spec §7.1–§7.2, §7.5–§7.7, §9.2.

### Task 18 (ImpressoRx): unattended grants, refusal list and the admin view

**Files:**
- Modify: `src/lib/oneon/grants.ts` (issue `Action` and `Schedule` grants), `src/app/api/oneon/token/route.ts` (`grantType: "issue"`)
- Modify: `src/server/trpc/trpc.ts` (unattended refusal), `src/server/trpc/routers/oneon.ts` (`setUnattended`, `grants`, `revokeGrant`), `src/app/(dashboard)/settings/oneon/page.tsx`
- Test: `src/lib/oneon/grants.test.ts` (extend), `src/server/trpc/trpc.test.ts` (extend), `src/server/trpc/routers/oneon.test.ts` (extend)

**Interfaces:**
- Token request `grantType: "issue"`: claims `attendedGrantId`, `attendedGrant` (value; rotated as a normal exchange), `requestId`, `kind: "action" | "schedule"`, `scope: string[]` (permission codes), `oneonActionId` (required for `action`), `absoluteExpiresAt` (ISO). Refused unless `OneonClient.unattendedAllowed`. Expiry is capped at 60 days; `action` grants have idle expiry equal to absolute; `schedule` grants have idle expiry 14 days. Response adds `issued: { id, value, generation }`.
- Exchanging an `Action` or `Schedule` grant yields `unattended: true`, `scope` = grant scope ∩ role permissions, and for `Action`, `oneonActionId` from the grant (a request-supplied one is ignored).
- `UNATTENDED_FORBIDDEN_PREFIXES = ['users.', 'companySettings.', 'oneon.', 'support.', 'setup.', 'deletionRequests.approve', 'recycleBin.']` and `UNATTENDED_FORBIDDEN_PERMISSIONS = [P.USERS_MANAGE, P.SETTINGS_UPDATE, P.SETTINGS_ONEON, P.AUDIT_APPROVE_DELETION]`. With `ctx.agent.unattended`, `enforceAuth` refuses a matching path and `requirePermission` refuses a listed permission, both `FORBIDDEN`.
- Router (Admin, `P.SETTINGS_ONEON`): `setUnattended({ allowed: boolean })` (turning off revokes every `Action` and `Schedule` grant); `grants` (every grant: kind, user name, scope, created, last used, expiry, status, revoked reason); `revokeGrant({ id })`.

- [ ] **Step 1: Write the failing tests**
  - `issues an action grant bound to its action id` → exchanging it yields `unattended: true` and that `oneonActionId` even when the request names another.
  - `refuses issue while unattended access is off`; `turning unattended off revokes action and schedule grants but keeps attended ones`.
  - `caps a requested expiry at 60 days`.
  - `scope is the lower of grant and role` → a grant scoped to `inventory.transfer` for a role lacking it yields an empty scope.
  - One test per refusal: an unattended token calling `users.*`, `companySettings.*`, `oneon.*`, `support.*`, `setup.*`, `deletionRequests.approve`, `recycleBin.*`, and a procedure requiring each listed permission → `FORBIDDEN`. The same calls with an attended token from an Admin succeed.
  - `grants lists every grant for an Admin and is refused for others`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** Settings → Oneon gains the **Allow unattended access** switch and the grants table with a Revoke button per row.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): add unattended grants with a refusal list and admin controls`.

### Task 19 (Oneon): action-bound grants, approval age, delegation failures

**Files:**
- Modify: `packages/application/src/actions/policy/types.ts` (`maxApprovalAgeHours`), `.../policy/clamp-policy.ts`
- Modify: `packages/application/src/actions/orchestrator/advance.ts`, `.../orchestrator/decisions.ts` (approve)
- Modify: `packages/agent-server/src/actions-wiring.ts` (token selection, grant issue and revoke hooks), `packages/agent-server/src/routes/actions.route.ts`
- Test: `packages/application/src/actions/orchestrator/approval-age.test.ts`, `packages/agent-server/src/actions-wiring.test.ts` (extend)

**Interfaces:**
- `PolicyFloor.maxApprovalAgeHours?: number`. Tenant-scope definitions get floor `24`. `clampPolicy` keeps the configured value only if it is lower than the floor.
- In `executeApproved`, before preconditions: for a tenant instance, if `now − approvedAt > maxApprovalAgeHours`, move to `failed` with `error: { code: "approval_stale", message: "This approval is too old to act on. Ask for it again.", stage: "recheck" }`. `approvedAt` is the `created_at` of the instance's event whose `to_status` is `approved` (add `ActionInstanceRepository.approvedAt(id): string | null`).
- Approving a tenant action in a request: after the approval is recorded, `client.forSession(sessionId).issue({ kind: "action", oneonActionId: id, scope: requiredPermissions without the "impressorx:" prefix, absoluteExpiresAt: approvedAt + maxApprovalAgeHours })` stores the grant (`kind: "action"`, `actionId`). If ImpressoRx refuses issuance (unattended off), the approval stands and execution must run in the request.
- Approving a tenant action first calls `client.forSession(sessionId).me()` live (spec §9.3). Refused → membership `suspended`, 403, approval not recorded. The approver's role must be in `approverRoles` per that live snapshot.
- `tokenFor(instance, session?: string)`: attended when the call is inside a request with a session; else the action grant for `instance.id`; neither → `DelegationRevokedError`.
- Failure mapping at execution: `ImpressoRxRefusedError` → revoke the local grant, `failed` with `delegation_revoked`; `ImpressoRxUnreachableError` → the instance stays `approved`, an event records `{ retry: "impressorx_unreachable" }`, and the sweeper retries until the age limit makes it `approval_stale`.
- On any final status of a tenant instance, its action grant is revoked locally and at ImpressoRx.
- "Needs reconnect": an instance `failed` with `delegation_revoked` shows "Needs reconnect" on its action card and keeps the existing **Retry** operation; Settings → Connections lists it (Task 20).

- [ ] **Step 1: Write the failing tests**
  - `an approval older than 24 hours fails as approval_stale` and `a 23-hour approval proceeds`.
  - `configuration may lower maxApprovalAgeHours but not raise it` (`48` clamps to `24`, `6` stays `6`).
  - `approving a tenant action issues an action-bound grant scoped to its permissions`.
  - `approval checks the approver live and refuses a role changed since the snapshot` (the fake returns a role outside `approverRoles` → 403; status stays `awaiting_approval`).
  - `outside a request the executor uses the action grant`; `with no grant it fails delegation_revoked`.
  - `a refused exchange fails delegation_revoked and revokes the local grant`.
  - `an unreachable ImpressoRx keeps the action approved and retries, then approval_stale after the limit`.
  - `reaching completed revokes the action grant at ImpressoRx`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): bind unattended execution to action grants and an approval age limit`.

### Task 20 (Oneon): Settings → Connections

**Files:**
- Create: `packages/agent-server/src/routes/connections.route.ts`
- Create: `packages/dashboard/src/components/settings/connections-settings.tsx`; Modify: `packages/dashboard/src/app/settings/page.tsx`
- Test: `packages/agent-server/src/routes/connections.route.test.ts`

**Interfaces:**
- `GET /api/connections` → `{ grants: Array<{ id; tenantName; kind; scope: string[]; createdAt; lastUsedAt; expiresAt; status }>; needsReconnect: Array<{ tenantName; actionId; label; failedAt }> }` for `req.identityId` only. `needsReconnect` reads each of the identity's active memberships' files through the gate, one at a time.
- `POST /api/connections/:grantId/revoke` → 204; 404 when the grant belongs to another identity. Forwards to ImpressoRx through the client, then revokes locally.

- [ ] **Step 1: Write the failing tests**
  - `lists only the caller's grants`; `revoking another identity's grant returns 404`.
  - `revocation reaches ImpressoRx` (the fake records it) and `the grant is revoked locally`.
  - `needsReconnect lists delegation_revoked actions across the caller's tenants`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** The view lists each connection with kind, pharmacy, scope and dates, a Revoke button, and a "Needs reconnect" section linking to each action.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): show and revoke connections in Settings`.
