# Phase 3: enrolment console, hand-off and the attended grant (both repos)

Spec §5.2–§5.4, §6, §7.3–§7.4, §12. Tasks alternate between the repos. Oneon tests use the fake ImpressoRx created in Task 8, which implements exactly the endpoints below.

### Task 8 (Oneon): crypto, tenant registrations and the enrolment console

**Files:**
- Create: `packages/infrastructure/src/crypto/envelope.ts`, `packages/infrastructure/src/crypto/jws.ts`
- Create: `packages/infrastructure/src/database/control/tenant-registration-repository.ts`, `.../control/platform-operator-repository.ts`
- Create: `packages/infrastructure/src/impressorx/fake-impressorx.ts` (enrol endpoint now; Task 12 extends it)
- Create: `packages/agent-server/src/routes/platform.route.ts`, `packages/agent-server/scripts/grant-operator.ts`
- Create: `packages/dashboard/src/app/platform/enrol/page.tsx`
- Modify: `packages/infrastructure/package.json` (`jose`)
- Test: `.../crypto/envelope.test.ts`, `.../crypto/jws.test.ts`, `.../control/tenant-registration-repository.test.ts`, `packages/agent-server/src/routes/platform.route.test.ts`

**Interfaces:**
- `sealSecret(plaintext: string, masterKeyB64: string): { wrappedKey: string; ciphertext: string }` and `openSecret(sealed, masterKeyB64): string`: a fresh 32-byte data key per secret, AES-256-GCM for both layers.
- `signJws` and `verifyJws`: same signatures and claim rules as ImpressoRx Task 2, with `consumeJti?: (jti: string, expiresAt: string) => boolean` (false means already used).
- `TenantRegistrationRepository`: `create(input: { tenantSlug; displayName; origin; deploymentKeyId; deploymentPublicKeyJwk; oneonKeyId; oneonPrivateKeySealed; enrolledBy }): TenantRegistration` (sets `id` = new UUID, `tenant_id` = `id`, `file_name` = `id + ".db"`, status `active`, and writes a `tenant_registration_events` row); `findById`; `findByIssuer(iss: string)` (`"impressorx:" + slug`); `listActive()`; `setStatus(id, status, actor, reason)`; `addDeploymentKey(id, keyId, jwk)`.
- `PlatformOperatorRepository.isOperator(identityId): boolean` (latest row per identity decides).
- Route `POST /api/platform/enrolments` (operator only, else 403): body `{ origin: string (https), code: string }`. Generates an Ed25519 key pair, sends the signed enrol request (ImpressoRx Task 4 contract), verifies the reply's signature with the returned deployment key and its `nonce`, creates the registration, then `gate.createTenantFile(id, id)`. Responses: 201 `{ registrationId, tenantSlug }`; 502 `{ error: "Enrolment failed" }` for any remote failure, with no detail echoed.
- Script: `pnpm --filter @oneon/agent-server grant-operator <identityId>` inserts a `platform_operators` grant row.
- **Key rotation (spec §5.4):**
  - `rotateOneonKey(registrationId)`: generates a new key, sends `POST /api/oneon/keys` signed with the current key, stores the new key and keeps the old one for 7 days. It's a button on the platform console.
  - `refreshDeploymentKeys(registrationId)`: fetches `GET /api/oneon/keys`, verifies the reply with a currently known deployment key, and stores the list. It runs nightly, and once on any signature failure from that registration before refusing.

