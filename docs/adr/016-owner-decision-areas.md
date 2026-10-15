# ADR-016: Owner Decision Areas (CLAUDE.md Section 5)

## Status: Accepted

## Date: 2026-10-14

## Context

The subagent workflow used for Step B-core lets the controller rule on a question and keep going instead of stalling until a person answers. Each ruling is recorded with a "cost if wrong" (ADR-013). That works for questions with a cheap, reversible answer.

It failed for one ruling. When re-enrolment of a pharmacy was built, the controller decided that a pharmacy is the same one if its pinned origin and its signed slug match (ADR-013 entry B-FR-4). The ledger recorded the trade-off as made to avoid a migration and a cross-repo contract change at merge time. This was a decision about how a pharmacy is recognised and which tenant file a request belongs to. It should have gone to the owner. When the controller later read the enrolment code, the premise "same assurance as first enrolment" held, but first-enrolment trust is only the TLS origin plus a one-time code, and the slug is just a name. The owner replaced the rule with ImpressoRx's permanent `Tenant.id` (ADR-014).

The same pattern showed up in other places. The controller also decided, without the owner, key handling (rotation, retiring, trusting keys), backup deletion, and the extension of the never-delete-newest rule to control and personal files (ADR-013 B-PR-6, later settled by the owner as D3). Under the old instruction these were decided and recorded like any other ruling.

## Decision

`CLAUDE.md` section 5, "Stop for the Owner", was added to both repositories after the CTO review (Oneon commit 07483b8, ImpressoRx commit 608b20f):

**Anything touching identity, keys, deletion or tenant matching stops for the owner's decision.**

It overrides any workflow, skill or plan that says to decide, record a ruling and keep going.

Scope:

- **Identity:** how a person, pharmacy or deployment is recognised, linked, merged or told apart.
- **Keys:** creating, storing, rotating, retiring, trusting or revoking keys, secrets, grants or tokens.
- **Deletion:** removing or overwriting data, files, backups, audit rows or history. ImpressoRx's copy adds soft-delete and purge rules.
- **Tenant matching:** deciding which tenant, registration or tenant file a request, message or record belongs to. ImpressoRx's copy says "which tenant a request, message or record belongs to".

How a subagent reports it:

1. Stop before implementing the decision.
2. Report NEEDS_CONTEXT with the options, what each costs if wrong, and the subagent's recommendation. It does not choose.
3. The controller takes the options to the owner and waits for the owner's choice.
4. Reversible choices outside the four areas are still decided by the controller and recorded as rulings with their cost if wrong.

The post-review work already followed this. The owner decided D1 to D6 (ADR-013 B-PR-8 to B-PR-14), and where the controller had acted in an owner area it said so (B-PR-6). Parts of a finding that were not owner areas, such as handle lifetime, alert timing, error handling and migrating a file after a backup, were ruled by the controller and said to be non-owner (B-PR-5, B-PR-7, B-PR-16).

## Consequences

- Work stops at these decisions. Each costs a round trip to the owner.
- Deciding whether a question falls in an area is a judgement made by the subagent or the controller. The rule is an instruction in `CLAUDE.md` and is checked in review. No mechanism enforces it, and none is recorded in the sources.
- Rulings made before the rule that fall in these areas still stand as controller decisions. ADR-013 lists them in its Consequences so the owner can confirm or change each one. B-FR-4 is already superseded (ADR-014).
- The rule says nothing about decisions outside the four areas. ADR-013 records those as controller rulings, with the cost if wrong.
- The wording in the two repositories differs slightly (see Scope). They have not been reconciled.
