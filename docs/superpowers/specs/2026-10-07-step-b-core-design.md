# Step B-core: Identity, Membership and Tenant Context — Design

**Status:** Draft for review
**Date:** 2026-10-07
**Decided with:** Gerry, in a design session on 2026-10-07 (questions Q1–Q9, sections 1–8 approved)
**Builds on:** Action Spec framework (ADR-011), AI Data Boundary (ADR-012, spec 2026-10-03), Roadmap v1.2 with errata (`docs/superpowers/roadmap/2026-10-07-oneon-roadmap-v1.2.md`)
**Repos:** Oneon (`camp-aneone`) and ImpressoRx
**Comes before:** B-channels, B-retention, boundary phase 2 (read tools), Step C

---

## 1. Purpose

Oneon must act inside ImpressoRx businesses as a specific staff member, never as itself and never across businesses. B-core builds the security core for that:

- who the person is (identity);
- which business they are acting in (membership and active context);
- what they may do (delegated access, re-checked by ImpressoRx);
- where Oneon keeps each business's records (physical isolation).

**Success** means:

1. A staff member opens Oneon from ImpressoRx and lands in that pharmacy's context.
2. Oneon reads and acts only as that person, and ImpressoRx re-authorizes every call.
3. A role change, deactivation, tenant suspension or Oneon switch-off takes effect at ImpressoRx immediately, and in Oneon within one exchange or 5 minutes.
4. Personal use of Oneon behaves exactly as today.
5. No tenant's records can reach another tenant or anyone's personal context.

## 2. Decisions this spec records (2026-10-07)

| # | Decision |
|---|---|
| Q1 | Step B is split into **B-core** (this spec), **B-channels** (channel-identity slot as a contract, adapter interface) and **B-retention** (schedule per data class, redaction of `action_events`, identity-mapping erasure; needs counsel). |
| Q2 | Doors: **(c), sequenced (a) → (b).** B-core builds the launch hand-off. An embedded ImpressoRx panel comes later as another door onto the same core. |
| Q3 | **Create on first launch, link deliberately.** The first verified hand-off creates an identity and a membership keyed by tenant plus ImpressoRx user id. Linking identities is explicit, proven by both logins in one session, never by email. |
| Q4 | **Revocable, staff-bound grants**, under Gerry's conditions (§7). |
| Q5 | **A database file per tenant plus a control database**, under Gerry's conditions (§8). |
| Q6 | **Two-sided enrolment** with key pairs in both directions, off the vendor channel (§5). The tenant credential never substitutes for staff authorization. |
| Q7 | **Tenant AI limit in Oneon's control database**, changed only after a fresh ImpressoRx check (§9.4). |
| Q8 | **`actorType: Agent`** in ImpressoRx's audit, with first-class `oneonActionId` and `unattended` columns, set only from the delegated-token context (§10). |
| Q9 | **Link ids:** `model_call_decisions.conversation_id` and `.turn_id`; `action_instances.model_call_id` (§11). |

Earlier decisions this spec relies on (2026-10-03): one human → one identity → many memberships; email is a login attribute; membership permissions in Oneon are a cache for offering and early refusal; ImpressoRx re-authorizes every call; snapshot at most 5 minutes old; locations are context only; one role per membership; the tenant admin enables Oneon; Oneon never uses the vendor channel.

## 3. Trust model

Three relationships, each with its own credentials. None substitutes for another.

| Relationship | Proves | Credential |
|---|---|---|
| Vendor channel (unchanged) | ImpressoRx ↔ its vendor | `VENDOR_SHARED_SECRET`. Oneon never holds or uses it. |
| Tenant trust | "This is tenant T's real deployment" and "this is the real Oneon" | An Ed25519 key pair on each side, exchanged at enrolment (§5) |
| Staff delegation | "Oneon may act for staff user U in tenant T" | An attended grant (§6) or an unattended grant (§7), always exchanged for a short-lived access token that ImpressoRx re-checks |

The chain of trust is: tenant trust → deployment identity → staff identity → membership → delegated grant → access token.

### 3.1 Invariants and their mechanisms

