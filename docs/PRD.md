# Camp-Aneone (Oneon) — Product Requirements Document

**Version:** 1.0
**Date:** 2026-04-14
**Author:** Product Owner
**Status:** Draft → Approved

---

## 1. Vision

Camp-Aneone (nicknamed **Oneon**) is a personal AI agent that collapses the chaos of a
fragmented digital workday into one intelligent, unified system. Oneon continuously ingests
messages from Gmail, Outlook, Teams, and GitHub; classifies them by urgency and type;
extracts deadlines and submission dates; proposes actions with safety gates; and answers
natural language questions backed by real data.

**Scale Vision:** While MVP1 is a single-user personal agent solving the builder's own daily
pain, the architecture is designed from day one for future multi-user scaling. A growing
number of professionals — pharmacists, product managers, engineers, supply chain managers —
face the same triage overload. Oneon's Clean Architecture foundation (ports/adapters,
provider-agnostic domain, progressive feature flags) ensures the path from personal tool to
commercial product requires adapter and auth changes, not rewrites.

---

## 2. Target User (MVP1)

**Primary persona:** A pharmacist / aspiring product manager / software engineer who juggles
multiple communication channels daily and frequently:

- Misses priority emails buried under newsletters and noise
- Forgets submission deadlines and meeting commitments
- Spends 45–60 minutes each morning manually triaging Gmail, Outlook, Teams, and GitHub
- Loses track of follow-ups across platforms

**Future personas (post-MVP1):**

- Pharmaceutical managers tracking regulatory submissions and ERP data
- CEOs / business owners needing unified business intelligence from sales management systems
- Engineers monitoring deployed software health alongside communications
- Teams needing shared triage with role-based approval workflows

---

## 3. Problem Statement

Every workday morning requires 45–60 minutes of manual triage across Gmail, Outlook, Teams,
and GitHub before any real work begins. Priority emails get buried under newsletters.
Submission deadlines are forgotten. Calendar conflicts go unresolved. GitHub PR reviews sit
unnoticed. Teams messages with action items are lost in channel noise.

The cost is not just time — it is missed opportunities, broken commitments, forgotten
deadlines, and the cognitive overhead of context-switching across 4+ platforms before the
actual job even starts.

**Core thesis:** Agentic systems become reliable when the LLM does planning and
interpretation, but the system enforces state, safety, idempotency, and deterministic
execution. *LLM decides; software guarantees.*

---

## 4. Success Metrics (MVP1)

| Metric | Current State | Target | How Measured |
|--------|--------------|--------|-------------|
| Morning triage time | 45–60 min | ≤ 5 min | Self-reported time log |
| Missed priority-1 items/week | 2–3 | 0 | Count from audit log |
| Missed deadlines/month | 3–5 | 0 | Count from deadline tracker |
| Classification accuracy | N/A | ≥ 85% | Feedback loop corrections |
| System uptime | N/A | ≥ 99% | Docker health checks |
| LLM monthly cost | N/A | ≤ $20 | Anthropic billing dashboard |

---

## 5. Functional Requirements

### 5.1 Unified Inbox

| ID | Requirement | Priority |
|----|------------|----------|
| FR-001 | Ingest Gmail messages via Gmail API polling (configurable interval, default 60s) | P0 |
| FR-002 | Ingest Outlook messages via Power Automate webhook | P0 |
| FR-003 | Ingest Teams messages via Power Automate webhook | P0 |
| FR-004 | Ingest GitHub notifications via GitHub webhooks (PR opened, issue created) | P0 |
| FR-005 | Normalize all sources into a single `InboundItem` domain entity | P0 |
| FR-006 | Deduplicate items via upsert on `(source, external_id)` | P0 |
| FR-007 | Display unified inbox in dashboard with source, category, priority filters | P0 |
| FR-008 | Skip classification for social media senders (regex: facebook, instagram, twitter, tiktok, reddit, discord, youtube) | P1 |
| FR-009 | Skip classification for Gmail promo/social label categories | P1 |
| FR-010 | Maintain in-memory seen-ID set to avoid reprocessing within a server session | P1 |

### 5.2 AI Classification Pipeline

| ID | Requirement | Priority |
|----|------------|----------|
| FR-011 | Classify each item into one of 6 categories: Urgent, Work, Personal, Newsletter, Transactional, Spam | P0 |
| FR-012 | Assign priority 1–5 (1 = most urgent, 5 = least) | P0 |
| FR-013 | Generate human-readable summary (≤ 3 bullet points) | P0 |
| FR-014 | Extract action items with optional due dates | P0 |
| FR-015 | Flag follow-up needed (boolean) | P0 |
| FR-016 | Use Claude Haiku for classification (cheap, fast) | P0 |
| FR-017 | Validate LLM output against Zod schema; retry once on parse failure | P0 |
| FR-018 | Store classifications in separate table linked to inbound items | P0 |
| FR-019 | Idempotent: never re-classify an already-classified item | P0 |
| FR-020 | Store `model` and `prompt_version` per classification for auditability | P1 |

