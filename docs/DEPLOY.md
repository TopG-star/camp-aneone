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

> **Upgrading to the release that adds pharmacies (Step B-core):** set `BACKUP_ENCRYPTION_KEY` in `.env` (`openssl rand -base64 32`, with a copy kept off the VPS) *before* you deploy it. Its first start migrates `oneon.db` and creates `control.db`, and Oneon backs a file up before migrating it only when the key is set. Without the key that first migration runs with no backup of its own (the server only warns), and the copy `deploy.sh` takes is a plain file copy, which can catch the file mid-write.

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
- **Missing pharmacy file:** an active pharmacy whose file is not on disk is skipped the same way (listed in `skipped.json` with `code: "tenant_file_missing"`), and logged at error with `alert: "tenant_file_missing"` ("backup skipped: the tenant file is missing") on every nightly run until it is fixed. This is not a schema problem: the file has to be restored from a backup (see Restore).
- **Backup age:** after every hourly check Oneon looks at the newest restorable copy of `control`, `personal` and each active pharmacy: a sealed file in a finished `yyyy-mm-dd/` folder or under `pre-migration/`, by the time it was written (never a `.partial` folder or a `.part` file). Any whose newest copy is older than 26 hours, or that has none, is logged at error with `alert: "backup_stale"` (`context`, `registrationId` for a pharmacy, `ageHours` or `"none"`), every hour until a fresh copy exists. A skipped pharmacy therefore keeps alerting once its `pre-migration/` copy is more than 26 hours old.
- **Encryption:** AES-256-GCM under `BACKUP_ENCRYPTION_KEY` (base64 of 32 bytes: `openssl rand -base64 32`). Without it no backups are made and the server warns at startup; once any pharmacy is registered the server refuses to start without it, so enrolling a pharmacy is refused (HTTP 503, naming `BACKUP_ENCRYPTION_KEY`) until the key is set and the server restarted. Keep a copy of the key somewhere other than the VPS: a backup is only as recoverable as its key. Each file is bound to its own folder and file name (`<day>/<name>.db.enc`), so sync the folder as it is. If a file was renamed or moved anyway (for example fetched from off-site into another folder), restore it with `--as` (below).
- **Restore test:** once a month Oneon restores one pharmacy (rotating) from the latest backup into a temporary folder, runs `PRAGMA integrity_check`, reads `context_meta`, and deletes the copy. The test passes only if `context_meta` says kind `tenant` with the tenant id of the registration that owns the file; a file with no owning registration, a different tenant id or no `context_meta` fails. A failure is logged at error level ("Monthly restore test failed"); watch the logs for it.
- **Startup lock:** while the server prepares storage (opening and migrating `control.db`, backing up, migrating the other files) it holds an operating-system lock on `storage.lock`, beside `control.db`. If a second Oneon process starts meanwhile it stops with "Another Oneon process is preparing storage". The system releases the lock when a process dies, so a crash or kill never leaves it stuck: there is no lock file to delete by hand. Backups and restore tests keep their plaintext scratch in `backup-scratch/`, beside `control.db` (on the data volume, never in `BACKUP_DIR` or the system's temporary folder); startup removes what an interrupted backup left there, and `.part` files in `BACKUP_DIR`.
- **Off-site:** the folder only protects against mistakes until it leaves the VPS. Sync `BACKUP_DIR` off-site with the tool of your choice, for example `rclone` to Cloudflare R2 or to a Hetzner Storage Box:
  ```bash
  docker run --rm -v camp-aneone_db-data:/data:ro -v ~/.config/rclone:/config/rclone rclone/rclone \
    sync /data/backups r2:camp-aneone-backups
  ```
- **Pruning is yours:** Oneon never deletes a backup in this release, so the folder grows. Prune old `yyyy-mm-dd` and `pre-migration` folders yourself (for example keep 30 daily folders). A later release (B-retention) will delete each backup on the same schedule as its file. Whoever prunes, by hand or in B-retention, must never delete a context's newest copy: that includes a skipped pharmacy's last good copy under `pre-migration/` (it may be the only one), and `control` and `personal` as well. Check `backup_stale` before and after pruning.

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

## Pharmacies (ImpressoRx)

Oneon serves a pharmacy only after a platform operator has enrolled that pharmacy's ImpressoRx deployment.

### Keys

Set these in `.env` before you enrol the first pharmacy. Each is base64 of 32 bytes (`openssl rand -base64 32`):

| Key | What it seals | If it is lost |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY` | backups (see Backups) | no backup can be restored |
| `ONEON_SIGNING_KEY_MASTER_KEY` | Oneon's private signing key for each pharmacy | every pharmacy registration stops working; each must be enrolled again |
| `ONEON_GRANT_MASTER_KEY` | the delegation grants ImpressoRx issues at each hand-off | every grant is unusable; staff open Oneon from ImpressoRx again |

Keep a copy of each key somewhere other than the VPS. Nothing can decrypt what a lost key sealed. Enrolment is refused with HTTP 503, naming each missing key, until all three are set and the server has been restarted. `CONTROL_DATABASE_PATH` (default `./data/control.db`) and `TENANT_DATA_DIR` (default `./data/tenants`) must stay on the data volume.

### Becoming the first platform operator

1. Sign in to the dashboard with Google once. That creates your Oneon identity.
2. Find your identity id (replace the email with yours):
   ```bash
   docker compose exec agent-server node -e "const db = require('better-sqlite3')(process.env.CONTROL_DATABASE_PATH || './data/control.db', { fileMustExist: true }); console.log(db.prepare('SELECT identity_id, kind, email FROM login_identities WHERE lower(email) = lower(?)').all(process.argv[1]))" you@example.com
   ```
3. Grant operator to that id. The command backs up `control.db` first if a migration is pending, and it refuses a control database that does not exist (it never creates an empty one):
   ```bash
   docker compose exec agent-server node --input-type=module -e "const { grantOperator, grantOperatorPaths } = await import('/app/packages/agent-server/dist/grant-operator.js'); await grantOperator({ ...grantOperatorPaths(process.env), keyB64: process.env.BACKUP_ENCRYPTION_KEY || undefined, identityId: process.argv[1] }); console.log('Granted platform operator')" <identity-id>
   ```
   From a checkout of the repository (local development), the same step is `pnpm --filter @oneon/agent-server grant-operator <identity-id>`, run from the repository root. A relative `CONTROL_DATABASE_PATH` is taken from the folder you typed the command in.

### Enrolling a pharmacy

1. The pharmacy's ImpressoRx admin opens **Settings → Oneon** and presses **Enable**. ImpressoRx shows a one-time enrolment code that is valid for 10 minutes.
2. Check the deployment's HTTPS origin against the tenant registry, out of band. Enrolment trusts whichever deployment answers at that origin and holds the code.
3. In the dashboard, open **/platform/enrol** and enter the origin, the tenant slug and the code. A successful enrolment creates the pharmacy's registration and its database file.

   The deployment's signed reply names its ImpressoRx tenant id, ImpressoRx's `Tenant.id`. That id is made once per pharmacy database and never reused, and Oneon stores it as the pharmacy's permanent identity. The slug is only a name: a pharmacy deleted and set up again can come back under the same slug, but not with the same id. Enrolment is refused with 502 if the reply names no tenant id (the ImpressoRx release is too old: update it first), or if another registration already holds that id (for example, a copy of an enrolled pharmacy's database). Both refusals come after the code has been used.
4. **/platform** lists every pharmacy with its status and its latest daily rollup (counts only).

### Suspending a pharmacy

**Suspend**, on **/platform**, stops Oneon serving a pharmacy at once. Its staff cannot open it in Oneon, and nightly jobs and backups skip it. Nothing changes in ImpressoRx. **Resume** undoes a suspension. Each change is recorded as a `status_changed` event on the registration and as a log line ("Pharmacy suspended by operator", "Pharmacy resumed by operator").

A pharmacy whose admin pressed **Remove** in ImpressoRx, or whose keys are lost, still shows as active, but every exchange with it fails. Lost keys means a lost `ONEON_SIGNING_KEY_MASTER_KEY`, or a deployment key Oneon could not refresh within its 7-day overlap. To reconnect it:

1. **Suspend** it on **/platform**.
2. The pharmacy's ImpressoRx admin opens **Settings → Oneon**. If Oneon is still enabled there, the admin presses **Remove**. The admin then presses **Enable**, which issues a fresh enrolment code.
3. Enrol it again on **/platform/enrol** with the same origin, the same tenant slug and the new code.

Re-enrolment runs the full two-sided enrolment proof. On success, Oneon:

- retires every old key at once (with no 7-day overlap) and stores the new keys;
- revokes every grant of the pharmacy;
- sets the pharmacy active again.

Its database file, tenant id and memberships are kept. Each staff member reconnects by opening Oneon from ImpressoRx, as usual.

Re-enrolment is refused in these cases:

- with 409 while the pharmacy is active;
- with 409 at any origin other than the one the pharmacy was enrolled at;
- with 502 if the deployment's signed reply names a different tenant slug;
- with 502 if the reply names a different ImpressoRx tenant id from the one stored at enrolment. The pharmacy at that origin was set up again or its database was replaced, so it is not the pharmacy this registration belongs to, and the registration and its data stay with the original. Re-enrolment never moves a registration to a different pharmacy.

The 502 refusals come after the code has been used, so the admin must issue a new one.

A registration enrolled before ImpressoRx sent its tenant id has none stored. Its next successful re-enrolment records the id (the `reenrolled` event says `impressorxTenantIdRecorded: true`), and later re-enrolments must match it.

Moving a pharmacy to a new origin is not possible from the console. It remains a manual procedure on `control.db`, done with the server stopped and a fresh backup.

### Log alerts to watch

- `code: "tenant_mismatch"` ("Tenant mismatch", error): a row of another context was found in a pharmacy's file. No row content is logged.
- `alert: "link_check"` (error): the nightly link check found an action grant whose action no longer exists, or could not check a pharmacy.
- `alert: "backup_stale"` (error, every hour until it is fixed): the newest restorable copy of `control`, `personal` or a pharmacy is older than 26 hours or missing. See Backups.
- `alert: "tenant_file_missing"` (error, every night until it is fixed): an active pharmacy's file is not on disk, so it could not be backed up. Restore it from a backup. See Backups.
- "backup skipped: the tenant is refused service" (error, every night until it is fixed): see Backups.
- "Monthly restore test failed" (error): see Backups.
- "Deployment key refresh failed" (warning): Oneon could not refresh a deployment's public keys. The refresh runs at startup and once a day. If it keeps failing for 7 days after the pharmacy rotates its key, the pharmacy can be stranded.

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