| # | Invariant | Mechanism |
|---|---|---|
| I1 | `tenantId` never comes from request input, in either system. | ImpressoRx: existing rule (ADR-001 §3.5) and tRPC context. Oneon: the active context comes from the session, and an architecture test fails if a route handler reads a tenant id from `req.body`, `req.query` or `req.params`. |
| I2 | Only the gate turns a context into a database handle. | `ContextDbGate` is the only module that constructs a SQLite `Database` for a context file. Architecture test. |
| I3 | Repositories accept only typed handles. | Repository constructors take `ContextDb` (`PersonalDb` or `TenantDb`), never a path or raw connection. Branded types plus an architecture test, the same pattern as `ApprovedModelCall`. |
| I4 | Only the ImpressoRx client holds or exchanges grants. | The grant store is imported only by `impressorx-client`. Architecture test. |
| I5 | The tenant key never stands in for staff authorization. | ImpressoRx's token endpoint issues tokens only for a valid grant naming a staff user. No endpoint accepts Oneon's service signature alone as authority for a business call. Route test. |
| I6 | No grant value, access token or enrolment code is logged. | Logger redaction of the named fields plus a test that exercises each flow and scans the captured log output. |
| I7 | Every Oneon write in ImpressoRx belongs to an Oneon action and is attributed `Agent`. | Database `CHECK` on `AuditLog` (§10) plus the audit layer deriving the actor from the token context. |
| I8 | Rows in a tenant file belong to that tenant. | `tenant_id` on content rows, asserted on every read (§8.4). |

## 4. Identity, membership and active context (Oneon)

### 4.1 Control-database tables

- **`identities`**: `id`, `status` (`active` or `disabled`), `created_at`. Every existing `users.id` becomes an identity with the **same id**, so the personal database's 19 foreign keys to `users(id)` remain valid. The personal database keeps its `users` table as their local anchor.
- **`login_identities`**: `id`, `identity_id`, `kind` (`google` or `impressorx`), `subject`, `email` (attribute only), `created_at`. Unique on (`kind`, `subject`). The Google subject is Google's `sub`. The ImpressoRx subject is `<tenant_registration_id>:<impressorx_user_id>`.
- **`memberships`**: `id`, `identity_id`, `tenant_registration_id`, `external_user_id`, `role`, `permissions_json`, `location_ids_json`, `status` (`active`, `suspended` or `revoked`), `snapshot_at`, `created_at`. Unique on (`tenant_registration_id`, `external_user_id`).
- **`platform_operators`**: append-only grant and removal rows. An operator may run enrolment and read rollups. Nothing in this role opens a tenant file.
- **`channel_identities`**: `id`, `channel`, `scoped_subject`, `scope_key`, `identity_id` (nullable), `status` (`candidate` or `verified`). Reserved for B-channels. No B-core code writes to it.
- **`identity_link_events`**: append-only record of every link and unlink.

### 4.2 Migration of today's users

Today the session carries only an email. On each existing user's first Google sign-in after the upgrade, Oneon attaches their Google `sub` to the login identity matched by email. This is a one-time step for the users already on `ALLOWED_EMAILS`. After it, no identity is ever found by email. The dashboard's NextAuth `jwt` callback adds `sub` to the token.

### 4.3 Sessions

- **Google sign-in** works as today, with the active context starting as personal.
- **ImpressoRx hand-off** is a second NextAuth credentials provider whose credential is the hand-off grant (§6).
- A session carries an **identity id**, not an email. `session-auth` resolves the identity by id. `ALLOWED_EMAILS` continues to gate Google sign-in only.

### 4.4 Active context

- A session has exactly one active context: personal, or one membership.
- A conversation belongs to the context it was started in and lives in that context's database. Switching context switches the conversation list.
- Personal context is available only to identities that have a Google login identity. A tenant-only identity sees only its memberships.
- The context picker lists only `active` memberships.

### 4.5 Linking

Linking is done while signed in: from a hand-off session, "Link your personal Oneon account" runs Google sign-in in the same browser session, or the reverse. Both logins are proven in one session. If both logins already belong to different identities, the link merges the ImpressoRx login identity and its memberships into the identity that holds the Google login. Unlinking is allowed. Both are recorded in `identity_link_events`.

### 4.6 Membership snapshot

- Refreshed from ImpressoRx's `GET /api/oneon/me` at hand-off, on every token exchange (the response carries role and permissions), and at least every 5 minutes while a session is active.
- Used only to offer actions and refuse early (§9.2).
- If ImpressoRx reports the user inactive, Oneon disabled or the tenant not serviceable, the membership becomes `suspended`, the context becomes unavailable, and the membership's grants are treated as dead (§7.7).

### 4.7 Test fixture

