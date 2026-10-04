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
7. A shadow call is its own gateway call with its own placeholder map, so shadow tokens never resolve in the main turn.
8. The decision fails closed on invalid declarations: an unknown class is never within a limit, an invalid row class
   is treated as D3, and an entity type the placeholder map cannot name is withheld as unclassified.
9. The answer check's leak rule (O1) exempts a replaced value the person typed in the request.
10. An input check in the gateway, below D2, denies the call (`masked_value_present`) when the assembled prompt holds
    a value this turn replaced with a placeholder and the person did not type it, e.g. a tool echoing a restored
    parameter. One shared matcher (`restored-values.ts`) serves this check and answer check O1. For every entry in the
    placeholder map it matches, case-insensitively on Unicode word boundaries (each form at least 3 characters): the
    display string; a person's entity id (the bare address; customer and supplier ids are opaque and are not matched);
    the name part of a `Name <addr>` display (not purely numeric); and email addresses compared in normalised form
    (lowercased, `+tag` dropped), so `Ama+news@X.com` matches `ama@x.com`. A form the person typed is exempt, form by
    form. Limit: a value transformed beyond these forms, such as a translated or reformatted name, is not detected;
    the per-tool declarations (tools that echo parameters declare that output D2) remain the first line.

## Consequences

- Email classification pauses, cycle by cycle, until the person opts in to D2, or while the provider is suspended,
  unavailable or capped below D2. An item denied for its own content (a secret, a required field left empty, a masked
  value) counts a classify attempt, so it is skipped after the maximum.
- The daily briefing falls back to its structured summary without AI wording. On an empty day no model call is made.
- Chat keeps working at D1 without earlier assistant replies. A secret pasted into recent history blocks the AI for
  that conversation until it leaves the 20-message window (an open spec question).
- A scanner on free text is a backstop with false negatives. Prompt injection is mitigated, not prevented.
- "Personal" is defined by source, not content; business data in a personal inbox leaves on the person's opt-in.
- That an action's business facts come from `resolve`, not from the model's proposal, is a review convention until
  Step C adds a mechanism.

## Deploy

Set `MODEL_AUDIT_HMAC_KEY` (at least 32 characters) before upgrading: while a model provider key is set, the server
will not start without it.

## References

- Spec: `docs/superpowers/specs/2026-10-03-ai-data-boundary-design.md`
- ADR-011: Action Spec framework (the action safety plane this complements)
