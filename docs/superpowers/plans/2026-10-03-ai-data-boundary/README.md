# AI Data Boundary (Phase 1a, Oneon) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put one Model Gateway in front of every AI model call Oneon makes, so nothing reaches a provider without a recorded, policy-checked decision, and migrate the four existing call sites (email classification, intent extraction, chat reply, daily briefing) onto it.

**Architecture:** A new `application/src/ai-boundary/` module holds the data classes, the request types, the purpose and provider registries, the pure decision engine, placeholders, prompt assembly, the answer check, fingerprints and the gateway. Provider clients in `infrastructure` accept only an `ApprovedModelCall`, which only the gateway creates. Audit rows and personal opt-ins live in two new SQLite tables (migration 015). The agent-server wires the gateway in place of today's `llmPort`, and the dashboard gains Settings → AI data.

**Tech Stack:** TypeScript 5.7, Node 20, pnpm 9 workspace, zod 3, better-sqlite3, Express 4, vitest 3 (+ `fast-check` for the invariant test), Next.js + SWR (dashboard).

**Spec:** [`docs/superpowers/specs/2026-10-03-ai-data-boundary-design.md`](../../specs/2026-10-03-ai-data-boundary-design.md). Read the sections a task cites before starting it.

## Phases and tasks

| Phase | File | Tasks |
|---|---|---|
| 1. Foundations | [phase-1-foundations.md](phase-1-foundations.md) | 1 types, instructions, approved call · 2 provider registry and override parser · 3 purposes and output schemas · 4 scanner |
| 2. Engine | [phase-2-engine.md](phase-2-engine.md) | 5 decision engine · 6 placeholders and prompt assembly · 7 answer check and restore · 8 audit storage and fingerprints · 9 gateway |
| 3. Providers and tools | [phase-3-providers-tools.md](phase-3-providers-tools.md) | 10 provider clients · 11 tool output schemas and contracts |
| 4. Migration | [phase-4-migration.md](phase-4-migration.md) | 12 container wiring and env · 13 email classification · 14 chat · 15 daily briefing · 16 remove old LLM adapters, architecture tests |
| 5. Surface | [phase-5-surface.md](phase-5-surface.md) | 17 AI data API · 18 Settings → AI data and notices · 19 ADR-012, PRD, env template |

**Phase 1b (ImpressoRx classification map and its merge-blocking test, spec §9.1) is a separate plan in the ImpressoRx repository.** It has no dependency on this plan and can run in parallel. Typed-name resolution (§7.4), read tools (§9.2) and tenant contexts are phase 2, after Step B.

Tasks run in order. Each ends with the full suite green and one commit. Phases 1–3 add code without changing behaviour. Tasks 13–15 switch each call site; until Task 16, the old `LLMPort` adapters still exist but nothing new may use them.

## Global Constraints

