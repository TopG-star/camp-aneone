# Phase 4: tenant context (Oneon repo)

Spec §4.4, §4.6, §8.4, §9.1–§9.3, §9.5.

### Task 14: Active context and per-context repositories

**Files:**
- Modify: `packages/domain/src/context.ts` (`ActiveContext`)
- Create: `packages/agent-server/src/middleware/active-context.ts`
- Create: `packages/agent-server/src/context-wiring.ts`
- Modify: the context-scoped repositories in `packages/infrastructure/src/database/repositories/` (conversation, action instance, action config, legacy action, model audit): constructors take `ContextDb`; writes set `tenant_id`; reads call `assertRowTenant`
- Modify: `packages/agent-server/src/container.ts` (personal repositories built from `gate.openPersonal()`), `packages/agent-server/src/routes/chat.route.ts`
- Modify: `packages/agent-server/src/architecture.test.ts` (I1)
- Test: `packages/agent-server/src/__tests__/tenant-isolation.test.ts`

**Interfaces:**
- `type ActiveContext = { kind: "personal"; identityId: string } | { kind: "tenant"; identityId: string; membershipId: string; tenantId: string }` (`tenantId` = registration id).
- Middleware `resolveActiveContext(deps: { gate; memberships; identities })`: reads the session's `activeContext` (Google sessions default to personal); for tenant, requires the membership to be `active` and owned by `req.identityId`; sets `req.activeContext` and `req.contextDb`. Failure: 403 `{ error: "context_unavailable" }`. Personal context requires a Google login identity.
- `contextRepos(db: ContextDb): ContextRepositories` with `{ conversations; actionInstances; actionConfigs; legacyActions; modelAudit }`, memoized per handle (`WeakMap`).
- Routes read repositories from `contextRepos(req.contextDb)`, never from the container, for the five repositories above.
- Architecture test I1: no file under `packages/agent-server/src/routes` reads `tenantId`, `tenant_id` or `registrationId` from `req.body`, `req.query` or `req.params`.