### 5.3 Deadline Extraction

| ID | Requirement | Priority |
|----|------------|----------|
| FR-021 | Extract explicit deadlines from item text with confidence score (0.0–1.0) | P0 |
| FR-022 | Store deadlines in separate `deadlines` table linked to inbound item | P0 |
| FR-023 | Dashboard page showing upcoming and overdue deadlines | P0 |
| FR-024 | Deadline status transitions: open → done / dismissed | P0 |
| FR-025 | Confidence threshold: only auto-create reminders for confidence ≥ 0.6 | P1 |

### 5.4 Action Lifecycle (Event-Sourced)

| ID | Requirement | Priority |
|----|------------|----------|
| FR-026 | Rules engine evaluates classification → proposes one or more actions | P0 |
| FR-027 | Actions follow lifecycle: Proposed → Approved → Executed (or Rejected / RolledBack) | P0 |
| FR-028 | Risk levels: Auto (Classify, Notify, DraftReply, CreateReminder) and ApprovalRequired (Archive, Delete, Send, Forward) | P0 |
| FR-029 | Idempotent: no duplicate proposals for same `(resourceId, actionType)` | P0 |
| FR-030 | Append-only audit log — never UPDATE or DELETE `action_log` rows | P0 |
| FR-031 | Store rollback data for destructive actions | P1 |
| FR-032 | Dashboard approval queue with approve/reject buttons + quick-action deep links | P0 |
| FR-033 | Auto-execute low-risk actions immediately upon proposal | P0 |
| FR-034 | Failed execution leaves action in Approved state (retryable), does not roll back to Proposed | P1 |

### 5.5 Daily Briefing

| ID | Requirement | Priority |
|----|------------|----------|
| FR-035 | Generate morning briefing: today's calendar meetings + urgent items + deadlines due in 7 days | P0 |
| FR-036 | Briefing accessible via dashboard `/today` page | P0 |
| FR-037 | Briefing accessible via chat ("briefing", "what's up", "morning summary") | P0 |
| FR-038 | Briefing synthesized by Claude Sonnet with extended thinking | P1 |

### 5.6 Chat Interface (Agent Loop)

| ID | Requirement | Priority |
|----|------------|----------|
| FR-039 | Natural language chat powered by multi-round agent loop (max 3 rounds, MVP1) | P0 |
| FR-040 | Intent extraction mode: Haiku extracts → tools execute → Sonnet synthesizes | P0 |
| FR-041 | Tool registry with 13 registered tools (see §8 Tool Registry Spec) | P0 |
| FR-042 | Conversation history stored chronologically in `conversations` table, never edited/deleted | P0 |
| FR-043 | Local context injection: email stats, pending actions, follow-ups from DB | P0 |
| FR-044 | History truncation: last 20 messages, each capped at 2000 chars for LLM context | P1 |
| FR-045 | Stop condition: intents array empty or contains `{"type": "none"}` → exit loop | P0 |
| FR-046 | "ACTIONS ALREADY EXECUTED THIS TURN" block injected into subsequent rounds | P1 |

### 5.7 Notifications

| ID | Requirement | Priority |
|----|------------|----------|
| FR-047 | In-app notification queue (MVP1): store in `notifications` table, poll from dashboard | P0 |
| FR-048 | Notify triggers: new urgent item, deadline approaching (configurable lead time), action proposed | P0 |
| FR-049 | `push_subscriptions` table schema created (foundation for web push, MVP1.5) | P1 |
| FR-050 | `NotificationPort` interface is provider-agnostic (swap InApp → WebPush without use case changes) | P0 |
| FR-051 | Notification preferences: toggle per event type, configurable quiet hours | P1 |

### 5.8 Calendar Integration (Google Calendar)

| ID | Requirement | Priority |
|----|------------|----------|
| FR-052 | List Google Calendar events by date range | P0 |
| FR-053 | Create new calendar events with title, start, end, description, attendees | P0 |
| FR-054 | Update existing events (add attendees, change time) | P1 |
| FR-055 | Search events by keyword | P1 |
| FR-056 | Calendar data cached with 3-minute TTL | P1 |

### 5.9 GitHub Integration

