# Oneon AI Data Boundary — Design

**Status:** Draft for review
**Date:** 2026-10-03
**Decided with:** Gerry (product owner), in a design session on 2026-10-03
**Builds on:** the Action Spec framework (ADR-011, `docs/superpowers/specs/2026-10-01-action-spec-framework-design.md`)
**Comes before:** Step B (Identity, Membership & Tenant Context), then Step C (first end-to-end business capability)

---

## 1. Purpose

Oneon is becoming the intelligence and action layer for businesses that run on ImpressoRx. It already sends data to AI models: email content, chat messages, tool results, calendar events. As soon as Step B connects pharmacies, that data will include customer credit, supplier prices and controlled-drug records.

Today nothing stands between that data and the model provider. Any code that can build a prompt can send anything to any configured provider, and shadow mode silently sends a second copy elsewhere.

This spec adds a second safety plane beside the Action Spec framework:

| Plane | Question it answers | Mechanism |
|---|---|---|
| Action safety (Step A, built) | What may Oneon **do**? | Action definitions, policy floor, approval, verified execution |
| Data safety (this spec) | What may an AI model **see**? | One Model Gateway in front of every model call |

The principle:

> **Oneon does not give AI access to data. It gives a model the minimum data needed for an authorised task, and nothing reaches a model without a recorded decision.**

And its corollary:

> **No provider is trusted because it is approved. The gateway, not the provider, is the security boundary.**

## 2. Decisions this spec records

All made on 2026-10-03 unless noted.

1. **Every model call passes through the boundary**: personal email, calendar and chat, every future tenant, shadow mode, routing, and future reports. Rules depend on the context. Personal context can be looser than tenant context, and secrets are never sent.
2. **Field classes are declared in code, default-deny.** A data source declares each field's class. A field without a class is never sent. A scanner on free text is a backstop only.
3. **Limits form a hierarchy.** The platform sets each provider's maximum. A person (for their personal space) or a pharmacy admin (for their business) can only lower it. The effective limit for a call is the lowest of all layers.
4. **Placeholders lower a field's class only where a reviewed declaration in code says so.** Nothing is downgraded by default.
5. **The audit trail records decisions and the shape of released data, never content.** Fingerprints use a keyed HMAC.
6. **Day-one limits:**
   - Personal context: D1 for every provider by default. D2 needs an explicit, per-provider opt-in by the person.
   - Business context: D1 for every provider until that provider's vendor review and data-processing agreement are done.
   - D3: never sent to an external provider. D4: never sent anywhere.
7. **Gateway and provider registry live in Oneon.** Oneon is the party calling models and the party that signs processor agreements. ImpressoRx owns field classification next to its schema, and read tools that return already minimised, labelled data.
8. **Implementation option B: structured model requests**, with an approved-call type that only the gateway can construct (§5).
9. **Spec order:** this spec, then Step B, then Step C. No business data reaches any model before phase 2 (§11).
10. **Gerry's personal DeepSeek opt-in.** On 2026-10-03 Gerry consciously approved DeepSeek receiving his personal email content (D2) until this gateway is built. This is recorded as his decision, not something this spec assumes. When the gateway ships, the opt-in becomes a dated, versioned policy entry that takes effect only after Gerry confirms it once in Settings → AI data, having checked DeepSeek's current terms (§10.3).

## 3. Scope

**In scope (built in phase 1a/1b):**
- data classes;
- the model request structure and the approved-call type;
- the decision rules;
- minimisation and placeholders;
- the answer check;
- the provider registry with an emergency override;
- the D3/D4 scanner;
- the audit trail;
- migration of the four existing model call sites;
- Settings → AI data;
- ImpressoRx's classification map and merge-blocking check.

**Defined here, built later:**
- ImpressoRx read tools (phase 2, after Step B);
- the report pipeline and recipient-specific report versions;
- local or self-hosted models;
- debug and controlled-audit content retention.

**Out of scope:**
- vendor reviews themselves (a process, not code);
- WhatsApp and Telegram channels;
- Oneon's memory layers;
- retention of stored conversations (Step B, where business conversations first appear).

