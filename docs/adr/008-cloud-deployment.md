# ADR-008: Cloud Deployment — Docker Compose + Cloudflare Tunnel

## Status: Accepted

## Date: 2026-04-14

## Context

Camp-aneone runs as a long-lived server process that polls Gmail every 3 minutes, processes
webhooks from Power Automate and GitHub, serves the Next.js dashboard, and exposes an API.
The user wants cloud deployment so the system runs 24/7 without leaving a laptop on.

Key constraints:
- Single user — no horizontal scaling needed for MVP1
- Budget-conscious — minimal cloud cost
- Needs HTTPS for OAuth callbacks (Gmail, Google Calendar, NextAuth)
- Needs a stable public URL for Power Automate and GitHub webhooks
- The user wants Docker for reproducible deploys

## Decision

**Single VM + Docker Compose + Cloudflare Tunnel (zero-trust access)**

### Architecture

```
Internet
    │
    ▼
Cloudflare Tunnel (cloudflared)
    │  HTTPS termination + DDoS protection + caching
    ▼
Docker Compose host (single VM)
    ├── oneon-server    (agent-server: API + poller + scheduler)
    ├── oneon-dashboard (Next.js 14: SSR dashboard)
    └── oneon-volumes
         ├── ./data/oneon.db       (SQLite WAL)
         └── ./data/oneon.db-wal
```

### Key decisions

1. **Cloudflare Tunnel instead of a reverse proxy + Let's Encrypt:**
   - No open ports on the VM (zero-trust)
   - Automatic HTTPS with a Cloudflare-managed certificate
   - Free tier is sufficient for a single user
   - Stable subdomain (e.g., `oneon.yourdomain.com`) for OAuth redirect URIs

2. **Docker Compose (not Kubernetes):**
   - Single VM, 2-3 containers — Kubernetes is overkill
   - `docker compose up -d` for deployment, `docker compose pull && docker compose up -d`
     for updates
   - Health checks in compose file for auto-restart

3. **SQLite volume mount:**
   - The database file is bind-mounted from the host to the container
   - Backup = copy the `.db` and `.db-wal` files (while in WAL checkpoint)
   - Daily cron on host runs `sqlite3 oneon.db ".backup /backups/oneon-$(date +%Y%m%d).db"`

4. **VM recommendation:**
   - 1 vCPU, 2GB RAM, 20GB SSD (e.g., Hetzner CX22 at ~€4/mo, or DigitalOcean $6/mo)
   - Ubuntu 22.04 LTS with Docker pre-installed

### Deployment workflow

```
local dev → git push → SSH into VM → docker compose pull → docker compose up -d
```

For MVP1, this manual workflow is sufficient. CI/CD (GitHub Actions → SSH deploy) can be
added in a later phase.

## Consequences

**Easier:**
- Zero exposed ports — Cloudflare Tunnel handles everything
- No SSL certificate management
- Trivially simple deployment — one `docker compose` command
- Cheap: ~$4-6/mo for the VM, Cloudflare free tier
- SQLite backup is just a file copy

**Harder:**
- No zero-downtime deploys (containers restart during `docker compose up -d`)
  — acceptable for single user, downtime is seconds
- No auto-scaling — must manually upgrade VM if load increases
- SSH-based deployment requires the user to be present (no auto-deploy)
- If the VM dies, manual recovery from backup

## Alternatives Considered

1. **Kubernetes (k3s or managed k8s)** — superior scaling and self-healing but massive
   complexity for a single-user app. Rejected for MVP1.

2. **Vercel/Railway for everything** — easy deploys but: (a) long-running pollers don't
   fit serverless, (b) SQLite doesn't work on ephemeral filesystems, (c) cost adds up
   with always-on processes. Rejected.

3. **Bare metal (no Docker)** — works but loses reproducibility. "It works on my machine"
   problems. Rejected.

4. **Nginx + Let's Encrypt** — traditional approach but requires open ports 80/443,
   certbot renewal cron, and more config. Cloudflare Tunnel is simpler and more secure.
   Rejected.
