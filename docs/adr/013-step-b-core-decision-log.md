# ADR-013: Step B-core Decision Log

## Status: Accepted, with open items for the owner

## Date: 2026-10-14

## Context

Step B-core (spec `docs/superpowers/specs/2026-10-07-step-b-core-design.md`) was built by a subagent workflow: a controller dispatches an implementer per task, a reviewer checks the result, and findings go through fix rounds. When a task brief was silent, wrong or in conflict with the code, the workflow was set up to rule and keep going instead of stalling until a person answered. Each ruling was written into a ledger with its "cost if wrong".

The ledger (`.superpowers/sdd/README/progress.md`) is git-ignored, so it is not in the repository. The owner (Gerry) and the CTO reviewer asked for every ruling to be kept in the repo, in the same "cost if wrong" format. This ADR is that record. It adds the basis and assumption behind each ruling where the controller wrote them down, and a status where a later ruling, a reviewer finding or the owner changed it.

Rules for reading it:

- A ruling is a decision the controller made without asking. "Decided by: controller ruling" means exactly that: it was not reviewed by the owner when it was made. The owner's own decisions are marked "owner".
- "Basis" is the reason the ledger or the controller's later notes (`ruling-assumptions-session3.md`) give: a spec section, code that was read, a reviewer finding, or controller judgement. "Assumption: not recorded" means no source states one. Nothing here was reconstructed afterwards.
- "Cost if wrong" is quoted or shortened from the ledger. "None" is the controller's statement, not a verified fact.
- Entries are in ledger order, grouped by task. Task 26 was executed after Task 17, so it appears there. Ids are `B-<task>-<n>`. `pre` is the pre-flight scan, `FR` the final review and its fix wave, `PR` the post-review work after the CTO review.
- Rulings made only on the ImpressoRx side (Tasks 4, 9, 10, 11, 18 and 21) are indexed in the last table of this ADR, with the ImpressoRx decisions recorded in ImpressoRx's `SDA.md` section 19.1. Everything else is a full entry.
- Verification limits that apply to the whole log: the ImpressoRx migrations (Tasks 1, 9, 21) and `pnpm verify:audit` have never run against a database. The SQL and the audit constraints are first checked in ImpressoRx's CI Postgres job. Row-lock ordering (Task 18) was tested with a hook, not against Postgres.

Since the post-review work, `CLAUDE.md` section 5 ("Stop for the Owner") stops any decision on identity, keys, deletion or tenant matching for the owner. It replaces "decide, record a ruling and keep going" for those four areas (ADR-016). Several rulings below fall in those areas (for example B-FR-4, B-24-1, B-26-1). They were made before the rule existed and are recorded as made; the ones the owner has since decided or still has open are marked.

## Decision

Every ruling below is recorded as it was made, with the status it has today. This ADR makes no new decision and changes no code. Where a later ruling, a reviewer finding or the owner changed a ruling, the original entry stays and its status points to the change.

## Pre-flight scan rulings

### B-pre-1 Architecture test allows `database/backup.ts` to open SQLite files
- **Decision:** Task 24 adds `database/backup.ts` to the architecture test's allow-list for constructing `new Database(`, with a comment that it opens only decrypted temp copies.
- **Basis:** Pre-flight conflict between Task 6's architecture test (only the gate and `connection.ts` construct `new Database(`) and Task 24's `restoreTest`, which opens a temp file. Controller judgement: "keeps the restore test possible".
- **Assumption:** Not recorded.
- **Cost if wrong:** One more module may open SQLite files, limited to `backup.ts`.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-pre-2 Snapshot application goes through a callback, not a direct repository call
- **Decision:** Task 12's client takes an `onSnapshot(membershipId, snapshot)` callback dependency. Task 13 creates `MembershipRepository` and wires the callback.
- **Basis:** Ordering conflict: Task 12 applies snapshots through `MembershipRepository.applySnapshot`, which Task 13 creates. Controller judgement: avoids a forward dependency.
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra indirection.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-pre-3 Task 12 builds `issue` against the contract text before ImpressoRx's endpoint exists (cross-cutting)
- **Decision:** Task 12 implements `SessionCalls.issue` against the fake, using Task 18's documented request and response (README file map, phase-5 Task 18 Interfaces), with one test. Task 18 implements the real endpoint to the same contract.
- **Basis:** Task 12 precedes Task 18 in the execution order. Controller judgement.
- **Assumption:** The written contract is accurate enough to build against. Not stated as such in the ledger.
- **Cost if wrong:** Contract drift, caught when Task 19 runs against the fake built from Task 18's text.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-pre-4 `ToolRegistry.execute` takes `kind` as an optional third parameter
- **Decision:** `kind` is optional and defaults to `"personal"`, so existing callers are unchanged.
- **Basis:** Signature change used widely (Task 16). Controller judgement.
- **Assumption:** Not recorded.
- **Cost if wrong:** A tenant caller that forgets `kind` gets personal tools refused only if Task 16's chat wiring passes it. Task 16's test covers tenant chat.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-pre-5 ImpressoRx migrations are written without a database (cross-cutting)
- **Decision:** Implementers write ImpressoRx migrations (Tasks 1, 9, 21) with `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` (or the shadow-free `--from-schema-datamodel` of the previous schema) and never connect to any database. Task 21's local `pnpm verify:audit` step is replaced by the CI e2e job step the task adds.
- **Basis:** The plan says `prisma migrate dev`, but there is no local Postgres (Docker was not running) and `.env` points at localhost. Fact found in the pre-flight scan.
- **Assumption:** CI's Postgres job will run the migrations and `verify:audit`. Not recorded as checked.
- **Cost if wrong:** Migration SQL errors surface in CI instead of locally.
- **Status:** Accepted. Open verification: the migrations and `verify:audit` have never run against a database (see the note under the ImpressoRx index).
- **Decided by:** controller ruling

## Task 5: control database schema

### B-5-1 Keys live in a typed `tenant_keys` table
- **Decision:** Oneon and deployment keys live in a control table `tenant_keys(id, tenant_registration_id FK, owner 'oneon'|'deployment', key_id UNIQUE, public_key_jwk, private_key_wrapped NULL, private_key_ciphertext NULL, created_at, retired_at NULL)`. `tenant_registrations` drops `oneon_key_id` and `deployment_public_keys`.
- **Basis:** Spec section 5.4 (rotation needs several keys per side over time) and Task 8 (needs the sealed Oneon private key). The table was added in Task 5 fix round 1.
- **Assumption:** Not recorded.
- **Cost if wrong:** One more join in Task 8.
- **Status:** Accepted
- **Decided by:** controller ruling. This is a keys decision; it predates the stop rule.

## Task 6: gate and tenant_id

### B-6-1 Migration 016 adds `tenant_id` to three tables, not four
- **Decision:** Migration 016 adds `tenant_id` only to `conversations`, `action_events` and `model_call_outcomes`. `model_call_decisions` already has it from migration 015.
- **Basis:** Plan error found when reading the code.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-6-2 `tenant_id` only on tables that can hold tenant data
- **Decision:** `tenant_id` is added only to tables that can hold tenant data in B-core (conversations, action_instances and events, model_call_decisions and outcomes). Personal-only tables (Gmail, finance, memory, notifications, deadlines and so on) get none.
- **Basis:** Controller judgement. Spec section 8.4 says "every content table", but tenant files never write the personal-only tables.
- **Assumption:** Tenant files never write the personal-only tables. Not recorded as checked beyond that statement.
- **Cost if wrong:** A later feature that stores tenant data in such a table must add `tenant_id` in its own migration.
- **Status:** Accepted in the code. It departs from spec section 8.4 as written: spec amendment awaiting the owner (A1 below).
- **Decided by:** controller ruling

## Task 7: container wiring and identities

### B-7-1 The container opens the personal database through the gate
- **Decision:** The container gets the personal database via `gate.openPersonal()` and passes `rawDb(personal)` to existing repositories (one connection, through the gate). The architecture rule is extended so only `connection.ts`, `context-db-gate.ts` and `control/open-control-db.ts` call `createDatabase`.
- **Basis:** Closes the Task 6 pointer (`createDatabase` was still public and `container.ts` called it directly).
- **Assumption:** Not recorded.
- **Cost if wrong:** Container startup order changes (control DB and gate before repositories).
- **Status:** Accepted
- **Decided by:** controller ruling

### B-7-2 `migrate-all.ts` may call `createDatabase`
- **Decision:** `migrate-all.ts` joins the `createDatabase` allow-list.
- **Basis:** It must open tenant files before the gate can verify them.
- **Assumption:** Not recorded.
- **Cost if wrong:** One more caller of `createDatabase`, confined to migrations.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-7-3 Google sessions resolve identity through Google's `sub`
- **Decision:** Google sessions resolve the identity through Google's `sub`. Spec section 4.3 ("carries an identity id") is met for hand-off sessions in Task 13. Google JWTs keep `sub` because the dashboard cannot reach the control DB at sign-in.
- **Basis:** Spec section 4.3 and the dashboard's constraint, as stated in the ledger.
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra lookup per Google request.
- **Status:** Accepted
- **Decided by:** controller ruling. This touches identity; it predates the stop rule.

## Task 8: enrolment console and key rotation

### B-8-1 The enrolment console takes the tenant slug as well as origin and code
- **Decision:** The operator enters the slug with the HTTPS origin and code. The enrol request's `aud` must be `impressorx:<slug>`. The operator reads the slug from the same tenant registry used for the origin check.
- **Basis:** No unauthenticated endpoint names the tenant, so the slug has to come from the operator.
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra field for the operator. A wrong slug fails enrolment with a 502.
- **Status:** Accepted. The slug is no longer the pharmacy's identity after ADR-014 (B-FR-4), but it is still an input here.
- **Decided by:** controller ruling

### B-8-2 `oneonOrigin` is the agent-server's `PUBLIC_URL`
- **Decision:** Oneon's `oneonOrigin` is the agent-server's configured `PUBLIC_URL`, which must be https.
- **Basis:** Not recorded beyond the decision.
- **Assumption:** Not recorded.
- **Cost if wrong:** Hand-offs would POST to the wrong host, caught at the first launch.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-8-3 ImpressoRx signs `GET /api/oneon/keys` with its oldest still-valid key (contract; cross-cutting)
- **Decision:** ImpressoRx signs the key list with the oldest still-valid deployment key (`retired_at` null or in the future), not the newest. Oneon refreshes nightly, which keeps the chain unbroken through the 7-day overlaps.
- **Basis:** Oneon can verify only with a key it already trusts.
- **Assumption:** Oneon's nightly refresh keeps running. If it misses refreshes for a full overlap window, the chain breaks.
- **Cost if wrong:** If Oneon misses refreshes for a full overlap window, the operator re-enrols.
- **Status:** Accepted. Required an ImpressoRx follow-up to Task 4 code (commits 1a13b61..e365a1a on the ImpressoRx branch). The refresh is a daily job that also runs at startup (B-FR-3, m1).
- **Decided by:** controller ruling. This is a keys decision; it predates the stop rule.