## 4. Data classes

One scale for data sensitivity. It is deliberately separate from the action risk tiers L0–L4.

| Class | Meaning | Examples |
|---|---|---|
| **D0** Public | Safe anywhere | Tool names, generic terminology, code-written instructions |
| **D1** Internal | Business or personal information that identifies no one on its own | Stock quantities, aggregate sales, product names, your own chat message |
| **D2** Confidential | Identifies a person or business, or is commercially sensitive | Customer names and balances, supplier prices, cost prices, email bodies, staff identities |
| **D3** Highly sensitive | Health-linked or patient-linked information about an identifiable person | Controlled-drug buyer names, an individual customer's medicine purchases |
| **D4** Secret | Must never reach any model | Passwords and hashes, API keys, tokens, card numbers |

**Free text** (email bodies, notes, chat history) is D2 by declaration, because its content is not known in advance. Placeholders never apply inside free text.

**Legal framing, to be confirmed by counsel.** Ghana's Data Protection Act 2012 (Act 843) requires processing to be necessary and not excessive, to have a lawful basis, and to be secured. Processors must work under a written contract, including processors outside Ghana (s.30). Health information is special personal data (s.37). The Act is not read here as a blanket ban on transfers abroad. The 2025 Data Protection Bill is not law. Business confidentiality (supplier prices, margins) is protected for commercial reasons, not only legal ones.

## 5. The model request and the approved call

### 5.1 Structured requests

Code that needs a model does not build a prompt string. It hands the gateway a request:

```ts
interface ModelRequest {
  context: ModelContext;        // built by the server, never by the model
  purpose: ModelPurpose;        // closed union (§6.1)
  output: "json" | "text";
  parts: PromptPart[];          // ordered
}

type ModelContext =
  | { kind: "personal"; identityId: string }
  | { kind: "tenant"; identityId: string; tenantId: string; membershipId: string };   // ASSUMED, confirm in Step B

type PromptPart =
  | { kind: "instruction"; text: string }                         // written in code: D0
  | { kind: "user_message"; text: string }                        // the person's own words: D1 (§10.2)
  | { kind: "history"; turns: HistoryTurn[] }                     // earlier user turns D1, earlier replies D2 (§10.2)
  | { kind: "record"; source: string; rows: ClassifiedField[][] };   // tool, email or calendar data

interface ClassifiedField {
  name: string;
  class: DataClass | null;      // null = unclassified (rule F2)
  freeText?: boolean;           // free text: scanned, never placeholder-able
  value: unknown;
  entity?: { type: string; id: string };   // a placeholder candidate (§7.1)
}
```

### 5.2 The gateway

One entry point: `gateway.call(request): Promise<GatewayResult>`. In order, it:
1. decides (§6);
2. transforms the allowed fields (§7);
3. assembles the prompt;
4. wraps it in an `ApprovedModelCall`;
5. sends it to the provider;
6. runs the answer check (§7.2);
7. restores real names, only if the check passed;
8. writes the audit entries (§8).

```ts
type GatewayResult =
  | { kind: "answered"; output: string; withheld: WithheldItem[]; decisionId: string }
  | { kind: "denied"; reason: DenyReason; withheld: WithheldItem[]; decisionId: string }
  | { kind: "blocked"; reason: OutputBlockReason; decisionId: string };   // the answer failed the check
```

`withheld` lists what was held back and why, so callers can tell the person honestly. For example: "AI commentary withheld: your pharmacy's settings don't allow customer credit data to be sent to the AI." When a model call is denied, Oneon shows what it can calculate without the model, says what was withheld, and never invents commentary.

### 5.3 Bypass must not compile

- Provider clients (`infrastructure/src/llm/*`) implement a single method, `complete(call: ApprovedModelCall)`.
- `ApprovedModelCall` is an opaque class whose constructor is private to the gateway module.
- An architecture test fails if any module other than the gateway imports a provider client, or casts a value to `ApprovedModelCall`.

The type stops code that forgets the gateway. The test stops casts that work around the type. Both are required, because a type alone can be cast around and a test alone can be skipped.