- [ ] **Step 1: Write the failing tests**
  - `envelope round-trips and uses a different data key per secret`; `openSecret fails with the wrong master key`.
  - `jws accepts a 29-second clock skew and refuses 31 seconds` (Review Focus 5).
  - `enrols against the fake deployment` → 201; registration `active`; tenant file exists with `context_meta.tenant_id = registrationId`.
  - `refuses a non-operator` → 403. `refuses an http origin` → 400.
  - `reports a reply signed by the wrong key as failure and stores nothing` → 502; no registration row; no tenant file.
  - `rotateOneonKey registers the new key at the fake and signs with it afterwards`.
  - `refreshDeploymentKeys accepts a list signed by a known key and refuses one signed by an unknown key`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** The page has two fields (HTTPS origin, enrolment code) and states that the operator must check the origin against the tenant registry first.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): add tenant enrolment from the platform console`.

### Task 9 (ImpressoRx): grants and `POST /api/oneon/token`, `POST /api/oneon/revoke`

**Files:**
- Modify: `prisma/schema.prisma` + migration `oneon_grant`; `src/lib/data-classes.ts`
- Create: `src/lib/oneon/grants.ts`, `src/app/api/oneon/token/route.ts`, `src/app/api/oneon/revoke/route.ts`
- Modify: `src/lib/oneon/client.ts` (`disableOneon` and `removeOneon` revoke every grant)
- Test: `src/lib/oneon/grants.test.ts`, `src/app/api/oneon/token/route.test.ts`

**Interfaces:**
- Model `OneonGrant { id, kind OneonGrantKind, userId, tokenVersionAtIssue Int, valueHash, generation Int, status OneonGrantStatus, revokedReason String?, scopeJson Json, oneonActionId String?, lastRequestId String?, lastResultEnc String?, lastRequestAt DateTime?, idleExpiresAt, absoluteExpiresAt, lastUsedAt DateTime?, createdAt, tenantId }`; `enum OneonGrantKind { Attended Action Schedule }`; `enum OneonGrantStatus { Active Revoked Expired }`. Classes: `valueHash`, `lastResultEnc` D4; `userId` STAFF; rest D1.
- `POST /api/oneon/token` body `{ request: string }`, a JWS from Oneon (`iss: "oneon"`, verified against `OneonPublicKey` rows not retired) with claims:
  - `grantType: "handoff"`, `handoff` (the hand-off JWS; verified with this deployment's key, `aud: "oneon"`, ttl ≤ 60, `jti` consumed), `requestId` → issues an `Attended` grant (12 h absolute, 30 min idle) and returns its first value; or
  - `grantType: "grant"`, `grantId`, `grant` (value), `requestId`, optional `oneonActionId` → rotation.
- Response 200: `{ accessToken, accessTokenExpiresAt, grant: { id, value, generation }, snapshot: { userId, role, permissions, locationIds, tokenVersion, tenantStatus } }`. The access token is a JWS signed by the deployment key, `iss` = `aud` = `"impressorx:<slug>"`, ttl 300, claims `sub` (user id), `tv`, `grantId`, `unattended: false` (Attended), `scope` (permission codes), `oneonActionId?`.
- `exchangeGrant(db, input): Promise<ExchangeResult>` rules, in order:
  1. client `Active`, tenant serviceable (`isTenantServiceable`), grant `Active`, not past idle or absolute expiry;
  2. user `isActive` and not deleted, and `user.tokenVersion === grant.tokenVersionAtIssue`; otherwise revoke the grant (`revokedReason: "token_version"` or `"user_inactive"`) and refuse;
  3. if `requestId === lastRequestId` and `lastRequestAt` within 120 s → return the decrypted `lastResultEnc` unchanged;
  4. if `sha256(value) === valueHash` → rotate: new value (32 random bytes, base64url), `generation + 1`, store hash, store the encrypted result and `requestId`, extend idle expiry, return;
  5. otherwise (an older value with a new `requestId`) → revoke (`"reuse_detected"`), write an `AuditLog` entry (`action: 'Update'`, `entityType: 'OneonGrant'`, `actorType: 'System'`), create a `Notification` for the user and every Admin, refuse.
- Refusals return 401 `{ "error": "Unauthorized" }` (identical); a refusal for reasons 2 or 5 is distinguishable only in the audit log.
- `POST /api/oneon/revoke` body `{ request }` (Oneon-signed, claim `grantId`) → 204; revokes that grant.

- [ ] **Step 1: Write the failing tests**
  - `exchanges a hand-off for an attended grant and token` → token verifies; `unattended === false`; grant generation 1.
  - `rejects a replayed hand-off` → second exchange 401.
  - `rotates on each exchange` → generation 2, new value differs, old hash gone.
  - `returns the same result for the same requestId within 2 minutes` → identical `grant.value`.
  - `treats an older value with a new requestId as theft` → grant `Revoked` (`reuse_detected`); audit row; notifications for the user and each Admin.
  - `a tokenVersion change revokes the grant` → 401; `revokedReason: "token_version"`.
  - `disable revokes every grant` and `remove revokes every grant`.
  - `an idle-expired grant is refused` (fake clock +31 min).
  - `refuses a request not signed by a registered Oneon key` → 401.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.** Wrap rules 3–5 in one `$transaction` with `SELECT … FOR UPDATE` on the grant row (`$queryRaw`), so concurrent exchanges serialize.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): add grant exchange with rotation and reuse detection`.