### B-8-4 Log redaction protects `enrolmentCode`
- **Decision:** Log redaction protects the enrolment code under the key `enrolmentCode`, not `code` (error `code` fields stay visible). The code is never logged under any other key.
- **Basis:** Not recorded beyond the decision.
- **Assumption:** Not recorded.
- **Cost if wrong:** None; the value is still never logged.
- **Status:** Accepted. A later test scans real log output of failed and successful enrolments for secrets (commit 1b11371).
- **Decided by:** controller ruling

### B-8-5 JWKs travel as JSON strings; the contract document is corrected (contract; cross-cutting)
- **Decision:** JWKs travel as JSON strings in every claim and body, matching ImpressoRx as built. `impressorx-contract.md` is corrected.
- **Basis:** The controller's own contract text said "object"; the deployed ImpressoRx side uses strings.
- **Assumption:** Not recorded.
- **Cost if wrong:** None; it matches the deployed side.
- **Status:** Corrected: the earlier contract text ("object") was wrong and was replaced.
- **Decided by:** controller ruling

### B-8-6 Oneon key rotation persists the new key first, then announces it
- **Decision:** Rotation persists the new key before `POST /api/oneon/keys`. On 204, retire the old key locally (plus 7 days). On a definite 401, delete the new key. On an ambiguous failure, keep both, and when the deployment refuses the newest key, retry once with the other unretired key.
- **Basis:** Recovers a lost 204 without weakening the "only unretired keys change the key set" rule (B-4-1 in the ImpressoRx index below).
- **Assumption:** A single retry with the other key is enough. This proved wrong: a reviewer found rotation could lock itself after two non-landed ambiguous rotations.
- **Cost if wrong:** A stray unused key row until the next rotation.
- **Status:** Corrected: the retry-once step was replaced by B-8-7.
- **Decided by:** controller ruling. This is a keys decision; it predates the stop rule.

### B-8-7 The announced key never signs its own announcement; every unretired key is tried
- **Decision:** The key being announced is never a signing candidate for its own `POST /keys`. Signing tries every unretired Oneon key, newest first, with no cap. Only HTTP 401 is a definite refusal (delete the new key); every other failure is ambiguous (keep it).
- **Basis:** Reviewer finding in Task 8 fix round 1 (rotation lock-out). Aligns code with B-8-6 and removes the lock-out.
- **Assumption:** Not recorded.
- **Cost if wrong:** Extra round trips when several stale pending keys exist.
- **Status:** Accepted. It replaces B-8-6's retry-once step.
- **Decided by:** controller ruling. This is a keys decision; it predates the stop rule.

## Task 12: ImpressoRx client and pending exchanges

### B-12-1 Pending exchanges carry `pending_since` and their operation
- **Decision:** Pending exchanges carry `pending_since` and the pending operation (`pending_request_json`: grantType, oneonActionId, issue input) in a new control migration. The 120 s retry cutoff is measured from `pending_since` (stop when `now - pending_since + 10 s >= 110 s`). A reused pending id past the cutoff is never presented: the grant is revoked locally (reason `exchange_outcome_unknown`), a best-effort `/revoke` is sent, and `ImpressoRxRefusedError` is thrown. A reused id replays its stored operation exactly and applies that result to that operation before running the caller's own.
- **Basis:** Task 12 fix round 1. Avoids false theft revocations and alerts, and orphaned grants, after lost replies.
- **Assumption:** Not recorded.
- **Cost if wrong:** After a long outage mid-exchange the person reconnects instead of getting a theft alarm.
- **Status:** Accepted. The ledger separately accepts that an ImpressoRx outage longer than about 100 s mid-exchange ends attended sessions (the person relaunches); it is inherent to the 120 s retry rule.
- **Decided by:** controller ruling. This is a keys/grants decision; it predates the stop rule.

### B-12-2 Idle expiry slides on each successful exchange
- **Decision:** Each successful exchange sets `idle_expires_at = min(now + idle period for the kind, absolute_expires_at)` (attended 30 min, schedule 14 d, action = absolute).
- **Basis:** Idle expiry must slide. Task 12 fix round 1.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. The action-grant value was corrected by B-19-4 and the periods match ImpressoRx's B-18-1.
- **Decided by:** controller ruling

### B-12-3 Client factory takes the control DB and grant master key; hand-off checks the user
- **Decision:** The client exposes a factory that takes the control DB and the grant master key (agent-server cannot import grant-store under invariant I4). `exchangeHandoff` takes the expected external user id and refuses a snapshot whose `userId` differs.
- **Basis:** Needed by Task 13.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

## Task 14: context routing and the tenant_id guard

### B-14-1 Action config repositories check `scope`/`owner_id` against the handle
- **Decision:** Action config repositories have no `tenant_id` column, so they check `scope`/`owner_id` against the handle: in a tenant file only rows with `scope='tenant'` and `owner_id` = the handle's tenant are read or written; in the personal file only `scope='personal'`. A mismatch throws `tenant_mismatch`.
- **Basis:** Avoids a migration while keeping the section 8.4 guarantee.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

### B-14-2 Legacy actions are personal-only
- **Decision:** Legacy actions are personal-only. The legacy repository throws if constructed with a `TenantDb`.
- **Basis:** The legacy import came from the personal action log.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-14-3 `tenant_mismatch` is logged at error level and is the operator alert
- **Decision:** A `tenant_mismatch` is the section 8.4 "operator alert": logged at error level with code `tenant_mismatch`, the handle's tenant and the table (no row content).
- **Basis:** No separate alert channel exists yet.
- **Assumption:** Someone reads the error logs. See B-25-4.
- **Cost if wrong:** Operators must watch the error logs.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-14-4 Tenant `ActiveContext` carries `registrationId`; `tenantId` stays the registry `tenant_id`
- **Decision:** A tenant `ActiveContext` also carries `registrationId`. `tenantId` stays the rows' registry `tenant_id`.
- **Basis:** Tasks 15 and 16 need `registrationId` for grants and the ImpressoRx client.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. It differs from spec section 9.1, which says `tenantId` = registration id: spec amendment awaiting the owner (A2 below).
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

### B-14-5 Model audit refuses a record whose tenant differs from the handle's
- **Decision:** Model audit `recordDecision` and `recordOutcome` throw `tenant_mismatch` when the record's `tenantId` differs from the handle's, instead of overwriting. Marked "load-bearing for Task 16".
- **Basis:** Not recorded beyond the Task 16 dependency.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

## Task 15 and Task 16: tenant actors and the gateway

### B-15-1 Actor and action `tenantId` are the registry `tenant_id`
- **Decision:** Actor and action `tenantId` are the rows' registry `tenant_id` (B-14-4), not the registration id. `actorForInstance`'s `memberships.activeFor(identityId, tenantId)` is adapted in agent-server by resolving the registration by `tenant_id` (UNIQUE in `tenant_registrations`, status active), then the identity's active membership at that registration. Recovery iterates `listActive()` and opens `gate.openTenant` per registration.
- **Basis:** Keeps one tenant key across rows, actors and audit.
- **Assumption:** Not recorded.
- **Cost if wrong:** A rename at the adapter.
- **Status:** Accepted. Spec amendment awaiting the owner (A2 below). The rule that tenant recovery runs only at startup in B-core was a gap, fixed by B-25-6.
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

### B-16-1 Tenant `ModelContext.tenantId` uses the registry `tenant_id`; the limit is the default
- **Decision:** Tenant `ModelContext.tenantId` = `ActiveContext.tenantId` (registry `tenant_id`). `auditFor` returns the request handle's `contextRepos.modelAudit`. `tenantLimit` is wired to the `TENANT_CHOICE_LIMIT` default, because no limit storage exists in this task.
- **Basis:** Keeps audit rows on the one tenant key and avoids `tenant_mismatch` on `recordDecision`.
- **Assumption:** Not recorded.
- **Cost if wrong:** Audit rows keyed differently from action rows.
- **Status:** Accepted. Spec amendment awaiting the owner (A2 below). The default limit was replaced by stored limits in B-22-1.
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

## Task 17: context refresh and suspension

### B-17-1 Refresh goes through the bound attended grant; a stale snapshot never suspends
- **Decision:** Refresh calls `me()` through the attended grant bound to (sessionId, identityId, membershipId), never the unbound `forSession`. Session-auth's bound attended-grant check also rejects a grant past its local idle or absolute expiry; the session ends and the person relaunches from ImpressoRx, the membership untouched. A tenant context with a stale (over 300 s) snapshot and no usable bound grant gets 403 `launch_required`, never a suspension. Only an ImpressoRx refusal suspends.
- **Basis:** Task 13 minor (unbound `forSession`) and Task 13 pointer on expiry.
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra relaunch.
- **Status:** Accepted
- **Decided by:** controller ruling. This is tenant matching and grant handling; it predates the stop rule.

### B-17-2 Refresh is single-flight per membership
- **Decision:** Refresh is single-flight per membership in-process: concurrent requests share one `me()` call.
- **Basis:** Two concurrent exchanges of one grant value count as theft at ImpressoRx.
- **Assumption:** Single process. Not stated; the ruling says "in-process".
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-17-3 `GET /api/contexts` for a hand-off session lists one membership
- **Decision:** For a hand-off session, `GET /api/contexts` lists only the membership its attended grant is bound to. Personal appears only with a Google login. Tenants appear only for active memberships.
- **Basis:** Session-auth binds a hand-off session to one membership; switching would 401.
- **Assumption:** Not recorded.
- **Cost if wrong:** A linked multi-pharmacy hand-off user switches by relaunching.
- **Status:** Accepted
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

### B-17-4 The NextAuth `update` trigger never stores a client-supplied active context unvalidated
- **Decision:** The NextAuth `jwt` callback on trigger `update` never stores a client-supplied `activeContext` without a server-side validate call. The agent-server middleware's ownership and status check stays the authority.
- **Basis:** Not recorded beyond the decision.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

