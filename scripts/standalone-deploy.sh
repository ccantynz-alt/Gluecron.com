#!/usr/bin/env bash
#
# Standalone single-box deploy for Gluecron on a DEDICATED VPS.
# Brings up Gluecron + Postgres(pgvector) + Caddy(auto-HTTPS) with one command.
#
# Usage (as root on a fresh Ubuntu box):
#   curl -fsSL https://raw.githubusercontent.com/ccantynz-alt/Gluecron.com/claude/site-migration-vercel-XstpK/scripts/standalone-deploy.sh | bash
# or, after cloning:
#   bash scripts/standalone-deploy.sh
#
# To migrate existing data: copy a dump to /root/gluecron.sql.gz BEFORE running
# (e.g. `scp` it from the old box). The script restores it automatically.
set -euo pipefail

REPO_URL="https://github.com/ccantynz-alt/Gluecron.com.git"
REPO_DIR="/opt/gluecron"
COMPOSE="docker compose -f docker-compose.standalone.yml"

echo "== Gluecron standalone deploy =="

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "-- installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# 2. Code
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "-- cloning $REPO_URL"
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git pull --ff-only 2>/dev/null || true

# 3. Env (random Postgres password on first run)
if [ ! -f .env ]; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env
  echo "ANTHROPIC_API_KEY=" >> .env
  echo "-- generated .env (random Postgres password; add ANTHROPIC_API_KEY later if you want AI features)"
fi

# 4. Firewall (best-effort; only ports we need)
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi

# 5. Database first
echo "-- starting Postgres"
$COMPOSE up -d postgres
echo "-- waiting for Postgres to accept connections"
until $COMPOSE exec -T postgres pg_isready -U gluecron -d gluecron >/dev/null 2>&1; do sleep 2; done

# 6. Restore prior data if a dump is present
if [ -f /root/gluecron.sql.gz ]; then
  echo "-- restoring data from /root/gluecron.sql.gz"
  gunzip -c /root/gluecron.sql.gz | $COMPOSE exec -T postgres psql -U gluecron -d gluecron >/dev/null
elif [ -f /root/gluecron.sql ]; then
  echo "-- restoring data from /root/gluecron.sql"
  $COMPOSE exec -T postgres psql -U gluecron -d gluecron < /root/gluecron.sql >/dev/null
else
  echo "-- no dump found at /root/gluecron.sql(.gz); starting with a fresh database"
fi

# 7. App + Caddy
echo "-- building and starting Gluecron + Caddy"
$COMPOSE up -d --build

# 8. Migrations (idempotent — safe whether restored or fresh)
echo "-- applying migrations"
sleep 5
$COMPOSE exec -T gluecron bun run db:migrate || true

echo
echo "== status =="
$COMPOSE ps
echo
echo "Done. Now point gluecron.com + www.gluecron.com DNS at THIS box's IP"
echo "(Cloudflare, DNS-only / grey cloud). Caddy issues the cert automatically"
echo "within ~1 minute of DNS resolving here. Verify with:"
echo "    curl -sI https://gluecron.com/healthz"
