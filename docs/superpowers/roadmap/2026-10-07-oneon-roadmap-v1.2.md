# Oneon Roadmap v1.2: from control plane to capabilities

**Status:** Final for implementation, pending the open items in §9 and the errata below
**Date:** 2026-10-07
**Builds on:** Action Spec framework (ADR-011), AI Data Boundary design (2026-10-03) and its Phase 1a plan
**Changes:** adds practices to the existing plan. It does not rename, renumber or replace anything already built.
**Review:** [2026-10-07 reconciliation and technical and UX review](../reviews/2026-10-07-roadmap-v1.2-review.md)

---

## Errata v1.2.1 (2026-10-07): these take precedence over the text below

The original v1.2 text follows unchanged, so every change is visible. Each erratum cites the review finding (R-number) it settles.

### Ruled by Gerry on 2026-10-07

**E1. Suppliers are D2 by default (R2). This replaces §6.2 "Supplier classes" and the §6.4 sentence on supplier names.**
- A supplier's company name and id are D2, tagged `entity: supplier`. At a D1 limit the model sees a placeholder (`SUPPLIER_n`).
- D1, unmasked, is allowed only as a deliberate exception. That means a reviewed declaration in code naming the purpose or capability and the field (boundary Decision 4). The boundary v1.1 amendment defines the mechanism. It is built when a capability first needs it (Step C).
- Supplier contacts, prices, terms and balances stay D2.
- ImpressoRx already matches. `src/lib/data-classes.ts` at a3ce5a3 has `Supplier.id` and `companyName` as D2 with entity supplier, and every `supplierId` matches.
- In the §6.4 first slice, the model sees `SUPPLIER_n` unless that exception is declared.

**E2. What a personal D2 ceiling requires (R4). This adds a row to the §6.2 provider onboarding gate.**

What the provider must show, in a one-time review record:
- API-tier terms, not consumer or free-tier terms.
- No training on submitted data, stated in the terms or contract.
- A stated retention period, with any abuse-monitoring exception disclosed. Zero retention isn't required, but it has to be known.
- No human review of content by default.
- Sub-processors and data regions disclosed, including where data is transferred.
- Deletion on request.
- The conformance test passes in CI. That covers JSON mode, no content in logs or audit, timeouts and usage fields.
- A named reviewer and a review date, with re-review when the terms change materially.

What the person must do:
- Give an explicit opt-in that names the provider, as part of the confirmed, versioned set.
- Receive a plain-language notice of what D2 includes. That includes other people's words in emails and messages, which they can't consent for.
- Be able to revoke the opt-in at any time, with immediate effect.

What stays the same:
- The effective ceiling is still the lowest of the provider ceiling, the env override, the person's choice and the purpose limit.
- D3 and D4 never go.
- A provider that hasn't completed review runs at personal D1.

Where it differs from tenant D2: tenant D2 additionally needs a signed DPA and a tenant admin's choice. Personal D2 doesn't need the DPA, because the person opts in for their own data. That reasoning has a gap: a person's D2 includes third parties' text, so counsel should confirm that personal opt-in is enough under Act 843 (added to §9 as item 9).

DeepSeek specifically: its current terms, retention and transfer position can't be verified from here. The §6.1 terms check is a hard gate. If DeepSeek can't meet the no-training and retention-disclosure bar, it stays at personal D1 and out of the opt-in set. The same applies to Google and OpenAI until their review records exist.

*Consequence for what is built.* The registry marks DeepSeek and Anthropic `unreviewed`, yet gives them a personal ceiling of D2. Under E2 an unreviewed provider runs at personal D1. Once v1.1 ships, email sorting and the AI briefing stay paused until two things are true: the configured provider has a complete review record, and the person has confirmed. This is a deliberate behaviour change and an exception to §10's first guarantee.