- [ ] **Step 1: Write the failing tests** (fixture of spec §4.7, with the fake ImpressoRx)
  - `a conversation started in tenant A is invisible in B and in personal`.
  - `a conversation started in personal is invisible in A`.
  - `a row with another tenant's id in A's file throws tenant_mismatch on read` (insert directly with `rawDb`).
  - `a request naming a suspended membership gets 403 context_unavailable`.
  - `a tenant-only identity cannot select personal` → 403.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** Personal behaviour is unchanged: every existing route test passes without edits other than construction.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): resolve the active context and open its database per request`.

### Task 15: Tenant actor and per-context actions

**Files:**
- Modify: `packages/domain/src/actions/types.ts` (`tenantActor`)
- Modify: `packages/application/src/actions/orchestrator/shared.ts` (`actorForInstance`), `.../orchestrator/advance.ts`
- Modify: `packages/agent-server/src/actions-wiring.ts` (`actionsFor`), `packages/agent-server/src/context-wiring.ts`
- Test: `packages/application/src/actions/orchestrator/tenant-actor.test.ts`, `packages/agent-server/src/actions-wiring.test.ts` (extend)

**Interfaces:**
- `tenantActor(m: { identityId: string; tenantId: string; role: string; permissions: string[]; locationIds: string[] }): ActorContext` → `{ userId: identityId, scope: "tenant", tenantId, roles: [role], permissions: permissions.map(p => "impressorx:" + p), locationIds }`.
- `actorForInstance(instance: ActionInstance, memberships: { activeFor(identityId: string, tenantId: string): MembershipLike | null }): ActorContext`: personal unchanged; tenant builds `tenantActor` from the current membership; none active → throws `DelegationRevokedError`.
- `advance` catches `DelegationRevokedError` and moves the instance to `failed` with `error: { code: "delegation_revoked", message: "The person's access to this pharmacy has ended.", stage: "recheck" }`.
- `actionsFor(db: ContextDb): ActionsModule` (memoized per handle; tenant capabilities have no executors in B-core). `runActionRecovery` is called for personal and then for each active registration, opening one tenant file at a time.

- [ ] **Step 1: Write the failing tests**
  - `tenantActor namespaces permissions` → `["impressorx:inventory.view"]`.
  - `actorForInstance rebuilds a tenant actor from the current membership`.
  - `a tenant action whose membership is suspended fails with delegation_revoked` (status `failed`, code exact).
  - `an actor from tenant B cannot approve tenant A's action` (`canApprove` false).
  - `recovery visits personal and each active tenant once, one file at a time`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): build tenant actors from memberships`.

### Task 16: Gateway and tools by context

**Files:**
- Modify: `packages/application/src/ai-boundary/gateway.ts` (optional deps `auditFor`, `tenantLimit`)
- Modify: `packages/application/src/tools/tool-registry.ts` (`contexts`, `listFor`), each existing tool file (declare `contexts: ["personal"]`), `list-pending-actions.ts` (`contexts: ["personal", "tenant"]`, reads the context's action repository)
- Create: `packages/application/src/tools/show-my-access.ts`
- Modify: `packages/agent-server/src/model-wiring.ts`, `packages/agent-server/src/routes/chat.route.ts`
- Test: `packages/application/src/ai-boundary/gateway-tenant.test.ts`, `packages/application/src/tools/tool-registry.test.ts` (extend), `packages/application/src/tools/show-my-access.test.ts`

**Interfaces:**
- `ModelGatewayDeps.auditFor?: (context: ModelContext) => ModelAuditRepository` (default `() => audit`); `ModelGatewayDeps.tenantLimit?: (tenantId: string) => DataClass` (default `() => TENANT_CHOICE_LIMIT`).
- `ToolDefinition.contexts?: ReadonlyArray<"personal" | "tenant">` (default `["personal"]`); `ToolRegistry.listFor(kind: "personal" | "tenant")`; `ToolRegistry.execute(name, input, kind)` refuses a tool outside the context with `{ ok: false, error: "tool_not_in_context" }`.
- `show_my_access` (tenant only): returns `{ role, permissions, locationIds, snapshotAt }`; output schema: `role` D1, `permissions` D1, `locationIds` D1, `snapshotAt` D1.
- Chat in a tenant context calls `beginTurn({ kind: "tenant", identityId, tenantId, membershipId })` and offers `listFor("tenant")`.

- [ ] **Step 1: Write the failing tests**
  - `tenant model-call audit rows land in the tenant file, not personal`.
  - `tenantLimit is applied as the tenant layer` (stub returns `D1`; a D2 field is withheld).
  - `listFor("tenant") contains only show_my_access and list_pending_actions`.
  - `executing a personal tool in a tenant context returns tool_not_in_context`.
  - `every registered tool declares contexts explicitly` (scan the registry; default not relied on).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): route model calls and tools by context`.

### Task 17: Context picker and snapshot refresh

**Files:**
- Create: `packages/agent-server/src/routes/contexts.route.ts`
- Modify: `packages/agent-server/src/middleware/active-context.ts` (refresh)
- Create: `packages/dashboard/src/components/layout/context-picker.tsx`; Modify: `packages/dashboard/src/components/layout/topbar.tsx`, `packages/dashboard/src/lib/auth.ts` (`update` with `activeContext`)
- Test: `packages/agent-server/src/routes/contexts.route.test.ts`, `packages/agent-server/src/middleware/__tests__/active-context.test.ts`

**Interfaces:**
- `GET /api/contexts` → `{ active: ActiveContextView; available: Array<{ kind: "personal" } | { kind: "tenant"; membershipId; tenantName; role }> }`; personal listed only for identities with a Google login; tenants only `active` memberships.
- `POST /api/contexts/validate` body `{ kind: "personal" } | { kind: "tenant"; membershipId }` → 200 when allowed, else 403; the dashboard then calls NextAuth `update({ activeContext })`.
- Refresh: when the active membership's `snapshot_at` is older than 300 s, the middleware calls `client.forSession(sessionId).me()`, then `applySnapshot`. On `ImpressoRxRefusedError`: membership `suspended`, revoke every grant of that membership in the grant store, respond 403 with the suspended message. On `ImpressoRxUnreachableError`: keep the cached snapshot (it only offers), log at warn.