Gerry: one identity with a Google login; membership in tenant A with role `Admin`; membership in tenant B with role `WarehouseStaff`; a `platform_operators` row.

## 5. Two-sided enrolment

### 5.1 ImpressoRx

- **Settings → Oneon**, for users with a new permission `settings.oneon` (Admin only).
- **Enable** generates an enrolment code: 128 random bits, shown once, stored only as a hash, single-use, expiring after 10 minutes. It is audit-logged as a `User` action.
- A new **`OneonClient`** model holds Oneon's public keys (key id, key, added, retired), the deployment's signing key pair (Ed25519; private key encrypted with `ONEON_KEY_ENCRYPTION_KEY`), the unattended-access switch, and `status` (`pending`, `active`, `disabled`, `removed`).
- `POST /api/oneon/enrol` accepts a JWS signed with Oneon's new private key, carrying the code, Oneon's public key and key id, and a nonce. It checks the code hash, expiry and single use, and the signature. It stores Oneon's key and replies with the tenant slug, the deployment's public key and key id, signed over the nonce.
- Every failure returns an identical 401. The endpoint is rate-limited with the existing `rateLimit` helper.

### 5.2 Oneon

- The **enrolment console** is for platform operators. The operator enters the deployment's HTTPS origin and the code, after checking the origin against the tenant registry out of band.
- Oneon generates an Ed25519 key pair for that tenant. The private key is encrypted under the managed master key.
- Oneon calls `POST /api/oneon/enrol`, verifies the signed reply, and records a **tenant registration** in the control database: `id`, `tenant_slug`, `display_name`, `origin` (pinned), deployment public keys, Oneon key id, `status` (`active`, `suspended_by_operator`, `disabled_by_tenant`, `removed`), `enrolled_by`, `enrolled_at`. It then creates the tenant file through the gate (§8.2).
- Both systems record the enrolment: ImpressoRx in `AuditLog`, Oneon in append-only `tenant_registration_events`.

### 5.3 Signed messages

Every signed message between the systems is a compact JWS using EdDSA. It carries `iss`, `aud`, `kid`, `iat`, `exp` (at most 5 minutes after `iat`) and `jti`. The receiver rejects a reused `jti` within the expiry window. Both repos use `jose`.

### 5.4 Key rotation

Either side adds a new key through a request signed with its current key. Both keys are accepted during an overlap window of 7 days, then the old key is retired. A compromised key is handled by **Remove** followed by re-enrolment.

### 5.5 Switching Oneon off

| Action | Who | Effect |
|---|---|---|
| **Disable** (kill switch) | Tenant admin, in ImpressoRx | Immediate in ImpressoRx: every grant is revoked, the token endpoint refuses, and in-flight delegated tokens are rejected on their next request. Oneon learns at its next exchange or snapshot and suspends the memberships. Re-enabling restores the connection; grants must be issued again. |
| **Remove** | Tenant admin, in ImpressoRx | As Disable, plus Oneon's keys are deleted. Reconnecting needs full two-sided re-enrolment. |
| **Suspend** | Oneon platform operator | Oneon stops serving that tenant. ImpressoRx is unchanged. |

Correctness never depends on Oneon hearing about a Disable or Remove, because ImpressoRx refuses at the source.

### 5.6 What enrolment proves

Oneon learns the deployment's key during enrolment itself. Its trust rests on the operator's check of the HTTPS origin and on the one-time code that only that deployment's admin could produce.

## 6. Hand-off and attended access

### 6.1 Launch

1. Staff with a new permission `oneon.use` see **Ask Oneon** while the deployment's `OneonClient` is `active`. `oneon.use` is granted to all six roles by default, because ImpressoRx permissions are static code (`src/lib/permissions.ts`).
2. ImpressoRx's server mints a **hand-off grant**: a JWS signed with the deployment key, carrying `iss`, `aud` (Oneon), `sub` (the ImpressoRx user id), the tenant slug, `tokenVersion`, role, `jti`, and `exp` 60 seconds after issue.
3. The browser POSTs it to Oneon through an auto-submitting form. It never appears in a URL.
4. Oneon's NextAuth credentials provider sends it to the agent-server, which checks: the signature against the registration's deployment keys (looked up by `iss` and `kid`); the pinned origin; `aud`; `exp`; that the registration is `active`; and that the `jti` is new, by inserting it into `used_handoff_jti` (unique). It then finds or creates the login identity, identity and membership (§4), and opens a session whose active context is that membership.
5. Oneon exchanges the hand-off grant for an attended grant (§6.2) and immediately calls `GET /api/oneon/me`, so the snapshot comes from a live call.

