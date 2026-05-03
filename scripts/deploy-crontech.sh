#!/usr/bin/env bash
# ============================================================================
# Gluecron deploy to Crontech bare-metal
# ============================================================================
# Idempotent. Run as root on the Crontech box (45.76.171.37). Re-runnable.
#
# Usage:
#   bash scripts/deploy-crontech.sh
#
# Environment (prompted if not set):
#   DATABASE_URL          Neon Postgres pooled connection string
#   SITE_ADMIN_USERNAME   GitHub-style username for the bootstrap admin
#                         (default: ccantynz-alt)
#   SITE_DOMAIN           Public domain for HTTPS (default: gluecron.com)
#
# What it does:
#   1. Installs Bun if missing
#   2. bun install (frozen lockfile)
#   3. Ensures /data/repos exists for bare git repos
#   4. Writes /etc/gluecron.env (chmod 600)
#   5. Runs DB migrations
#   6. Writes /etc/systemd/system/gluecron.service + enables it
#   7. Adds <domain> { reverse_proxy localhost:3000 } to Caddyfile + reloads
#   8. Smoke-tests localhost:3000/healthz
# ============================================================================

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/gluecron}
BARE_REPOS=${BARE_REPOS:-/data/repos}
PORT=${PORT:-3001}
SITE_DOMAIN=${SITE_DOMAIN:-gluecron.com}
SITE_ADMIN_USERNAME=${SITE_ADMIN_USERNAME:-ccantynz-alt}

cd "$REPO_DIR" || {
  echo "ERROR: $REPO_DIR doesn't exist. Clone the repo first:"
  echo "  git clone https://github.com/ccantynz-alt/Gluecron.com.git $REPO_DIR"
  exit 1
}

echo "==> Pulling latest source"
git pull --ff-only origin main

# ---- DATABASE_URL prompt -------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f /etc/gluecron.env ] && grep -q '^DATABASE_URL=' /etc/gluecron.env; then
    DATABASE_URL=$(grep '^DATABASE_URL=' /etc/gluecron.env | cut -d= -f2-)
    echo "==> Reusing existing DATABASE_URL from /etc/gluecron.env"
  else
    echo
    echo "Paste the Neon DATABASE_URL (postgresql://... ?sslmode=require ...):"
    read -r DATABASE_URL
  fi
fi

APP_BASE_URL=${APP_BASE_URL:-https://${SITE_DOMAIN}}

# ---- Bun install ---------------------------------------------------------
if ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "==> Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
echo "==> bun: $(bun --version)"

# ---- Dependencies --------------------------------------------------------
echo "==> Installing project dependencies"
bun install --frozen-lockfile

# ---- Bare-repo dir -------------------------------------------------------
mkdir -p "$BARE_REPOS"
chmod 755 "$BARE_REPOS"

# ---- Env file ------------------------------------------------------------
echo "==> Writing /etc/gluecron.env"
umask 077
cat > /etc/gluecron.env <<EOF
DATABASE_URL=${DATABASE_URL}
APP_BASE_URL=${APP_BASE_URL}
SITE_ADMIN_USERNAME=${SITE_ADMIN_USERNAME}
GIT_REPOS_PATH=${BARE_REPOS}
PORT=${PORT}
DEMO_SEED_ON_BOOT=1
EMAIL_PROVIDER=log
EMAIL_FROM="gluecron <no-reply@${SITE_DOMAIN}>"
NODE_ENV=production
EOF
chmod 600 /etc/gluecron.env
umask 022

# ---- Migrations ----------------------------------------------------------
echo "==> Running database migrations"
set -a; source /etc/gluecron.env; set +a
bun run src/db/migrate.ts || {
  echo "WARNING: migration command failed — continuing (it may be idempotent already-applied)"
}

# ---- systemd unit --------------------------------------------------------
BUN_BIN="$(command -v bun)"
echo "==> Writing /etc/systemd/system/gluecron.service"
cat > /etc/systemd/system/gluecron.service <<EOF
[Unit]
Description=Gluecron — AI-native code intelligence platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${REPO_DIR}
EnvironmentFile=/etc/gluecron.env
ExecStart=${BUN_BIN} run src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gluecron
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

echo "==> Reloading systemd + (re)starting gluecron"
systemctl daemon-reload
systemctl enable gluecron >/dev/null 2>&1 || true
systemctl restart gluecron

# ---- Caddy ----------------------------------------------------------------
CADDYFILE="/etc/caddy/Caddyfile"
if [ -f "$CADDYFILE" ]; then
  if ! grep -q "^${SITE_DOMAIN} *{" "$CADDYFILE"; then
    echo "==> Adding ${SITE_DOMAIN} to Caddyfile"
    cat >> "$CADDYFILE" <<EOF

${SITE_DOMAIN} {
  reverse_proxy localhost:${PORT}
}
www.${SITE_DOMAIN} {
  redir https://${SITE_DOMAIN}{uri} permanent
}
EOF
    if command -v caddy >/dev/null; then
      caddy validate --config "$CADDYFILE" --adapter caddyfile && systemctl reload caddy
    else
      systemctl reload caddy || systemctl restart caddy || true
    fi
  else
    echo "==> ${SITE_DOMAIN} already in Caddyfile (skipping)"
  fi
else
  echo "WARNING: $CADDYFILE not found — skipping Caddy config"
  echo "         You'll need to add a reverse_proxy to localhost:${PORT} manually"
fi

# ---- Smoke test ----------------------------------------------------------
echo
echo "==> Waiting for /healthz to respond (up to 30s)"
for i in $(seq 1 10); do
  if curl -sf "http://localhost:${PORT}/healthz" >/dev/null; then
    echo "✓ gluecron is up at http://localhost:${PORT}"
    echo
    echo "============================================================"
    echo "DONE. Next steps:"
    echo "  1. DNS: ensure A record for ${SITE_DOMAIN} → this server's IP"
    echo "  2. Visit: https://${SITE_DOMAIN}"
    echo "  3. Register account '${SITE_ADMIN_USERNAME}' → instant site admin"
    echo
    echo "Useful commands:"
    echo "  systemctl status gluecron"
    echo "  journalctl -u gluecron -f"
    echo "  bash scripts/deploy-crontech.sh   # re-deploy after git pull"
    echo "============================================================"
    exit 0
  fi
  sleep 3
done

echo
echo "✗ gluecron did not respond on /healthz after 30s"
echo "Diagnose with:"
echo "  systemctl status gluecron"
echo "  journalctl -u gluecron -n 100 --no-pager"
exit 1