**E3. Flatten the memory tool's `metadata` (R6). This replaces "the search tool's metadata" in the §6.2 free-text list.**
- Replace the object with declared string fields: `tags` and `path`, both D2 free text. Drop the ids.
- Marking the object itself as free text would make the gateway always withhold it, because non-string free text can't take span removal.
- The other three strings are marked free text as written.

**E4. Sequencing.** Boundary v1.1 code (§6.2) starts after the Phase 1a PR merges. The Step B spec (§6.3) has no code dependency on 1a and can start meanwhile.

### Corrections of fact (no ruling needed)

**E5. §4 and §6.1 status (R1).**
- Already done at 535e132:
  - the input-check gap (one matcher for every form of a restored value; ADR Decision 10 and spec §6.3 match the code);
  - the pasted-secret rule (three-way by location, with the rotate notice);
  - a verified failure of the architecture test when a provider client is imported from outside the gateway.
- Phase 1b is on ImpressoRx `main` (a3ce5a3).
- Left in §6.1:
  - `MODEL_AUDIT_HMAC_KEY` in a secret manager;
  - the DeepSeek terms and JSON-mode check in staging, now also E2's gate;
  - the flake ticket;
  - opening and merging the PR.

**E6. Out-of-date model defaults (R12).**
- `env.ts` defaults Anthropic to `claude-3-5-haiku-20241022` and `claude-sonnet-4-20250514`.
- ADR-004 names `deepseek-chat`, while the 1a plan uses `deepseek-v4-pro` and `deepseek-v4-flash`.
- Update both with the tier configuration. Verify the Appendix A names for Google and OpenAI before use.

### Proposed, awaiting ruling

| # | Section | Proposal |
|---|---|---|
| P1 (R3) | §3 | The fast role falls back to the standard provider when unconfigured, and expert falls back to none (denied). Without this, declaring T1 changes routing. |
| P2 (R5) | §6.2 opt-in set | Keep one `ai_data_choices` row per provider. A set confirmation writes one row per provider, carrying `set_version`. The decision engine is unchanged (newest row per provider wins). A provider added later has no row, so it runs at personal D1 until a new confirmation. |
| P3 (R7) | §5, §6.5 | Name the new column `failover_hop` (0 or 1). `model_call_outcomes.attempts` keeps counting same-provider retries. |
| P4 (R8) | §6.5 | The amendment to boundary spec §6.8 ("no automatic fallback") is written when §6.5 starts, not in v1.1. |
| P5 (R9) | §6.5, §7 | Cost comes from a dated price table per model in configuration, applied to the token fields. Audit rows never store prices. |
| P6 (R10) | §6.4, §7 | A driver and handoff are required only for capabilities reachable from an unattended entry point (a scheduled run or a channel auto-reply). |
| P7 (R11) | §6.4 step 5 | The PO action's input may carry quantity, so a person can change it. Only price, total and balance fields are banned (AX2). |
| P8 (R13) | §3 | Shadow stays a role outside the tier map, with its own decision per call. |
| P9 (R14) | §6.2 | The CI scan for raw model-API endpoints is a pattern search. It can't see URLs built at run time, and the test says so. |

### Added to §9 (open decisions)

9. **Personal opt-in and third parties (E2).** Counsel confirms whether a person's opt-in suffices under Act 843 for other people's words in their email and messages.
10. **ImpressoRx branch protection.** GitHub accepted a direct push to `main` on 2026-10-07. Decide whether `main` requires pull requests and the "Lint, Type-check & Unit Tests" check, so the Phase 1b gate actually blocks merges.

---

## 1. Purpose and limits of this document

Oneon is the intelligence, interaction and orchestration layer above ImpressoRx. ImpressoRx stays the system of record. This document records which additional practices Oneon adopts, where each one lands in the existing plan, and which existing parts change.

What does not change:

- the three-part shape (intelligence, interaction, orchestration) over one control plane;
- the numbering: Step A, B and C, plus boundary phases 1a, 1b and 2;
- the Action Spec status machine (15 statuses);
- the gateway's public interface. Changes to it are additive only;
- the rule that the boundary governs disclosure to AI providers, not Oneon's own use of data (boundary spec §1.1). Staff always see real data.