### 6.2 Attended grant

- Created at hand-off and bound to the Oneon session.
- Absolute expiry 12 hours, idle expiry 30 minutes. Revoked at ImpressoRx on Oneon sign-out.
- Stored, encrypted and rotated exactly as unattended grants (§7.3, §7.4), with `kind = attended`.
- Only request handlers can use it: the ImpressoRx client resolves an attended grant only from the current request's session. Background jobs cannot reach it.

### 6.3 Interactive calls

- Oneon exchanges the attended grant for an access token valid for 5 minutes, cached in memory and fetched by one exchange at a time per grant.
- ImpressoRx's delegated-token middleware checks on every request: its own signature on the token; `OneonClient.status = active`; user active; `tokenVersion` matches; tenant serviceable. It builds the actor: that staff user, `agent = true`, `unattended = false`, plus `oneonActionId` when the token carries one.

### 6.4 Failure states

| Situation | Response |
|---|---|
| Expired or replayed hand-off | "This link has expired. Go back to ImpressoRx and choose Ask Oneon again." |
| Unknown or disabled registration, bad signature, wrong origin or audience | One generic refusal that does not reveal which tenants exist |
| Membership suspended | "This pharmacy has switched Oneon off, or your account is inactive." No context opens. |

### 6.5 Browser safeguards

The hand-off endpoint accepts POST only. Session cookies are `SameSite=Lax`, `Secure` and `HttpOnly`. `frame-ancestors 'none'` remains until the embedded panel is designed.

## 7. Unattended grants

### 7.1 When one is created

Only inside a live attended session, in two cases:

- **Action-bound:** when a person approves a tenant action. Scope: that action instance and its type. It dies when the action reaches a final status, or when the approval passes its maximum age (§7.6), whichever is first.
- **Schedule-bound:** when a person sets up a scheduled run (Step C). Scope: that schedule's capability and declared action types. Absolute expiry 60 days, idle expiry 14 days. A live session renews it.

### 7.2 Scope

At exchange, ImpressoRx grants the lower of the grant's scope and the person's current role permissions. Unattended tokens carry `unattended = true`, and ImpressoRx refuses these to them whatever the role: user management (`users.*`), settings (`settings.*`, including `settings.oneon`), role changes, support sessions, and deletion approvals (`audit.approve_deletion`).

### 7.3 Storage

- **Oneon:** `delegation_grants` in the control database: `id`, `identity_id`, `membership_id`, `tenant_registration_id`, `kind` (`attended`, `action`, `schedule`), `scope_json`, `encrypted_value`, `wrapped_key`, `generation`, `status` (`active`, `revoked`, `expired`), `revoked_reason`, `created_at`, `last_used_at`, `idle_expires_at`, `absolute_expires_at`. Each value is encrypted (AES-256-GCM) with its own data key, wrapped by `ONEON_GRANT_MASTER_KEY` from the secret manager.
- **ImpressoRx:** a new `OneonGrant` model with a hash of the current value, `generation`, `status`, scope, kind, expiries, user id, and the last `request_id` with its result.

### 7.4 Exchange: `POST /api/oneon/token`

