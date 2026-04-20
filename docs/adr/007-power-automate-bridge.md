# ADR-007: Power Automate Bridge for Outlook & Teams

## Status: Accepted

## Date: 2026-04-14

## Context

The user receives work-related messages via Microsoft Outlook and Microsoft Teams in
addition to Gmail. Microsoft's Graph API provides direct access to both services, but
requires:
- Azure AD app registration with admin consent for organizational tenants
- Complex OAuth2 flows with tenant-specific endpoints
- Handling delegated vs. application permissions
- Webhook subscriptions with validation endpoints

The user already has access to Power Automate (included with Microsoft 365) and is
familiar with its low-code flow builder. For MVP1, the goal is to capture inbound items
from Outlook and Teams as quickly as possible without building a Graph API integration.

## Decision

**MVP1: Power Automate as an ingestion bridge**

1. Create two Power Automate flows:
   - **Outlook flow:** Trigger "When a new email arrives" → HTTP POST to camp-aneone
     webhook endpoint with sender, subject, body snippet, received date, and a stable
     message ID.
   - **Teams flow:** Trigger "When a new message is posted in a channel" (or "When I am
     mentioned") → HTTP POST with author, channel, message text, and timestamp.

2. The webhook endpoint in camp-aneone is a standard authenticated POST route at
   `/api/webhooks/power-automate` that:
   - Validates a shared secret in the `Authorization` header
   - Normalises the payload into the `InboundItem` domain entity
   - Upserts into `inbound_items` with `source = 'outlook'` or `source = 'teams'`
   - Returns 200 + idempotency key

3. **MVP2+: Migrate to Microsoft Graph API** when the user needs bidirectional
   interaction (replying from the dashboard, marking as read, etc.). The domain layer
   remains unchanged — only the infrastructure adapter changes.

## Consequences

**Easier:**
- No Azure AD app registration required for MVP1
- Power Automate handles OAuth and reconnection to Microsoft services
- Flows can be built and tested in 30 minutes each
- The camp-aneone codebase stays focused on Gmail as the only "direct API" integration
- Clean separation: Power Automate is just another ingestion adapter behind the port

**Harder:**
- One-directional only: camp-aneone can read but not act on Outlook/Teams messages
- Depends on Power Automate reliability and throttling limits (typically generous for
  personal use)
- Slight latency increase vs. direct API polling (Power Automate checks every 1-3 minutes)
- The shared secret must be rotated manually if compromised

## Alternatives Considered

1. **Direct Graph API integration from day one** — full bidirectional access but 2-3 days
   of setup and auth complexity. Deferred to MVP2. Rejected for MVP1.

2. **IMAP for Outlook** — possible for email only, doesn't cover Teams at all, and
   Microsoft is deprecating basic auth IMAP. Rejected.

3. **Third-party integration platform (Zapier, Make)** — similar approach to Power
   Automate but adds cost. User already has Power Automate included. Rejected.
