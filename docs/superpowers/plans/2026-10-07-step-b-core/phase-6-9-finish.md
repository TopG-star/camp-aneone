# Phases 6–9: Agent audit, tenant AI limit, link ids, operations

Spec §8.7–§8.9, §9.4, §10, §11.

### Task 21 (ImpressoRx): `Agent` audit

**Files:**
- Create: `prisma/migrations/20261010000000_audit_actor_agent/migration.sql` (enum value only), `prisma/migrations/20261010000100_audit_agent_provenance/migration.sql` (columns and checks); Modify: `prisma/schema.prisma`
- Modify: `src/lib/auditLog.ts`, `src/lib/data-classes.ts`, `scripts/verify-audit-immutability.ts`, `.github/workflows/ci.yml` (e2e job runs `pnpm verify:audit` after `pnpm db:deploy`)
- Test: `src/lib/auditLog.test.ts` (extend)

**Interfaces:**
- `AuditActorType` (Prisma and the TypeScript union in `auditLog.ts`) gains `'Agent'`. The enum value gets its own migration, because Postgres cannot use a new enum value in the transaction that adds it.
- Columns: `AuditLog.oneonActionId TEXT NULL`, `AuditLog.unattended BOOLEAN NULL`. Constraints:
  - `AuditLog_agent_provenance CHECK ("actorType" <> 'Agent' OR ("userId" IS NOT NULL AND "oneonActionId" IS NOT NULL AND "actorLabel" = 'Oneon' AND "unattended" IS NOT NULL))`
  - `AuditLog_non_agent_no_provenance CHECK ("actorType" = 'Agent' OR ("oneonActionId" IS NULL AND "unattended" IS NULL))`
- `createAuditLog`: when `currentAgentAudit()` (Task 10) is defined, writes `actorType: 'Agent'`, `actorLabel: 'Oneon'`, `oneonActionId` and `unattended` from it. `AuditLogParams.actorType` excludes `'Agent'` at the type level, and a runtime `'Agent'` passed in throws. Without an agent context, behaviour is unchanged.
- Data classes: `AuditLog.oneonActionId` D1, `AuditLog.unattended` D1.
- `verify:audit` additionally asserts that both constraints exist and that an `Agent` insert without `oneonActionId` is rejected.

- [ ] **Step 1: Write the failing tests**
  - `attributes a write inside an agent context as Agent with its action id` (mocked `db.auditLog.create` receives `actorType: 'Agent'`, `actorLabel: 'Oneon'`, `oneonActionId`, `unattended: false`).
  - `marks an unattended agent write unattended`.
  - `refuses a caller-supplied Agent actorType` (throws).
  - `a write outside an agent context is unchanged` (`actorType: 'User'`, new fields absent).
  - `a support session inside no agent context is still Vendor`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS; run `pnpm verify:audit` against a local database after `pnpm db:deploy`.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): record Oneon writes as Agent with provenance`.

### Task 22 (Oneon): Tenant AI limit

**Files:**
- Create: `packages/infrastructure/src/database/control/tenant-ai-limit-repository.ts`
- Modify: `packages/application/src/ai-boundary/providers.ts` (`ProviderEntry.tenantDpa`)
- Create: `packages/agent-server/src/routes/tenant-settings.route.ts`
- Modify: `packages/agent-server/src/model-wiring.ts` (`tenantLimit`), `packages/dashboard/src/components/settings/ai-data-settings.tsx` (tenant view)
- Test: `.../control/tenant-ai-limit-repository.test.ts`, `packages/agent-server/src/routes/tenant-settings.route.test.ts`

**Interfaces:**
- `TenantAiLimitRepository`: `current(tenantId): DataClass` (newest row; `"D1"` when none); `history(tenantId): TenantAiLimitVersion[]`; `append(v: { tenantId; maxClass: "D0" | "D1" | "D2"; setBy: string; liveCheckRef: string; evidence: Record<string, unknown> | null }): void`.
- `ProviderEntry.tenantDpa?: { signedOn: string; reference: string } | null` (absent for both providers today).
- `GET /api/tenant/ai-limit` (tenant context) → `{ current, history }`. `POST /api/tenant/ai-limit` body `{ maxClass }`:
  1. `D3` or `D4` → 400 `{ error: "class_not_allowed" }`;
  2. live `client.forSession(sessionId).me()`; permissions must include `settings.oneon`, else 403; `ImpressoRxUnreachableError` → 503 `{ error: "impressorx_unreachable" }` (the lowering fallback is an unruled proposal, spec §9.4, and is not built);
  3. lowering or equal → append, 200;
  4. raising → allowed only up to the highest tenant ceiling among configured providers whose registry entry is `review: "reviewed"` and has `tenantDpa`, else 409 `{ error: "prerequisites_missing" }`.
  `liveCheckRef` records the snapshot's `tokenVersion` and the time of the check.
- Model wiring: `tenantLimit: (tenantId) => repo.current(tenantId)`.

- [ ] **Step 1: Write the failing tests**
  - `defaults to D1`; `history is append-only` (UPDATE raises).
  - `an admin lowers to D0 immediately`; `a non-admin is refused 403`.
  - `raising to D2 is refused while no provider is reviewed with a DPA` → 409; `allowed when one is` (test registry).
  - `D3 is refused 400`; `an unreachable ImpressoRx returns 503 and changes nothing`.
  - `the gateway applies the tenant's current limit` (D0 withholds a D1 field).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** Settings → AI data, in a tenant context, shows the pharmacy's limit and its history to everyone, with the change control only for admins.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(tenancy): store and change the tenant AI limit with a live check`.

### Task 23 (Oneon): Link ids

**Files:**
- Create: `packages/infrastructure/src/database/migrations/017_link_ids.sql`
- Modify: `packages/application/src/ai-boundary/gateway.ts`, `.../ai-boundary/audit.ts` (record fields), `packages/infrastructure/src/database/repositories/sqlite-model-audit.repository.ts`
- Modify: `packages/application/src/actions/orchestrator/request-action.ts`, `packages/agent-server/src/routes/chat.route.ts` and the chat use cases
- Test: `packages/application/src/ai-boundary/link-ids.test.ts`, `packages/agent-server/src/routes/chat.route.test.ts` (extend)

**Interfaces:**
- Migration 017: `model_call_decisions` add `conversation_id TEXT`, `turn_id TEXT`; `action_instances` add `model_call_id TEXT`.
- `beginTurn(context, options?: { channel?: string; conversationId?: string; turnId?: string })`; `ModelDecisionRecord` gains `conversationId: string | null`, `turnId: string | null`; every `GatewayResult` carries `callId` (add it where absent).
- `requestAction(input)` gains optional `modelCallId?: string`, stored in `action_instances.model_call_id`.
- Chat passes `conversationId` and `turnId` (the id of the user message row that started the turn); an action proposed from intent extraction passes that call's `callId`.

- [ ] **Step 1: Write the failing tests**
  - `chat model calls record conversation and turn ids`; `email classification and the briefing record null`.
  - `an action proposed in chat records the proposing model call id`, and `joining action_instances.model_call_id to model_call_decisions.call_id returns that turn`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(ai-boundary): link model calls to turns and proposed actions`.

