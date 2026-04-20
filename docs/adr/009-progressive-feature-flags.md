# ADR-009: Progressive Feature Flags via Environment Variables

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-aneone integrates with multiple external services (Gmail, Google Calendar, GitHub,
Outlook via Power Automate, Teams via Power Automate, Anthropic LLM). Not all services
will be configured on day one — the user may:

- Start with Gmail only while waiting for Google Calendar consent
- Skip Power Automate flows initially
- Disable GitHub integration during development
- Run a "dry run" mode where the agent classifies but never executes

The system must degrade gracefully when a service is not configured, rather than crashing
at startup.

## Decision

**Feature activation is controlled by the presence of environment variables.** There is
no separate feature-flag service or database table.

### Rules

1. **Missing config = adapter disabled.** Each infrastructure adapter checks its required
   env vars at construction time. If any required var is empty or missing, the adapter
   returns a no-op implementation of its port interface.

   ```typescript
   // Example: GmailAdapter checks for GMAIL_CLIENT_ID
   export function createGmailAdapter(): EmailPort {
     if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
       console.warn('[gmail] Missing credentials — Gmail adapter disabled');
       return new NoOpEmailAdapter();
     }
     return new GmailAdapter(/* ... */);
   }
   ```

2. **Explicit feature flags for non-obvious toggles:** Some features don't map 1:1 to
   an external service. These get explicit boolean-style env vars:

   | Variable                    | Default | Purpose                              |
   |-----------------------------|---------|--------------------------------------|
   | `FEATURE_AUTO_EXECUTE`      | `false` | Allow auto-execution of low-risk actions |
   | `FEATURE_PUSH_NOTIFICATIONS`| `false` | Enable web push via VAPID            |
   | `FEATURE_CHAT`              | `true`  | Enable chat interface                |

3. **Startup health report:** On boot, the composition root logs which adapters are active
   and which are disabled, producing a clear summary:

   ```
   [boot] Gmail:     ✓ active
   [boot] Calendar:  ✓ active
   [boot] GitHub:    ✗ disabled (missing GITHUB_TOKEN)
   [boot] Outlook:   ✗ disabled (missing PA_OUTLOOK_SECRET)
   [boot] Teams:     ✗ disabled (missing PA_TEAMS_SECRET)
   [boot] LLM:       ✓ active (haiku + sonnet)
   ```

4. **12-Factor alignment:** All configuration lives in the environment (Factor III: Config).
   No config files, no `.json` settings, no compile-time flags.

## Consequences

**Easier:**
- New users can start with Gmail-only and add services incrementally
- Development is simpler: set only the env vars you're working with
- CI/testing can disable all external services for pure unit tests
- No feature-flag infrastructure to build or maintain
- Clear startup diagnostics — user immediately knows what's active

**Harder:**
- No runtime toggle — changing a feature requires restart (acceptable for single user)
- No gradual rollout percentages (not needed for single user)
- Must document every env var clearly in `.env.example`
- Risk of silent degradation if an env var is accidentally removed

## Alternatives Considered

1. **Database-backed feature flags** — runtime toggleable but adds a table, admin UI,
   and complexity. Overkill for single user. Rejected.

2. **Config file (JSON/YAML)** — violates 12-Factor. Harder to manage across environments.
   Rejected.

3. **Compile-time flags** — requires rebuild to toggle. Rejected.

4. **Third-party feature flag service (LaunchDarkly, Flagsmith)** — enterprise-grade but
   adds a dependency and cost for zero benefit at single-user scale. Rejected.