- Branch: `feat/ai-data-boundary`, created from `docs/ai-data-boundary` (which sits on `main` at `c2fbf75` and holds the spec and this plan).
- Commits: conventional (`feat(ai-boundary): …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never put the trailer in the subject line.
- Every task ends with `pnpm -r run build && pnpm -r run typecheck && pnpm test` all passing. Baseline before this plan: **1,402 tests**.
- Build order: after changing `domain`, run `pnpm --filter @oneon/domain build`; after changing `application`, run `pnpm --filter @oneon/application build` before `infrastructure` or `agent-server` tests (they resolve sibling packages from `dist`).
- **Deviation from spec §5.5 (ruled):** the provider interface `ModelProvider` and the `ApprovedModelCall` class live in `application/src/ai-boundary/`, not `domain`, because `infrastructure` already depends on `application`. That lets the class sit beside the gateway. `DataClass` and the request types also live in `ai-boundary`. `domain` is unchanged except for removing `LLMPort` in Task 16.
- **Spec extension (ruled):** `GatewayResult` has a fourth kind, `failed` (the provider errored or timed out), besides `answered`, `denied` and `blocked`.
- Data classes, exactly: `D0`, `D1`, `D2`, `D3`, `D4` (rank order). The effective limit is the lowest of all layers.
- Purposes, exactly: `email_classification`, `intent_extraction`, `chat_reply`, `daily_briefing`. Any other purpose string is denied `unknown_purpose`.
- Deny reasons, exactly: `unknown_purpose`, `provider_unavailable`, `invalid_context`, `secret_present`, `required_part_withheld`.
- Withheld reasons, exactly: `not_allowed_for_purpose`, `unclassified`, `d3_never_sent`, `row_d3`, `above_limit`, `group_too_small`, `part_not_allowed`.
- Answer-check block reasons, exactly: `masked_value_leaked`, `unknown_token`, `secret_in_output`, `invalid_output`.
- Day-one provider limits: `deepseek` and `anthropic` both `{ personal: "D2", tenant: "D1" }`, review status `unreviewed`.
- Personal choice default `D1`; D2 only via a confirmed row in `ai_data_choices`. Tenant choice is hardcoded `D1`.
- Minimum aggregate group size: **5** (a purpose may raise it, never lower it).
- Placeholder format: `TYPE_n`, uppercase entity type plus a number from 1, unique within one turn. Known entity types: `PERSON`, `CUSTOMER`, `SUPPLIER`.
- The scanner's D3 removal marker in assembled text, exactly: `[removed]`.
- New env vars: `MODEL_PROVIDER_OVERRIDES` (optional), `MODEL_AUDIT_HMAC_KEY` (required, at least 32 characters, whenever `ANTHROPIC_API_KEY` or `DEEPSEEK_API_KEY` is set), `MODEL_AUDIT_HMAC_KEY_VERSION` (default `1`).
- Tables (migration 015): `ai_data_choices`, `model_call_decisions`, `model_call_outcomes`. All three are append-only. Trigger messages, exactly: `ai_data_choices is append-only`, `model_call_decisions is append-only`, `model_call_outcomes is append-only`.
- Never store prompts, answers, data values, matched scanner text, or the placeholder mapping in the model audit tables, and never log them from the gateway or a model call site. Action tables and stored chat tool calls are Oneon's own records and are outside this rule (spec §7.6).
- **The boundary applies only inside the gateway (spec §1.1).** Do not add class checks to tools, action `resolve` or executors, storage, or API responses to the signed-in person. Tools keep returning full data; the gateway decides what the model sees.
- The recorded decision, verbatim (Task 17): provider `deepseek`, max class `D2`, decided on `2026-10-03`, note `Approved by Gerry in the 2026-10-03 design session for his personal email, pending confirmation after checking DeepSeek's current terms.`

## Review Focus

Inputs the spec implies but no other test pins. Each line's test is added in the owning task.

1. **The person hasn't confirmed the opt-in.** Chat must still answer, at D1, with earlier assistant replies left out. It must never error or come back empty because history was withheld. Test: Task 14.
2. **The opt-in is confirmed, then revoked by choosing D1.** The newest row wins, so email classification pauses again on the next cycle. Test: Task 8 (repository) and Task 13 (cycle).
3. **A tool starts returning an extra field after a refactor.** The field is withheld with a `boundary_alert`, and the chat still answers. Test: Task 11.
4. **The model invents a placeholder in a tool request** (`CUSTOMER_9`, never issued). That intent is skipped with a warning, and the loop carries on with the others. Test: Task 14.
5. **`MODEL_PROVIDER_OVERRIDES` written loosely** (`DeepSeek : Suspended , anthropic:d1`). Whitespace and case are tolerated for provider ids and values. A truly unknown id or value still stops startup. Test: Task 2.
6. **The model proposes an action using a placeholder** (`create_calendar_event` with attendee `PERSON_1`, from an inbox result at D1). `requestAction` receives the real address, never the token (spec §7.6 AX1). Test: Task 14.
7. **The chat reply is denied or fails after an action was requested.** The action keeps its status, and the chat response still lists it (spec §7.6 AX5). Test: Task 14.

## File map

| Path | Responsibility | Task |
|---|---|---|
| `packages/application/src/ai-boundary/types.ts` | data classes, contexts, purposes, request and part types | 1 |
| `packages/application/src/ai-boundary/instruction.ts` | `Instruction` brand, `instruction` tag | 1 |
| `packages/application/src/ai-boundary/approved-call.ts` | `ApprovedModelCall`, `ModelProvider`, `ProviderError` | 1 |
| `packages/application/src/ai-boundary/providers.ts` | provider registry, override parser, provider limit | 2 |
| `packages/application/src/ai-boundary/purposes/*.ts` | four purpose definitions, output schemas, instructions | 3 |
| `packages/application/src/ai-boundary/scanner.ts` | D3/D4 pattern scanner | 4 |
| `packages/application/src/ai-boundary/decide.ts` | pure decision engine (stages 1–3) | 5 |
| `packages/application/src/ai-boundary/placeholders.ts` | turn-scoped placeholder map | 6 |
| `packages/application/src/ai-boundary/assemble.ts` | apply outcomes, render system and user text | 6 |
| `packages/application/src/ai-boundary/answer-check.ts` | O1–O5, name and parameter restoration | 7 |
| `packages/application/src/ai-boundary/audit.ts` | audit and choice repository ports, record types | 8 |
| `packages/application/src/ai-boundary/fingerprints.ts` | HKDF + HMAC fingerprints | 8 |
| `packages/infrastructure/src/database/migrations/015_ai_data_boundary.sql` | three tables and triggers | 8 |
| `packages/infrastructure/src/database/repositories/sqlite-model-audit.repository.ts` | decisions and outcomes | 8 |
| `packages/infrastructure/src/database/repositories/sqlite-ai-data-choice.repository.ts` | personal opt-ins | 8 |
| `packages/application/src/ai-boundary/gateway.ts` | `createModelGateway`, turns, retries, shadow, audit | 9 |
| `packages/infrastructure/src/llm/providers/*.ts` | DeepSeek and Anthropic provider clients | 10 |
| `packages/application/src/tools/output-schema.ts` | tool output schema type, result → record | 11 |
| `packages/agent-server/src/model-wiring.ts` | builds providers, routing and gateway from env | 12 |
| `packages/agent-server/src/routes/ai-data.route.ts` | AI data API | 17 |
| `packages/contracts/src/ai-data.contract.ts` | API schemas | 17 |
| `packages/dashboard/src/components/settings/ai-data-settings.tsx` | Settings → AI data | 18 |
| `docs/adr/012-ai-data-boundary.md` | decision record | 19 |
