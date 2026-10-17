# ADR-017: Hosting and Network for a Production Oneon

## Status: Accepted (owner decisions, Gerry, 2026-10-17), with one open item

## Supersedes: ADR-008 (single VM, Docker Compose and Cloudflare Tunnel)

## Date: 2026-10-17

## Context

ADR-008 chose one VM with Docker Compose and a Cloudflare Tunnel for a single user at minimal cost. Oneon is now both a personal assistant and the shared AI layer for ImpressoRx, with more products planned. A system review on 2026-10-17 found that the application is sound but the hosting is not:
- one machine, with no off-site copies of backups;
- no CI since early October (the GitHub account is locked by a billing issue);
- no monitoring;
- secrets in a plain `.env` file on the same disk as the data;
- ports 3000 and 4000 published on the host, which bypasses UFW;
- a compose file that starts a temporary quick tunnel while the deploy guide describes a named one.

The Hetzner account has since been deleted, with no recovery possible, and no off-site backups existed. Copies of the personal database dated 2026-10-03 remain on the owner's computer; whether one of them came from the live server is not yet confirmed.

Constraints set by the owner:
- **Budget:** under $50 a month.
- **Recovery:** RPO 1 hour, RTO 4 hours.
- **Uptime:** an internal objective, not a contractual promise.
- **Certification:** built to be ISO/IEC certifiable.
- **Data location:** users are in Ghana, and counsel accepts cross-border processing under the D0–D2 policies.

## Decision

1. **One codebase, two deployments.** A personal instance (Gmail, finance, Power Automate, GitHub) and a shared-service instance (hand-off, businesses, platform console). A deployment-role setting chooses which features an instance serves. Each instance has its own data, secrets and address.
2. **Hosting first, storage later.** Both instances move to Render, one instance each with a persistent disk, keeping SQLite. The shared service moves to Postgres in a later, separately planned project. The personal instance stays on SQLite.
3. **Region: Frankfurt** for Render and for Oneon's future Neon project. Oneon calls ImpressoRx's functions, which run in London (`lhr1`). It never connects to ImpressoRx's database in Ohio.
4. **Network:** public HTTPS behind Cloudflare in proxy mode. Cloudflare is listed as a subprocessor because it sees decrypted traffic. Cloudflare Access protects the platform console and admin pages. Oneon's own services talk over Render's private network where the plan allows it. There are no published ports and no tunnel in production.
5. **Secrets** live in Render's secret store, not in files.
6. **Backups:**
   - Sealed copies every hour for business files, `control.db` and the personal file.
   - Each copy is uploaded automatically to Backblaze B2 under Object Lock in governance mode.
   - Oneon's B2 key can add files but cannot delete them or override the lock. A separate override key is kept offline and used only when deletion is legally required.
   - B2 keeps hourly copies for 7 days and one copy a day up to 30 days.
   - The 30 days is stated in the retention policy and privacy notice.
7. **Alerts: Healthchecks.io** (owner's choice). It works by expecting pings and alerting when they stop:
   - each successful backup pings a backup check;
   - a liveness job inside each instance pings a liveness check every few minutes, which covers "is Oneon running";
   - Render's own health check restarts an instance that stops answering.

   Healthchecks.io is a supplier, but it sees only the pings, which carry no data. `/health` also returns no data.
8. **Staging:** one permanent staging instance of the shared service at a stable HTTPS address, so enrolment and token exchange with ImpressoRx can be tested. The personal instance has no staging.
9. **Storage model for the later Postgres move:** one Neon project with one schema per business, plus a control schema.
10. **Addresses** (owner, 2026-10-17). The domain is `oneon.app`, registered with Cloudflare Registrar in Oneon's Cloudflare account.

    | Instance | Address |
    |---|---|
    | Personal | `me.oneon.app` |
    | Shared service | `api.oneon.app` |
    | Shared-service staging | `staging.oneon.app` |

    - ImpressoRx pins `api.oneon.app` at enrolment, so it does not change. Changing it means every business enrols again.
    - Each address is one level below `oneon.app`, so Cloudflare's free edge certificate covers it.
    - `.app` is on the browsers' HSTS preload list, so every address needs a valid certificate from its first request, staging included.
    - The bare `oneon.app` serves nothing for now.
    - Zone settings applied 2026-10-17: SSL/TLS Full (strict), Always Use HTTPS on, minimum TLS 1.2.
    - The DNS records are added once the Render services exist. Each is a CNAME to its Render service, first in DNS-only mode until Render issues its certificate, then proxied. Whether Render can renew a certificate while the record is proxied is checked against Render's documentation at that point.
    - Email from the domain: ADR-018.

## Open item (owner decision: deletion)

Object Lock and the thinned history conflict. A locked file cannot be deleted before its lock expires, so hourly copies locked for 30 days cannot be thinned to one a day after 7 days. The proposed resolution:
- set the lock per file at upload: 7 days for hourly copies, 30 days for the daily copy;
- a lifecycle rule removes hourly copies once their lock ends.

Not built until the owner confirms.

## Consequences

**Easier:**
- No server to patch and no firewall to configure.
- Copies leave the machine within the hour.
- Secrets are off the data disk.
- Personal data is separated from business data, and certification scope can cover the shared service alone.

**Harder or accepted:**
- Each deploy causes a few seconds of downtime, because a service with a disk runs as one instance.
- The two-deployment split needs a deployment-role setting and a migration of the personal data.
- Estimated cost is about $39–45 a month after the move: two production instances of the API and dashboard, one staging instance, disks and B2. The later Postgres move may cross $50; that is decided before it starts.

**Not covered here:** retention and deletion of business data (a later ADR, owner decisions), the Postgres port, and the generic host layer needed before a second product.

## References

- Oneon System Review and Oneon Production Roadmap, 2026-10-17.
- The CTO's recommendation, "Oneon Hosting and Network Architecture Recommendation", 2026-10-16.
- Render: Persistent disks (one instance per disk; no zero-downtime deploys).