### Task 10 (ImpressoRx): delegated-token authentication and `GET /api/oneon/me`

**Files:**
- Create: `src/lib/oneon/agentContext.ts`, `src/app/api/oneon/me/route.ts`
- Modify: `src/server/trpc/trpc.ts` (`TRPCContext.agent`, `enforceAuth`, `requirePermission`), `src/app/api/trpc/[trpc]/route.ts` (read `Authorization: Bearer`)
- Test: `src/lib/oneon/agentContext.test.ts`, `src/server/trpc/trpc.test.ts` (extend), `src/app/api/oneon/me/route.test.ts`

**Interfaces:**
- `type AgentPrincipal = { userId: string; tokenVersion: number; grantId: string; unattended: boolean; scope: Permission[]; oneonActionId: string | null }`.
- `verifyAccessToken(token: string): Promise<AgentPrincipal | null>` (deployment key, `iss` = `aud` = own issuer, ttl ≤ 300).
- `agentAudit: AsyncLocalStorage<{ oneonActionId: string | null; unattended: boolean }>` and `currentAgentAudit(): { oneonActionId; unattended } | undefined`.
- `enforceAuth` with `ctx.agent`: loads the user; refuses (`UNAUTHORIZED`) unless active, `tokenVersion === agent.tokenVersion`, `OneonClient.status === 'Active'`, tenant serviceable; builds `session.user` from the real user (id, name, role); runs `next()` inside `agentAudit.run(...)`. An agent and a user session never coexist: a request with both is refused.
- `requirePermission`: with `ctx.agent`, the permission must be held by the role **and** be in `agent.scope`.
- `GET /api/oneon/me` (Bearer access token): `{ userId, name, role, permissions, locationIds, tokenVersion, tenantStatus, oneonStatus }`. `locationIds` = locations where `assignedUserId` is the user, plus `defaultLocationId`.