**Layering:** `DataClass`, `ModelContext`, `PromptPart`, `ClassifiedField` and the `ApprovedModelCall` interface live in `domain`. The gateway lives in `application`. Provider clients stay in `infrastructure`.

## 6. Decision rules

The rules are MECE: mutually exclusive and collectively exhaustive. They are checked in order, and the first match wins, so every input has exactly one outcome. The only outcomes are **deny the call with a reason** or **allow it with a withheld list**.

### 6.1 Purposes

Each purpose declares, in code:
- its class limit;
- its **allowed fields** per part (anything else is withheld);
- its **required parts** (if one is withheld, the call is denied);
- its output schema (for `json` output);
- its minimum aggregate group size (default 5; may be raised, never lowered).

Day-one purposes: `email_classification`, `intent_extraction`, `chat_reply`, `daily_briefing` (§10.1).

### 6.2 Layers and the effective limit

| Layer | Set by | Personal context | Tenant context |
|---|---|---|---|
| Provider limit (registry, code) | Oneon platform | at most D2 | **D1 for every provider until reviewed** |
| Emergency override (env) | Oneon platform | can only lower or suspend | same |
| Person or pharmacy choice | the person / the pharmacy admin | **D1 by default**; D2 per provider by explicit opt-in | **hardcoded D1, no admin override**, until Step B decides where this choice is stored |
| Purpose limit | code | per purpose | per purpose |

**Effective limit = the lowest of all layers.** Every layer always has a value: an unset choice means D1, never "no constraint". The registry also records each provider's review status, which is what allows a future raise.

### 6.3 Stage 1: the whole call, before looking at data

| # | Condition | Outcome |
|---|---|---|
| C1 | Purpose not in the closed list | deny `unknown_purpose` |
| C2 | Provider not in the registry, or suspended | deny `provider_unavailable` |
| C3 | Context incomplete (e.g. a tenant context with no membership) | deny `invalid_context` |
| C4 | A declared D4 field, or a scanner D4 hit in any free text | deny `secret_present`. A D4 field means minimisation failed upstream |

### 6.4 Stage 2: each structured field (exactly one row applies)

| # | Condition | Outcome |
|---|---|---|
| F1 | Not on the purpose's allowed fields | withheld, plus a `boundary_alert`: a source returned more than the purpose allows |
| F2 | No class | withheld, plus a `boundary_alert` |
| F3 | Declared D3 | withheld. **D3 is never downgraded** |
| F4 | Class ≤ effective limit | sent |
| F5 | Above the limit, but a valid declared downgrade brings it to or below the limit | transformed, then sent |
| F6 | Anything else | withheld |

A downgrade (F5) is valid only if all of these hold:
- it does not start from D3;
- a placeholder applies only to a structured identifier field (an ID or a name column, marked with `entity`), never to free text;
- an aggregate covers at least the purpose's minimum group size (default 5); smaller groups are folded into "other" or suppressed.

### 6.5 Stage 2b: free-text parts

- Messages, history turns and free-text fields carry their declared class (§5.1, §10.2).
- D4 scanner hits were already caught by C4.
- A **D3 scanner hit has that span removed**, and the removal is recorded.
- Then: class ≤ limit → sent; otherwise the part (or turn) is withheld.

### 6.6 Stage 3: the whole call, after the fields

| # | Condition | Outcome |
|---|---|---|
| R1 | A required part was withheld or ended up empty | deny `required_part_withheld` |
| R2 | Anything else | allow, with the `withheld` list |

### 6.7 Emergency override

`MODEL_PROVIDER_OVERRIDES=deepseek:suspended,anthropic:D1`

- The override can only suspend a provider or lower its limit.
- **The server refuses to start** on any of: a malformed value, a value that would raise a limit, or an unknown provider name (for example `deepsek:suspended`). A typo must never silently change policy.
- Suspending a provider needs only a restart, never a deploy.

### 6.8 Shadow mode, routing, retries

