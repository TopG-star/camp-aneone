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

### Manual database backup
```bash
mkdir -p backups
docker run --rm \
  -v camp-aneone_db-data:/data:ro \
  -v $(pwd)/backups:/backup \
  alpine:3.20 cp /data/oneon.db /backup/manual_$(date +%Y%m%d).db
```

### Restore database from backup
```bash
docker compose down
docker run --rm \
  -v camp-aneone_db-data:/data \
  -v $(pwd)/backups:/backup \
  alpine:3.20 cp /backup/<backup_file>.db /data/oneon.db
docker compose up -d
```

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