### B-17-5 Only a remote HTTP 401 from `/me` suspends a membership
- **Decision:** Only a remote HTTP 401 from `/me` suspends. The client marks remote 401 refusals distinctly. Any other refusal or unexpected status gives 403 `launch_required` with no side effects, logged at warn with the status. A non-active registration is checked before refreshing, giving the gate's own refusal with no side effects.
- **Basis:** Reviewer finding in Task 17 (confirmed real): refresh suspended memberships, and revoked grants locally only, on refusals ImpressoRx never sent, namely a local "Registration is not active" (spec section 5.5 says an operator suspension leaves ImpressoRx unchanged) and non-401 statuses (404, 400, 3xx).
- **Assumption:** Contract: every ImpressoRx refusal is 401.
- **Cost if wrong:** A malformed ImpressoRx reply makes the person relaunch instead of suspending.
- **Status:** Accepted. Extended by B-17-7.
- **Decided by:** controller ruling

### B-17-6 30 s cooldown after an unreachable refresh
- **Decision:** A per-membership cooldown of 30 s after an unreachable refresh: keep the cache, no new `me()` inside the cooldown.
- **Basis:** Caps the roughly 31 s wait per stale request during an outage.
- **Assumption:** Not recorded.
- **Cost if wrong:** Refresh can lag up to 30 s more during an outage.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-17-7 A remote 401 on either leg of the refresh suspends
- **Decision:** A remote 401 on either leg of the refresh (the token exchange or `/me`) suspends the membership. A theft-induced 401 suspends too. Suspension lifts at the next hand-off snapshot.
- **Basis:** Spec section 5.5: "Oneon learns at its next exchange or snapshot and suspends".
- **Assumption:** A 401 means ImpressoRx refused. The final review later found ImpressoRx returned 401 for infrastructure failures too; that was fixed on the ImpressoRx side (B-FR-1, 503 instead of 401).
- **Cost if wrong:** A deployment-wide 401 (for example a key mix-up) suspends memberships until each person relaunches.
- **Status:** Accepted. It extends B-17-5.
- **Decided by:** controller ruling

## Task 26: linking identities (executed after Task 17)

### B-26-1 Link intents use control migration `004_link_intents.sql`
- **Decision:** The migration is `004_link_intents.sql`, because 002 and 003 are taken.
- **Basis:** Task 12 pointer.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-26-2 A link intent is bound to a one-time secret held in a short cookie
- **Decision:** A link intent is bound to a random one-time binding secret (stored hashed, returned once), held by the dashboard in a 5-minute httpOnly SameSite=Lax cookie, plus the creating identity.
- **Basis:** Google sessions have no `sessionId` (Task 17 pointer) and the second sign-in replaces the JWT, so a JWT-held intent is lost. The cookie proves "same browser session" for both directions.
- **Assumption:** Not recorded.
- **Cost if wrong:** A schema column rename.
- **Status:** Accepted. Refined by B-26-13 (the cookie takes the `__Host-` prefix).
- **Decided by:** controller ruling. This is identity linking; it predates the stop rule.

### B-26-3 Linking two identities that both hold a Google login is refused
- **Decision:** A link where both identities already hold a Google login is refused with 409 `link_conflict`.
- **Basis:** Merging two Google identities would orphan personal data in `oneon.db`.
- **Assumption:** Not recorded.
- **Cost if wrong:** Such a person must unlink first.
- **Status:** Accepted
- **Decided by:** controller ruling. This is identity merging; it predates the stop rule.

### B-26-4 `mergeInto` updates tenant files first, then the control DB in one transaction
- **Decision:** `mergeInto` updates the tenant files first (idempotent `UPDATE ... WHERE user_id = from`, one file at a time, each in its own transaction). Then one control-DB transaction moves logins and memberships, disables `from` with `merged_into`, writes the link event and revokes `from`'s grants. A failure part-way returns 500 `{ error: "link_incomplete" }` with the control DB unchanged, and a retry with a fresh intent completes.
- **Basis:** No cross-file transaction exists.
- **Assumption:** The tenant-file updates are idempotent, so a retry is safe. Stated in the ruling.
- **Cost if wrong:** A failed link briefly hides the hand-off identity's tenant conversations until retried.
- **Status:** Accepted
- **Decided by:** controller ruling. This is identity merging and overwriting rows; it predates the stop rule.

### B-26-5 Personal-only routes in a tenant context answer 403 `personal_context_required`
- **Decision:** Personal-only routes in a tenant context return 403 `{ error: "personal_context_required" }`, and the dashboard shows "Switch to Personal to use this." instead of signing out.
- **Basis:** Becomes reachable in Task 26 (Task 17 pointer).
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-26-6 Linking completes at a same-site `GET /auth/link/complete`
- **Decision:** Linking completes at a same-site `GET /auth/link/complete`, because a Lax cookie does not ride ImpressoRx's cross-site hand-off POST. The hand-off link body is `{ kind: "impressorx", identityId }`.
- **Basis:** The implementer's design, "accepted pending review".
- **Assumption:** Not recorded.
- **Cost if wrong:** Rework of the completion route.
- **Status:** Corrected: the review found the merge committed on a GET with no confirmation. The commit step moved to a same-origin POST (B-26-10).
- **Decided by:** controller ruling. This is identity merging; it predates the stop rule.

### B-26-7 Memberships of a removed registration are moved without opening the file; a paused one refuses the link
- **Decision:** Memberships of a removed registration are moved without opening their file (rows there are retained only for deletion). A suspended or disabled registration refuses the link with 409 `link_unavailable` and a message to try again when the pharmacy is back. Ruled for the fix round.
- **Basis:** Never orphan rows, never block forever.
- **Assumption:** Not recorded.
- **Cost if wrong:** A paused pharmacy delays linking.
- **Status:** Accepted
- **Decided by:** controller ruling. This involves identity and tenant files; it predates the stop rule.

### B-26-8 After a merge commits, the moved grants are evicted and revoked at ImpressoRx
- **Decision:** After the control transaction commits, `from`'s revoked grants are evicted from the client's token cache and revoked at ImpressoRx best-effort (`POST /api/oneon/revoke`, failures logged). Ruled for the fix round.
- **Basis:** The raw-SQL revoke left cached access tokens usable for up to 5 minutes.
- **Assumption:** The revoke at ImpressoRx may fail, and the local revoke is enough for Oneon's own side. Stated in the ruling ("best-effort").
- **Cost if wrong:** None.
- **Status:** Accepted. B-26-12 applies it to unlink.
- **Decided by:** controller ruling. This is grant revocation; it predates the stop rule.

### B-26-9 After a link, the stale session ends and a confirmation page shows
- **Decision:** After a successful link, `/auth/link/complete` ends the now-stale session and shows a confirmation page ("Your accounts are linked. Sign in again to continue.") with Google sign-in and "open Oneon from ImpressoRx" options, instead of a 401 bounce. Ruled for the fix round.
- **Basis:** Explicit state, instead of a bounce.
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra sign-in.
- **Status:** Superseded by B-26-10, which repeats the page and adds the preview step. Ledger wording: "supersedes the queued post-link page ruling".
- **Decided by:** controller ruling

### B-26-10 The link needs a preview and a same-origin POST with a CSRF token
- **Decision:** `/auth/link/complete` shows "Link <role> at <pharmacy> to <Google email>?" and commits only on a same-origin POST (Origin check plus a CSRF token). Sign-out clears the intent cookie. After commit the stale session ends and the confirmation page appears.
- **Basis:** Reviewer finding in Task 26 (confirmed real): a merge committed on a GET with no pre-commit confirmation, and the intent cookie survived sign-out, so on a shared browser another staff member's hand-off within 5 minutes could silently merge into the first person's identity (cross-role conversation exposure).
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra click.
- **Status:** Accepted. Supersedes B-26-9 and the commit step of B-26-6.
- **Decided by:** controller ruling. This is identity merging; it predates the stop rule.

### B-26-11 The hand-off direction of a link needs a server-verified attended grant
- **Decision:** The hand-off-direction link requires the server to verify `hasAttendedGrant(sessionId, identityId, membershipId)` from the sealed session, not the service token alone.
- **Basis:** Spec section 4.5: "both logins proven in one session".
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling. This is identity linking; it predates the stop rule.

### B-26-12 Grant eviction and best-effort revoke also cover unlink
- **Decision:** The grant cache-eviction and best-effort ImpressoRx revoke of B-26-8 covers unlink's moved membership too.
- **Basis:** Consistency with B-26-8.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling. This is grant revocation; it predates the stop rule.

### B-26-13 The confirm token binds the previewed login; the intent cookie is `__Host-`
- **Decision:** The confirm token binds the previewed login (Google `sub`, or the hand-off sessionId and identityId) as well as the intent. A mismatch at POST refuses and re-previews. The intent cookie uses the `__Host-` prefix with `Path=/` and no `Domain`, so a sibling subdomain cannot plant one.
- **Basis:** Reviewer finding in Task 26 fix round 1 (confirmed real): Confirm committed whoever was signed in at POST time, not the login the page previewed, so another launch or Google sign-in in another tab between preview and Confirm would be merged.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. It refines B-26-2 and B-26-10.
- **Decided by:** controller ruling. This is identity linking; it predates the stop rule.

## Task 19: approvals and execution

### B-19-1 Every attended call uses the bound session lookup
- **Decision:** Every attended call in Task 19 uses the bound session lookup (sessionId, identityId, membershipId) for the membership of the instance's tenant, never the unbound `forSession`.
- **Basis:** Task 13 minor and B-17-1.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-19-2 The live approver check follows Task 17's classification
- **Decision:** A remote 401 (`ImpressoRxUnauthorizedError`) suspends the membership, revokes its grants, answers 403, and the approval is not recorded. Any other refusal (no usable bound grant, local refusal, unexpected status) gives 403 `launch_required`, the approval not recorded, no side effects. Unreachable gives 503 `{ error: "impressorx_unreachable" }`, the approval not recorded.
- **Basis:** Spec section 9.3 requires the live check at approval; classification from B-17-5 and B-17-7.
- **Assumption:** Not recorded.
- **Cost if wrong:** An approval waits for ImpressoRx to come back.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-19-3 Execution failures are mapped by kind
- **Decision:** A remote 401 or a local grant refusal (missing, expired, revoked) revokes the local grant and fails the action `delegation_revoked`. Unreachable (network, timeout, 5xx/503) leaves the action approved with a retry event until `approval_stale`. Any other HTTP error (for example a tRPC FORBIDDEN) takes the executor's existing non-retried failure path.
- **Basis:** A permanent refusal must not retry for 24 hours.
- **Assumption:** Not recorded.
- **Cost if wrong:** A misclassified transient error fails one action.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-19-4 An action grant's idle expiry equals its absolute expiry
- **Decision:** Oneon's action-grant idle expiry equals its absolute expiry.
- **Basis:** Task 12 minor (the insert used 14 days). Matches ImpressoRx's B-18-1.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. It corrects the 14-day value Task 12 used for action grants.
- **Decided by:** controller ruling

