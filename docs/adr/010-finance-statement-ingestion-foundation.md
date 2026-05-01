# ADR-010: Finance Statement Intake Foundation (FIN-001a)

## Status: Accepted

## Date: 2026-04-29

## Context

Camp-aneone PRD v1.0 marked finance processing out of scope for MVP1, but current sprint planning
requires beginning finance work without violating MVP guardrails.

At present, ingestion infrastructure is metadata-first and optimized for idempotent polling loops.
This makes a narrow first slice feasible: detect candidate bank-statement emails and persist intake
records safely, while deferring all parsing and analytics behavior.

The key risk is scope creep into PDF parsing, transaction extraction, or dashboard analytics before
core intake durability and idempotency are proven.

## Decision

Adopt a bounded finance scope called FIN-001a: statement intake foundation only.

### Included in FIN-001a

1. Candidate detection using configurable sender allowlist + subject keyword rules.
2. Idempotent persistence to `bank_statements` keyed by `(user_id, source, external_id)`.
3. Intake lifecycle states: `discovered`, `skipped_duplicate`, `queued_for_parse`.
4. Immutable metadata evidence storage (`message_id`, `thread_id`, sender, subject, received_at,
   detection_rule_version).

### Explicitly Excluded from FIN-001a

1. Downloading attachments or parsing PDFs.
2. Extracting transactions or category-level spend data.
3. Conversational finance tools and prompt context wiring.
4. Finance dashboard pages, charts, or reporting UI.

## Consequences

### Easier

- Maintains MVP architecture discipline while opening a safe path into finance.
- Enables incremental delivery with low blast radius.
- Reuses existing ingestion/idempotency patterns already proven in notification and email flows.

### Harder

- Users will not yet see finance insights in chat or dashboard.
- Additional follow-up slices are required (FIN-001b+) before end-user value is visible.
- Requires strict enforcement to avoid accidental parser/UI work leaking into this slice.

## Alternatives Considered

1. Full finance vertical slice now (ingest + parse + analytics + UI)
   - Rejected: too broad for current branch scope and increases regression risk.

2. Keep all finance fully out of scope
   - Rejected: blocks deliberate progress and increases future integration risk.

3. Parse attachments in ingestion stage
   - Rejected: mixes ingestion and extraction concerns, increases failure modes too early.
