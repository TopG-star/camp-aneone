# Staging Deployment Guide

Deploy camp-aneone to a Hetzner CX22 VPS with Docker Compose and Cloudflare Tunnel.

## Architecture

```
Internet → Cloudflare Tunnel → dashboard (:3000) → agent-server (:4000)
                                                        ↕
                                                    SQLite (volume)
```

Three containers:
- **dashboard** — Next.js 15 frontend (port 3000)
- **agent-server** — Express API (port 4000, SQLite)
- **cloudflared** — Cloudflare Tunnel sidecar (no exposed ports)

## Prerequisites

| Item | Details |
|------|---------|
| Hetzner CX22 | 2 vCPU, 4 GB RAM, 40 GB disk, Ubuntu 24.04 |
| Cloudflare account | Free plan is fine |
| Domain | Managed via Cloudflare DNS |

## 1. Provision VPS

Create a Hetzner CX22 with Ubuntu 24.04 via the Hetzner Cloud Console.

```bash
# SSH in
ssh root@<VPS_IP>

# Update & install Docker
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Verify
docker --version
docker compose version
```

## 2. Create Cloudflare Tunnel

1. Go to **Cloudflare Dashboard → Zero Trust → Networks → Tunnels**
2. Click **Create a tunnel** → Name it `camp-aneone-staging`
3. Copy the **tunnel token** (starts with `eyJ…`)
4. Add a **Public Hostname**:
   - Subdomain: `app` (or your choice)
   - Domain: `aneone.com` (or your domain)
   - Service: `http://dashboard:3000`
5. DNS record is created automatically by Cloudflare

## 3. Clone & Configure

```bash
# Clone the repo
git clone https://github.com/TopG-star/camp-aneone.git
cd camp-aneone

# Create .env from template
cp .env.template .env
nano .env
```

Fill in all required values in `.env`:

```
NODE_ENV=production
PORT=4000
PUBLIC_URL=https://app.aneone.com
NEXTAUTH_SECRET=<openssl rand -base64 32>
NEXTAUTH_URL=https://app.aneone.com
ALLOWED_EMAILS=your@email.com
API_TOKEN=<openssl rand -base64 32>
OAUTH_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
ANTHROPIC_API_KEY=<from Anthropic>
CLOUDFLARE_TUNNEL_TOKEN=<from step 2>
DATABASE_PATH=./data/oneon.db
FEATURE_BACKGROUND_LOOP=true
```

> **Important**: Update your Google OAuth authorized redirect URI to `https://app.aneone.com/api/auth/callback/google`.

## 4. Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

The script will:
1. Back up any existing SQLite database
2. Pull latest code from git
3. Build Docker images
4. Start all 3 containers
5. Run a health check against `http://localhost:4000/health`

## 5. Verify

```bash
# Check containers are running
docker compose ps

# Check health endpoint
curl -s http://localhost:4000/health | python3 -m json.tool

# Check Cloudflare Tunnel
# Visit https://app.aneone.com in your browser
```

## Subsequent Deploys

```bash
cd camp-aneone
./deploy.sh
```

To restart without rebuilding:
```bash
./deploy.sh --no-build
```

## Maintenance

### View logs
```bash
docker compose logs -f                  # all services
docker compose logs -f agent-server     # specific service
docker compose logs -f dashboard
docker compose logs -f cloudflared
```

### Backups

Oneon writes its own backups; do not copy the database files by hand (a plain `cp` can copy a file in the middle of a write).