- **Shadow mode:** the shadow copy is its own `gateway.call` with its own decision. If it is denied, it is skipped and audited, and the main call is unaffected.
- **Routing:** the router picks the provider, then the gateway decides for that provider. **There is no automatic fallback** to a different provider on denial, because that would send data somewhere nobody chose.
- **Retries:** a coarser retry after a denial (for example "margin by category" instead of "margin by supplier") is a **new call** with its own decision, made by the caller. The gateway never falls back internally.

## 7. Minimisation, placeholders and the answer check

### 7.1 Placeholders

- A declared entity value is replaced with `TYPE_n` (`CUSTOMER_1`, `SUPPLIER_2`). Numbering starts at 1 in every request.
- The same entity gets the same token within one request, so the model can reason about it.
- **The mapping exists only in memory**, for one request. It is never logged, never audited, and discarded when the request ends. Because tokens restart each request, a provider cannot link `CUSTOMER_1` across requests.

### 7.2 The answer check

Run before anything returns to the person.

| # | Check | If it fails |
|---|---|---|
| O1 | The answer contains a real value that this request replaced with a placeholder | block `masked_value_leaked`. Possible only if the value reached the model another way, so it signals a bug |
| O2 | The answer contains a placeholder token not issued in this request | block `unknown_token` |
| O3 | The scanner finds a D4 pattern | block `secret_in_output` |
| O4 | `json` output fails the purpose's schema | block `invalid_output`. The caller gets an error, never partial data |
| O5 | Everything else | restore real names for this request's tokens, then return |

**What the check does not do, stated as limits:**
- It does not judge whether the model's reasoning is correct.
- It does not detect injected instructions. Prompt-injection defence stays where it is:
  - instructions tell the model that tool and data text is content, never instructions;
  - a model answer can never trigger an action by itself, because actions still require the Action Spec's policy and approval.

### 7.3 Numbers stay authoritative

For report-style purposes (future), figures shown to a person come from code, not from model text. The model interprets; it cannot create an authoritative value. None of the four day-one purposes produces authoritative figures.

## 8. Audit trail

Oneon migration 015 adds two tables. Both are append-only and locked by triggers that reject `UPDATE` and `DELETE`. The triggers stop changes made through the application, not someone with direct access to the database file.

**`model_call_decisions`**: one row per call, written at decision time, including denied calls.

| Group | Columns |
|---|---|
| Identity | id, call_id, created_at |
| Who | context_kind, identity_id, tenant_id?, membership_id? |
| Why | purpose, channel |
| Where | provider, model |
| Limits | effective_limit, a snapshot of each layer's value |
| Outcome | decision, deny_reason?, withheld reasons |
| Released shape | each field name with `sent`, `placeholder`, `aggregate(n)` or `withheld:<reason>` |
| Counts | placeholder_count, scanner hits by class (counts only), alert flag |
| Fingerprints | policy_fingerprint, input_fingerprint, key_version |

**`model_call_outcomes`**: one row per sent call.
- call_id and status;
- latency, token usage, estimated cost;
- the result of each answer check (O1–O5);
- output_fingerprint and key_version.

**Fingerprints** are HMAC-SHA256 with a key per context, derived from a master secret held outside the database (`MODEL_AUDIT_HMAC_KEY`, via HKDF with the tenant id, or `personal:` plus the identity id). A plain hash of small structured data could be reversed by guessing; a keyed one cannot, without the key. Oneon can still confirm that a given text was sent, by recomputing its HMAC. Rotating the key bumps `key_version`.

**Never stored:** prompts, answers, data values, matched scanner text, or the placeholder mapping. This applies to shadow calls too.

**Retention classes:**
- Built now: `NONE`, the default for every call. Decision and outcome rows have no content to expire, so they are kept.
- Defined, not built: `METADATA_ONLY`, `DEBUG_TEMPORARY` (encrypted, short-lived, personal and dev only) and `CONTROLLED_AUDIT` (needs a justification).
- D3 and D4 content is never retained, whatever the setting.

**Readers:**
- Personal calls: the person, in Settings → AI data, which lists recent calls, decisions and withheld fields.
- Business calls: the pharmacy admin, with the exact rules settled in Step B.
- Platform admin: counts only, never one pharmacy's rows.

## 9. The ImpressoRx side