### Task 24 (Oneon): Backups and the restore test

**Files:**
- Create: `packages/infrastructure/src/database/backup.ts`
- Modify: `packages/infrastructure/src/database/migrate-all.ts` (back up each file before migrating it), `packages/agent-server/src/background-loop.ts` (nightly backup, monthly restore test), `packages/agent-server/src/config/env.ts` (`BACKUP_DIR` default `./data/backups`, `BACKUP_ENCRYPTION_KEY` base64 of 32 bytes, required once any registration exists), `docs/DEPLOY.md` (replace the manual `cp` section)
- Test: `packages/infrastructure/src/database/backup.test.ts`

**Interfaces:**
- `backupAll(deps: { gate; control: ControlDb; outDir: string; keyB64: string; now: () => Date }): Promise<Array<{ file: string; context: "control" | "personal" | string }>>`: for each of control, personal and every active tenant, `db.backup(tmpPath)`, then seal with `sealSecret` (Task 8) into `<outDir>/<yyyy-mm-dd>/<name>.db.enc`, then delete the plaintext temp file.
- `restoreTest(deps: { file: string; keyB64: string; tmpDir: string }): Promise<{ ok: boolean; integrity: string; contextMeta: { kind: string; tenant_id: string | null } | null }>`: decrypts into `tmpDir`, runs `PRAGMA integrity_check`, reads `context_meta`, deletes the temp file.
- DEPLOY.md: backups are written by Oneon itself to `BACKUP_DIR`; the operator syncs that folder off-site (for example `rclone` to Cloudflare R2 or a Hetzner Storage Box); restore = stop the server, decrypt with `pnpm --filter @oneon/agent-server restore-backup <file>`, replace the file, start.

- [ ] **Step 1: Write the failing tests**
  - `backs up every file while a write is in progress and the copy passes integrity_check` (open a write transaction on one tenant during the backup).
  - `no plaintext database remains in outDir`.
  - `restoreTest reports the tenant id from context_meta`; `restoreTest fails with the wrong key`.
  - `migrateAll backs up a file before migrating it`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement, including the `restore-backup` script.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(ops): add encrypted per-file backups and a restore test`.

### Task 25 (Oneon): Rollups, platform view, link checker, job budgets

**Files:**
- Create: `packages/agent-server/src/tenant-jobs.ts`
- Modify: `packages/agent-server/src/routes/platform.route.ts` (`GET /api/platform/tenants`), `packages/agent-server/src/background-loop.ts`
- Create: `packages/dashboard/src/app/platform/page.tsx`
- Test: `packages/agent-server/src/tenant-jobs.test.ts`, `packages/agent-server/src/routes/platform.route.test.ts` (extend)

**Interfaces:**
- `forEachTenant(deps: { gate; registrations }, fn: (db: TenantDb, deadline: number) => Promise<void>, opts?: { budgetMs?: number }): Promise<{ visited: string[]; failed: string[] }>`: active registrations in order, one open file at a time, `deadline = now + budgetMs` (default 2000), an exception in one tenant is recorded and the loop continues. The sweeper (Task 15), backups (Task 24) and rollups use it.
- `writeRollups(deps, day: string)`: per tenant, one `tenant_rollups` row `{ tenant_id, day, metrics_json }` where `metrics_json` has exactly the numeric keys `modelCalls`, `modelDenials`, `actionsByStatus` (status → count), `activeGrants`. Daily.
- `checkLinks(deps): Array<{ grantId; actionId; tenantId }>`: action grants whose `actionId` no longer exists in the tenant file; logged and raised as an operator alert, never deleted. Nightly.
- `GET /api/platform/tenants` (operator only): registrations plus their latest rollups, read from the control database only.

- [ ] **Step 1: Write the failing tests**
  - `forEachTenant continues after a tenant throws` and `passes a deadline of now + budget`.
  - `rollups contain only the four numeric keys` (assert key set; no string values other than status names).
  - `the platform view never opens a tenant file` (spy: `gate.openTenant` not called) and `is refused for non-operators`.
  - `checkLinks reports an action grant whose action is gone`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(ops): add tenant rollups, a link checker and per-tenant job budgets`.
