# ADR-005: Intent Extraction Mode First, Tool Use Mode Later

## Status: Accepted

## Date: 2026-04-14

## Context

The chat system needs to translate natural language into tool calls. Two approaches exist:

1. **Intent extraction** — a fast LLM (Haiku) parses the user message into structured JSON
   intents, the system executes those intents via tool functions, then a quality LLM (Sonnet)
   synthesizes the final response. Two-LLM architecture.

2. **Tool use** — the LLM (Sonnet) receives tool definitions natively and decides which tools
   to call using Claude's built-in tool-use API. The model handles routing, parameter
   extraction, and multi-tool orchestration internally.

The reference implementation (Alfred) discovered that intent extraction works well for ≤ 15
tools but the routing prompt becomes fragile beyond that. Tool use is more reliable but burns
through API credits faster because each round is a full Sonnet call with the entire tool
catalogue attached.

## Decision

**MVP1:** Implement intent extraction mode only.
**MVP1.5:** Add tool use mode behind the same `ChatStrategy` interface.

Both modes will share the same `ToolRegistry`, so all capabilities are available in both
modes without duplication.

The chat request accepts a `mode` parameter that selects the active strategy:
```typescript
const strategy = mode === "tool_use" ? toolUseStrategy : intentStrategy;
```

## Consequences

**Easier (MVP1):**
- Cheaper per chat turn (1 Haiku call + 1 Sonnet call vs. N Sonnet calls)
- Simpler to debug — intent JSON is visible and inspectable
- Faster time to MVP — no need to implement tool-use response parsing

**Harder:**
- Intent extraction prompt becomes fragile as tools grow beyond ~15
- Need to maintain routing rules in the prompt
- Two-step architecture is more complex than single-model tool use

**Mitigation:** The `ChatStrategy` interface ensures adding tool use mode later is purely
additive — a new strategy class, not a rewrite.

## Alternatives Considered

1. **Tool use mode only** — more reliable routing but no cost control for simple queries.
   A "what time is my meeting?" turns into a full Sonnet + tools call instead of a cheap
   Haiku extraction. Rejected for MVP1.

2. **Both modes from day one** — technically feasible but doubles the testing surface.
   Intent mode covers MVP1 needs with 13 tools. Deferred to MVP1.5.