### 9.1 Phase 1b: classification (no dependency on Oneon)

- **`src/lib/data-classes.ts`**: a map of every Prisma model and field to its class, covering **all 45 models**, including those never exposed. Free-text fields are marked as such. Appendix A drafts the first models.
- **A merge-blocking CI test** reads Prisma's model metadata (DMMF). It fails if any field has no class, or an invalid one. That makes unclassified fields impossible to merge.
- **Not a production startup failure.** ImpressoRx is live for a paying pharmacy, so a missing class must not take a pharmacy offline. The CI gate prevents it, and at run time read tools fail closed per field: an unclassified field is never returned.
- **Classes are confirmed by what each field means in the business, not by its name.**

### 9.2 Phase 2: read tools (contract only; built after Step B)

- Each tool calls existing service functions **as the requesting staff member**, under existing `permissionProcedure` checks, so per-rep sales confidentiality (SECURITY.md §9.4) holds.
- Each tool returns `{ fields: [{ name, class, freeText?, entity? }], rows }`, with classes taken from the map.
- Tools aggregate where they can. Reports and dashboards are the preferred source.
- **Oneon trusts none of it.** Every field is re-checked by rules F1–F6.
- Delegated access is short-lived and bound to both tenant and user (Step B).
- **Oneon never uses ImpressoRx's vendor API** (SECURITY.md §6.3.2). That API cannot read business data by design.

## 10. Migrating today's call sites

### 10.1 The four purposes

All four run in personal context today.

| Purpose | Parts | Required | Allowed fields |
|---|---|---|---|
| `email_classification` | instruction; email record: `from`, `subject`, `bodyPreview` (D2, free text), `receivedAt` (D1), `source` (D0) | the email record | exactly those five |
| `intent_extraction` | instruction with the tool list (D0); user message; history; earlier tool results this turn | user message | each tool's declared fields |
| `chat_reply` | instruction; persona settings (D1); user message; history; tool results | user message | each tool's declared fields |
| `daily_briefing` | instruction; urgent items, deadlines, calendar events | none (sections can be empty) | declared briefing fields |

**Every existing chat tool (about 20) must declare classes for the fields it returns.** Without that, rule F2 withholds their data. Declaring them all is part of phase 1a.

### 10.2 Classes for the person's own words

- **The user's message is D1.** The person sends it to the AI on purpose, and the scanner still catches D3 and D4.
- **History: earlier user messages are D1; Oneon's earlier replies are D2.** Replies can contain real names restored from D2 tool data. Under a D1 limit, earlier replies are withheld, so chat remembers what was asked but not what it answered.
- **Email bodies are D2.** Other people wrote them, and nobody chose to send them to the AI.

### 10.3 What changes on release day

- Chat keeps working, without earlier replies in context, until the person opts in.
- Email classification and the daily briefing stop (`required_part_withheld`), and a visible notice in the dashboard says why.
- Both resume once Gerry confirms the DeepSeek opt-in in Settings → AI data. The confirmation records a dated, versioned policy entry, referencing his 2026-10-03 decision.

## 11. Phases

**1a — Oneon:**
- domain types;
- the gateway (stages 1–3, transforms, answer check);
- the registry and the strict override parser;
- the D3/D4 scanner;
- migration 015 (audit tables);
- provider clients changed to accept only `ApprovedModelCall`, with shadow mode and routing re-expressed as gateway features;
- the four call sites migrated, and all tools declaring their field classes;
- Settings → AI data, with opt-in confirmation;
- architecture test, decision-table tests, golden prompts, invariant tests.

**1b — ImpressoRx (in parallel):** classification map for all 45 models, the merge-blocking CI test, and confirmation of Appendix A.

**2 — after Step B:**
- live tenant contexts;
- where the pharmacy limit is stored;
- ImpressoRx read tools;
- the business audit view;
- retention of business conversations.

**Until phase 2, no business data reaches any model.**

## 12. Testing contract