| ID | Requirement | Priority |
|----|------------|----------|
| FR-057 | List notifications across all accessible repos | P0 |
| FR-058 | List open pull requests (filterable by repo, author, state) | P0 |
| FR-059 | Webhook ingestion: PR opened, issue created events | P0 |
| FR-060 | Normalize GitHub webhook payloads to `InboundItem` | P0 |
| FR-061 | Verify webhook signatures via HMAC-SHA256 (`GITHUB_WEBHOOK_SECRET`) | P0 |

---

## 6. Non-Functional Requirements

| ID | Requirement | Category | Target |
|----|------------|----------|--------|
| NFR-001 | Classification latency per item | Performance | ≤ 3 seconds |
| NFR-002 | Dashboard page load | Performance | ≤ 2 seconds |
| NFR-003 | Agent server uptime | Availability | ≥ 99% (auto-restart via Docker) |
| NFR-004 | Credentials stored in env vars only, never in code/logs | Security | 100% compliance |
| NFR-005 | Single-user auth via Google OAuth allowlist | Security | `ALLOWED_EMAIL` check |
| NFR-006 | HTTPS via Cloudflare Tunnel — no exposed ports | Security | Zero open inbound ports |
| NFR-007 | Structured JSON logging to stdout (12-Factor XI) | Observability | All log output |
| NFR-008 | Graceful degradation when optional services unconfigured | Resilience | No crash on missing config |
| NFR-009 | Circuit breaker on LLM failures (pause + auto-resume) | Resilience | Auto-pause on 401/403/429 |
| NFR-010 | Retry with linear backoff for Power Automate calls | Resilience | 3 attempts, 1s/2s/3s |
| NFR-011 | 30-second request timeout with AbortController | Resilience | No indefinite hangs |
| NFR-012 | All config via environment variables (12-Factor III) | Portability | Zero hardcoded config |
| NFR-013 | Immutable releases via Docker images (12-Factor V) | Portability | Image per git SHA |
| NFR-014 | Stateless processes; all state in SQLite (12-Factor VI) | Portability | No in-process persistent state |
| NFR-015 | Port binding via env var (12-Factor VII) | Portability | `AGENT_PORT`, `DASHBOARD_PORT` |
| NFR-016 | GitHub webhook payloads verified via HMAC signature | Security | Reject invalid signatures |

---

## 7. Data Model Summary

| Table | Purpose | Key Integrity Rule |
|-------|---------|-------------------|
| `inbound_items` | Unified inbox across all sources | Upsert on `(source, external_id)` |
| `classifications` | AI classification results | Unique on `inbound_item_id`; raw item untouched |
| `deadlines` | Extracted deadlines from items | Linked to `inbound_items`; status: open/done/dismissed |
| `action_log` | Append-only action state machine | Never UPDATE/DELETE; full lifecycle audit trail |
| `notifications` | In-app notification queue | Read status tracking; deep links |
| `conversations` | Chat message history | Chronological order; never edited/deleted |
| `preferences` | User settings (polling, notifications) | Key-value store |
| `push_subscriptions` | Web push endpoints (MVP1.5 foundation) | Unique on `endpoint` |
| `classification_feedback` | User corrections for eval loop | Links to `classifications` |

---

## 8. Tool Registry Spec (Chat MVP1)

| Tool Name | Description | Key Input Fields |
|-----------|-------------|-----------------|
| `search_emails` | Search emails by query, category, source, sender | `query?, category?, source?, limit?` |
| `list_inbox` | List recent inbox items by priority threshold | `maxPriority?, source?, since?, limit?` |
| `list_deadlines` | List deadlines in date range | `from?, to?, status?` |
| `list_calendar_events` | List Google Calendar events | `timeMin, timeMax` |
| `create_calendar_event` | Create a new calendar event | `title, start, end, attendees?, description?` |
| `search_calendar` | Search events by keyword | `query, timeMin?, timeMax?` |
| `list_github_notifications` | List GitHub notifications | `all?, participating?` |
| `list_github_prs` | List open PRs | `state?, author?, repo?` |
| `search_teams_messages` | Search Teams messages | `query, channel?` |
| `list_pending_actions` | List actions awaiting approval | `status?` |
| `list_follow_ups` | List items needing follow-up | `overdue?` |
| `daily_briefing` | Generate today's full briefing | `{}` (no input) |
| `none` | Signal no more tools needed (stop loop) | `{}` (no input) |

---

