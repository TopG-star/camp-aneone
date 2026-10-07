# Step B-core (Identity, Membership and Tenant Context) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a staff member open Oneon from ImpressoRx and have Oneon act only as that person, inside that pharmacy, with ImpressoRx re-authorizing every call and each pharmacy's records in its own file.

**Architecture:** ImpressoRx gains an enrolment endpoint, signed hand-offs, a grant-exchange endpoint, delegated-token authentication and `Agent` audit. Oneon gains a control database (identities, memberships, registrations, grants), a gate that opens per-tenant SQLite files as typed handles, an ImpressoRx client that alone holds grants, and per-context repositories, actors, tools and model-call audit. Personal use keeps today's `oneon.db` and behaviour.

**Tech Stack:** Oneon: TypeScript 5.7, Node 20, pnpm workspace, Express 4, better-sqlite3, zod 3, vitest 3, Next.js + NextAuth v5 (dashboard). ImpressoRx: Next.js 16, tRPC 11, Prisma 5.22 on Postgres, NextAuth v5, zod 4, vitest 4. Both: `jose` for JWS (EdDSA), Node `crypto` for AES-256-GCM.

**Spec:** [`docs/superpowers/specs/2026-10-07-step-b-core-design.md`](../../specs/2026-10-07-step-b-core-design.md). Read the sections a task cites before starting it.

## Phases and tasks

| Phase | File | Repo | Tasks |
|---|---|---|---|
| 1. ImpressoRx enrolment | [phase-1-impressorx-enrolment.md](phase-1-impressorx-enrolment.md) | ImpressoRx | 1 permissions and `OneonClient` · 2 JWS and key crypto · 3 Settings → Oneon router · 4 enrol endpoint |
| 2. Oneon control and gate | [phase-2-oneon-control.md](phase-2-oneon-control.md) | Oneon | 5 control database · 6 gate, handles, multi-file migrations · 7 identities and sessions by identity |
| 3. Enrolment, hand-off, attended grant | [phase-3-handoff.md](phase-3-handoff.md) | both | 8 Oneon enrolment console · 9 ImpressoRx grants and token endpoint · 10 delegated-token auth and `/me` · 11 hand-off minting · 12 Oneon ImpressoRx client · 13 hand-off redemption and sessions |
| 4. Tenant context | [phase-4-tenant-context.md](phase-4-tenant-context.md) | Oneon | 14 active context and per-context repositories · 15 tenant actor and per-context actions · 16 gateway and tools by context · 17 context picker and snapshot refresh · 26 linking identities (numbered 26 so later numbers stay stable; runs after 17) |
| 5. Unattended grants | [phase-5-unattended.md](phase-5-unattended.md) | both | 18 ImpressoRx unattended grants · 19 Oneon action-bound grants and approval age · 20 Settings → Connections |
| 6–9. Audit, limit, links, operations | [phase-6-9-finish.md](phase-6-9-finish.md) | both | 21 `Agent` audit · 22 tenant AI limit · 23 link ids · 24 backups · 25 rollups, link checker, job budgets |

Tasks run in order (Task 26 runs after Task 17). Each task ends with its repo's full suite green and one commit. Where a task needs the other repo, its Interfaces block names the endpoint and the Oneon side tests against a fake that implements exactly that contract (`packages/infrastructure/src/impressorx/fake-impressorx.ts`, created in Task 8 and extended in Tasks 12 and 18).

## Global Constraints

