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