- **What:** SQLite's online backup API, one sealed file per database: `control`, `personal` and one per active tenant. They are written to `BACKUP_DIR` (default `./data/backups`, which is `/app/data/backups` in the container, inside the `db-data` volume).
- **When:** once per calendar day (a `yyyy-mm-dd` folder), and before every migration that is pending (`pre-migration/<timestamp>/`). A day is written into `yyyy-mm-dd.partial/` and renamed to `yyyy-mm-dd` only when every file succeeded, so a day folder always means a complete day. If a file fails, or the server dies part-way, no day folder exists and the next hourly check starts the day again (a leftover `.partial` folder is replaced); sync and prune only `yyyy-mm-dd` and `pre-migration` folders. If the backup before a migration fails, that file is not migrated: a pharmacy is refused service and logged at error level while the others are served; a failure for `control` or `personal` stops the server from starting.
- **Skipped pharmacies:** a pharmacy the server refuses to open (for example `tenant_schema_behind` after its pre-migration backup failed, so it was not migrated) does not hold the day back. The day completes without it; the pharmacy is listed in `yyyy-mm-dd/skipped.json` (`[{registrationId, code}]`, absent when nothing was skipped) and logged at error ("backup skipped") on every nightly run until it is fixed. Its last good copy is its backup under `pre-migration/<timestamp>/`. Any other failure (a backup, seal or write error, or an unexpected error opening a file) still keeps the day in `.partial` and is retried hourly.
- **Encryption:** AES-256-GCM under `BACKUP_ENCRYPTION_KEY` (base64 of 32 bytes: `openssl rand -base64 32`). Without it no backups are made and the server warns at startup; once any pharmacy is registered the server refuses to start without it, so enrolling a pharmacy is refused (HTTP 503, naming `BACKUP_ENCRYPTION_KEY`) until the key is set and the server restarted. Keep a copy of the key somewhere other than the VPS: a backup is only as recoverable as its key. Each file is bound to its own folder and file name (`<day>/<name>.db.enc`), so sync the folder as it is. If a file was renamed or moved anyway (for example fetched from off-site into another folder), restore it with `--as` (below).
- **Restore test:** once a month Oneon restores one pharmacy (rotating) from the latest backup into a temporary folder, runs `PRAGMA integrity_check`, reads `context_meta`, and deletes the copy. The test passes only if `context_meta` says kind `tenant` with the tenant id of the registration that owns the file; a file with no owning registration, a different tenant id or no `context_meta` fails. A failure is logged at error level ("Monthly restore test failed"); watch the logs for it.
- **Startup lock:** while the server prepares storage (opening and migrating `control.db`, backing up, migrating the other files) it holds an operating-system lock on `storage.lock`, beside `control.db`. If a second Oneon process starts meanwhile it stops with "Another Oneon process is preparing storage". The system releases the lock when a process dies, so a crash or kill never leaves it stuck: there is no lock file to delete by hand. Startup also removes plaintext scratch folders and `.part` files an interrupted backup left behind.
- **Off-site:** the folder only protects against mistakes until it leaves the VPS. Sync `BACKUP_DIR` off-site with the tool of your choice, for example `rclone` to Cloudflare R2 or to a Hetzner Storage Box:
  ```bash
  docker run --rm -v camp-aneone_db-data:/data:ro -v ~/.config/rclone:/config/rclone rclone/rclone \
    sync /data/backups r2:camp-aneone-backups
  ```
- **Pruning is yours:** Oneon never deletes a backup in this release, so the folder grows. Prune old `yyyy-mm-dd` and `pre-migration` folders yourself (for example keep 30 daily folders). A later release (B-retention) will delete each backup on the same schedule as its file.

### Restore database from backup

Restore one file at a time: stop the server, decrypt, replace the file, start. Run the decrypt step from a checkout of the repository (the container image does not carry the script), with `BACKUP_ENCRYPTION_KEY` in the checkout's `.env` or the environment. Relative `<file>` and `--out` paths are taken from the directory you typed the command in, not from the package folder.

```bash
docker compose down

# Decrypt to a new file. It refuses to overwrite an existing file unless you add --force.
pnpm --filter @oneon/agent-server restore-backup /path/to/backups/2026-10-10/personal.db.enc --out /tmp/oneon.db

# If the file was renamed or moved, name where it was written: <day>/<file name>.
# pnpm --filter @oneon/agent-server restore-backup ./fetched/copy.enc --as 2026-10-10/personal.db.enc --out /tmp/oneon.db

# Replace the live file with it (personal -> oneon.db, control -> control.db, a pharmacy -> tenants/<its file name>).
# Remove the old file's -wal and -shm files at the same time.
docker run --rm \
  -v camp-aneone_db-data:/data \
  -v /tmp:/restore \
  alpine:3.20 sh -c 'rm -f /data/oneon.db-wal /data/oneon.db-shm && cp /restore/oneon.db /data/oneon.db'

docker compose up -d
```

The decrypted file is plaintext: delete it when you are done, and do not leave it in `BACKUP_DIR`. The file you restore carries its own schema version; the server migrates it when it starts (with a backup first).

## Firewall (Optional but Recommended)

Since Cloudflare Tunnel handles ingress, no ports need to be exposed:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw enable
```

Port 3000 and 4000 stay internal to Docker — Cloudflare Tunnel connects outbound.

## Migrating to Caddy (Future)

When ready to replace Cloudflare Tunnel with Caddy for direct TLS:
1. Add a Caddy service to `docker-compose.yml`
2. Expose ports 80 and 443
3. Remove the `cloudflared` service
4. Update Cloudflare DNS to point A record to VPS IP