- **Branches:** Oneon `feat/step-b-core` from `main` (d96de96). ImpressoRx `feat/oneon-delegation` from `main` (a3ce5a3). Oneon's dashboard checkout used for manual testing is not switched; work in a worktree.
- **Commits:** conventional (`feat(identity): …`, `feat(oneon): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Green gates:** Oneon: `pnpm -r run build && pnpm -r run typecheck && pnpm test`. ImpressoRx: `pnpm lint && pnpm type-check && pnpm test`. After changing `domain` or `application` in Oneon, build that package before dependent tests.
- **ImpressoRx data classes:** every new Prisma model and column is added to `src/lib/data-classes.ts` in the same task (the phase 1b gate fails otherwise). Secret material (private keys, code and grant hashes) is D4; ids and statuses D1; staff ids D2 staff.
- **Signed messages:** compact JWS, `alg: EdDSA` (Ed25519), header `kid`; claims `iss`, `aud`, `iat`, `exp`, `jti`; `exp − iat ≤ 300` s (hand-off grant: 60 s); verification leeway 30 s; reused `jti` rejected within its expiry. Issuer ids: Oneon is `"oneon"`; a deployment is `"impressorx:<tenant-slug>"`. Audience is the other side's issuer id.
- **Expiries (spec):** enrolment code 10 min; hand-off grant 60 s; access token 5 min; attended grant 12 h absolute, 30 min idle; schedule grant 60 days absolute, 14 days idle; key rotation overlap 7 days; `request_id` idempotency window 2 min; snapshot age ≤ 5 min; `maxApprovalAgeHours` floor 24 for tenant actions.
- **Error codes, exactly:** Oneon action errors `approval_stale`, `delegation_revoked`, `impressorx_unreachable`; gate refusals `tenant_unavailable`, `tenant_schema_behind`; row check `tenant_mismatch`.
- **New env vars.** Oneon: `ONEON_GRANT_MASTER_KEY` and `ONEON_SIGNING_KEY_MASTER_KEY` (each base64 of 32 bytes; required once any tenant registration exists), `CONTROL_DATABASE_PATH` (default `./data/control.db`), `TENANT_DATA_DIR` (default `./data/tenants`), `BACKUP_DIR` (default `./data/backups`), `BACKUP_ENCRYPTION_KEY` (base64 of 32 bytes; required once any tenant registration exists). ImpressoRx: `ONEON_KEY_ENCRYPTION_KEY` (base64 of 32 bytes; required when `OneonClient.status` is `active`).
- **Never logged:** grant values, access tokens, enrolment codes, private keys, hand-off grants. Redaction keys: `grant`, `grantValue`, `accessToken`, `code`, `privateKey`, `handoff`.
- **Unchanged:** the 15 Action Spec statuses; the vendor API (`/api/vendor/*`); the personal database's existing tables and rows; the gateway's existing call signatures (only optional additions).
- **Anchor rows:** context files share the personal schema, whose foreign keys reference `users(id)` with `foreign_keys = ON`. Before an identity writes to a tenant file, `ensureIdentityAnchor(db, identityId)` inserts `users(id, email)` with `email = "<identityId>@anchor.invalid"` if absent.

## Review Focus

1. **A staff member's email changes in ImpressoRx.** The next hand-off lands in the same identity and membership, because the key is tenant plus user id. Test: Task 13.
2. **A hand-off arrives while the browser holds another identity's session.** The new hand-off replaces the session; it never links or merges silently. Test: Task 13.
3. **The same person launches Oneon from two tabs at once.** Two sessions, two attended grants, no theft alarm. Test: Task 12.
4. **A tenant file is missing on disk while its registration is active** (deleted, or a failed restore). The gate refuses with `tenant_unavailable` and never creates an empty replacement. Test: Task 6.
5. **The two servers' clocks differ by up to 30 seconds.** Signed messages within the leeway verify; beyond it they are refused. Test: Tasks 2 and 8.

## File map

| Path | Responsibility | Task |
|---|---|---|
| ImpressoRx `src/lib/permissions.ts` | `settings.oneon`, `oneon.use` | 1 |
| ImpressoRx `prisma/schema.prisma` + migrations | `OneonClient`, `OneonUsedJti`, `OneonGrant`, `AuditLog` changes | 1, 9, 21 |
| ImpressoRx `src/lib/oneon/jws.ts`, `src/lib/oneon/keys.ts` | signing, verification, replay, key encryption | 2 |
| ImpressoRx `src/lib/oneon/client.ts` | enable, disable, remove, enrol, status | 3, 4 |
| ImpressoRx `src/server/trpc/routers/oneon.ts` | Settings → Oneon and launch | 3, 11, 18 |
| ImpressoRx `src/app/api/oneon/{enrol,token,revoke,me}/route.ts` | Oneon-facing endpoints | 4, 9, 10 |
| ImpressoRx `src/lib/oneon/grants.ts` | grant issue, exchange, rotation, theft, revoke | 9, 18 |
| ImpressoRx `src/lib/oneon/agentContext.ts` | delegated-token verification, `AsyncLocalStorage` agent context | 10 |
| ImpressoRx `src/app/(dashboard)/settings/oneon/page.tsx` | admin UI | 3, 18 |
| Oneon `packages/infrastructure/src/database/control-migrations/*.sql` | control schema | 5 |
| Oneon `packages/infrastructure/src/database/context-db-gate.ts` | the gate, handles, cache | 6 |
| Oneon `packages/domain/src/context.ts` | `PersonalDb`, `TenantDb`, `ContextDb`, `ActiveContext` types | 6, 14 |
| Oneon `packages/infrastructure/src/database/control/*.ts` | control repositories | 5, 7, 8, 12, 22 |
| Oneon `packages/infrastructure/src/crypto/{envelope,jws}.ts` | AES-GCM envelope, JWS | 8 |
| Oneon `packages/infrastructure/src/impressorx/client.ts` | the only grant holder | 12 |
| Oneon `packages/agent-server/src/routes/{platform,handoff,contexts,connections,tenant-settings}.route.ts` | new routes | 8, 13, 17, 20, 22 |
| Oneon `packages/agent-server/src/context-wiring.ts` | per-context repositories and actions | 14, 15 |
| Oneon `packages/dashboard/src/lib/auth.ts` | `impressorx` credentials provider, `sub` | 7, 13 |
| Oneon `packages/infrastructure/src/database/backup.ts` | online backup, restore test | 24 |
