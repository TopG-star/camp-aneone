# ADR-003: SQLite as Primary Database (Local-First)

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-Aneone needs a persistent data store for inbound items, classifications, deadlines,
action logs, conversations, and notifications. The system is single-user for MVP1 and must
run on a single cloud VM with minimal operational overhead.

Options evaluated: PostgreSQL, MySQL, MongoDB, SQLite.

## Decision

Use **SQLite** via `better-sqlite3` (synchronous Node.js driver) as the sole database for
MVP1.

Configuration:
- WAL (Write-Ahead Logging) mode for concurrent readers
- Foreign keys enabled via `PRAGMA foreign_keys = ON`
- Database file stored at configurable `DB_PATH` (default: `./data/oneon.db`)
- Migrations run on server startup before accepting requests

## Consequences

**Easier:**
- Zero external services to manage — no database server, no connection strings
- Single-file database — backup is just copying a file
- Synchronous API (`better-sqlite3`) — no connection pool management
- Extremely fast for single-user read/write patterns
- Works identically in development and production (12-Factor X: dev/prod parity)
- No cold start — database is always available

**Harder:**
- No built-in network access — can't share database across processes easily
- Write contention under high concurrency (acceptable for single-user)
- No built-in full-text search (can add FTS5 extension later)
- Migration to multi-user requires migrating to PostgreSQL

**Migration path to PostgreSQL (documented for future):**
1. Replace `better-sqlite3` with a Postgres driver (e.g., `pg` or Drizzle with Postgres)
2. Repository implementations change; port interfaces stay identical
3. SQL syntax differences are minimal (both support standard SQL)
4. Composition root swaps repo implementations based on `DB_TYPE` env var

## Alternatives Considered

1. **PostgreSQL** — production-grade, scales to multi-user, great ecosystem. But adds
   operational complexity (server management, connection pooling, backups). Premature for
   single-user MVP1. Will adopt for multi-user phase.

2. **MongoDB** — document model fits some patterns but adds a server dependency and doesn't
   enforce relational integrity (classifications → inbound_items FK). Rejected.

3. **Turso (libSQL)** — SQLite-compatible with replication. Interesting for future but adds
   a dependency. Can evaluate when multi-user is needed. Rejected for now.