## 2. Doctrine

1. **Control plane before experience layer.** Identity, authorization, the AI data boundary and the Action Spec come before new interfaces.
2. **Capability before channel.** A business function is defined once and reached from chat, schedules, dashboards and every channel. There is one implementation per function.
3. **AI is optional inside a process.** Deterministic code, queries and analytics run first (tier T0). A model is called only to interpret or explain.
4. **Reasoning is separate from execution.** A model may propose. Code defines the exact action, policy authorizes it, an executor performs it, and a check confirms it.
5. **One driver at a time.** Automation and a person never steer the same conversation at once. Taking over pauses automation until it is handed back.
6. **Every disclosure is deliberate.** Every model call goes through the gateway, and a model receives the minimum needed for the purpose.
7. **Friction scales with risk.** A trusted, reviewed provider carries no per-call approval and no extra screens. An unknown provider has no access at all.

Before building any capability, answer five questions: what is the authoritative source, what is deterministic, what needs a model, what can Oneon actually do (its Action Spec), and what happens if a person steps in. If any answer is missing, the capability is not ready.

## 3. Vocabulary and model tiers

One vocabulary only. Each term below is either mapped to something that exists or explicitly adopted.

| Term | Decision |
|---|---|
| model-call audit | Existing `model_call_decisions` and `model_call_outcomes`. No second store. |
| data pick (what was released) | Existing `released_json` and `withheld_json`. No new object. |
| capability | Adopted in Step C as a composition layer over existing tools and Action Specs (§6.4). |
| model roles | Existing standard, reasoning and shadow remain the router's mechanism. Tiers (below) are the vocabulary purposes declare; each tier resolves to a role plus configuration. |
| simulation mode | Dropped. Only live and dry-run exist. |
| driver | Adopted in Step C as an attribute of a conversation (§6.4). |

### Tier map

| Tier | Meaning | Resolves to today's role | Planning share |
|---|---|---|---|
| T0 | No model. Deterministic ERP and analytics. | none | 20–40% |
| T1 micro / T1 fast | High-volume everyday intelligence (classification, extraction, short replies). | new role (fast) | 35–50% |
| T2 standard | Main Oneon reasoning. | standard | 10–25% |
| T3 deep reasoning | Complex business analysis. A model plus a higher reasoning-effort setting, not necessarily a different model. | reasoning | 3–10% |
| T4 expert | Exceptional strategic reasoning, gated and rare. | new role (expert) | under 1–3% |

Rules:

- **Purposes declare a tier.** The four existing purposes map without behavior change: `email_classification` and `intent_extraction` to T1, `chat_reply` and `daily_briefing` keep today's reasoning role (T3) until measured. Standard and reasoning keep working exactly as now.
- **Names live in configuration.** Specific model names, primary and alternates per tier, are configuration in the provider registry and environment, not part of this plan. The names supplied for the first configuration are listed in Appendix A and must be verified for availability and terms before use.
- **DeepSeek stays.** It is an alternate in T1 micro and T1 fast. It remains subject to the same limits as every provider.
- **Shares are hypotheses.** The planning shares are targets to compare against measured cost and token audit data. The router does not enforce them.
- **T4 is gated.** A per-call and per-tenant ceiling on cost, and a purpose allow-list. Nothing reaches T4 by default.
- **Failover never changes the class limit.** See §6.5.

## 4. Where things stand

| Area | State |
|---|---|
| Step A: Action Spec | Built. |
| Boundary Phase 1a | Built on `feat/ai-data-boundary`, not yet merged. Closure checklist in §6.1. |
| Boundary Phase 1b (ImpressoRx classification and CI check) | Separate plan, runs in parallel. |
| Step B: identity, membership, tenant context | Spec not yet written. Additions in §6.3. |
| Boundary Phase 2 (read tools, tenant contexts) | After Step B. |
| Step C: first end-to-end business capability | After Step B. Shape in §6.4. |