- **Decision table.** Every rule in §6 has at least one row:
  - each of C1–C4, F1–F6 and R1–R2;
  - an unclassified field;
  - a declared D3 field;
  - a required part withheld;
  - an unknown purpose;
  - a suspended provider;
  - a shadow call denied while the main call is allowed;
  - a personal call before and after opt-in;
  - a tenant field downgraded by placeholder while a sibling D2 field is withheld.
- **Override parser.** Startup fails on a malformed value, a value that would raise a limit, and an unknown provider name.
- **Answer check.** One case each for O1–O4, and restoration on O5.
- **Invariant test** over generated inputs:
  - nothing sent exceeds the effective limit;
  - no D3 or D4 value appears in any assembled prompt;
  - no placeholder mapping appears in any audit row.
- **Golden files** of assembled prompts for each purpose, so changes show up in review.
- **Architecture test.** Only the gateway imports provider clients, and nothing outside it casts to `ApprovedModelCall`.
- **Audit.** Decision rows exist for denied calls; outcome rows exist only for sent calls; neither contains prompt, answer or data values.

## 13. Interfaces assumed from Step B

Marked here so Step B confirms or replaces them:
- `ModelContext.tenant` with `identityId`, `tenantId`, `membershipId`;
- where a pharmacy admin's AI limit is stored and who may change it;
- who may read a pharmacy's audit rows;
- the short-lived, tenant-and-user-bound delegated access that read tools run under.

## 14. Accepted limitations

These are accepted, not solved:

1. **Personal is defined by source, not content.** Gerry's personal inbox can contain business data: supplier threads, customer complaints, staff matters. With his D2 opt-in, that content leaves on the strength of his opt-in. The scanner removes or denies only D3/D4 patterns. Oneon cannot reliably tell a supplier thread from a personal email, and this spec does not claim to.
2. **The scanner has false negatives.** Nothing in this design depends on it catching everything.
3. **Prompt injection is mitigated, not prevented.** See §7.2.
4. **Tamper resistance is application-level.** The triggers stop in-app changes, not direct database access.
5. **DeepSeek's terms are not verified by this spec.** They must be checked against current documents before the personal opt-in is confirmed, and before any business review.
6. **Legal references are to be confirmed by counsel** (§4).

## Appendix A — ImpressoRx classification draft

A draft for Gerry to confirm field by field, **by what each field means in the business**. Source: `prisma/schema.prisma` at ImpressoRx `77f73d0`.

Conventions:
- `free` marks free text: D2, scanned, never placeholder-able.
- `entity:X` marks a placeholder candidate, downgradable to D1 by declaration.
- `id`, `tenantId`, `createdAt`, `updatedAt` and `deletedAt` are D1 on every model below and appear on no purpose's allowed list unless needed.

### Inventory

| Model | D1 | D2 | D3 | D4 |
|---|---|---|---|---|
| Product | sku, brandName, productName, genericName, strength, dosageForm, unit, unitSize, manufacturer, categoryId, drugClass, requiresColdChain, isControlled, barcode, shelfLocation, reorderLevel, basePrice, manualPriceOverride, isActive, needsReview | costPrice, markupPercent | — | — |
| ProductTierPrice | productId, tier | price | — | — |
| ProductBatch | productId, batchNumber, expiryDate, quantityReceived, quantityInStock, quarantineQty, grnLineItemId, locationId, storageCondition, isWrittenOff | writeOffReason (free) | — | — |
| Category | name, isActive | — | — | — |
| Location | name, type, parentId, address, isActive | assignedUserId (staff) | — | — |
| StockMovement | productId, productBatchId, movementType, quantity, referenceType, referenceId | notes (free), createdById (staff) | — | — |
| StockTransfer | fromLocationId, toLocationId, status | vanRepId, transferredById (staff), notes (free) | — | — |
| StockTransferItem | stockTransferId, productId, productBatchId, quantity | — | — | — |

### Sales