### B-19-5 A pending exchange is abandoned on a 401 only when the 401 is unambiguous
- **Decision:** The pending exchange is abandoned on a 401 only when it was not a reused (replayed) pending exchange and every attempt in that `signedPost` got 401 with no earlier timeout or 5xx. Otherwise it is kept as before.
- **Basis:** Reviewer finding in Task 19 (confirmed real): `abandonExchange` on any 401 could cause a false theft. A 401 from a suspended tenant (no revoke at ImpressoRx) after a rotation whose reply was lost cleared the pending exchange, and Oneon then presented the pre-rotation value.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. It preserves the client's guarantee never to present a pre-rotation value.
- **Decided by:** controller ruling. This is grant handling; it predates the stop rule.

### B-19-6 A grant issued after its action ended is released, with a tombstone
- **Decision:** After `issueActionGrant`, re-read the instance and release the grant if the action is final. A release leaves a tombstone for the action id, so any later insert of an action grant for it lands revoked (and is revoked at ImpressoRx best-effort).
- **Basis:** Reviewer finding in Task 19 (confirmed real): an action grant stored after its action reached a final status was never revoked (cancel during issue; a replayed issue landing after the action ended). Spec section 7.1.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. Uses control migration 005.
- **Decided by:** controller ruling. This is grant revocation; it predates the stop rule.

### B-19-7 Person-facing wording for a missing action grant
- **Decision:** "No action grant" (issue unreachable or unattended off) records reason `no_action_grant` and shows "Oneon couldn't keep access to finish this on its own. Retry while you're signed in." instead of "access has ended". Retry-note events (from equals to) render as "Waiting for ImpressoRx". `requiredPermissions` without the `impressorx:` prefix are filtered out of the scope. The age check uses the limit recorded with the approval.
- **Basis:** Person-facing accuracy.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. The age-check part was refined by B-19-8.
- **Decided by:** controller ruling

### B-19-8 The approval age check uses the smaller of the recorded and the current limit
- **Decision:** The approval age check uses `min(limit recorded with the approval, current policy limit)`.
- **Basis:** Raising cannot extend an approval and lowering takes effect immediately. The ledger says "same principle as Q7 for limits" (Q7 is one of the step-b-core design questions Q1-Q9; its text is not in the sources I used).
- **Assumption:** Not recorded.
- **Cost if wrong:** An approval made under a longer limit fails earlier after a lowering.
- **Status:** Accepted
- **Decided by:** controller ruling

## Task 20: connections page

### B-20-1 `/api/connections` is identity-scoped
- **Decision:** `/api/connections` is identity-scoped and works in both personal and tenant contexts. `needsReconnect` lists only `delegation_revoked` (`no_action_grant` has its own Retry message). A tenant file that fails to open is skipped with a warn and named in an `unavailable` list.
- **Basis:** Not recorded beyond the decision.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-20-2 Revoke is local first, then ImpressoRx, and reports whether ImpressoRx answered
- **Decision:** Revoke is local first (grant revoked, token cache evicted, always), then ImpressoRx. The response is 200 `{ remote: "revoked" | "unreachable" }` (not 204), so the person is told when ImpressoRx could not be reached. Idempotent on an already-revoked grant. Revoking the current session's attended grant warns that it signs the person out of that pharmacy.
- **Basis:** A revoke must never depend on ImpressoRx being up.
- **Assumption:** Not recorded.
- **Cost if wrong:** The brief's 204 shape differs.
- **Status:** Accepted. B-20-4 and B-20-5 amend it.
- **Decided by:** controller ruling. This is grant revocation; it predates the stop rule.

### B-20-3 Settings lists linked logins with Unlink
- **Decision:** Settings, Connections also lists the identity's linked logins, with Unlink for `impressorx` logins (the existing `/api/identity/unlink`).
- **Basis:** Gives Task 26's `link_outcome_unknown` "check Settings" message something to show, and exposes unlink.
- **Assumption:** Not recorded.
- **Cost if wrong:** A small extra section.
- **Status:** Accepted
- **Decided by:** controller ruling. This touches identity linking; it predates the stop rule.

### B-20-4 Revoking an already-revoked grant re-sends the remote revoke
- **Decision:** Revoking an already-revoked grant re-sends the idempotent remote revoke.
- **Basis:** Oneon does not store whether the first remote revoke got through; re-sending completes an earlier unreachable one.
- **Assumption:** The remote revoke is idempotent.
- **Cost if wrong:** One extra request.
- **Status:** Accepted. It amends B-20-2.
- **Decided by:** controller ruling. This is grant revocation; it predates the stop rule.

### B-20-5 Revoke wording and reconnect list are made honest
- **Decision:** Keep the `remote` enum but change the text to "Revoked in Oneon. ImpressoRx didn't confirm it, so it may stay open there until <date>." `needsReconnect` excludes originals that have a retry (`retry_of`) and queries only the caller's own actions. Each item carries the caller's `membershipId` and links to the action only when the active context matches; otherwise it offers "Switch to <pharmacy>" (or the reconnect text in a hand-off session that cannot switch).
- **Basis:** Reviewer finding in Task 20 (confirmed real): "ImpressoRx couldn't be reached" was shown when ImpressoRx answered 401 or was never asked (inactive registration). Person-facing accuracy.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. It amends B-20-2's text.
- **Decided by:** controller ruling

## Task 22: tenant AI limit

### B-22-1 Tenant AI limits are keyed by registration id; a missing registration fails closed to D0
- **Decision:** `tenant_ai_limit_versions` (control migration 001) is keyed by `tenant_registration_id`, so the repository takes the registration id. Routes use `req.activeContext.registrationId`. The model wiring's `tenantLimit(tenantId)` resolves the registration by the registry `tenant_id` (UNIQUE) and fails closed to D0 when none is found.
- **Basis:** Keeps the one tenant key on rows and contexts (B-14-4, B-16-1).
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. It replaces the default limit of B-16-1.
- **Decided by:** controller ruling. This is tenant matching; it predates the stop rule.

### B-22-2 The limit change needs a live check; lowering and raising are decided inside the write transaction
- **Decision:** The live check uses the bound session lookup and Task 17's classification (remote 401 suspends, revokes, 403; other refusal 403 `launch_required`; unreachable 503 `impressorx_unreachable`; nothing appended in any refusal). `settings.oneon` is checked against the live snapshot's raw ImpressoRx codes. Lowering versus raising is decided against the current row read inside the same IMMEDIATE transaction as the append. The gateway reads the current limit on every call (no cache), so lowering takes effect at once.
- **Basis:** The "Q7 conditions" (design question Q7; its text is not in the sources I used) and spec section 9.4.
- **Assumption:** ImpressoRx is reachable when someone changes the limit. This is why the spec's proposed fallback to the cached snapshot for lowering is open (A5 below).
- **Cost if wrong:** None.
- **Status:** Accepted. The spec section 9.4 fallback for lowering is not built: awaiting the owner (A5 below).
- **Decided by:** controller ruling

### B-22-3 A raise needs one qualified provider, and only a raise to D2 needs review and a DPA
- **Decision:** Spec section 9.4 governs: a raise must stay within a configured provider's tenant ceiling (platform overrides applied). Only a raise to D2 also needs that provider reviewed with a recorded DPA. So D0 to D1 is allowed when a configured provider's tenant ceiling reaches D1.
- **Basis:** Corrects the controller's own earlier dispatch, which required review and DPA for every raise and would have trapped a pharmacy at D0. The spec text says "within each provider's tenant ceiling"; the ruling reads it as "a configured provider's". The final review lists that change as a spec amendment.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Corrected: it replaced the controller's earlier dispatch. Spec amendment awaiting the owner (A3 below).
- **Decided by:** controller ruling

### B-22-4 In a tenant context each provider is capped at D1 unless reviewed and covered by a DPA
- **Decision:** In a tenant context the gateway caps each provider at D1 unless its registry entry is review "reviewed" and has `tenantDpa`. This is enforced per call, so it survives routing changes. The raise gate still requires at least one configured provider that qualifies for D2.
- **Basis:** Reviewer finding in Task 22 (confirmed real, latent because both tenant ceilings are D1 today): the D2 gate could be met by a keyed provider that never receives the data, since the gateway capped a tenant call only by the routed provider's ceiling and never checked review or DPA at call time. Spec section 9.4, "that provider's review record and DPA".
- **Assumption:** Not recorded.
- **Cost if wrong:** None (personal context unchanged).
- **Status:** Accepted. Part of spec amendment A3.
- **Decided by:** controller ruling

### B-22-5 Limit history ordering, fail-closed read, optimistic check and wording
- **Decision:** `current()` orders by rowid (insertion order; deletes are blocked), not `created_at`. A repository error in `tenantLimit` is caught, logged, and fails closed to D0 so the decision is still audited. POST takes an optional `expectedCurrent` and answers 409 `limit_changed` when it differs (the dashboard sends it). Raise evidence also records platform overrides applied and the routing in force. Wording: no "you can always lower it"; the D0 label says chat replies in the pharmacy are refused; "aggregate sales" not "sales figures"; `context_unavailable` gets a message.
- **Basis:** Task 22 fix round 1.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted
- **Decided by:** controller ruling

## Task 24: backups

### B-24-1 Backup files are sealed with AES-256-GCM, bound to their name
- **Decision:** Backup files are sealed with AES-256-GCM over the raw bytes (a buffer variant beside `sealSecret`/`openSecret` in `crypto/envelope.ts`, same key format), with the backup's relative name as associated data, so one tenant's backup cannot be presented as another's. Plaintext temp copies live in a private (0700) temp dir outside `outDir` and are removed in `finally`. Sealed files are 0600.
- **Basis:** `sealSecret` takes strings and would base64 whole databases. The AAD binding is the ledger's stated reason.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. The AAD is now `<folder>/<name>`; see ADR-015. The temp dir moved under the data directory (B-FR-3, m2).
- **Decided by:** controller ruling. This is a keys decision; it predates the stop rule.

