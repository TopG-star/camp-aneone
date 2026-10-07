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
10. An input check in the gateway, below D2, denies the call (`masked_value_present`) when the data sent in the prompt holds
    a value this turn replaced with a placeholder and the person did not type it, e.g. a tool echoing a restored
    parameter. The check scans only data that could carry a restored value, as actually sent: sent and aggregate record field values (not
    the persona record), sent history turns, and tool-error values; never instructions, the tool catalog, record headers or
    field names. One shared matcher (`restored-values.ts`) serves this check and answer check O1. For every entry in the
    placeholder map it matches: the display string and the name part of a `Name <addr>` display (not purely numeric), as
    case-insensitive text on Unicode word boundaries with whitespace runs matching any whitespace, each at least 3
    characters; a person's entity id (a login or name is matched as text like a display; customer and supplier ids are
    opaque and are not matched); and email addresses, which are matched as whole email-like tokens in normalised form
    (lowercased, leading punctuation and a `+tag` dropped), not on word boundaries, so `Ama+news@X.com` and `_ama@x.com_`
    match `ama@x.com` while `bob.ama@x.com` does not. A form the person typed is exempt, form by form. Any non-address form (a display, a name part or a login) that also
    appears in Oneon's own vocabulary is exempt too, whatever this call sent: every registered tool's name and
    description, every purpose's instructions, the record source names, and the persona values. So a sender called
    "GitHub" does not trip on a tool named `list_github_prs`, nor on an answer that says "3 GitHub notifications". An
    address is exempt only if the person typed it. Limits: a value transformed beyond these forms, such as a translated or
    reformatted name, is not detected; an address outside the email pattern (an apostrophe, a punycode TLD) is matched as
    text, case-insensitively on word boundaries, and like other text forms is exempt only via the person's own text or
    Oneon's vocabulary; the per-tool declarations (tools that echo parameters declare that output D2) remain the first line.

## Consequences

- Email classification pauses, cycle by cycle, until the person opts in to D2, or while the provider is suspended,
  unavailable or capped below D2. An item denied for its own content (a secret, a required field left empty, a masked
  value) counts a classify attempt, so it is skipped after the maximum.
- The daily briefing falls back to its structured summary without AI wording. On an empty day no model call is made.
- Chat keeps working at D1 without earlier assistant replies. A secret pasted into the current message denies that turn only
  (the reply tells the person to rotate it); in later turns the history turn holding it is withheld and chat carries on
  (changed 2026-10-04, Gerry). A secret in a tool record still denies the whole call.
- A scanner on free text is a backstop with false negatives. Prompt injection is mitigated, not prevented.
- "Personal" is defined by source, not content; business data in a personal inbox leaves on the person's opt-in.
- That an action's business facts come from `resolve`, not from the model's proposal, is a review convention until
  Step C adds a mechanism.

## Deploy

Set `MODEL_AUDIT_HMAC_KEY` (at least 32 characters) before upgrading: while a model provider key is set, the server
will not start without it.

Manage the key like any other long-lived secret:

- Keep `MODEL_AUDIT_HMAC_KEY` in the secret manager, not only in an env file, and back it up.
- Each audit row stores the `key_version` that wrote it. The server loads one key at a time, set by
  `MODEL_AUDIT_HMAC_KEY` and `MODEL_AUDIT_HMAC_KEY_VERSION` (default 1). Fingerprints are derived per context from the
  master key with HKDF.
- Keep every old key with its version. An old fingerprint can only be checked with the key that wrote it. The running
  server does not check old versions, so verify old rows offline or in a separate tool, using the old key and its
  version from the secret manager.
- To rotate, store the new key as a new version and bump `MODEL_AUDIT_HMAC_KEY_VERSION`. New rows use the new key. Old
  rows keep their old `key_version`.
- That an action's business facts come from `resolve` is now a Step C requirement for business actions (spec §7.6, AX2).

## References

- Spec: `docs/superpowers/specs/2026-10-03-ai-data-boundary-design.md`
- ADR-011: Action Spec framework (the action safety plane this complements)