- [ ] **Step 1: Write the failing tests**
  - `lists only active memberships`; `omits personal for a tenant-only identity`.
  - `refreshes a snapshot older than 5 minutes and not a newer one`.
  - `a refused refresh suspends the membership, revokes its grants and returns 403`.
  - `an unreachable ImpressoRx keeps the cached snapshot`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** The picker shows "Personal" and each pharmacy by name with the role; switching reloads the conversation list.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): add the context picker and snapshot refresh`.

### Task 26: Linking identities (runs after Task 17)

Spec §4.5 and limitation 6. Numbered 26 so later task numbers stay stable.

**Files:**
- Create: `packages/agent-server/src/routes/identity-link.route.ts`
- Create: `packages/infrastructure/src/database/control-migrations/002_link_intents.sql` (`link_intents(id, session_id, identity_id, expires_at, used_at)`)
- Modify: `packages/infrastructure/src/database/control/identity-repository.ts` (`mergeInto`, `unlink`)
- Modify: `packages/dashboard/src/lib/auth.ts` (`linkIntent` in the JWT), `packages/dashboard/src/components/settings/connections-settings.tsx` (or the Settings page until Task 20: a "Link your personal Oneon account" button)
- Test: `packages/agent-server/src/routes/identity-link.route.test.ts`, `.../control/identity-repository.test.ts` (extend)

**Interfaces:**
- `POST /api/identity/link-intent` → `{ linkIntentId }`, stored in the control database for 5 minutes and bound to the current `sessionId`. The dashboard keeps it in the JWT, then starts Google sign-in (from a hand-off session) or a hand-off (from a Google session).
- On the second sign-in, the dashboard's `jwt` callback sends `POST /api/identity/link` (service-token auth) with `{ linkIntentId, sessionId, login: { kind, subject, email? } }`. The intent must exist, be unexpired, unused and bound to the same `sessionId`, else 409 `{ error: "link_expired" }`.
- `IdentityRepository.mergeInto(fromId, toId, actor)`, where `toId` is the identity holding the Google login:
  - moves `from`'s login identities and memberships to `to`;
  - for each tenant file of a moved membership: `ensureIdentityAnchor(db, toId)`; `UPDATE conversations SET user_id = toId WHERE user_id = fromId`; `UPDATE action_instances SET user_id = toId WHERE user_id = fromId`, and the same for `initiator_user_id`;
  - leaves append-only rows (`action_events`, `model_call_decisions`, `model_call_outcomes`) unchanged as history;
  - sets `from.status = 'disabled'`, `from.merged_into = toId`; records an `identity_link_events` row. Grants of `from` are revoked (the person reconnects).
- If no Google identity exists yet (linking from a hand-off to a brand-new Google login), the Google login identity is attached to the current identity instead; no merge.
- `POST /api/identity/unlink` body `{ loginIdentityId }`: detaches an `impressorx` login identity and its memberships into a new identity; earlier conversations stay with the identity they were created under (limitation 6). Refused if it would leave an identity with no login identity.

- [ ] **Step 1: Write the failing tests**
  - `linking from a hand-off session to an existing Google identity merges into the Google identity` → memberships and conversations in the tenant file now belong to the Google identity; `from` is `disabled` with `merged_into`.
  - `append-only rows keep the old identity id`.
  - `a link intent from another browser session is refused` → 409 `link_expired`; `an intent older than 5 minutes is refused`.
  - `linking never happens by matching email` (two identities with the same login email and no intent stay separate).
  - `unlink creates a new identity for the detached login`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): link identities deliberately within one session`.
