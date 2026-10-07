# Phase 1: ImpressoRx enrolment (ImpressoRx repo)

Spec §5, §12. Branch `feat/oneon-delegation`.

### Task 1: Permissions and the `OneonClient` model

**Files:**
- Modify: `src/lib/permissions.ts` (P constants, `ROLE_PERMISSIONS`)
- Modify: `prisma/schema.prisma`; Create: `prisma/migrations/20261008000000_oneon_client/migration.sql`
- Modify: `src/lib/data-classes.ts`
- Test: `src/lib/permissions.test.ts`, `src/lib/data-classes.test.ts` (existing gate)

**Interfaces:**
- Produces: `P.SETTINGS_ONEON = 'settings.oneon'` (Admin only); `P.ONEON_USE = 'oneon.use'` (all six roles).
- Produces Prisma models:
  - `OneonClient { id, status OneonClientStatus @default(Pending), enrolCodeHash String?, enrolCodeExpiresAt DateTime?, oneonIssuer String?, oneonOrigin String?, unattendedAllowed Boolean @default(false), enabledById String?, createdAt, updatedAt, tenantId }`
  - `OneonPublicKey { id, clientId, keyId @unique, publicKey, addedAt, retiredAt DateTime?, tenantId }` (Oneon's keys)
  - `OneonDeploymentKey { id, clientId, keyId @unique, publicKey, privateKeyEnc, addedAt, retiredAt DateTime?, tenantId }` (this deployment's keys; the newest unretired one signs)
  - `OneonUsedJti { jti @id, expiresAt, tenantId }`
  - `enum OneonClientStatus { Pending Active Disabled Removed }`
- Data classes: `publicKey` columns, `privateKeyEnc` and `enrolCodeHash` D4; `enabledById` STAFF; everything else D1.

- [ ] **Step 1: Write the failing tests**
  - `permissions.test.ts › grants settings.oneon to Admin only`: `hasPermission('Admin', P.SETTINGS_ONEON)` true; false for the other five roles.
  - `permissions.test.ts › grants oneon.use to every role`: true for all six.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm vitest run src/lib/permissions.test.ts`. Expected: FAIL (`P.SETTINGS_ONEON` undefined).
- [ ] **Step 3: Add the constants, the role grants, the models and migration (`pnpm prisma migrate dev --name oneon_client`), and the data-class entries.**
- [ ] **Step 4: Run `pnpm test`.** Expected: PASS, including the data-class gate (a missing entry fails as `OneonClient.<column>: no class`).
- [ ] **Step 5: Lint, type-check, commit** `feat(oneon): add Oneon permissions and the OneonClient model`.

### Task 2: JWS and key crypto

**Files:**
- Create: `src/lib/oneon/jws.ts`, `src/lib/oneon/keys.ts`
- Modify: `src/lib/env.ts` (`ONEON_KEY_ENCRYPTION_KEY`, optional, base64 of 32 bytes when set)
- Modify: `package.json` (add `jose` as a direct dependency)
- Test: `src/lib/oneon/jws.test.ts`, `src/lib/oneon/keys.test.ts`

**Interfaces:**
- Produces in `keys.ts`:
  - `generateSigningKeyPair(): Promise<{ keyId: string; publicKeyJwk: string; privateKeyJwk: string }>` (Ed25519; `keyId` a UUID);
  - `encryptPrivateKey(jwk: string): string` / `decryptPrivateKey(enc: string): string` (AES-256-GCM under `ONEON_KEY_ENCRYPTION_KEY`; output `v1.<iv>.<tag>.<ciphertext>` base64url).
- Produces in `jws.ts`:
  - `signJws(claims: Record<string, unknown>, opts: { privateKeyJwk: string; keyId: string; issuer: string; audience: string; ttlSeconds: number }): Promise<string>` (adds `iat`, `exp`, `jti`);
  - `verifyJws(token: string, opts: { keys: Array<{ keyId: string; publicKeyJwk: string }>; issuer: string; audience: string; maxTtlSeconds: number; consumeJti?: PrismaClient; now?: () => Date }): Promise<{ ok: true; claims: JwsClaims } | { ok: false; reason: 'signature' | 'expired' | 'claims' | 'replayed' }>`. When `consumeJti` is given, the `jti` is inserted into `OneonUsedJti` (unique) and a duplicate returns `'replayed'`;
  - `type JwsClaims = { iss: string; aud: string; iat: number; exp: number; jti: string } & Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**
  - `round-trips a signed message` → `verifyJws` returns `ok: true` with the same custom claim.
  - `rejects a wrong key` → `reason: 'signature'`.
  - `rejects an expired message beyond 30 s leeway` (fake clock 31 s past `exp`) → `'expired'`; `accepts within leeway` (29 s) → `ok: true`.
  - `rejects a ttl above maxTtlSeconds` → `'claims'`; `rejects a wrong audience` → `'claims'`.
  - `rejects a reused jti when consumeJti` → second call `'replayed'`.
  - `keys.test.ts › encrypts and decrypts a private key`; `refuses when ONEON_KEY_ENCRYPTION_KEY is unset` (throws).
- [ ] **Step 2: Run and confirm they fail** (`pnpm vitest run src/lib/oneon`). Expected: module not found.
- [ ] **Step 3: Implement with `jose` (`SignJWT`, `jwtVerify`, `importJWK`, `generateKeyPair('EdDSA')`) and Node `crypto`.**
- [ ] **Step 4: Run and confirm they pass.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): add signed-message and key-encryption helpers`.

### Task 3: Settings → Oneon (enable, code, disable, remove)

**Files:**
- Create: `src/lib/oneon/client.ts`, `src/server/trpc/routers/oneon.ts`, `src/app/(dashboard)/settings/oneon/page.tsx`
- Modify: `src/server/trpc/routers/index.ts` (mount `oneon`), `src/app/(dashboard)/settings/page.tsx` (link)
- Test: `src/lib/oneon/client.test.ts`, `src/server/trpc/routers/oneon.test.ts`

**Interfaces:**
- Produces in `client.ts`:
  - `enableOneon(db, actorUserId): Promise<{ status: 'Pending'; code: string; expiresAt: Date } | { status: 'Active' }>`:
    - first enable, or after Remove: creates or reuses the single `OneonClient`, sets `Pending`, stores `sha256(code)` with expiry now + 10 min, and returns the code. The code is 16 random bytes in base32 without padding, grouped `XXXX-XXXX-…`;
    - after Disable, with keys still present: sets `Active` and returns `{ status: 'Active' }` (spec §5.5: re-enabling restores the connection; grants must be issued again).
  - `disableOneon(db, actorUserId)`: sets status `Disabled`. Task 9 extends it to revoke every grant.
  - `removeOneon(db, actorUserId)`: status `Removed`; deletes `OneonPublicKey` rows and deployment keys.
  - `getOneonStatus(db): Promise<{ status: OneonClientStatus; unattendedAllowed: boolean; enrolledAt: Date | null }>`.
- Every function writes an `AuditLog` entry via `createAuditLog` (`entityType: 'OneonClient'`).
- Router `oneon`: `status` (query), `enable`, `disable`, `remove` (mutations), each `permissionProcedure(P.SETTINGS_ONEON)`.

- [ ] **Step 1: Write the failing tests**
  - `enable returns a 10-minute code and stores only its hash` → stored `enrolCodeHash !== code`, `enrolCodeExpiresAt` = now + 600 s.
  - `re-enabling after disable restores Active without a code` (client with keys, status `Disabled`) → `{ status: 'Active' }`.
  - `disable sets Disabled and writes an audit entry`; `remove deletes keys`.
  - Router: `non-admin is refused` (`FORBIDDEN` for `SalesManager`).
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement the service, router and page.** The page shows status, Enable (code displayed once with its expiry), Disable, Remove (with a confirm dialog naming that reconnecting needs re-enrolment).
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): add Settings → Oneon with enable, disable and remove`.

### Task 4: `POST /api/oneon/enrol`

**Files:**
- Create: `src/app/api/oneon/enrol/route.ts`
- Modify: `src/lib/oneon/client.ts` (`completeEnrolment`)
- Test: `src/app/api/oneon/enrol/route.test.ts`

**Interfaces:**
- Request body: `{ request: string }`, a JWS signed by Oneon's new private key with `iss: "oneon"`, `aud: "impressorx:<slug>"`, claims `code`, `oneonPublicKeyJwk`, `oneonKeyId`, `oneonOrigin` (https URL), `nonce`.
- The signature is verified against the `oneonPublicKeyJwk` inside the payload (proof of possession), after decoding the payload unverified only to read that key.
- `completeEnrolment(db, input): Promise<{ ok: true; tenantSlug: string; deploymentKeyId: string; deploymentPublicKeyJwk: string } | { ok: false }>`: checks `sha256(code)` equals the stored hash, not expired, status `Pending`; generates the first `OneonDeploymentKey`; stores Oneon's key (`OneonPublicKey`), `oneonIssuer`, `oneonOrigin`; clears the code hash; sets `Active`; audit entry.
- Response 200: `{ response: string }`, a JWS signed by the deployment key, `iss: "impressorx:<slug>"`, `aud: "oneon"`, claims `nonce`, `tenantSlug`, `deploymentKeyId`, `deploymentPublicKeyJwk`.
- Every failure: 401 with body `{ "error": "Unauthorized" }`, identical. Rate limit: existing `rateLimit` helper, 10 requests per minute per IP.
- **Key rotation (spec §5.4), in the same task:**
  - `POST /api/oneon/keys` (Create `src/app/api/oneon/keys/route.ts`): body `{ request }` signed by a current, unretired Oneon key, with claims `newKeyId` and `newPublicKeyJwk`. It adds the key and sets `retiredAt = now + 7 days` on every other Oneon key. Response 204.
  - `GET /api/oneon/keys`: returns `{ response }`, a JWS signed by the current deployment key, listing unretired deployment keys `[{ keyId, publicKeyJwk, retiresAt }]`.
  - Router `oneon.rotateDeploymentKey` (Admin): adds a new deployment key and sets `retiredAt = now + 7 days` on the previous one. The newest unretired key signs from then on.
  - Verification on this side accepts any key whose `retiredAt` is null or in the future.

- [ ] **Step 1: Write the failing tests**
  - `enrols with a valid code and returns a signed reply` → 200; reply verifies with the returned key; `OneonClient.status === 'Active'`.
  - `refuses a wrong code`, `an expired code`, `a reused code`, `a signature that does not match the embedded key`, `a non-https oneonOrigin` → each 401 with identical body.
  - `rate-limits the eleventh request in a minute` → 429.
  - `adds a new Oneon key signed by the current one and retires the old after 7 days` → old key verifies at day 6, not at day 8.
  - `refuses a key addition signed by a retired key` → 401.
  - `rotating the deployment key signs new messages with the new key while the old still verifies for 7 days`.
- [ ] **Step 2: Run, confirm FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Lint, type-check, full suite, commit** `feat(oneon): add two-sided enrolment and key rotation`.
