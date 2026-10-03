# ADR-012: AI Data Boundary

## Status: Accepted

## Date: 2026-10-03

## Context

Oneon sent data to AI providers from four call sites with no checkpoint: any code that could build a prompt
could send anything to any configured provider, and shadow mode copied it to a second provider. Connecting
ImpressoRx pharmacies (Step B) would add customer credit, supplier prices and controlled-drug records.

## Decision

1. One Model Gateway in front of every model call. Provider clients accept only an `ApprovedModelCall`, which only
   the gateway creates; architecture tests enforce it.
2. Data classes D0–D4, declared per field in code; an unclassified field is never sent. D3 never goes to an external
   provider; D4 never goes anywhere.
3. The effective limit is the lowest of: the provider's platform limit (registry in code), an emergency override
   that can only lower, the person's or pharmacy's choice, and the purpose's limit. Every provider starts unreviewed:
   personal D2 at most, business D1. Personal data above D1 needs the person's explicit opt-in.
4. Identifiers can be replaced by turn-scoped placeholders, restored for the person only after the answer passes a
   check. The mapping lives in memory only.
5. The audit trail records each decision and the shape of what was released, with keyed (HMAC) fingerprints — never
   prompts, answers or data values. The tables are append-only through the application; this does not stop direct
   database access.
6. The boundary governs disclosure to AI providers, not Oneon's authorised internal use of data. Rules apply only
   in the gateway. An approved action's executor receives the authoritative data it needs through `resolve`, even
   when the model that proposed the action never saw that data. Placeholders are restored to real identifiers
   before any tool or action receives them.

## Consequences

- Email classification and the daily briefing pause until the person opts in to D2 for their email provider.
- Chat keeps working at D1 without earlier assistant replies in context.
- A scanner on free text is a backstop with false negatives. Prompt injection is mitigated, not prevented.
- "Personal" is defined by source, not content; business data in a personal inbox leaves on the person's opt-in.
- That an action's business facts come from `resolve`, not from the model's proposal, is a review convention until
  Step C adds a mechanism.

## References

- Spec: `docs/superpowers/specs/2026-10-03-ai-data-boundary-design.md`
- ADR-011: Action Spec framework (the action safety plane this complements)