## 9. Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLEAN ARCHITECTURE                          │
│                                                                 │
│  ┌─────────┐   ┌──────────────┐   ┌────────────────────────┐   │
│  │ Domain  │ ← │ Application  │ ← │   Infrastructure       │   │
│  │         │   │              │   │                        │   │
│  │Entities │   │ Use Cases    │   │ Gmail Adapter          │   │
│  │Enums    │   │ Strategies   │   │ Outlook PA Adapter     │   │
│  │Ports    │   │ Rules Engine │   │ Teams PA Adapter       │   │
│  │(0 deps) │   │ (domain only)│   │ GitHub Adapter         │   │
│  └─────────┘   └──────────────┘   │ Google Calendar Adapter│   │
│       ↑              ↑            │ Claude LLM Adapter     │   │
│       │              │            │ SQLite Repos           │   │
│  Dependency direction: inward     │ TTL Cache              │   │
│                                   │ Push Notification      │   │
│                                   │ Structured Logger      │   │
│                                   └────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              COMPOSITION ROOT                            │   │
│  │  Wire ports → adapters based on env config               │   │
│  │  Missing config → skip adapter (graceful degradation)    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐     │
│  │ Agent Server │  │  Dashboard   │  │ Cloudflare Tunnel │     │
│  │ (Node.js API │  │  (Next.js)   │  │ (HTTPS gateway)   │     │
│  │  + Workers)  │  │  Client-only │  │                   │     │
│  └──────────────┘  └──────────────┘  └───────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 10. Out of Scope (MVP1)

These are explicitly deferred to future phases:

- Multi-user / multi-tenant authentication and data isolation
- Finance / bank statement processing pipeline
- Pharmaceutical ERP / sales management system integration
- Deployed software monitoring and alerting
- RAG / vector search over personal knowledge base
- WhatsApp / LinkedIn integration
- Smart home integration (HomeKit, robot vacuum status)
- Tool-use chat mode (Claude native tool calling — planned MVP1.5)
- Web push notifications (schema ready; implementation in MVP1.5)
- Mobile app or native widgets (Android/iOS)
- Second persona / multi-persona support
- Spotify / podcast recommendation engine

---

## 11. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R1 | LLM API costs spiral beyond budget | Medium | High | Haiku for all cheap tasks; Sonnet only for synthesis; monthly spending limit ($20) |
| R2 | Gmail API rate limits (250 quota units/sec) | Low | Medium | Circuit breaker + exponential backoff; poll only 50 messages per tick |
| R3 | Power Automate reliability (webhook drops) | Medium | Medium | Retry 3x with linear backoff; items persisted locally even if classification fails |
| R4 | Classification accuracy below 85% target | Medium | Medium | Feedback loop + prompt versioning + offline test set; rule-based overrides for known senders |
| R5 | Scope creep during development | High | High | Hard MVP1 scope boundary in this PRD; future items in backlog only |
| R6 | Anthropic API breaking changes | Low | High | Abstract via `LLMPort` interface; model version pinned in config |
| R7 | SQLite write contention under load | Low (single-user) | Low | WAL mode enabled; acceptable for single-user; migration path to Postgres documented in ADR |
| R8 | Google OAuth token expiry mid-session | Medium | Medium | Refresh token stored in env; auto-refresh in Gmail adapter |

---

## 12. Glossary

| Term | Definition |
|------|-----------|
| **Inbound Item** | A normalized message/notification from any source (Gmail, Outlook, Teams, GitHub) |
| **Classification** | AI-generated metadata for an inbound item: category, priority, summary, action items, follow-up flag |
| **Deadline** | An explicit or implied due date extracted from an inbound item's text |
| **Action** | A proposed operation on an inbound item: archive, delete, draft reply, create reminder, notify, etc. |
| **Risk Level** | Whether an action auto-executes (Auto) or requires dashboard approval (ApprovalRequired) |
| **Agent Loop** | The background polling cycle: ingest → deduplicate → classify → extract deadlines → propose actions |
| **Chat Turn** | One user message → multi-round intent extraction/execution → synthesized response |
| **Tool Registry** | Central catalog of all capabilities available to the chat system |
| **Circuit Breaker** | Pattern that pauses LLM calls on fatal errors and auto-resumes on recovery |
| **Composition Root** | The single location where port interfaces are bound to concrete adapter implementations |
| **TTL Cache** | Time-to-live in-memory cache that auto-evicts expired entries |

---

## 13. Approval

| Role | Name | Date | Status |
|------|------|------|--------|
| Product Owner | _________________ | ____/____/2026 | ☐ Approved |
| Technical Lead | _________________ | ____/____/2026 | ☐ Approved |

---

*This document is the source of truth for Camp-Aneone MVP1 scope. Any feature not listed
here is out of scope until a future PRD revision.*
