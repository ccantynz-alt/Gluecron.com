#!/usr/bin/env bash
#
# Standalone single-box deploy for Gluecron on a DEDICATED VPS.
# Brings up Gluecron + Postgres(pgvector) + Caddy(auto-HTTPS) with one command.
#
# Usage (as root on a fresh Ubuntu box):
#   curl -fsSL https://raw.githubusercontent.com/ccantynz-alt/Gluecron.com/main/scripts/standalone-deploy.sh | bash
# or, after cloning:
#   bash scripts/standalone-deploy.sh
#
# To migrate existing data: copy a dump to /root/gluecron.sql.gz BEFORE running
# (e.g. `scp` it from the old box). The script restores it automatically.
set -euo pipefail

REPO_URL="https://github.com/ccantynz-alt/Gluecron.com.git"
REPO_BRANCH="main"
REPO_DIR="/opt/gluecron"
COMPOSE="docker compose -f docker-compose.standalone.yml"

echo "== Gluecron standalone deploy =="

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "-- installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# 2. Code (the standalone compose file lives on $REPO_BRANCH)
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "-- cloning $REPO_URL ($REPO_BRANCH)"
  git clone -b "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git fetch origin "$REPO_BRANCH" 2>/dev/null || true
git checkout "$REPO_BRANCH" 2>/dev/null || true
git pull --ff-only origin "$REPO_BRANCH" 2>/dev/null || true

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

# 9. Swap (protects a small box from OOM kills)
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  echo "-- creating 1G swap file"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 10. Unattended security updates
echo "-- enabling unattended-upgrades"
DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades >/dev/null 2>&1 || true
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

# 11. Self-managing systemd timers: fast auto-deploy (~60s) + daily backup
chmod +x scripts/auto-update.sh scripts/backup.sh

cat > /etc/systemd/system/gluecron-update.service <<EOF
[Unit]
Description=Gluecron auto-deploy (pull + rebuild on new commits)
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
EnvironmentFile=-$REPO_DIR/.env
ExecStart=$REPO_DIR/scripts/auto-update.sh
EOF

cat > /etc/systemd/system/gluecron-update.timer <<EOF
[Unit]
Description=Run Gluecron auto-deploy every minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/gluecron-backup.service <<EOF
[Unit]
Description=Gluecron daily Postgres backup
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
EnvironmentFile=-$REPO_DIR/.env
ExecStart=$REPO_DIR/scripts/backup.sh
EOF

cat > /etc/systemd/system/gluecron-backup.timer <<EOF
[Unit]
Description=Run Gluecron backup daily
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now gluecron-update.timer gluecron-backup.timer >/dev/null 2>&1 || true

echo
echo "== status =="
$COMPOSE ps
echo "-- timers --"
systemctl list-timers 'gluecron-*' --no-pager 2>/dev/null || true
echo
echo "Self-healing active: container auto-restart, autoheal, log rotation,"
echo "1G swap, unattended security updates, daily DB backups (backups/), and"
echo "auto-deploy (~60s) from the deploy branch."
echo
echo "Done. Now point gluecron.com + www.gluecron.com DNS at THIS box's IP"
echo "(Cloudflare, DNS-only / grey cloud). Caddy issues the cert automatically"
echo "within ~1 minute of DNS resolving here. Verify with:"
echo "    curl -sI https://gluecron.com/healthz"
