# Phase 2: Oneon control database, gate and identities (Oneon repo)

Spec §4, §8. Branch `feat/step-b-core`. No behaviour change for personal use: the existing suite must stay green unchanged except where a task says otherwise.

### Task 5: The control database

**Files:**
- Create: `packages/infrastructure/src/database/control-migrations/001_control_schema.sql`
- Modify: `packages/infrastructure/src/database/connection.ts` (`runMigrations(db, dir?)`)
- Create: `packages/infrastructure/src/database/control/open-control-db.ts`
- Modify: `packages/agent-server/src/config/env.ts` (`CONTROL_DATABASE_PATH`, `TENANT_DATA_DIR`, `ONEON_GRANT_MASTER_KEY`, `ONEON_SIGNING_KEY_MASTER_KEY`)
- Test: `packages/infrastructure/src/database/control/control-schema.test.ts`

**Interfaces:**
- Produces: `runMigrations(db: Database.Database, migrationsDir?: string): void` (default stays today's directory, so existing callers are unchanged).
- Produces: `openControlDb(path: string): ControlDb` where `type ControlDb = Database.Database & { readonly __control: unique symbol }`.
- `identities` has `merged_into TEXT NULL` besides spec §4.1's columns (Task 26).
- Schema (exact table names; columns from spec §4.1, §5.2, §7.3, §8.8, §9.4): `identities`, `login_identities`, `memberships`, `platform_operators`, `channel_identities`, `identity_link_events`, `tenant_registrations`, `tenant_registration_events`, `delegation_grants`, `tenant_ai_limit_versions`, `tenant_rollups`, `used_handoff_jti`.
- Append-only triggers (BEFORE UPDATE and BEFORE DELETE, `RAISE(ABORT, '<table> is append-only')`) on `platform_operators`, `identity_link_events`, `tenant_registration_events`, `tenant_ai_limit_versions`.
- Unique constraints: `login_identities(kind, subject)`; `memberships(tenant_registration_id, external_user_id)`; `used_handoff_jti(jti)`.

- [ ] **Step 1: Write the failing tests**
  - `creates every control table` → the 12 names above exist in `sqlite_master`.
  - `append-only tables refuse UPDATE and DELETE` → each of the four raises its exact message.
  - `login_identities is unique per kind and subject` → second insert throws `UNIQUE constraint failed`.
- [ ] **Step 2: Run, confirm FAIL** (`pnpm --filter @oneon/infrastructure test -- control-schema`).
- [ ] **Step 3: Implement.** `openControlDb` calls `createDatabase` then `runMigrations(db, controlMigrationsDir)`. Env: the two master keys are optional strings validated as base64 of exactly 32 bytes when present.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): add the control database schema`.

### Task 6: The gate, typed handles and multi-file migrations

**Files:**
- Create: `packages/domain/src/context.ts`
- Create: `packages/infrastructure/src/database/context-db-gate.ts`
- Create: `packages/infrastructure/src/database/migrations/016_context_meta_and_tenant_id.sql`
- Create: `packages/infrastructure/src/database/migrate-all.ts`
- Modify: `packages/agent-server/src/architecture.test.ts`
- Test: `packages/infrastructure/src/database/context-db-gate.test.ts`, `packages/infrastructure/src/database/migrate-all.test.ts`

**Interfaces:**
- Produces in `domain/src/context.ts`:
  - `type PersonalDb = { readonly kind: "personal"; readonly raw: unknown; readonly __brand: "PersonalDb" }`
  - `type TenantDb = { readonly kind: "tenant"; readonly tenantId: string; readonly raw: unknown; readonly __brand: "TenantDb" }`
  - `type ContextDb = PersonalDb | TenantDb`
  - `function assertRowTenant(db: ContextDb, rowTenantId: string | null): void` (throws `Error("tenant_mismatch")` when `db.kind === "tenant"` and `rowTenantId !== db.tenantId`, or `db.kind === "personal"` and `rowTenantId !== null`).
- Produces in `context-db-gate.ts`:
  - `class ContextDbGate { constructor(deps: { control: ControlDb; personalPath: string; tenantDir: string; cacheSize?: number }); openPersonal(): PersonalDb; openTenant(registrationId: string): TenantDb; createTenantFile(registrationId: string, tenantId: string): TenantDb; close(): void }`
  - `class TenantRefusedError extends Error { code: "tenant_unavailable" | "tenant_schema_behind" }`
  - `function rawDb(db: ContextDb): Database.Database` (exported only from infrastructure, for repositories).
  - `ensureIdentityAnchor(db: ContextDb, identityId: string): void` (README Global Constraints).
- Migration 016: `CREATE TABLE context_meta (kind TEXT NOT NULL CHECK (kind IN ('personal','tenant')), tenant_id TEXT, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL)`; add nullable `tenant_id TEXT` to `conversations`, `action_events`, `model_call_decisions`, `model_call_outcomes` (`action_instances` already has it). The personal file's `context_meta` row is written by `openPersonal` on first open: `('personal', NULL, <version>, now)`.
- Produces in `migrate-all.ts`: `migrateAll(deps: { control: ControlDb; personalPath: string; tenantDir: string; lockPath: string; logger }): { migrated: string[]; failed: Array<{ registrationId: string; error: string }> }`. Takes an exclusive lock file (`fs.openSync(lockPath, 'wx')`, removed in `finally`), migrates personal then each `tenant_registrations` row with status `active`. A failure is recorded and the loop continues.

Gate rules: filename comes from `tenant_registrations.file_name`, must match `^[0-9a-f-]{36}\.db$`; the file must already exist (`openTenant` never creates); `context_meta.kind = 'tenant'` and `tenant_id` equals the registration's `tenant_id`; schema version equals the latest migration number, else `tenant_schema_behind`. Handles are cached in an LRU of `cacheSize` (default 32), closing the evicted connection.

- [ ] **Step 1: Write the failing tests**
  - `openTenant refuses an unknown registration` → `TenantRefusedError` `tenant_unavailable`.
  - `openTenant refuses a suspended registration` → `tenant_unavailable`.
  - `openTenant refuses a file missing on disk and does not create it` (Review Focus 4) → `tenant_unavailable`; `fs.existsSync(path)` still false.
  - `openTenant refuses a file name outside the pattern` (registry row `../oneon.db`) → `tenant_unavailable`.
  - `openTenant refuses a file whose context_meta names another tenant` → `tenant_unavailable`.
  - `openTenant refuses a file at an old schema version` → `tenant_schema_behind`.
  - `the cache closes the least recently used handle beyond its size` (size 2, open three) → first handle's `raw.open === false`.
  - `assertRowTenant throws tenant_mismatch` for a tenant handle and a row of another tenant, and for a personal handle and a non-null row tenant.
  - `migrateAll migrates personal and every active tenant, and continues past a failing file` (one corrupt file) → `failed` names it; the others are at the latest version.
  - `migrateAll refuses to run while the lock file exists` → throws.
  - Architecture (`architecture.test.ts`): `only the gate and connection.ts construct a SQLite Database` (scan `packages/*/src` for `new Database(`); `repositories accept handles, not paths` (no exported repository constructor in `infrastructure/src/database/repositories` has a parameter typed `string` named `path` or `dbPath`).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): add the context database gate and multi-file migrations`.

### Task 7: Identities, Google `sub`, sessions by identity

**Files:**
- Create: `packages/infrastructure/src/database/control/identity-repository.ts`
- Create: `packages/infrastructure/src/database/control/backfill-identities.ts`
- Modify: `packages/dashboard/src/lib/auth.ts` (`jwt` callback stores `token.sub = profile.sub` for Google; `session.user.sub`)
- Modify: `packages/agent-server/src/middleware/session-auth.ts`
- Modify: `packages/agent-server/src/types/*.d.ts` (`req.identityId`)
- Modify: `packages/agent-server/src/container.ts` (open control DB, gate, run backfill, wire repository)
- Test: `packages/infrastructure/src/database/control/identity-repository.test.ts`, `packages/agent-server/src/middleware/__tests__/session-auth.test.ts` (extend)

**Interfaces:**
- Produces: `interface IdentityRepository { findByLogin(kind: "google" | "impressorx", subject: string): Identity | null; createWithLogin(input: { kind; subject; email?: string; id?: string }): Identity; attachGoogleSubByEmailOnce(email: string, sub: string): Identity | null; linkLogin(identityId: string, loginId: string, actor: string): void; listMemberships(identityId: string): Membership[] }` and `type Identity = { id: string; status: "active" | "disabled" }`, `type Membership = { id; identityId; tenantRegistrationId; externalUserId; role; permissions: string[]; locationIds: string[]; status: "active" | "suspended" | "revoked"; snapshotAt: string }`.
- `backfillIdentities(personal: PersonalDb, control: ControlDb): number`: for every `users` row with no identity, inserts `identities(id = users.id)` and a `google` login identity with `subject = "email:" + email` (a pending marker) and `email`. Idempotent.
- `attachGoogleSubByEmailOnce`: finds the login identity whose subject is `"email:" + email`, replaces the subject with the real `sub`, returns the identity; returns null when no pending marker exists. This is the only email lookup (spec §4.2).
- `session-auth`: decrypts the session as today; a session without `sub` sets nothing (signed out); with `sub`, it resolves `findByLogin("google", sub)`, falling back once to `attachGoogleSubByEmailOnce(email, sub)`; a new allow-listed Google user gets `createWithLogin` (and a `users` row via the existing `upsertUser`, same id). Sets `req.identityId` and keeps `req.userId = identityId` so every existing route works unchanged.

- [ ] **Step 1: Write the failing tests**
  - `backfill creates one identity per user with the same id` and `is idempotent`.
  - `attaches the Google sub by email exactly once` → second call with another `sub` returns null.
  - `findByLogin ignores email` → an identity whose login email is `a@x` is not found by `findByLogin("google", "a@x")`.
  - Session: `resolves the identity by sub`; `migrates a pre-existing user on first sign-in with sub` → `req.identityId === users.id`; `a session without sub is treated as signed out` → no `req.identityId` (each existing user signs in once after the upgrade; email is never used to resolve a session).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS; the existing suite passes unchanged.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): key sessions to identities and backfill existing users`.
