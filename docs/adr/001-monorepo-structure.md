# ADR-001: Monorepo Structure with pnpm Workspaces

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-Aneone consists of multiple distinct concerns: domain logic, application use cases,
infrastructure adapters, shared API contracts, an agent server, and a dashboard. These
could be organized as separate repositories, a single flat directory, or a monorepo with
workspace packages.

The reference architecture (Alfred) uses a monorepo where packages build in dependency
order: domain → application → infrastructure → contracts → agent-server → dashboard.
This enforces the Clean Architecture dependency rule at the package boundary level.

## Decision

Use a **pnpm workspaces monorepo** with the following package structure:

```
packages/
  domain/           → 0 dependencies — pure TypeScript entities, enums, port interfaces
  application/      → depends on domain — use cases, strategies, rules engine
  infrastructure/   → depends on domain + application — adapters, repos, LLM, cache
  contracts/        → depends on domain — shared API DTOs between server and dashboard
apps/
  agent-server/     → depends on all packages — HTTP API + background workers
  dashboard/        → depends on contracts only — Next.js client UI
```

Build script compiles packages in topological order to enforce dependency direction.

## Consequences

**Easier:**
- Dependency direction is enforced by package boundaries (domain can't import infrastructure)
- Single `pnpm install` at root installs everything
- Single CI pipeline builds and tests the entire system
- Shared TypeScript config across packages
- Atomic commits across domain + use case + adapter changes

**Harder:**
- Slightly more complex initial setup (workspace config, cross-package references)
- Build order must be maintained (sequential build script)
- New contributors need to understand the package graph

## Alternatives Considered

1. **Single flat directory** — simpler setup but no enforcement of dependency boundaries.
   Nothing prevents `domain/` from importing `infrastructure/`. Rejected.

2. **Separate repositories** — strongest isolation but painful cross-repo changes, version
   coordination, and testing. Overkill for a single-user MVP. Rejected.

3. **Turborepo / Nx** — adds build caching and parallel execution. Valuable at scale but
   unnecessary complexity for MVP1 with 6 packages. Can adopt later. Rejected for now.