## 5. What changes in what exists

| Existing component | Change | Type |
|---|---|---|
| Action Spec status machine | None. | none |
| `action_instances` | Nullable `model_call_id` linking an action to the model call that proposed it. | additive migration |
| `action_events` and `action_instances.input_json` | Hold content (addresses, subjects). Need a controlled redaction and retention mechanism. | new migration (§6.3) |
| `model_call_decisions` | Add a turn or conversation id, a request correlation id and an attempt number, so a decision joins to an action, a turn and a failover chain. | additive migration |
| `model_call_outcomes` | Add a failure-class field (§6.5). | additive migration |
| `ai_data_choices` | Foreign key to `users(id)` blocks deleting a user while choices exist. Resolve inside the retention work. Also records the confirmed provider-set version (§6.2). | decision (§9) plus additive column |
| Gateway | No interface change. Mark four D2 string fields as free text so the scanner covers them at D2. Add a CI search for raw model-API endpoints outside the provider clients. Add the failover rule (§6.5). | small fix plus additive |
| Provider registry | Add per-provider review record and tier assignments (§6.2). Registers Google and OpenAI providers when configured. | additive |
| Tool output schemas | Unchanged. Capabilities reference them. | none |
| Model router | Roles stay. Purposes gain a tier declaration. Two new roles (fast, expert). | additive |
| Step B identity | Add a typed, scoped channel-identity slot. No merge logic. | addition |
| Authorization at execution | Add an ImpressoRx re-check through a short-lived token bound to the staff member. | addition |
| Sends outside the Action Spec (deadline reminders, cycle alerts, action-status notices) | No change. They stay outside (§6.4). | none |

## 6. Sequence

### 6.1 Phase 1a closure (before the PR merges)

- Fix the parked input-check gap. The check must match every form of a restored value (bare address, header form, case and plus-address variants), with tests for each. Correct the two doc sentences (ADR Decision 10, spec §6.3) so they match the code.
- Decide the pasted-secret rule (spec C4). A secret in the current message denies that turn with a clear message. A secret in an older history turn withholds that turn only. A declared D4 field from a tool still denies the whole call. Tell the person to rotate a pasted secret.
- Deploy `MODEL_AUDIT_HMAC_KEY` from a secret manager, with a backup. Keep every key version.
- Check DeepSeek's current terms and that `deepseek-v4-pro` accepts JSON mode, in staging.
- Open a separate ticket for the flaky `actions.route.test.ts` test that also fails on main.
- Verify the architecture tests fail when a provider client is imported from outside the gateway.

Exit: PR merged with CI green and a staging smoke test showing audit rows without content.

### 6.2 Boundary spec v1.1 (small amendment, independent of Step B)

**Text and data rules**

- Restate the third-party text rule: any text not typed by the signed-in person is D2 free text, including email bodies, Teams and GitHub text, and inbound messages from every channel (Webchat, WhatsApp, Telegram, Messenger, Instagram).
- Mark these D2 strings as free text so the scanner checks them: GitHub notification subject, Teams `channelName`, GitHub repository, the search tool's metadata.
- Derived-data rule: an embedding or index carries the class of its source, and an embedding call is a model call that goes through the gateway as its own purpose.
- Untrusted-content rule: synced or scraped pages and uploaded files are untrusted and are scanned and withheld like email bodies.
- Retention of append-only audit rows stays an open item (§9).

**Supplier classes (for Appendix A and Phase 1b)**

- Supplier company name: D1, unmasked. It is tagged as an entity, so a pharmacy can turn on placeholder masking later without a schema change.
- Supplier contact person, phone and email: D2.
- Supplier prices, terms and balances: D2.

**Provider onboarding gate (code and config, no per-call approval, no new UI)**

