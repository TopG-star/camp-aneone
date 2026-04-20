#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# deploy.sh — Build & deploy camp-aneone on the staging VPS
#
# Usage:  ./deploy.sh            (default: backup + build + restart)
#         ./deploy.sh --no-build (restart only, skip image rebuild)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

COMPOSE="docker compose"
BACKUP_DIR="./backups"
DB_VOLUME="camp-aneone_db-data"
HEALTH_URL="http://localhost:4000/health"
MAX_WAIT=30  # seconds to wait for health check

# ── Colours ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

# ── Pre-flight checks ────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  error "docker not found. Install Docker first."
  exit 1
fi

if [ ! -f .env ]; then
  error ".env file not found. Copy .env.production.template → .env and fill in values."
  exit 1
fi

# ── 1. Backup SQLite database ────────────────────────────────
info "Backing up SQLite database…"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/oneon_${TIMESTAMP}.db"

# Use docker cp from the volume mount if containers exist
if docker volume inspect "$DB_VOLUME" &>/dev/null; then
  docker run --rm \
    -v "${DB_VOLUME}:/data:ro" \
    -v "$(pwd)/${BACKUP_DIR}:/backup" \
    alpine:3.20 \
    cp /data/oneon.db "/backup/oneon_${TIMESTAMP}.db" 2>/dev/null && \
    info "Backup saved → ${BACKUP_FILE}" || \
    warn "No existing database to back up (first deploy?)."
else
  warn "No db-data volume found — skipping backup (first deploy)."
fi

# Prune backups older than 7 days
find "$BACKUP_DIR" -name "oneon_*.db" -mtime +7 -delete 2>/dev/null || true

# ── 2. Pull latest code ──────────────────────────────────────
info "Pulling latest code…"
git pull --ff-only

# ── 3. Build images ──────────────────────────────────────────
if [[ "${1:-}" != "--no-build" ]]; then
  info "Building Docker images…"
  $COMPOSE build --parallel
else
  warn "Skipping build (--no-build flag)."
fi

# ── 4. Restart services ──────────────────────────────────────
info "Restarting services…"
$COMPOSE down
$COMPOSE up -d

# ── 5. Health check ──────────────────────────────────────────
info "Waiting for agent-server health check…"
SECONDS_WAITED=0
until curl -sf "$HEALTH_URL" > /dev/null 2>&1; do
  if [ "$SECONDS_WAITED" -ge "$MAX_WAIT" ]; then
    error "Health check failed after ${MAX_WAIT}s!"
    error "Check logs:  docker compose logs --tail 50"
    exit 1
  fi
  sleep 2
  SECONDS_WAITED=$((SECONDS_WAITED + 2))
  printf "."
done
echo ""

HEALTH=$(curl -sf "$HEALTH_URL")
info "Health check passed ✓"
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"

# ── 6. Show running containers ────────────────────────────────
info "Running containers:"
$COMPOSE ps

info "Deploy complete ✓"