| Model | D1 | D2 | D3 | D4 |
|---|---|---|---|---|
| Customer | type, tier, channel, isActive, status, customerSource, customerSize, region, district, territory, needsReview | id (entity:customer), name (entity:customer), contactPerson, phone, email, address, gpsCoordinates, assignedRepId, creditLimit, outstandingBalance, lastOrderDate, paymentTerms, preferredPaymentMethod, businessRegNumber, taxId, pharmacyLicense, preferredContactMethod, preferredLanguage, marketingConsent, notes (free) | see note 1 | — |
| SalesOrder | deliveryLocationId, sourceLocationId, source, saleType, status, subtotal, discountTotal, orderDiscountPercent, orderDiscountAmount, taxRate, taxAmount, grandTotal, paymentType | orderNumber, customerId (entity:customer), createdById (rep, §9.4), notes (free) | see note 1 | — |
| SalesOrderLineItem | salesOrderId, productId, productBatchId, quantity, unitPrice, discountPercent, discountAmount, lineTotal | — | see note 1 | — |
| Invoice | salesOrderId, deliveryLocationId, subtotal, taxRate, taxAmount, total, status, dueDate, issuedAt | invoiceNumber, customerId (entity:customer) | — | — |
| Payment | invoiceId, amount, method, receivedAt | referenceNumber, receivedById (staff) | — | — |
| Return | salesOrderId, reason, status | returnNumber, customerId (entity:customer), approvedById, receivedById, createdById, notes (free) | — | — |
| CreditNote | returnId, invoiceId, amount, taxAmount, total, status, appliedToInvoiceId, issuedAt | creditNoteNumber, customerId (entity:customer), createdById, notes (free) | — | — |
| ControlledDrugLog | productId, productBatchId, quantity, loggedAt | salesOrderId, authorizingPharmacist, loggedById | **buyerName**, **buyerLicenseNumber** (see note 2) | — |

### Reports and dashboards (derived; no model of their own)

| Output | Class |
|---|---|
| Revenue, orders, stock value, expiry exposure as totals by period, location or category | D1 |
| Margin and cost-based figures (use `costPrice`) | D2 |
| Per-rep performance (SECURITY.md §9.4 confidentiality) | D2 |
| Per-customer receivables and ageing | D2, with customer as entity |

### Notes to confirm

1. **Individual customers.** `Customer.type = Individual` is a natural person. An individual's purchase lines link a person to medicines, which is health-linked. Per-field classes cannot express this row-level fact, so **read tools must exclude individual-customer rows from line-level results, or return them only as aggregates of at least 5**, treating such rows as D3. Confirm whether the retail tenant records individuals this way.
2. **ControlledDrugLog.** `buyerName` is D3 (a named buyer of a controlled drug). `buyerLicenseNumber` is drafted D3 in case buyers include prescribers or patients. If, in this business, it is always another pharmacy's licence, it may be D2.
3. **`basePrice` is drafted D1** (a published selling price). Confirm it is not commercially sensitive for your tier pricing.
4. **`User` (not in this appendix)** will include `passwordHash`, `tokenVersion` and `failedLoginAttempts` as D4.

## Appendix B — Worked example

**Question:** "Which customers owe us more than GHS 5,000?" Asked by a sales manager, in tenant context, after phase 2.

1. Intent extraction:
   - Your message (D1) is sent.
   - The model picks the `receivables` read tool.
2. ImpressoRx runs `receivables` as the manager. A rep would see only their own customers.
   - It returns customer `id` and `name` (D2, entity:customer), `outstandingBalance` (D2), days overdue (D1).
   - It omits phone, address and notes.
3. The gateway applies the effective limit, D1 (the tenant hardcode):
   - `name` and `id` are downgraded to placeholders (`CUSTOMER_1`…), which is valid under F5.
   - `outstandingBalance` (D2, no declared downgrade) is withheld (F6).
   - Days overdue (D1) is sent.
4. The model reasons over "`CUSTOMER_1`, 73 days overdue…". The answer check passes, and `CUSTOMER_1` is restored to "ABC Hospital".
5. The person sees the code-calculated table of names and balances (authorised for them, never sent to the model), plus the model's commentary, plus a note: "Balances weren't shared with the AI under your pharmacy's settings."
6. Audit: one decision row (released shape: `name:placeholder`, `id:placeholder`, `outstandingBalance:withheld:above_limit`, `daysOverdue:sent`) and one outcome row. No names, no balances, no mapping.