- An unregistered provider is unavailable. This is already enforced.
- A registered provider has a versioned review record in the registry: terms link, retention, training use, regions, DPA status, review date and reviewer.
- A provider conformance test runs in CI: JSON mode, error handling, no content in logs or audit, timeouts, usage fields.
- Review depth scales with the ceiling being raised. Tenant D1 needs a short read of the terms. Tenant D2 needs a signed DPA. D3 is never allowed.
- Promotion is a one-line registry change with a dated evidence link. Tenant admins can lower a ceiling, never raise it.
- Defaults stay as today: personal D2 only through opt-in, tenant D1.
- A one-time review is per provider, and is repeated when the provider's terms change materially. Quality level is a tier assignment, not a separate review.

**Personal opt-in set**

- One confirmation covers a named, versioned set of providers. The set is explicit and immutable once confirmed, and the confirmed set version is stored with the choice.
- Adding a provider creates a new set version and requires a new confirmation. Until then the new provider runs at personal D1.
- Initial set for confirmation: DeepSeek, Anthropic, Google, OpenAI. The DeepSeek terms check (§6.1) precedes the confirmation.

Exit: amendment merged. No code change beyond the free-text marks, the registry fields and the set-version column.

### 6.3 Step B additions

Added to the Step B design (the spec is not yet written):

- **Identity.** One identity with many login identities, as already decided. Add a channel-identity slot, typed by channel and scoped. It never assumes a phone number or an email: WhatsApp uses a phone number, Telegram a user id, Messenger and Instagram ids scoped to the connected page and not matchable across pages, Webchat an anonymous session. A channel identity is a candidate, not an authorization. No merge logic until a channel exists. A merge is allowed only after verification.
- **Channel architecture (from day one).** A channel adapter layer carries inbound normalization, outbound sending, identity slot, and channel limits. It serves two audiences from the start: staff-facing and customer-facing. Only staff-facing is exposed first. Customer-facing stays off until the staff-facing capability is reliable and the customer-facing rules below are met.
- **Customer-facing preconditions.** Inbound text is D2 free text. A customer's identity is unverified until proven. Customer-facing replies do not read tenant data beyond what the capability permits, and any action proposed from a customer message needs a staff approval step. Messaging-window and template rules for Meta channels must be checked against the platform's current policy before any send path is built.
- **Authorization at execution.** Step A already re-checks preconditions, resolve, changes since approval and policy before calling the executor. Step B adds an ImpressoRx check through a short-lived token bound to the tenant and the staff member. Cached authorization can speed decisions but never authorizes a consequential write. Audit entries for writes read "Oneon on behalf of" the staff member.
- **Tenant limit storage.** Where a pharmacy's AI limit is stored and who may change it (already assumed in boundary spec §13).
- **Retention and deletion.** A schedule per data class, with purpose, storage location, deletion mechanism, legal basis and audit. See §9.
- **Link id.** The migrations in §5 that join model decisions, actions, conversation turns and failover chains.

Exit: Step B spec written and approved with these items present.

### 6.4 Step C: first end-to-end capability

**Capability contract.** A capability is a typed definition that references what exists. It contains:

- an id, input and output schemas;
- required permissions and tenant and location scope;
- the tools it uses and the action definitions it may propose, referenced by id, never copied;
- the purposes it calls (so the gateway decides every disclosure) and each purpose's tier;
- whether it supports dry-run, and its audit requirements.

Field classes stay with the tools. The capability does not restate them. Enforcement stays in the gateway. A contract test checks that no action input schema has a field for a price, total or balance, so the model cannot supply those values (this makes the AX2 convention structural).

**Dry-run.** A function that runs the validation steps (preconditions, resolve, policy decision, description) and returns the preview without saving an instance. It still performs live, authorized reads. The output states that no records were created.

**One driver.** A conversation has a `driver` of Oneon or a person, stored in its own append-only events. The Action Spec status machine is untouched, because actions are already serialized. A person taking over pauses automation. Hand-back is explicit. When workflow runs exist, the same attribute applies to them.

