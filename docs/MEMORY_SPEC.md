# Personal Memory v1 Spec

Version: 1.0
Date: 2026-05-08
Status: Approved for implementation

## 1. Goal

Provide a practical, user-controlled memory layer that grounds chat responses and action proposals in stable personal context without requiring vector infrastructure.

## 2. Memory Sources (v1)

Personal Memory v1 includes exactly three retrieval sources:

1. Notes: user-authored notes persisted in app data.
2. Pins: explicitly user-pinned assistant outputs.
3. Curated docs: markdown documents from configured docs roots.

## 3. Source Semantics

### 3.1 Notes

- Purpose: durable user guidance, preferences, and durable facts.
- Shape: title, content, tags, pinned flag.
- Scope: user-scoped.

### 3.2 Pins

- Purpose: preserve useful assistant outputs chosen by the user.
- Ingestion policy: explicit only (no auto-ingestion).
- Dedupe policy: dedupe by sourceMessageId when present.
- Scope: user-scoped.

### 3.3 Curated Docs

- Purpose: reusable local knowledge references.
- Allowed format: markdown files.
- Discovery: recursively scan configured roots, skip missing roots safely.
- Scope: workspace-local docs surfaced as retrieval hits.

## 4. Retrieval Contract

- API: user-scoped search endpoint.
- Tool: search_personal_memory in chat tool registry.
- Query options: limit, includeNotes, includePins, includeDocs.
- Ranking: lexical matching with source-aware weighting and recency tie-breaking.

## 5. v1 Boundaries

In scope:

- Lexical/hybrid ranked retrieval across notes, pins, and curated docs.
- Chat grounding through tool execution.
- Explicit pin UX in chat.

Out of scope:

- Embeddings/vector index.
- Automatic ingestion of all conversation outputs.
- Cross-user/shared memory.

## 6. Acceptance Criteria

1. A user can create/list/update/delete notes.
2. A user can pin an assistant output and duplicate pins are prevented by sourceMessageId.
3. Curated docs appear in memory search results when includeDocs=true.
4. Chat can execute search_personal_memory and return memory-grounded output.
