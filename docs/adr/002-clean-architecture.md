# ADR-002: Clean Architecture with Ports and Adapters

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-Aneone integrates with 6+ external services (Gmail, Outlook, Teams, GitHub, Google
Calendar, Anthropic Claude). Each service has its own SDK, authentication model, data
format, and failure modes. The system also needs to be extensible — future phases add
WhatsApp, LinkedIn, ERP systems, and finance processing.

The reference architecture (Alfred) attributes its extensibility directly to Clean
Architecture: "When your domain layer knows nothing about Gmail, adding Outlook is just
another adapter. When your use cases speak in ports, swapping Claude Haiku for Sonnet is a
one-line change in the composition root."

## Decision

Adopt **Clean Architecture** with strict dependency direction:

```
Domain (innermost)
  ↑
Application (use cases)
  ↑
Infrastructure (outermost)
```

**Rules:**
1. The **domain** package contains entities, enums, and port interfaces. It has ZERO npm
   dependencies and ZERO imports from application or infrastructure.

2. The **application** package contains use cases and strategy interfaces. It depends ONLY
   on domain. It never imports an adapter, SDK, or database driver.

3. The **infrastructure** package contains all adapters (Gmail, Claude, SQLite, etc.).
   It implements the port interfaces defined in domain.

4. The **composition root** (`apps/agent-server/src/composition-root.ts`) is the ONLY place
   where port interfaces are bound to concrete adapter implementations.

5. Adding a new external service means: (a) define a port interface in domain if one doesn't
   exist, (b) write an adapter in infrastructure, (c) wire it in the composition root.
   Zero changes to domain or application.

## Consequences

**Easier:**
- Adding new providers (e.g., Outlook adapter) without modifying existing code
- Swapping LLM models (Haiku ↔ Sonnet ↔ Opus) with a config change
- Unit testing use cases with mock ports (no real API calls)
- Reasoning about the system — each layer has a clear, bounded responsibility

**Harder:**
- More files and indirection compared to a flat architecture
- Initial setup takes longer (interfaces, then implementations, then wiring)
- Developers must understand dependency injection to contribute effectively
- Over-abstracting simple things (mitigated by YAGNI discipline)

## Alternatives Considered

1. **Flat MVC / service layer** — faster to start but provider-specific code leaks into
   business logic. Adding a new email provider would require changes throughout. Rejected.

2. **Hexagonal Architecture** — essentially the same as what we're adopting. "Ports and
   adapters" is the hexagonal pattern. We use the Clean Architecture naming convention
   (domain/application/infrastructure) because it matches the reference implementation and
   the build order is more explicit. Considered equivalent; naming preference.

3. **Microservices** — each integration as a separate service. Massive overkill for a
   single-user system. Would add network hops, deployment complexity, and operational
   overhead with no benefit at this scale. Rejected.