**Delivery status.** Outbound messages that are replies or proposals reach the person through channel adapters, and each reports a status per channel (sent, delivered or failed). A channel reports only what it can know. The word "verified" is not used for delivery. Email send and Teams send need executors (and permissions) before they can report anything.

**Sends that stay outside the Action Spec.** Deadline reminders, cycle alerts and action-status notices are system notifications, not model-written or third-party content. They remain outside the Action Spec and outside delivery status, so they do not carry its overhead. They join the Action Spec only if one starts carrying model-written text or goes to a third party.

**First slice: inventory risk to purchase order.**
1. The person asks which products may run out in 14 days.
2. Code (T0) reads inventory and sales aggregates through the capability and computes risk with a deterministic forecast.
3. A model explains the result, receiving D1 data only.
4. The person asks for purchase orders for the critical products.
5. An Action Spec proposal takes its facts (supplier, price, quantity, totals) from resolve, never from the model.
6. Authorization, approval, execution through Step B's delegated access, verification, audit.
7. The same capability is then reached from a scheduled run and a dashboard card, with no second implementation.

A supplier company name may travel to the model unmasked as D1. Supplier prices, contacts and balances stay D2 and never reach the model in this slice. Procurement read tools come later. An ML forecast replaces the deterministic one only after the slice works.

Exit: the slice runs end to end in a test tenant, and the definition of done in §7 passes.

### 6.5 Model routing, failover and cost controls

Starts after Step C or earlier if the tier work is needed. Uses the token and cost fields already in `model_call_outcomes`.

**Tier routing.** Each purpose declares a tier. Each tier has a primary provider and ordered alternates, held in configuration. Every alternate must be registered and reviewed to at least the ceiling the call needs.

