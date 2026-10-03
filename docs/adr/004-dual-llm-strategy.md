# ADR-004: Dual LLM Strategy (Haiku + Sonnet)

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-Aneone uses LLMs for multiple tasks with different quality and cost requirements:

1. **Classification** — produce structured JSON (category, priority, summary). Needs
   reliability and speed, not deep reasoning.
2. **Intent extraction** — parse user chat into tool calls. Structured output, not prose.
3. **Response synthesis** — compose a final answer to the user. Needs quality, nuance, and
   the ability to connect information across multiple data sources.
4. **Daily briefing** — synthesize meetings, urgent items, and deadlines into a coherent
   report. Quality matters.

Using a single expensive model for all tasks would blow the budget. Using a single cheap
model for all tasks would produce poor synthesis quality.

## Decision

Use a **two-model architecture** abstracted behind a single `LLMPort` interface:

| Task | Model | Reason |
|------|-------|--------|
| Classification | Claude Haiku 3.5 | Cheap, fast, reliable for structured JSON |
| Intent extraction | Claude Haiku 3.5 | Only needs to produce intent JSON, not reason |
| Response synthesis | Claude Sonnet 4 | Quality prose, connects information across context |
| Daily briefing | Claude Sonnet 4 | Nuanced summary requiring reasoning |

The composition root creates two `ClaudeAdapter` instances:
- `haiku` — for mechanical tasks
- `sonnet` — for synthesis tasks

Both implement the same `LLMPort` interface. Use cases receive whichever they need via
dependency injection.

## Consequences

**Easier:**
- Cost stays within $20/month budget (Haiku calls are ~20x cheaper than Sonnet)
- Quality where it matters — user-facing responses are Sonnet-grade
- Swapping models is a config change (e.g., move to Haiku 4 when available)
- Can A/B test models by changing composition root wiring

**Harder:**
- Two API keys (actually same key, two model IDs) to manage
- Must be deliberate about which model goes where — a misconfiguration could use Sonnet for
  classification (expensive) or Haiku for synthesis (low quality)
- Testing needs two distinct behavior expectations

## Alternatives Considered

1. **Single model (Sonnet for everything)** — higher quality across the board but
   prohibitively expensive for 50+ classification calls per day. Rejected.

2. **Single model (Haiku for everything)** — cheapest but synthesis quality is noticeably
   worse. User-facing responses felt mechanical and missed nuance. Rejected.

3. **Opus for synthesis** — highest quality but significantly more expensive than Sonnet.
   The quality difference for this use case doesn't justify the cost. Can revisit for
   specific high-value tasks later. Rejected for default use.

4. **Open-source model (Llama, Mistral) for classification** — would reduce API costs to
   zero for cheap tasks but requires hosting infrastructure. Not worth the complexity for
   MVP1. Rejected for now.

---

## Addendum: Multi-Provider Architecture (2026-04-25)

### Status: Accepted (extends this ADR, does not supersede)

### Context

Following the original ADR, we added support for **DeepSeek** as an alternative LLM
provider, a **shadow A/B harness**, and **premium routing** for synthesis.

The changes were motivated by:
- Cost reduction: DeepSeek `deepseek-chat` is materially cheaper than Claude Haiku for
  structured output tasks.
- Provider diversification: reduces lock-in to a single API.
- A/B validation: shadow mode lets us compare provider outputs before fully switching,
  without affecting users.

### Additional Decisions

#### 1. Tiny HTTP Client (no SDK)

`DeepSeekHttpClient` uses `fetch` directly. No `openai` or `@deepseek/sdk` dependency.
Rationale: DeepSeek's API is simple REST; an SDK adds ~0 value and +3MB+ to the bundle.

#### 2. DeepSeek-Specific Error Taxonomy

Three error classes map to observable behaviours:
- `DeepSeekRateLimitError` (status=429): Do **not** retry. Throw immediately.
- `DeepSeekApiError` (status=4xx/5xx other than 429): Surface to circuit breaker.
- `DeepSeekEmptyResponseError`: Retryable (transient).

#### 3. Shadow Mode (`LLM_SHADOW_PROVIDER`)

`ShadowLlmAdapter` wraps primary + shadow. Shadow calls are **fire-and-forget**:
- Primary result returned immediately to caller.
- Shadow result is compared structurally (field names + types, never values — PII safety).
- Shape differences are logged at WARN.
- Shadow errors are swallowed with a WARN log; they never surface to callers.

#### 4. Premium Routing (`LLM_REASONING_PROVIDER_PREMIUM`)

`RoutingLlmAdapter` dispatches by method:
- `classify()` / `extractIntents()` → `standard` LLM (fast, cheap structured output)
- `synthesize()` → `reasoning` LLM (premium quality)

When `LLM_REASONING_PROVIDER_PREMIUM=none` (default), routing is bypassed entirely — the
primary adapter handles all three methods.

#### 5. Separate Timeouts

`LLM_CLASSIFIER_TIMEOUT_MS` (default: 15 s) and `LLM_SYNTHESIS_TIMEOUT_MS` (default: 30 s)
replace the single `LLM_TIMEOUT_MS`. Each call creates its own `AbortController` and clears
the timer in a `finally` block to prevent timer leaks.

#### 6. Fail-Fast Validation

`env.ts` `superRefine` enforces at startup:
- If any `*_PROVIDER=deepseek` → `DEEPSEEK_API_KEY` must be present.
- If any `*_PROVIDER=deepseek` → `DEEPSEEK_CLASSIFIER_MODEL` and `DEEPSEEK_SYNTHESIS_MODEL`
  must be **explicitly set** (no defaults — DeepSeek model IDs are opaque and must be
  intentional).

#### 7. Structured Output

DeepSeek's `response_format: {type: "json_object"}` is set **only** on `classify()` and
`extractIntents()`. Not on `synthesize()` (free-form prose). Requires the word "json" in
the system prompt — all classification/intent prompts already include it.

### Env Variables Added

| Variable | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | Primary provider: `anthropic` or `deepseek` |
| `LLM_SHADOW_PROVIDER` | `none` | Shadow harness provider (or `none`) |
| `LLM_REASONING_PROVIDER_PREMIUM` | `none` | Premium synthesis provider (or `none`) |
| `DEEPSEEK_API_KEY` | — | Required when any provider is `deepseek` |
| `DEEPSEEK_CLASSIFIER_MODEL` | — | Required when any provider is `deepseek`. No default. |
| `DEEPSEEK_SYNTHESIS_MODEL` | — | Required when any provider is `deepseek`. No default. |
| `LLM_CLASSIFIER_TIMEOUT_MS` | `15000` | Timeout for classify / extractIntents |
| `LLM_SYNTHESIS_TIMEOUT_MS` | `30000` | Timeout for synthesize |