- [ ] **Step 1: Write the failing tests**
  - `accepts a valid access token as that staff member` → `ctx.session.user.id === staffId`.
  - Refuses each: expired token; token signed by another key; user deactivated; `tokenVersion` bumped; client `Disabled`; tenant suspended; a request carrying both a user session and a token.
  - `scope narrows the role` → an Admin token whose `scope` lacks `products.update` is `FORBIDDEN` on a procedure requiring it.
  - `me returns the role's permissions and assigned locations`.
  - `an Oneon-signed request JWS presented as a Bearer token is refused` (I5: the service key is never staff authority).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): authenticate delegated tokens as the staff member`.

### Task 11 (ImpressoRx): hand-off minting and Ask Oneon

**Files:**
- Modify: `src/server/trpc/routers/oneon.ts` (`launch`)
- Create: `src/components/oneon/AskOneonButton.tsx`; Modify: the dashboard top bar to render it
- Test: `src/server/trpc/routers/oneon.test.ts` (extend)

**Interfaces:**
- `oneon.launch` mutation (`permissionProcedure(P.ONEON_USE)`): refuses `PRECONDITION_FAILED` unless the client is `Active`; returns `{ action: \`${oneonOrigin}/auth/impressorx\`, handoff }`, where `handoff` is a JWS signed by the deployment key, `iss: "impressorx:<slug>"`, `aud: "oneon"`, ttl 60, claims `sub` (user id), `tenantSlug`, `tv`, `role`.
- `AskOneonButton` calls `launch`, then submits a hidden `<form method="post" action={action}>` with one field `handoff`. It is rendered only when `oneon.status` reports `Active` and the user has `oneon.use`.

- [ ] **Step 1: Write the failing tests**
  - `launch returns a 60-second hand-off for the caller` → claims `sub === caller`, `exp − iat === 60`.
  - `launch is refused while Oneon is disabled` → `PRECONDITION_FAILED`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): add Ask Oneon with a signed hand-off`.

### Task 12 (Oneon): the ImpressoRx client and grant store

**Files:**
- Create: `packages/infrastructure/src/database/control/grant-store.ts`
- Create: `packages/infrastructure/src/impressorx/client.ts`
- Modify: `packages/infrastructure/src/impressorx/fake-impressorx.ts` (token, me, revoke, per ImpressoRx Tasks 9–10)
- Modify: `packages/agent-server/src/architecture.test.ts`; logger redaction in `packages/infrastructure/src/logger*`
- Test: `packages/infrastructure/src/impressorx/client.test.ts`

**Interfaces:**
- `GrantStore` (control DB, `delegation_grants`): `insert(g: { id; identityId; membershipId; tenantRegistrationId; kind: "attended" | "action" | "schedule"; scope; value; generation; sessionId?: string; actionId?: string; idleExpiresAt; absoluteExpiresAt })` (seals `value` with `ONEON_GRANT_MASTER_KEY`); `beginExchange(id): { value; generation; requestId }` (inside `BEGIN IMMEDIATE`; reuses a stored `pending_request_id` if present, else creates and stores one); `completeExchange(id, requestId, newValue, generation)` (clears `pending_request_id`); `revoke(id, reason)`; `listForIdentity(identityId)`; `findAttendedForSession(sessionId)`.
- `ImpressoRxClient` (constructed with the registration repository, the grant store, the signing-key master key, `fetch`):
  - `exchangeHandoff(registrationId: string, handoff: string, sessionId: string, identityId: string, membershipId: string): Promise<{ grantId: string; snapshot: MembershipSnapshot }>`;
  - `forSession(sessionId: string): SessionCalls | null` (attended; only request handlers hold a session id);
  - `forGrant(grantId: string): GrantCalls` (unattended; Phase 5);
  - `SessionCalls` / `GrantCalls`: `accessToken(opts?: { oneonActionId?: string }): Promise<string>`; `me(): Promise<MembershipSnapshot>`; `revoke(): Promise<void>`; `trpc<T>(path: string, input: unknown, type: "query" | "mutation"): Promise<T>`.
  - `SessionCalls.issue(input: { kind: "action" | "schedule"; oneonActionId?: string; scope: string[]; absoluteExpiresAt: string }): Promise<{ grantId: string }>` (ImpressoRx Task 18 contract; stores the issued grant). `GrantStore.findActionGrant(actionId): string | null`.
  - After every exchange, the response's `snapshot` is applied to the membership (`MembershipRepository.applySnapshot`, Task 13), so the snapshot refreshes on every exchange (spec §4.6).
  - Errors: `class ImpressoRxRefusedError` (401 from ImpressoRx) and `class ImpressoRxUnreachableError` (network or 5xx).
  - Access tokens are cached in memory per grant until 30 s before expiry. Exchanges are single-flight per grant: an in-process promise map in front of the database lock.
- `type MembershipSnapshot = { userId: string; role: string; permissions: string[]; locationIds: string[]; tokenVersion: number; tenantStatus: string }`.
- Architecture test I4: only `impressorx/client.ts` imports `grant-store`.

- [ ] **Step 1: Write the failing tests** (against the fake)
  - `exchanges a hand-off and stores the grant sealed` → the raw `delegation_grants.encrypted_value` does not contain the value.
  - `rotates and persists the new value on each exchange`.
  - `retries a crashed exchange with the same requestId and gets the same value` (simulate a throw after the fake responds, before `completeExchange`) → the fake sees one rotation; no theft flag.
  - `ten concurrent accessToken() calls cause one exchange`.
  - `two sessions for the same person hold two grants and never trip theft detection` (Review Focus 3).
  - `maps 401 to ImpressoRxRefusedError and network failure to ImpressoRxUnreachableError`.
  - `never logs grant values or tokens` (capture logger output across the above; assert no value or token string appears) (I6).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): add the ImpressoRx client as the sole grant holder`.