**Failover rule (amendment to the boundary's no-fallback rule).**

- Failover is allowed only for a provider failure, decided by an explicit failure-class check: timeout, network error, 5xx, 429 rate limit, or an open circuit. It is never allowed for a denial, a block, an answer-check failure, or a client error (4xx).
- A failover is a fresh routing decision, not a fresh identity. The alternate goes through the full gateway decision against its own limits and review status. If the alternate's limit is lower than the data requires, the call is denied, not degraded and not sent.
- The request keeps its correlation id and idempotency key. Each attempt has its own attempt number and decision row, so the audit shows the whole chain.
- The model gateway returns text only and has no side effects, so a retry cannot duplicate a business action. A failed call never undoes an action (AX5).
- Cap: one failover hop per request, and a per-tenant failover budget per time window.
- Circuit breaker per provider: repeated failure opens the circuit, requests skip that provider for a cooldown, and a half-open probe closes it. A circuit opening is visible to operators.
- A tier's secondary must be at least as capable as the primary for that purpose. A fast model is not an acceptable fallback for T3 or T4 work. Where no suitable alternate exists, the call fails with a clear message.

**Cost visibility.** Token and cost usage per tenant, purpose and tier, visible to the pharmacy and to operators. T4 has a hard ceiling.

**Proactive insight.** Rules or models detect a signal from ImpressoRx data, a model explains it, and an Action Spec proposes the response.

**Later.** Knowledge, staff copilot, workflows, command inbox, multi-channel identity merge, an external agent gateway. Each starts when its trigger in §8 is met.

## 7. Definition of done for a capability

A capability is production-ready only when all apply:

- typed contract with schemas, permissions and scope;
- tenant context and authorization from Step B;
- every model call through the gateway, with a purpose, a tier and classified parts;
- deterministic retrieval for facts, with the model limited to interpretation;
- output validation;
- audit rows without content;
- cost tracked per call;
- retention class assigned;
- failure handling and tests.

Where the capability can act, also:

- an Action Spec with approval policy and verification;
- dry-run;
- driver and handoff behavior;
- delivery status if it sends replies or proposals through a channel.

Read-only capabilities do not need the second list.

## 8. Deferred, with triggers

| Item | Starts when |
|---|---|
| Staff-facing chat channel (first) | Staff-facing capability reliable, adapter layer built (§6.3). The first channel is chosen then (§9). |
| Customer-facing channels | Staff-facing is reliable, one provider has completed review, a tenant has opted in to D2, and the customer-facing preconditions in §6.3 are met. |
| Additional channels (Webchat, WhatsApp, Telegram, Messenger, Instagram) | The adapter layer exists. Each channel adds an adapter and a typed identity slot, not a new capability. |
| Staff copilot | One provider has completed review and a tenant has opted in to D2, because inbound customer text is D2. |
| Knowledge | A concrete document use case exists, and the derived-data and untrusted-content rules (§6.2) are in the spec. |
| Workflows (typed) | At least two capabilities exist and a customer needs a multi-step process. Each model step is its own gateway call. |
| Command inbox | Handoff semantics and delivery status are built and a second channel exists. |
| Multi-channel identity merge | A channel exists and verification is designed. |
| T4 expert tier | A named purpose needs it and the cost ceiling is set. |
| External agent gateway | Last. Tokens bound to tenant and membership, short-lived, one per agent or machine, narrow scopes, immediate revocation, role ceiling, separate scopes for personal data and debug. It sits behind the gateway like every other path. |
| Gradual rollout per tenant | More than one paying tenant. |

## 9. Open decisions

Decided in this version: suppliers (§6.2), the provider onboarding gate (§6.2), the personal opt-in set (§6.2), failover (§6.5), sends outside the Action Spec (§6.4), channel list and architecture (§6.3), DeepSeek stays (§3).

Still open:

1. **Retention approach.** Recommended: for the model-call audit tables, pseudonymize by erasing the identity mapping; for `action_events` and related input JSON, a controlled redaction and retention migration. Counsel must decide two things: retention periods under Act 843, and whether destroying an old HMAC key version (to make fingerprints unlinkable) overrides the current rule to keep every key version.
2. **T1 micro versus T1 fast.** The two sub-levels are named but not defined. Proposed: micro for classification and extraction, fast for short replies and summaries. Confirm or correct.
3. **T3 secondary.** The tier table lists a fast model as the secondary for deep reasoning. §6.5 forbids a weaker fallback. Confirm that T3 has a secondary at the same level, or none.
4. **T4 ceiling.** Per-call and per-tenant cost ceilings and the purpose allow-list.
5. **First channel.** Which staff-facing channel ships first.
6. **Driver unit.** Confirm the conversation is the unit now and that "driver" means who is steering (Oneon or a person).
7. **Email and Teams send.** When do the Gmail send and modify permissions and a Teams send executor get added? Delivery status for those channels waits on them.
8. **Link id shape.** A turn id, a conversation id, or both on `model_call_decisions` (the failover chain adds a request correlation id and attempt number regardless).

## 10. Continuity guarantees

- Nothing in §6.1 or §6.2 changes behavior except the stricter input check, the free-text marks and the registry and set-version fields.
- No Action Spec status is added, removed or renamed.
- The gateway interface only gains optional fields.
- Standard and reasoning roles keep working unchanged. Tiers are an addition.
- Every migration is additive except the retention migration, which is designed and reviewed separately.
- Each step ends with build, typecheck and the full test suite green, and one reviewed commit or PR.

## Appendix A. First provider configuration (as supplied, to verify)

Held in configuration, not in code. Availability, exact identifiers and terms must be verified before use. Names for non-Anthropic providers are as supplied and have not been independently checked.

| Tier | Primary | Alternates |
|---|---|---|
| T1 micro / fast | Gemini 3.8 Flash | GPT-6 Luna, DeepSeek |
| T2 standard | GPT-6.1 Sol | Claude Sonnet 5.5 |
| T3 deep reasoning | Claude Sonnet 5.5 or GPT-6.1 Sol at high reasoning effort | same level (§9 item 3) |
| T4 expert | GPT-6 Astra | Claude Opus 5.5 |

New vendors to register and review before use: Google and OpenAI. Until each passes its review record, it runs at tenant D1 and personal D1 only.
