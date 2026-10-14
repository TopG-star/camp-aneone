# ADR-014: Pharmacy Identity Is ImpressoRx's Permanent Tenant.id

## Status: Accepted (owner decision, Gerry, 2026-10-14)

## Supersedes: the re-enrolment identity rule in ADR-013 entry B-FR-4 (pinned origin plus signed slug)

## Date: 2026-10-14

## Context

Oneon recognised a connected pharmacy by its tenant slug. The slug is a name that ImpressoRx chooses and shows; it is not a stable identity. A pharmacy deleted in ImpressoRx and set up again can come back under the same slug. Matching on a name like that is the nOAuth pattern: a person or system is treated as the same one because a self-declared, reusable attribute matches.

The first build of re-enrolment (B-FR-4) matched on the pinned origin plus the slug signed in ImpressoRx's enrol reply. The controller decided that without the owner, as a trade-off to avoid a migration and a cross-repo contract change at merge time. The ledger recorded the cost if wrong: an ImpressoRx that deleted and recreated a tenant under the same slug could be re-attached to the old pharmacy's tenant file. Re-enrolment keeps the tenant file, its `tenant_id` and its memberships, so a wrong match hands the old pharmacy's conversations and actions to whoever now holds the slug. This was an identity and tenant-matching decision that should have gone to the owner (ADR-016).

What first enrolment proves is narrower than the first build assumed. Oneon trusts the deployment key it receives during enrolment. That trust rests on two things only: the operator's out-of-band check of the deployment's HTTPS origin (TLS), and the one-time enrolment code (128 random bits, shown once, valid 10 minutes, single use). The enrol reply is verified with the public key the reply itself announces, so the signature proves nothing on its own: it shows that whoever answered holds the key they announced. The code is what ties the reply to the real deployment. The slug in the reply is just a name.

After the CTO review the owner accepted the before-merge list with a permanent-id fix. Gerry committed it himself (Oneon 688b6a2, ImpressoRx 6a7362f) and then answered the open questions about legacy rows (B-PR-8, "D1").

## Decision

1. **What identifies a pharmacy.** ImpressoRx's `Tenant.id`. ImpressoRx signs it into the enrol reply as `impressorxTenantId`. DEPLOY.md states that the id is made once per pharmacy database and never reused. That guarantee comes from ImpressoRx and is not enforced by Oneon.
2. **What Oneon stores.** The id is stored on the registration as `impressorx_tenant_id` (control migration 006). It is a separate column from `tenant_id`, which is Oneon's own id for the pharmacy's rows. The slug stays as a display name and as an input to enrolment (the enrol request's audience is `impressorx:<slug>`).
3. **Uniqueness.** The column has a unique index where it is set, so one pharmacy, or a copy of its database, cannot hold two registrations. Enrolment is refused (409, per DEPLOY.md) when another registration already holds the id. Enrolment is refused (502) when the reply names no id, which means the ImpressoRx release is too old. Both refusals come after the code has been used.
4. **Re-enrolment compares it.** Re-enrolment is allowed only while the registration is suspended by the operator, the ImpressoRx origin equals the pinned origin, a fresh code is proved through the normal two-sided enrolment, and the signed `impressorxTenantId` equals the stored one. A reply with a different id is refused. On success the keys are replaced at once with no overlap, every grant of the registration is revoked, and the tenant file, `tenant_id` and memberships are kept.
5. **NULL is not allowed (owner decision D1, option b).** Control migration 007 refuses to run while any registration has a NULL `impressorx_tenant_id`. The migration's transaction rolls back, nothing is changed, and the server refuses to start, naming every such registration. Insert and update triggers on `tenant_registrations` also abort a NULL. The reason for the rule: with a NULL stored, re-enrolment would record whatever id the next re-enrolment presents (trust on first use), which reopens the slug-reuse gap for that row. A control file that holds such a registration predates the id, and no production registration does. It must be created again, not patched by hand (DEPLOY.md).
6. **Trust at first enrolment is unchanged.** It is the TLS origin plus the one-time code, with the operator checking the origin against the tenant registry out of band. The reply's self-announced key proves nothing on its own, and the signed `Tenant.id` is as trustworthy at first enrolment as the rest of that reply. What the id adds is a fixed point for every later enrolment of the same registration.

## Consequences

- Re-enrolment can no longer re-attach a recreated pharmacy to an old tenant file just because it reuses a slug. A different `Tenant.id` is refused.
- First enrolment is still trust on first use for the origin-plus-code step. An attacker who controls the origin an operator types and holds a valid code is not stopped by the id. Mitigation is the operator's origin check and the short, single-use code, as before.
- The guarantee depends on ImpressoRx. If ImpressoRx ever reused a `Tenant.id`, or a restored database kept an old one, Oneon would treat it as the same pharmacy. Nothing in Oneon checks that.
- ImpressoRx must run a release that signs the id before a pharmacy can enrol (otherwise 502). A pharmacy already enrolled before the id existed holds no id and, under migration 007, stops the server from starting until the control file is created again. No production registration exists, so the cost so far falls on development and test control files only.
- Two columns now carry names of a pharmacy: `tenant_id` (Oneon's own) and `impressorx_tenant_id` (ImpressoRx's). Code and docs must not mix them up.
- Not verified: the ImpressoRx side that signs the id was checked by its test gates; ImpressoRx migrations have never run against a database (ADR-013).
- The ledger does not record which other options the owner was offered besides the one chosen ("option b" for NULL ids, and "the permanent-id fix instead of a switch"). Option (c) in B-FR-4, a stable ImpressoRx tenant id in the reply, is the one that was taken.