### Task 13 (Oneon): hand-off redemption and sessions

**Files:**
- Create: `packages/agent-server/src/routes/handoff.route.ts`
- Create: `packages/infrastructure/src/database/control/membership-repository.ts`
- Modify: `packages/dashboard/src/lib/auth.ts` (Credentials provider `impressorx`), Create: `packages/dashboard/src/app/auth/impressorx/route.ts` (POST)
- Modify: `packages/agent-server/src/middleware/session-auth.ts` (session carries `identityId`, `sessionId`, `activeContext`)
- Test: `packages/agent-server/src/routes/handoff.route.test.ts`, dashboard auth test

**Interfaces:**
- `POST /api/auth/handoff/redeem` (service-token auth, the dashboard's existing API token): body `{ handoff: string; sessionId: string }`. Steps: read `iss` → `findByIssuer`; verify with that registration's deployment keys, `aud: "oneon"`, ttl ≤ 60, origin pinned via the registration; consume `jti` in `used_handoff_jti`; find or create login identity (`impressorx`, subject `<registrationId>:<sub>`) and its identity; upsert the membership (`external_user_id = sub`, role from claims, status `active`); `ensureIdentityAnchor(tenantDb, identityId)`; `client.exchangeHandoff(...)`; write the snapshot from `/me`. Returns 200 `{ identityId, membershipId }`; any failure 401 `{ error: "handoff_rejected", reason: "expired" | "generic" | "membership_suspended" }`.
- `MembershipRepository`: `upsertFromHandoff`, `applySnapshot(id, snapshot)`, `setStatus(id, status)`, `findById`, `listActiveForIdentity`.
- Dashboard: `/auth/impressorx` accepts POST form field `handoff`, generates `sessionId` (UUID), calls `signIn("impressorx", { handoff, sessionId, redirectTo: "/" })`. The `jwt` callback stores `identityId`, `sessionId`, `activeContext: { kind: "tenant", membershipId }`. A new hand-off sign-in replaces any existing session cookie.
- Messages (spec §6.4), exact: expired → "This link has expired. Go back to ImpressoRx and choose Ask Oneon again."; suspended → "This pharmacy has switched Oneon off, or your account is inactive."; generic → "Oneon couldn't open this link."
- Sign-out calls `client.forSession(sessionId)?.revoke()`.

- [ ] **Step 1: Write the failing tests**
  - `first hand-off creates an identity and membership` → one identity, one membership, a `users` anchor row in the tenant file.
  - `a second hand-off for the same staff user reuses them`, and `after an email change in ImpressoRx, the same identity is used` (Review Focus 1).
  - `a replayed hand-off is rejected as expired`; `a wrong audience`, `an unknown issuer` and `a suspended registration` → `generic`, identical responses.
  - `a hand-off while another identity is signed in replaces the session and links nothing` (Review Focus 2) → `identity_link_events` empty.
  - `sign-out revokes the attended grant` → the fake records a revoke.
  - `/auth/impressorx rejects GET with 405`; `dashboard responses carry Content-Security-Policy frame-ancestors 'none'`; `the session cookie is HttpOnly, Secure and SameSite=Lax` (spec §6.5).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Build, typecheck, full suite, commit** `feat(identity): sign staff in through the ImpressoRx hand-off`.