- The body is a JWS signed with Oneon's tenant key (Oneon's service authentication), carrying the grant value, a `request_id`, the requested scope, and the Oneon action id where there is one.
- ImpressoRx checks: Oneon's signature; the hash matches the current generation; user active and `tokenVersion` matches; tenant serviceable; `OneonClient.status = active`; unattended access allowed (for `action` and `schedule` grants).
- It rotates the grant and returns a 5-minute access token plus the new value. The token binds the user, `unattended`, the effective scope, and `oneonActionId` (from the grant's scope for an action-bound grant, otherwise from the signed request).
- **Idempotency:** the same `request_id` within 2 minutes returns the same result, so a crash before Oneon saves the new value is safe.
- **Theft detection:** an older value presented with a new `request_id` revokes the grant, writes an audit entry, and alerts the person and the tenant admin.
- Oneon serializes exchanges per grant with a row lock in the control database.

### 7.5 Visibility

- **Oneon → Settings → Connections:** each person sees their own grants (kind, scope, created, last used, expiry) and can revoke any of them. Oneon forwards the revocation to ImpressoRx.
- **ImpressoRx → Settings → Oneon:** the tenant admin sees every grant in the pharmacy, the **Allow unattended access** switch, and Disable and Remove.

### 7.6 Approval age limit

A new Action Spec policy field `maxApprovalAgeHours`, with a floor of 24 hours for tenant actions. At the execution re-check Step A already runs (`advance.ts`), an approval older than the limit fails the action with code `approval_stale` inside the existing `failed` status. No status is added.

### 7.7 Needs reconnect

When a grant dies, whether by role change (`tokenVersion`), deactivation, Disable, Remove, revocation or theft detection, that person's pending executions fail at the re-check with `delegation_revoked`, inside `failed`. They can be retried through the existing retry operation after the person reconnects. Schedules (Step C) gain a `paused_needs_reconnect` state. The person and the tenant admin see a "needs reconnect" notice. Nothing is reassigned to another person.

## 8. Storage: control database and tenant files

### 8.1 Host

Oneon runs as one long-running Express process with better-sqlite3 on a Hetzner VPS under Docker Compose (ADR-008). Data lives on the `db-data` volume at `/app/data`. Every file is tied to that machine. Repository interfaces (§8.3) keep a later move to a networked store, such as Postgres with a schema per tenant, a change below the application layer.

### 8.2 Files and the gate

- `/app/data/oneon.db`: the personal database, unchanged (`DATABASE_PATH`).
- `/app/data/control.db`.
- `/app/data/tenants/<registration-id>.db`: one per enrolled tenant.
- **`ContextDbGate`** is the only module that opens context files:
  - `openPersonal(): PersonalDb`;
  - `openTenant(registrationId): TenantDb`, which reads the filename from the registry, checks it against `^[0-9a-f-]{36}\.db$`, never derives it from request input, and before returning checks that the registration is `active`, that the file's single-row `context_meta` names the same `tenant_id`, and that its schema version is current. Otherwise it refuses with `tenant_unavailable` or `tenant_schema_behind`.
- Open handles sit in a least-recently-used cache capped at 32.

### 8.3 Schema and handles

- Personal and tenant files share one migration chain, plus `context_meta` (`kind`, `tenant_id`, `schema_version`, `created_at`). Tables a tenant does not use stay empty. Today's repositories work unchanged against a `ContextDb`.
- `control.db` has its own migration chain.

### 8.4 `tenant_id` on rows

An additive migration gives every content table a nullable `tenant_id` (null in the personal database). Repositories compare it with the handle's tenant on every read. A mismatch throws `tenant_mismatch` and raises an operator alert.

### 8.5 Ids and cross-file links

Ids remain UUIDs. There are no foreign keys between files. A link from the control database into a tenant file is a plain id plus a tenant registration id, for example a grant's action id. A nightly job verifies these links and reports broken ones.

### 8.6 Migrations

Each file records its schema version (`schema_migrations`, as today). At startup, under a lock file, the runner migrates `control.db`, then `oneon.db`, then each tenant file. A tenant file that fails is refused service; the others are served; the operator is alerted. CI runs every migration against a personal file and three tenant files, one at an old version.

### 8.7 Backups

- With SQLite's online backup API (`db.backup()`), per file, nightly and before each migration. This replaces the manual `cp` in DEPLOY.md, which can copy a file mid-write.
- Encrypted before leaving the VPS. The off-site store is an operator choice (for example Cloudflare R2 or a Hetzner Storage Box).
- A monthly restore test restores one tenant into a temporary folder and checks `context_meta` and `PRAGMA integrity_check`.
- Backups are deleted on the same schedule as their file (B-retention).

### 8.8 Platform-admin counts

Each tenant writes content-free daily rollups to `tenant_rollups` in the control database: model calls, denials, actions by status, grant counts. The admin view reads only these and never opens a tenant file.

### 8.9 Background jobs

The sweeper and scheduler iterate the registry, open one tenant file at a time, use one writer per tenant, and give each tenant a time budget per pass.

### 8.10 Placement

| Item | Lives in |
|---|---|
| Identities, login identities, memberships, operators, registrations, grants, tenant AI limit history, rollups, channel slot, used hand-off `jti`s | `control.db` |
| Conversations, action instances and events, model-call decisions and outcomes | the context database of the conversation or call |
| `ai_data_choices`, personal memory, Gmail, Teams, finance, notifications | `oneon.db` (personal), unchanged |

## 9. Tenant actors, authorization and the gateway

### 9.1 Tenant `ActorContext`

Built from the membership: `userId` = identity id; `scope = "tenant"`; `tenantId` = registration id; `roles = [role]`; `permissions` = snapshot codes namespaced `impressorx:<code>`; `locationIds` = context only. `actorForInstance` stops throwing for tenant scope and rebuilds the actor from the current membership. A `suspended` or `revoked` membership fails the action with `delegation_revoked`.

### 9.2 Where authorization happens

- Oneon's policy check (`decide`, `canAct`, `canApprove`) uses the snapshot to offer and to refuse early. It never authorizes a write.
- Before an executor runs, Oneon exchanges the attended grant (execution within the request) or the action-bound grant (execution later) for a fresh token. That exchange is ImpressoRx's live check (§7.4).
- Every ImpressoRx call is then checked again by ImpressoRx's existing `permissionProcedure`, which keeps per-rep sales confidentiality (SECURITY.md §9.4).
- A refused exchange fails the action with `delegation_revoked`. An unreachable ImpressoRx gives `impressorx_unreachable`, which the sweeper retries until the approval's maximum age.

### 9.3 Approvals

An approver must hold an `active` membership in the tenant with a role in the action's `approverRoles`. Oneon refreshes `GET /api/oneon/me` live at the moment of approval. Whether a person may approve their own proposal is set per action definition in Step C.

### 9.4 Tenant AI limit

- `tenant_ai_limit_versions` in the control database: append-only; the newest row applies; default D1. Each row records the class, who set it, when, a reference to the live check that authorized it, and the prerequisite evidence for a raise.
- The gateway's tenant layer reads the newest row. The effective limit remains the lowest of all layers (boundary spec §6.2).
- A change requires a live `GET /api/oneon/me` call confirming `settings.oneon`. Lowering applies immediately. Raising must stay within each provider's tenant ceiling; a raise to D2 also needs that provider's complete review record (roadmap E2) and a signed DPA recorded in the provider registry. D3 and D4 are never allowed.
- **Proposed, for ruling at spec review:** when ImpressoRx is unreachable, lowering may fall back to the cached snapshot's `settings.oneon`, and the row records that fallback. Raising always requires the live check.

### 9.5 Gateway and tools in tenant context

- `beginTurn({ kind: "tenant", identityId, tenantId, membershipId })` becomes reachable. Model-call audit rows are written to the tenant file.
- The tool registry is filtered by context. Personal tools (Gmail, calendar, finance, personal memory, Teams, GitHub) are never offered in a tenant context.
- B-core adds no tenant read tools. A tenant conversation can converse, show the person's role and permissions, and show pending items. No ImpressoRx business data reaches a model before boundary phase 2.

## 10. ImpressoRx `Agent` audit

- Migration: add `Agent` to `AuditActorType`; add `AuditLog.oneonActionId` (text, nullable) and `AuditLog.unattended` (boolean, nullable). Keep the immutability triggers. The TypeScript `AuditActorType` in `src/lib/auditLog.ts` is updated with it, as the existing diff test requires.
- `CHECK` constraints: an `Agent` row has `userId` and `oneonActionId` not null and `actorLabel = 'Oneon'`; a non-`Agent` row has both new columns null.
- `src/lib/data-classes.ts` classifies `oneonActionId` and `unattended` as D1. The phase 1b gate fails until it does.
- The audit layer sets `actorType = 'Agent'`, `oneonActionId` and `unattended` from the delegated-token context, the same way support sessions are attributed today. No router changes. A test asserts a request body cannot set any of the three.
- A delegated write whose token carries no `oneonActionId` cannot satisfy the constraint, so every Oneon write belongs to an Oneon action (I7).
- ImpressoRx's audit is the authoritative record of the business change. Oneon's `action_events` hold the provenance (proposal, policy, approval, grant, execution). `oneonActionId` joins them.
- The database checks that the fields are present. That `unattended = true` came from an unattended grant is enforced by the delegated-token middleware and the audit layer, and pinned by a test.

## 11. Link ids

- Context-database migration: `model_call_decisions.conversation_id`, `model_call_decisions.turn_id`, `action_instances.model_call_id`, all nullable.
- A turn id is the id of the user message that started the turn (`conversations.id`).
- `beginTurn` gains optional `conversationId` and `turnId`. Chat sets them. Email classification and the daily briefing leave them null.
- The failover correlation id and hop (roadmap §6.5) are not part of B-core.

## 12. ImpressoRx surface added by B-core

| Item | Purpose |
|---|---|
| Permissions `settings.oneon` (Admin), `oneon.use` (all roles) | Who manages Oneon, who may launch it |
| `OneonClient`, `OneonGrant` models | Keys, status, unattended switch; grant hashes |
| `POST /api/oneon/enrol` | Enrolment (§5) |
| Hand-off minting and the Ask Oneon button | Launch (§6.1) |
| `POST /api/oneon/token` | Grant exchange (§7.4) |
| `POST /api/oneon/revoke` | Revocation from Oneon (§7.5) |
| `GET /api/oneon/me` | Snapshot: user, role, permissions, locations, `tokenVersion`, tenant status |
| Delegated-token middleware in the tRPC context | Actor = staff user, agent, unattended flag (§6.3) |
| Unattended refusal list | §7.2 |
| `Agent` audit migration and audit-layer change | §10 |
| Settings → Oneon | Enable, Disable, Remove, enrolment code, grants list, unattended switch |

Every new model is added to `src/lib/data-classes.ts` (phase 1b gate). The vendor API (`/api/vendor/*`) is untouched.

## 13. Testing contract

- **Isolation:** architecture tests for I1–I4 and I6; `tenant_mismatch` tests; a fixture run (§4.7) asserting that conversations, actions and audit rows never cross between A, B and personal, and that personal tools are absent in tenant contexts.
- **Enrolment:** bad, expired and reused codes; wrong signature; wrong origin; identical 401s.
- **Hand-off:** expired, replayed, wrong audience, wrong issuer key, disabled registration.
- **Grants:** rotation; same `request_id` returns the same result; an old value with a new `request_id` revokes and alerts; concurrent exchanges serialize; `tokenVersion` change, Disable and Remove each kill grants; unattended tokens refused on every item of §7.2; effective scope is the lower of grant and role.
- **Execution:** `approval_stale`; `delegation_revoked`; `impressorx_unreachable` retried until the maximum age, then failed.
- **Tenant AI limit:** lowering immediate; raising refused above a ceiling, without a review record, or without a DPA; history append-only.
- **Operations:** migrations across files including one at an old version; backup and restore test; rollups contain no content.
- **ImpressoRx:** `Agent` constraints; request bodies cannot set provenance fields; delegated middleware rejects every failure case of §6.3; the phase 1b gate covers the new models and columns.

## 14. Build order

Each step ends with both repos' suites green. ImpressoRx and Oneon steps alternate where one depends on the other.

1. ImpressoRx: permissions, `OneonClient`, enrolment, signing keys, `GET /api/oneon/me`.
2. Oneon: control database, the gate, typed handles, identity migration. No behaviour change for personal use.
3. Both: hand-off and the attended grant (ImpressoRx token endpoint and middleware; Oneon credentials provider, ImpressoRx client).
4. Oneon: tenant actor, tenant gateway context, tool filtering, context picker.
5. Both: unattended grants, unattended refusal list, approval age limit, needs-reconnect handling, Connections and Settings → Oneon views.
6. ImpressoRx: `Agent` audit.
7. Oneon: tenant AI limit.
8. Oneon: link ids.
9. Oneon: backups, rollups, per-tenant background jobs, link checker.

## 15. Out of scope

The embedded ImpressoRx panel (door b); B-channels; B-retention; ImpressoRx read tools and `resolveEntities` (boundary phase 2); business actions and schedules (Step C); tenant memory; running Oneon as more than one process.

## 16. Accepted limitations

1. Enrolment trusts the deployment key it receives during enrolment. That trust rests on the operator's origin check and the one-time code.
2. All files live on one VPS. Losing the disk means restoring from the nightly backup, losing up to a day of data unless continuous replication is added.
3. The membership snapshot can be up to 5 minutes old. It is used to offer and refuse early, never to authorize.
4. That `unattended = true` came from an unattended grant is enforced in code and tests, not by the database.
5. Tenant files are not encrypted on disk. Anyone with root access to the VPS can read them. The isolation in this spec protects against application faults, not against the host's administrator.
6. Linking merges an ImpressoRx login identity into the Google-holding identity. Splitting a mistaken link is an unlink followed by a fresh hand-off, which creates a new identity; earlier conversations stay with the identity they were created under.