### B-24-2 A pending migration is preceded by a backup; no backup, no migration
- **Decision:** The pre-migration backup runs only when a migration is pending, for control (in `openControlDb`, which migrates first), personal and each tenant. If that backup fails the file is not migrated: a tenant is refused service and logged at error, and a control or personal failure stops startup. With no `BACKUP_ENCRYPTION_KEY` (allowed only while no registration exists) backups are skipped with a startup warn. The environment refuses to start without the key once any registration exists.
- **Basis:** Spec section 8.7 (backup before each migration) and the Task 6 note that control is migrated when it is opened.
- **Assumption:** Not recorded.
- **Cost if wrong:** A failed backup blocks a migration until fixed.
- **Status:** Accepted. Startup migration now covers suspended files too (B-PR-16).
- **Decided by:** controller ruling

### B-24-3 Nightly backup once per day, monthly restore test, no automatic deletion in B-core
- **Decision:** The nightly backup runs once per calendar day (today's folder existing means done). The monthly restore test restores one tenant (rotating) from the latest backup and logs the result, at error level on failure. No automatic deletion of backups in B-core: DEPLOY.md says the operator prunes, and B-retention adds deletion with the file's schedule (spec section 8.7).
- **Basis:** Spec section 8.7.
- **Assumption:** Disk use can grow until B-retention. Not recorded as measured.
- **Cost if wrong:** Disk use grows until B-retention.
- **Status:** Accepted in part. "Today's folder existing means done" was corrected by B-24-4 (a crash marked the day done). "No automatic deletion" no longer holds for hourly copies: D6 (B-PR-14).
- **Decided by:** controller ruling. This is a deletion decision; it predates the stop rule.

### B-24-4 OS-released migration lock, `.partial` days, owned restore test, enrolment needs the key
- **Decision:** The migration lock is an OS-released lock (a SQLite lock file held with `locking_mode=EXCLUSIVE` and `BEGIN EXCLUSIVE`, released by the kernel on death) and covers control too. The nightly run writes into `<day>.partial/` and renames to `<day>` only when every file succeeded. Shutdown awaits the backup scheduler. The restore test requires `context_meta` kind `tenant` with the `tenant_id` of the registration that owns the file. Enrolment is refused while `BACKUP_ENCRYPTION_KEY` is unset. Startup sweeps plaintext temp copies, restore scratch and `.part` files. `grant-operator` backs up control before migrating (or refuses when a migration is pending). `restore-backup` resolves paths from `INIT_CWD` and takes `--as <day>/<name>` for the AAD.
- **Basis:** Reviewer findings in Task 24 (confirmed real): a stale `migrate.lock` after SIGKILL crash-loops a restart-policy deploy (PID checks are useless, node is PID 1); a crash mid-nightly marks the day done; the restore test passes without checking `context_meta` (spec section 8.7); enrolling without the key makes the next restart refuse to start.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. Corrects the "folder exists means done" rule of B-24-3.
- **Decided by:** controller ruling. This involves keys and overwriting files; it predates the stop rule.

### B-24-5 A pharmacy the gate refuses is skipped, not failed
- **Decision:** A tenant the gate refuses to open (a typed refusal such as `tenant_schema_behind`) is skipped, not failed: logged at error on every run, listed in `<day>/skipped.json` (registration id and refusal code), and the day still completes when every file that opened was sealed. Any other failure (open throwing a non-refusal error, backup, seal or write) keeps the day partial and retried. DEPLOY.md documents `skipped.json` and that a skipped tenant's last good copy is its pre-migration backup.
- **Basis:** Spec section 8.7, plus a reviewer finding: one persistently refused tenant blocked every complete day folder, so one broken pharmacy took every pharmacy's daily backup off-site.
- **Assumption:** A refused file is unchanged while it is refused, because the gate refuses every open. Verified in code.
- **Cost if wrong:** A refused tenant has no nightly copy until fixed (it is not being written to while refused).
- **Status:** Accepted. The weak case, a deleted file shown only as a log line, is covered by the `tenant_file_missing` alert and by measuring backups by age (`backup_stale`): B-PR-4.
- **Decided by:** controller ruling

## Task 25: gate leases, background jobs, rollups

### B-25-1 The gate leases handles, with a 60 s grace for unleased ones
- **Decision:** The gate gains `lease(registrationId)` returning `{ db, release() }`. A leased entry is never evicted by LRU, and a suspension eviction of a leased entry refuses new opens at once but defers the close until the last release. Unleased handles evicted by LRU close after a 60 s grace (unref'd timer) instead of at once. `gate.close()` closes everything immediately. `forEachTenant` opens through a lease and releases in `finally`.
- **Basis:** The Task 14 pointer (LRU eviction could close a handle held by an in-flight request once more than 32 tenants are active) and the Task 24 concern.
- **Assumption:** 60 s outlasts any request. The value was a guess, and it was wrong: chat turns can run longer.
- **Cost if wrong:** Up to cacheSize extra file handles open for 60 s.
- **Status:** Superseded by B-PR-3 (post-review item 2): every caller leases, the grace timer is removed, and a handle closes when its lease count reaches zero and it has been evicted.
- **Decided by:** controller ruling

### B-25-2 `forEachTenant` reports `refused` separately from `failed`
- **Decision:** `forEachTenant` returns `{ visited, failed, refused: Array<{ registrationId, code }> }`. A `TenantRefusedError` on open is refused, not failed. `backupAll` moves onto `forEachTenant`, keeping `skipped.json` and the `.partial` rename rule.
- **Basis:** Consistency with B-24-5.
- **Assumption:** Not recorded.
- **Cost if wrong:** One extra field on the plan's interface.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-25-3 Time budgets are advisory
- **Decision:** The time budget is cooperative: `forEachTenant` passes `deadline = now + budgetMs` and never aborts `fn`; it logs warn when a tenant's `fn` overruns. The sweeper stops its per-tenant work at the deadline and continues next pass. Backups and rollups pass their own `budgetMs` (backup 10 min, rollups 2 s default) and do not abort mid-file.
- **Basis:** The original reason was "`db.backup` cannot be preempted and a half backup is worthless". The first half is false.
- **Assumption:** `db.backup` cannot be preempted. False: better-sqlite3 11.10.0 aborts a backup when the progress callback throws (`lib/methods/backup.js`).
- **Cost if wrong:** One slow tenant can delay later tenants in a backup pass.
- **Status:** Corrected: the premise is false. Advisory budgets remain a choice, not a constraint. The budget values (backup 10 min, rollups 2 s) are guesses to be re-tuned from measurements. Backups run on the leased gate handle, which is the same connection that serves writes, so in-process writes do not restart them. The only restart window was the 60 s grace when an evicted and a fresh connection coexist, which B-PR-3 closed.
- **Decided by:** controller ruling

### B-25-4 An operator alert is a `logger.error` with an `alert` field
- **Decision:** "Operator alert" means `logger.error` with a stable structured field `alert: "<kind>"` (`link_check` here). No new channel exists in B-core.
- **Basis:** The spec says "raise an operator alert" and no alert channel exists. Verified in code.
- **Assumption:** Someone reads the logs.
- **Cost if wrong:** Alerts are log-only until a channel exists. A heartbeat to an outside monitor is a post-merge item.
- **Status:** Accepted
- **Decided by:** controller ruling

### B-25-5 Rollups use the previous UTC day
- **Decision:** Rollups are written once per UTC day for the previous day, upserted on (`tenant_id`, `day`) so a rerun is idempotent. `modelCalls` and `modelDenials` count `model_call_decisions` of that day. `actionsByStatus` counts actions created that day by current status. `activeGrants` counts grants active at write time. Content-free counts only.
- **Basis:** Controller judgement; the spec names the categories only.
- **Assumption:** UTC is correct for Ghana (UTC, no DST).
- **Cost if wrong:** Metric definitions change in one function. A per-tenant timezone is a post-merge item.
- **Status:** Accepted. A reviewer finding in the same task (activeGrants counted idle-expired grants still marked active) was fixed in fix round 1.
- **Decided by:** controller ruling

### B-25-6 Tenant action recovery runs every pass
- **Decision:** Tenant action recovery (sweep and expiry) runs on every background pass, not only at startup, as a non-overlapping pass on the background-loop interval, awaited at shutdown.
- **Basis:** Spec section 7.4 already runs recovery every cycle for personal users, and section 8 says the sweeper iterates the registry per pass. The startup-only call was a Task 15 gap. The task review also found the tenant sweep's "next pass" had no pass.
- **Assumption:** Concurrent sweeps are guarded by `TransitionConflictError`. Checked by the re-reviewer.
- **Cost if wrong:** One registry pass per poll interval.
- **Status:** Accepted
- **Decided by:** controller ruling

## Final review and its fix wave

### B-FR-1 The ImpressoRx fix wave takes I1, I2 and the cheap Minors (cross-cutting)
- **Decision:** The ImpressoRx fix wave takes I1 (token, revoke and keys endpoints mapped infrastructure failures to 401, which Oneon reads as revocation), I2 (silent "Ask Oneon" launch failure), M1 (hand-off issue locks the client row), M3 (guard hooks for upsert and `createManyAndReturn`), M4 (enable refuses without `ONEON_KEY_ENCRYPTION_KEY`), M5 (no `oneon.available` call in support sessions) and the SECURITY.md half of M2. The spec section 10 and invariant I7 text amendment waits for Gerry's confirmation of the Task 21 amendment.
- **Basis:** Controller judgement under the one-fix-wave rule: each item is cheap and touches correctness or an explicit failure state.
- **Assumption:** Not recorded.
- **Cost if wrong:** A slightly larger fix diff.
- **Status:** Accepted. The ImpressoRx commits are 544ffe8..36909d3; the scoped re-review was clean. The section 10 text is open: A4 below.
- **Decided by:** controller ruling

### B-FR-2 Suspend, Resume and re-enrolment were built, not deferred
- **Decision:** Operator-only POST suspend and resume on a registration (`setStatus` plus an event; the gate already refuses non-active), and re-enrolment of an existing slug allowed only while the registration is suspended: a fresh ImpressoRx code proved through the normal two-sided enrolment, keys on the existing registration replaced, tenant file and memberships kept, status set active.
- **Basis:** Spec sections 5.4 and 5.5 promise both, and final-review finding I1. Requiring Suspend first (so a code-holder cannot silently swap an active pharmacy's keys) is controller design.
- **Assumption:** Not recorded.
- **Cost if wrong:** Re-enrolment needs two operator steps.
- **Status:** Accepted. This was scope added late; the CTO asked for a dedicated state-transition review and it was done (B-PR-7 onward). The identity rule inside it was superseded: B-FR-4.
- **Decided by:** controller ruling

### B-FR-3 The Oneon fix wave also takes I2, I3 and six Minors
- **Decision:** The Oneon fix wave takes I2 (DEPLOY.md "Pharmacies (ImpressoRx)" section, four env lines in `.env.template`, a 503 naming the missing key when the signing or grant master key is unset, `grant-operator` paths from `INIT_CWD` and identity-id instructions) and I3 (`conversationId` bounded at the route contract, 400 otherwise). It also takes m1 (deployment-key refresh as a `DailyJob` that also runs at startup; fix the raw 0xA7 byte), m2 (backup and restore scratch under the data dir beside `control.db`, swept only there), m4 (the active-context middleware leases its tenant handle and releases on response finish or close; the 60 s grace stays for other callers), m6 (DEPLOY.md: set `BACKUP_ENCRYPTION_KEY` before upgrading), m9 (link confirmation says linking does not let one session switch between Personal and a pharmacy) and m11 (enrolment flow log-scan test).
- **Basis:** Controller judgement.
- **Assumption:** Not recorded.
- **Cost if wrong:** A larger final fix diff.
- **Status:** Accepted. m4's "60 s grace stays" was superseded by B-PR-3.
- **Decided by:** controller ruling

### B-FR-4 Re-enrolment identity is the pinned origin plus the signed slug
- **Decision:** Option (a): the registration must be suspended, the ImpressoRx origin must equal the registration's pinned origin, and the slug signed in ImpressoRx's enrol reply must equal the registration's slug. No new origin (moving an origin stays a manual procedure in DEPLOY.md). Keys are replaced at once with no overlap (the old ImpressoRx deployment key and Oneon's per-registration signing key are both retired immediately; re-enrolment is compromise or Remove recovery). Every grant of the registration is revoked. The tenant file, `tenant_id` and memberships are kept; memberships reactivate through the normal hand-off snapshot; status becomes active.
- **Basis:** A trade-off made to avoid a migration and a cross-repo contract change at merge time.
- **Assumption:** "Same assurance as first enrolment (origin, fresh code, signed slug) plus pinning". The controller confirmed this when it later read `enrolment-service.ts`, but first-enrolment trust is only the TLS origin plus a one-time code: the reply is verified with the key it announces itself, and the slug is just a name (the nOAuth pattern).
- **Cost if wrong:** An ImpressoRx that deleted and recreated a tenant under the same slug could be re-attached to the old tenant file (it needs an operator Suspend and a code from that ImpressoRx's admin). The ledger noted option (c), a stable ImpressoRx tenant id in the reply, as a pointer for Step C.
- **Status:** Superseded by ADR-014 (owner decision). This should have gone to the owner: it is an identity and tenant-matching decision. The slug check was replaced by ImpressoRx's permanent `Tenant.id`, signed into the enrol reply and compared on re-enrolment.
- **Decided by:** controller ruling

### B-FR-5 An explicit architecture-test exemption, not a variable rename
- **Decision:** Commit ff8ed15's variable rename, made to dodge the request-tenant-id architecture rule, is replaced by an explicit, commented exemption in the architecture test for the operator-only platform registration routes (rotate-key, suspend, resume, re-enrol).
- **Basis:** Principle: a guard you pass by renaming no longer guards.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted (commit 5648d17)
- **Decided by:** controller ruling

### B-FR-6 Parked N1: a request's lease is never released on early disconnect
- **Decision:** Real, deferred. Fix by attaching listeners before `ensureFresh` or checking `res.writableEnded` / `req.destroyed`.
- **Basis:** Final-review item N1 (`active-context.ts:229-237`). New opens are still refused after Suspend, so it is not a security gap. Parked under the no-second-fix-wave rule.
- **Assumption:** Not recorded.
- **Cost if wrong:** A slow handle leak on a busy server with many disconnects (one handle held until restart per such request).
- **Status:** Accepted, then fixed post-review: B-PR-5 attaches the release listeners before any await.
- **Decided by:** controller ruling

### B-FR-7 Parked N2: the Suspend text says "at once"
- **Decision:** Real, deferred. Wording fix: "new requests are refused at once; requests already running finish".
- **Basis:** Final-review item N2. Parked under the no-second-fix-wave rule.
- **Assumption:** Not recorded.
- **Cost if wrong:** An operator may expect an in-flight request to be cut off.
- **Status:** Accepted, deferred. No later ledger line records the wording fix.
- **Decided by:** controller ruling

### B-FR-8 Parked N3: no test runs real grant revocation inside the re-enrolment transaction
- **Decision:** Deferred test gap.
- **Basis:** Final-review item N3. The reviewer verified the savepoint path by reading. Parked under the no-second-fix-wave rule.
- **Assumption:** The savepoint path works as read. Not tested.
- **Cost if wrong:** A future change to revocation could break re-enrolment unnoticed.
- **Status:** Accepted, deferred. No later ledger line records the test.
- **Decided by:** controller ruling

## Post-review (after the CTO review, 2026-10-14)

### B-PR-1 Tenant identity is ImpressoRx's permanent `Tenant.id`
- **Decision:** Gerry accepted the CTO review's before-merge list with the permanent-id fix instead of a switch. Gerry committed 688b6a2 (Oneon: control migration 006 `impressorx_tenant_id`, unique where set; enrolment requires it; re-enrolment must match) and 6a7362f (ImpressoRx: the enrol reply signs `impressorxTenantId` = `Tenant.id`).
- **Basis:** The CTO review (the list itself is not in the sources used here). Reason for the id: a slug can be reused (B-FR-4).
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Accepted. Full record in ADR-014. Supersedes B-FR-4. Full gates were green on both heads.
- **Decided by:** owner

### B-PR-2 The stop rule is committed to CLAUDE.md in both repos
- **Decision:** Identity, keys, deletion and tenant matching stop for the owner's decision (commits 07483b8 in Oneon, 608b20f in ImpressoRx).
- **Basis:** B-FR-4 should have gone to the owner. See ADR-016.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Accepted. It supersedes "decide and record" for those areas.
- **Decided by:** owner (post-review). The ledger records the commits; it does not quote the owner's wording.

### B-PR-3 Tenant handles close only when nothing uses them (post-review item 2)
- **Decision:** The gate uses leases only: the 60 s grace timer is removed, `openTenant` is private, `withTenant` is added (commit a56ae0a). A handle closes when its lease count reaches zero and it has been evicted.
- **Basis:** B-25-1's 60 s was a guess and was wrong, because chat turns can run longer. Part of the CTO before-merge list the owner accepted.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Accepted. Supersedes B-25-1. Not a ledger "Ruling" line.
- **Decided by:** owner (accepted list item); built under the controller

### B-PR-4 Backup age and missing-file alerts (post-review item 3)
- **Decision:** `backup_stale` is logged at error when the newest restorable copy is older than 26 hours (checked hourly), and `tenant_file_missing` when an active or suspended pharmacy's file is not on disk (commit c7ded58). A pharmacy is stale only when its newest copy (or, with none, the later of its enrolment and its last move to active) is older than 26 hours.
- **Basis:** A deleted file had only been a log line (the weak case of B-24-5). Part of the CTO list the owner accepted. The `activeSince` rule came from a task review finding (a new or just-resumed pharmacy would alert hourly).
- **Assumption:** Someone reads the logs (B-25-4).
- **Cost if wrong:** Not recorded.
- **Status:** Accepted. Detail in ADR-015. Not a ledger "Ruling" line.
- **Decided by:** owner (accepted list item); built under the controller

### B-PR-5 Handlers that write after an await hold their own lease
- **Decision:** I1: async route handlers that write after awaiting (chat, actions, any other) hold their own lease for their whole run (`withTenant`), so the request lease is only a floor and a disconnect cannot release a handle still in use. The middleware's release listeners attach before any await (this covers parked N1). I2: the suspend transition, and any other move away from active, tells the gate to detach that registration at once: closed now if unleased, on last release otherwise. I3: a pharmacy is stale only when its newest copy (or, with none, the later of its enrolment and its last move to active) is older than 26 hours.
- **Basis:** Task review of post-review items 2-3: spec failed, three Important findings (I1 request lease released on client disconnect while chat and actions handlers still write; I2 a suspended file closes on last release only if a lease was attempted in between; I3 `backup_stale` alerts hourly for a newly enrolled or just-resumed pharmacy). The controller judged these "not owner-area decisions (handle lifetime, alert timing)".
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. Commits c7ded58..caac461; the task review was clean after fix round 1.
- **Decided by:** controller ruling

### B-PR-6 The never-delete-newest rule was narrowed back to pharmacies, pending the owner
- **Decision:** DEPLOY.md's never-delete-newest rule had been extended to control and personal beyond the approved text. It was narrowed back to pharmacies pending Gerry's decision. The controller recommended extending it ("it only protects data").
- **Basis:** Owner area (deletion): the extension went beyond what the owner approved.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Superseded by D3 (B-PR-10)
- **Decided by:** controller ruling, made in the owner's area and pending the owner

### B-PR-7 Non-owner parts of the state-transition review
- **Decision:** I2(a): every post-proof failure answers an explicit status and message saying ImpressoRx is now connected on its side and the admin must press Remove, then Enable (no bare 500; constraint violations mapped). I2(b): an in-process lock per registration or slug from pre-check to commit, and Suspend or Resume refused while a re-enrolment holds it. I3(a), migration part: Resume migrates the file first (with a pre-migration backup) and refuses with an explicit reason if that fails.
- **Basis:** The state-transition review (0 Critical, 3 Important, 8 Minor), with its findings: I2 post-proof refusals and races left ImpressoRx Active with a key Oneon had discarded, gave wrong "ask for a new code" advice (ImpressoRx issues none while Active, so Remove first), let Resume race a re-enrolment into a 500 with stale keys, and gave two same-slug enrolments a 500. I3 Resume and re-enrolment reported success while the file might be schema-behind or its deployment keys stale.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. The parts that touch keys and deletion went to the owner: D4 (B-PR-11), D5 (B-PR-12). Detail commits 51e7b67..943077f.
- **Decided by:** controller ruling

### B-PR-8 D1: a registration without an ImpressoRx tenant id refuses startup (identity)
- **Decision:** Option b: a control migration refuses to start while any registration has a NULL `impressorx_tenant_id` (the column is effectively required). `GET /tenants` shows `impressorxTenantId`.
- **Basis:** State-transition review I1 and the open question the ledger raised: a registration with no stored id records whatever id its next re-enrolment presents (trust on first use), which reopens the slug-reuse gap for legacy rows. No production registration exists yet.
- **Assumption:** No production registration holds a NULL id. Stated in the ledger.
- **Cost if wrong:** Not recorded. A control file that predates the id must be created again; it cannot be patched by hand (DEPLOY.md).
- **Status:** Accepted. Implemented as control migration 007 and insert and update triggers. See ADR-014.
- **Decided by:** owner (Gerry, "yes continue" to the recommendations, 2026-10-14)

### B-PR-9 D2: hourly sealed backups now; Litestream deferred (keys)
- **Decision:** Option c: hourly sealed backups for pharmacy files and `control.db` now (personal stays daily). Litestream is deferred until it regains client-side encryption. Daily snapshots remain the second copy. The controller stated its interpretation of this decision to Gerry for correction; the ledger records no correction.
- **Basis:** The Litestream research: 0.5.x replicates a directory of per-tenant files with watch (v0.5.4+) but has no client-side encryption (age was removed in 0.5; only S3 SSE-C or SSE-KMS).
- **Assumption:** Sealing before the files leave the VPS matters more than continuous replication. Implied by the choice; not stated as such in the ledger.
- **Cost if wrong:** Not recorded. Data-loss window: see ADR-015.
- **Status:** Accepted. See ADR-015.
- **Decided by:** owner (Gerry, "yes continue" to the recommendations, 2026-10-14)

### B-PR-10 D3: never delete the newest copy of any file, including control and personal (deletion)
- **Decision:** The never-delete-newest-copy rule extends to `control.db` and the personal file.
- **Basis:** Resolves the question in B-PR-6.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Accepted. Supersedes B-PR-6. See ADR-015.
- **Decided by:** owner (Gerry, "yes continue", 2026-10-14)

### B-PR-11 D4: no automatic revoke at ImpressoRx after a post-proof refusal (keys)
- **Decision:** Option a: no automatic revoke at ImpressoRx after a post-proof refusal. The messages tell the admin to press Remove, then Enable.
- **Basis:** State-transition review I2, the part touching keys (revoking at ImpressoRx on refusal).
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded. ImpressoRx stays Active with a key Oneon discarded until the admin acts.
- **Status:** Accepted
- **Decided by:** owner (Gerry, "yes continue", 2026-10-14)

### B-PR-12 D5: Resume refreshes the deployment keys first; suspended pharmacies stay in backups (keys, deletion)
- **Decision:** Resume refreshes the deployment keys before flipping to active, and refuses if that fails. Suspended pharmacies stay in the nightly backup set and in the `backup_stale` alert.
- **Basis:** State-transition review I3: suspended files were not backed up, and Resume and re-enrolment reported success while the file might be schema-behind or its deployment keys stale.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Accepted. Review of the built work found a gap (a suspended file behind a new migration was refused by backups); fixed by B-PR-16.
- **Decided by:** owner (Gerry, "yes continue", 2026-10-14)

### B-PR-13 Owner-area Minors M1, M3, M4, M5 and M8 become Step C tickets
- **Decision:** The owner-area Minors M1, M3, M4, M5 and M8 of `state-transition-review.md` are Step C tickets. Nothing is built now.
- **Basis:** Owner areas: they wait for the owner.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded. The text of those Minors is in the review report, which is not in the sources used here.
- **Status:** Accepted, open: not built
- **Decided by:** owner (Gerry, "yes continue", 2026-10-14)

### B-PR-14 D6: automatic deletion of hourly copies, 48 kept (deletion)
- **Decision:** Hourly sealed backups keep the most recent 48 hourly copies per file. Older hourly copies are deleted automatically. Daily snapshots are never deleted automatically. The newest copy of any file is never deleted.
- **Basis:** Owner decision, 2026-10-14.
- **Assumption:** Not recorded.
- **Cost if wrong:** Not recorded.
- **Status:** Accepted, with an open question. The built code counts the 48 most recent complete hourly folders, not 48 copies per file; the review raised this as I3 and it waits for the owner (ADR-015).
- **Decided by:** owner (Gerry, 2026-10-14)

### B-PR-15 Re-review Minors N1 and N2 join the item 4 pass
- **Decision:** N1 (`holdContext` should retain the request's own lease, not lease again by id) and N2 (a refused hold answers a generic 500, and the chat catch mislabels unrelated errors as suspension) join the item 4 pass as section H. N3 (a just-resumed pharmacy with an older copy alerts until its next backup) is resolved by D5 plus section G (suspended pharmacies keep being backed up, hourly); only the comment and DEPLOY wording change.
- **Basis:** Same code, cheap, and N2 is an unexplained failure state.
- **Assumption:** Not recorded.
- **Cost if wrong:** None.
- **Status:** Accepted. Commit 943077f (`holdContext` retains the request's own lease; a lost context is 403 `context_unavailable`).
- **Decided by:** controller ruling

### B-PR-16 Explicit catch in async platform handlers; startup migrates suspended files
- **Decision:** I2: an explicit catch in every async platform handler answering an explicit status, plus a test that a repository throw gives a response, not a hang. I1: startup migration covers `suspended_by_operator` files too, with the same sealed pre-migration backup rule (not removed or `disabled_by_tenant`), so D5 holds. Resume's own migrate step stays as the backstop.
- **Basis:** Review of item 4: A to H met as written, with three Important findings. I1 a suspended file behind a new tenant migration was refused by backups (startup migrated active files only), so D5's intent failed. I2 an async suspend or resume handler had try/finally but no catch (Express 4 drops the rejection: the request hangs, and Node 15 or later can crash). I3 hourly retention is per folder, but D6 said per file. The controller judged I1 and I2 not owner areas (error handling; a schema migration with a backup first, nothing deleted).
- **Assumption:** Not recorded.
- **Cost if wrong:** A suspended pharmacy's file is migrated while not served.
- **Status:** Accepted. Commits 943077f..c321ee4. I3 is not fixed; it waits for the owner, with leftover hourly `.partial` folders (M2) and `rclone sync` versus `copy` (M3): ADR-015.
- **Decided by:** controller ruling

## ImpressoRx-side rulings (index)

These rulings changed only the ImpressoRx repository. All were controller rulings, none was reviewed by the owner when made, and all are status Accepted unless the last column says otherwise. The full text and the cross-reference to ImpressoRx's decision table (`SDA.md` section 19.1, ADR-016 to ADR-022) are here so this log accounts for every ledger "Ruling" line. Task 21's spec amendment is also listed as A4 below.

| Id | Decision | Basis | Cost if wrong | Where recorded |
|---|---|---|---|---|
| B-4-1 | Key-set changes (`POST /api/oneon/keys`) accept only Oneon keys with `retiredAt` null. Retiring keys still verify ordinary messages for 7 days. | The brief says "signed by a current, unretired Oneon key". A retiring compromised key must not survive rotation. | Oneon must rotate within the first key's life, never from a retiring key. | SDA ADR-016 |
| B-4-2 | Rotation retires only keys whose `retiredAt` is null; it never extends an existing deadline. | Safer than "every other key". | None observed. | SDA ADR-016 |
| B-9-1 | A hand-off exchange is not idempotent: its `jti` is consumed and no result is stored. If Oneon loses the 200, the person chooses Ask Oneon again. | Not recorded beyond the decision. | One extra click after a network blip. | SDA ADR-017 |
| B-9-2 | Amends the brief's rule 3: a replay within 120 s returns the cached result only when `requestId` matches and the presented value's hash equals the hash of the value presented by the original request (stored inside `lastResultEnc` as `{presentedHash, response}`). Any other request with that `requestId` is theft. | The brief's value-blind replay made `requestId` a 120 s bearer secret. | None for legitimate retries, which resend the same value. | SDA ADR-017. Task 9 fix round 1 |
| B-10-1 | Agent (delegated-token) requests are refused on every tRPC procedure unless the path is in an explicit `AGENT_ALLOWED_PROCEDURES` allow-list, which is empty in B-core. Each procedure later exposed to Oneon is added with a test proving role intersect scope holds inside its handler. | Scope narrowing existed only in `requirePermission`, while `protectedProcedure` endpoints and in-handler role checks (offline sync, search, dashboard, `sales.list`/`getById`) granted the full role. Reviewer finding in Task 10. | Oneon can call no tRPC procedure until Step C allow-lists one (B-core needs only `/api/oneon/me`). | SDA ADR-021 |
| B-10-2 | Infrastructure failures during token verification or authorization return 503, not 401, on `/me` and the tRPC route. 401 is reserved for authentication or authorization refusals. | Oneon maps 401 to `delegation_revoked` and revokes its grant (Task 19), so a database blip must not look like a revocation. The final review (I1) found the token, revoke and keys endpoints still mapped infrastructure failures to 401; fixed in B-FR-1. | None. | SDA ADR-019 |
| B-11-1 | Add `oneon.available` (`P.ONEON_USE`; true only when Active with an origin) for the button's visibility. | `oneon.status` is admin-only (`settings.oneon`), so the brief's "render when `oneon.status` reports Active" cannot work for staff. | One extra tiny query. | Not in SDA; detail here |
| B-18-1 | Idle windows per grant kind: Attended 30 min, Schedule 14 d, Action = absolute. | Closes the Task 9 pointer. Matches Oneon's Task 12 slide (B-12-2). | None. | Not in SDA; detail here |
| B-18-2 | Unattended grants record `issuedFromGrantId`. Revoking an attended grant cascades to grants issued from it only on theft (reuse detected). Expiry, sign-out and ordinary revoke do not cascade. An issued grant whose reply Oneon lost is unusable without its value, visible and revocable in the admin view, and dies at its expiry. | Unattended work must outlive the 12 h session. Closes the Task 12 pointer. | An orphaned issued grant lingers up to 60 d with nobody holding its value. | SDA ADR-018 |
| B-18-3 | The unattended refusal list is checked after, and independently of, `AGENT_ALLOWED_PROCEDURES`. A listed path or permission is refused for unattended tokens even when allow-listed. The brief's "same calls with an attended Admin token succeed" tests run with those test procedures allow-listed through a test-only seam. | The empty allow-list (B-10-1) otherwise refuses every agent call. | None. | SDA ADR-021 |
| B-18-4 | Remove resets `OneonClient.unattendedAllowed` to false (re-enrolment starts with unattended off). Disable keeps it (re-enable restores the connection; grants are revoked anyway). | Spec section 5.5: Remove means start over. | The admin flips the switch again after re-enrolment. | Not in SDA; detail here |
| B-18-5 | Exchange of an Action or Schedule grant is refused (identical 401) when `unattendedAllowed` is false. The issue path locks the `OneonClient` row (`FOR UPDATE`) before reading the switch, so switch-off and Disable serialise after the insert. | Reviewer finding in Task 18 (Critical, confirmed real): switching unattended off could leave a usable unattended grant (the issue path read the row unlocked under READ COMMITTED, and the exchange never checked the switch). Spec section 7.4. | None. | Not in SDA; detail here. Row-lock ordering was tested with a hook, not against Postgres. |
| B-18-6 | Unattended tokens are also refused any permission whose code starts with `settings.`, in addition to the plan's enumerated list. | Spec section 7.2 (`settings.*`). The spec governs the plan. | None (no procedure uses `settings.view` today). | Not in SDA; detail here |
| B-18-7 | A replayed issue result after switch-off returns 200 with an already-revoked `issued` grant, documented in `impressorx-contract.md`. | A 401 would strand the rotated attended value. | Oneon's first exchange of that grant fails with 401. | Not in SDA; detail here |
| B-21-1 | `createAuditLog` inside an agent context that lacks an `oneonActionId` throws a clear error before the insert (fail closed; the CHECK is the backstop). | Every Oneon write goes through an action (design question Q8; its text is not in the sources used here). | An attended agent write without an action id is refused until Step C gives it one. | SDA ADR-020 |
| B-21-2 | If no local Postgres is available, `verify:audit` is not faked: the implementer reports it unrun, and the CI e2e job (`pnpm db:deploy` then `pnpm verify:audit`) is the check. | See B-pre-5. | The constraints are first proven in CI. | SDA ADR-020. Status: `verify:audit` was not run locally and the migration SQL has never run against a database. |
| B-21-3 | `AuditLog_agent_provenance` drops `"userId" IS NOT NULL`. Attribution at write time is enforced by `createAuditLog` (refuses an Agent write without `userId`) and a BEFORE INSERT trigger on `AuditLog` rejecting Agent rows with NULL `userId`. `verify:audit` asserts the trigger and that a purge's SET NULL still works. | A recycle-bin purge sets `userId` NULL and the CHECK would block purging any user with Agent rows. Deletion must not be blocked by audit provenance. | One more trigger to maintain. | SDA ADR-020. Spec amendment awaiting the owner (A4). |
| B-21-4 | The never-applied migration is edited in place: `actorLabel` uses `IS NOT DISTINCT FROM 'Oneon'`; `userId` leaves the CHECK (B-21-3) and a BEFORE INSERT trigger rejects Agent rows with NULL `userId`; `fn_prevent_audit_modification` is replaced to also compare `oneonActionId` and `unattended`. | Reviewer finding in Task 21 (confirmed real): the CHECK passed a NULL `actorLabel` on Agent rows, and the immutability trigger did not compare `oneonActionId` or `unattended` (rewritable once the `userId` CHECK is relaxed). | None (nothing deployed). | SDA ADR-020 |
| B-21-5 | `enforceAuth` refuses an agent mutation whose token has no `oneonActionId` before the resolver runs. `safeCreateAuditLog` rethrows inside an agent context. A Prisma query extension on `auditLog.create`/`createMany` throws inside an agent context unless `actorType` is Agent. `AgentAudit` carries `userId` and `createAuditLog` throws on a mismatch. | Same Task 21 reviewer findings: the post-commit `safeCreateAuditLog` swallowed the missing-action-id throw (an unaudited Oneon write), and direct `auditLog.create` calls in routers wrote `User` inside an agent context. | None while the allow-list is empty. | SDA ADR-020 |
| B-21-6 | Spec section 10's literal CHECK `"userId" IS NOT NULL` for Agent rows becomes an insert-time trigger so a recycle-bin purge (SET NULL) still works. Ledger: "record for the user". | See B-21-3. | None. | SDA ADR-020. Spec amendment awaiting the owner (A4). |

Verification limit for every row that touches a database: the ImpressoRx migrations (Tasks 1, 9 and 21) and `pnpm verify:audit` have never run against a database. The migration SQL, the FOR UPDATE and cascade behaviour of Task 9, and the CHECK and trigger behaviour of Task 21 are first checked in ImpressoRx's CI Postgres job.

## Consequences

- The ledger is not in the repository. This ADR is now the repo record of the build's rulings. Where a ruling's basis or assumption was never written down, the entry says "Not recorded" instead of supplying one.
- Every ruling was a controller decision, so none was reviewed by the owner when made. The exceptions are the owner decisions in B-PR-1, B-PR-2, B-PR-8 to B-PR-14 (and B-PR-3 and B-PR-4, which came from the CTO list the owner accepted).
- Rulings in the four owner areas of `CLAUDE.md` section 5 that were made before the stop rule and still stand as controller decisions are marked in their entries ("predates the stop rule"). The marking is the writer's reading of section 5, not an owner ruling. They are: B-5-1, B-7-3, B-8-3, B-8-6, B-8-7, B-12-1, B-14-1, B-14-4, B-14-5, B-15-1, B-16-1, B-17-1, B-17-3, B-17-4, B-19-5, B-19-6, B-20-2, B-20-3, B-20-4, B-22-1, B-24-1, B-24-3, B-24-4, B-26-2, B-26-3, B-26-4, B-26-6, B-26-7, B-26-8, B-26-10, B-26-11, B-26-12, B-26-13. The owner can confirm or change each one. B-FR-4 is in this group and has already been superseded (ADR-014).
- Open for the owner, apart from the spec amendments below: the three backup questions in ADR-015 (retention per file or per folder, leftover hourly `.partial` folders, `rclone copy` versus `sync`), and the Step C tickets in B-PR-13.
- Deferred by the controller and not fixed: B-FR-7 (Suspend wording) and B-FR-8 (test gap for revocation inside the re-enrolment transaction).
- Not verified: the ImpressoRx migrations and `verify:audit` have never run against a database; row-lock ordering in Task 18 was tested with a hook; the ledger lists manual browser checks (including one for Task 20) as required before merge, and their results are not in the sources used here.

## Spec amendments awaiting the owner

Each item is a proposal. None is accepted. The spec (`docs/superpowers/specs/2026-10-07-step-b-core-design.md`) still reads as originally approved except where B-PR-1 already changed section 5.2. The final review listed these as "spec amendments to record". "Cost if wrong" is taken from the entries cited.

### A1. Section 8.4: `tenant_id` only on tenant-data tables
- **Spec says:** an additive migration gives every content table a nullable `tenant_id`.
- **Built:** only the tables that can hold tenant data in B-core carry it (conversations, action_instances and events, model_call_decisions and outcomes). Personal-only tables get none. Action config repositories, which have no `tenant_id`, check `scope` and `owner_id` against the handle instead (B-14-1).
- **Proposed wording (the writer's draft, for the owner to edit):** "Every table that can hold tenant data carries `tenant_id`; a feature that stores tenant data in another table adds it in its own migration."
- **Cost if wrong:** a later feature storing tenant data in a table without `tenant_id` must add it in its own migration.
- **Entries:** B-6-1, B-6-2, B-14-1.

### A2. Section 9.1: `tenantId` is the registry `tenant_id`, not the registration id
- **Spec says:** `tenantId` = registration id.
- **Built:** `tenantId` on actors, actions, rows and the model context is the registry `tenant_id`; the registration id travels separately as `registrationId` on `ActiveContext`.
- **Proposed wording (the writer's draft, for the owner to edit):** "`tenantId` = the tenant's registry `tenant_id` (UNIQUE on `tenant_registrations`); `registrationId` is carried separately."
- **Cost if wrong:** a rename at the adapter (B-15-1); audit rows keyed differently from action rows (B-16-1).
- **Entries:** B-14-4, B-15-1, B-16-1, B-22-1.

### A3. Section 9.4: "each provider" became "at least one configured provider", with a per-call cap
- **Spec says:** raising must stay within each provider's tenant ceiling, and a raise to D2 needs that provider's review record and DPA.
- **Built:** a raise must stay within a configured provider's tenant ceiling; only a raise to D2 also needs a provider that is reviewed and has a DPA. In a tenant context the gateway caps every provider at D1 per call unless it is reviewed and has `tenantDpa`, so a keyed provider that cannot receive D2 data cannot satisfy the gate.
- **Proposed wording (the writer's draft, for the owner to edit):** "Raising must stay within at least one configured provider's tenant ceiling, and every call is capped by the routed provider's own qualification (D1 unless reviewed and covered by a DPA)."
- **Cost if wrong:** none, per the ledger (personal context unchanged). Both tenant ceilings are D1 today, so the difference has no effect yet.
- **Entries:** B-22-3, B-22-4.

### A4. Section 10: the Agent audit `userId` CHECK became an insert trigger
- **Spec says:** a CHECK that an Agent row has `userId` and `oneonActionId` not null and `actorLabel = 'Oneon'`.
- **Built:** the CHECK no longer requires `userId` not null, because a recycle-bin purge sets `userId` NULL. A BEFORE INSERT trigger rejects Agent rows with NULL `userId`, and `createAuditLog` refuses an Agent write without it. Also built beyond the spec text: the immutability function compares `oneonActionId` and `unattended`; a query guard refuses `auditLog` writes in an agent context unless `actorType` is Agent.
- **Proposed wording (the writer's draft, for the owner to edit):** replace "CHECK ... `userId` not null" with "an insert-time trigger rejects an Agent row with NULL `userId`; a later SET NULL on purge is allowed".
- **Cost if wrong:** none per the ledger; one more trigger to maintain. Not verified: the SQL has never run against a database.
- **Entries:** B-21-3, B-21-4, B-21-6 (index above); B-FR-1 (the text amendment waits for the owner).

### A5. Section 9.4: lowering the AI limit while ImpressoRx is unreachable
- **Spec says:** "Proposed, for ruling at spec review: when ImpressoRx is unreachable, lowering may fall back to the cached snapshot's `settings.oneon`, and the row records that fallback. Raising always requires the live check."
- **Built:** no fallback. Every change, lowering or raising, needs the live check; if ImpressoRx is unreachable the request answers 503 `impressorx_unreachable` and nothing is appended (B-22-2).
- **Open question for the owner:** accept the fallback (code change needed), or amend the spec to say a lowering also needs the live check.
- **Cost if wrong:** not recorded. With the code as built, nobody can lower a pharmacy's AI limit while ImpressoRx is unreachable.
- **Entries:** B-22-2.
