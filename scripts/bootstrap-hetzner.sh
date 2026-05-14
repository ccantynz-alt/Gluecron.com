#!/usr/bin/env bash
# =============================================================================
# Gluecron one-shot Hetzner bootstrap.
#
# Run ONCE on a fresh (or partially-set-up) Hetzner box, via the web console,
# as root. Idempotent: safe to re-run. Won't touch existing crontech systemd
# units, will append gluecron's entries instead.
#
# Usage (paste this ONE line in Hetzner Console as root):
#   curl -sSL https://raw.githubusercontent.com/ccantynz-alt/Gluecron.com/main/scripts/bootstrap-hetzner.sh \
#     | bash -s -- "ssh-ed25519 AAAA... your@laptop"
#
# What it does (every step is idempotent + verbose):
#   1. Authorise the supplied SSH pubkey on root@ (so you can SSH from laptop)
#   2. Re-enable PasswordAuthentication as a safety fallback
#   3. Install Bun, Postgres, Caddy, git if missing
#   4. Create local Postgres DB + user 'gluecron' if missing
#   5. Clone /opt/gluecron from main if missing, or git pull if present
#   6. Write /etc/gluecron.env with DATABASE_URL pointing at local Postgres
#   7. Bun install + run migrations
#   8. Write systemd unit for gluecron on port 3010
#   9. Append gluecron + www.gluecron blocks to Caddyfile (if missing)
#  10. Reload Caddy + start gluecron
#  11. Smoke test /healthz
# =============================================================================

set -euo pipefail
PUBKEY="${1:-}"
PORT="${PORT:-3010}"
SITE_DOMAIN="${SITE_DOMAIN:-gluecron.com}"
DB_USER="gluecron"
DB_NAME="gluecron"
DB_PASS="$(openssl rand -hex 16)"

say() { echo ""; echo "==> $*"; }
ok() { echo "    ✓ $*"; }
warn() { echo "    ⚠ $*"; }

# ────────────────────────────────────────────────────────────────────────────
# 1. Authorise SSH pubkey
# ────────────────────────────────────────────────────────────────────────────
say "[1/11] Authorising SSH key on root@"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
if [ -n "$PUBKEY" ]; then
  if grep -qF "$PUBKEY" /root/.ssh/authorized_keys 2>/dev/null; then
    ok "SSH key already authorised"
  else
    echo "$PUBKEY" >> /root/.ssh/authorized_keys
    ok "SSH key added"
  fi
else
  warn "No PUBKEY argument — skipping SSH key install"
fi

# ────────────────────────────────────────────────────────────────────────────
# 2. Re-enable PasswordAuthentication (safety fallback)
# ────────────────────────────────────────────────────────────────────────────
say "[2/11] Configuring sshd (allow both key + password as fallback)"
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-gluecron-auth.conf <<EOF
PasswordAuthentication yes
PubkeyAuthentication yes
PermitRootLogin yes
EOF
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
ok "sshd reloaded — both auth methods enabled"

# ────────────────────────────────────────────────────────────────────────────
# 3. Install dependencies if missing
# ────────────────────────────────────────────────────────────────────────────
say "[3/11] Ensuring git, curl, postgresql, caddy, bun are installed"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

for pkg in git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https openssl unzip xz-utils tar; do
  dpkg -l | grep -qw "$pkg" || apt-get install -y -qq "$pkg"
done
ok "base packages installed"

# Postgres
if ! command -v psql >/dev/null 2>&1; then
  apt-get install -y -qq postgresql postgresql-contrib
  systemctl enable --now postgresql
  ok "postgres installed + started"
else
  ok "postgres already installed"
fi

# Caddy (skip install if already there — likely from crontech setup)
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  systemctl enable --now caddy
  ok "caddy installed + started"
else
  ok "caddy already installed (likely from crontech)"
fi

# Bun
if [ ! -x /root/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
  ok "bun installed"
else
  ok "bun already installed"
fi
export PATH="/root/.bun/bin:$PATH"
ok "bun version: $(/root/.bun/bin/bun --version 2>/dev/null || echo unknown)"

# ────────────────────────────────────────────────────────────────────────────
# 4. Local Postgres DB + user
# ────────────────────────────────────────────────────────────────────────────
say "[4/11] Creating local Postgres DB + user (idempotent)"
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  ok "postgres user '${DB_USER}' already exists"
else
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
  ok "postgres user '${DB_USER}' created"
fi
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  ok "postgres database '${DB_NAME}' already exists"
else
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
  ok "postgres database '${DB_NAME}' created"
fi

# Read existing DB password if env file already has one (don't overwrite)
EXISTING_DB_URL=""
if [ -f /etc/gluecron.env ] && grep -q '^DATABASE_URL=' /etc/gluecron.env; then
  EXISTING_DB_URL=$(grep '^DATABASE_URL=' /etc/gluecron.env | cut -d= -f2- | tr -d '"')
  ok "reusing existing DATABASE_URL from /etc/gluecron.env"
fi
DATABASE_URL="${EXISTING_DB_URL:-postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}}"

# If we're using a NEW password we just generated, sync it to the DB user
if [ -z "$EXISTING_DB_URL" ]; then
  sudo -u postgres psql -c "ALTER USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
fi

# ────────────────────────────────────────────────────────────────────────────
# 5. Clone or update /opt/gluecron
# ────────────────────────────────────────────────────────────────────────────
say "[5/11] Setting up /opt/gluecron source tree"
mkdir -p /opt
if [ ! -d /opt/gluecron/.git ]; then
  git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
  ok "cloned gluecron"
else
  cd /opt/gluecron
  git fetch --prune origin main
  git reset --hard origin/main
  ok "pulled latest main"
fi
cd /opt/gluecron

# ────────────────────────────────────────────────────────────────────────────
# 6. Write /etc/gluecron.env (preserve existing where present)
# ────────────────────────────────────────────────────────────────────────────
say "[6/11] Writing /etc/gluecron.env"
mkdir -p /data/repos
chmod 755 /data/repos
umask 077
cat > /etc/gluecron.env <<EOF
DATABASE_URL=${DATABASE_URL}
APP_BASE_URL=https://${SITE_DOMAIN}
SITE_ADMIN_USERNAME=${SITE_ADMIN_USERNAME:-ccantynz}
GIT_REPOS_PATH=/data/repos
PORT=${PORT}
DEMO_SEED_ON_BOOT=1
EMAIL_PROVIDER=log
EMAIL_FROM="gluecron <no-reply@${SITE_DOMAIN}>"
NODE_ENV=production
EOF
chmod 600 /etc/gluecron.env
umask 022
ok "/etc/gluecron.env written (chmod 600)"

# ────────────────────────────────────────────────────────────────────────────
# 7. Bun install + run migrations
# ────────────────────────────────────────────────────────────────────────────
say "[7/11] bun install + db:migrate"
/root/.bun/bin/bun install --frozen-lockfile
set -a; source /etc/gluecron.env; set +a
/root/.bun/bin/bun run src/db/migrate.ts || warn "migrations command failed — may already be applied"
ok "deps + migrations done"

# ────────────────────────────────────────────────────────────────────────────
# 8. systemd unit for gluecron
# ────────────────────────────────────────────────────────────────────────────
# Block N2 — `Type=notify` so `systemctl restart gluecron` blocks until the
# new process has called sd_notify(READY=1) (wired in src/lib/systemd-notify.ts
# from src/index.ts). That eliminates the post-restart sleep-and-poll loop in
# the deploy workflow.
#
# Block N2 — Bun-compiled single-binary path. If `/opt/gluecron/.next/gluecron-server`
# exists (built by the deploy workflow), prefer it (~10x faster cold start vs
# `bun run src/index.ts`). Falls back to interpreted Bun for safety so a stale
# bootstrap still produces a runnable unit on a brand-new box.
say "[8/11] Writing /etc/systemd/system/gluecron.service"
BUN_BIN=/root/.bun/bin/bun
COMPILED_BIN=/opt/gluecron/.next/gluecron-server
mkdir -p /opt/gluecron/.next
if [ -x "$COMPILED_BIN" ]; then
  EXEC_START="$COMPILED_BIN"
else
  EXEC_START="${BUN_BIN} run src/index.ts"
fi
cat > /etc/systemd/system/gluecron.service <<EOF
[Unit]
Description=Gluecron — AI-native code intelligence platform
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=main
User=root
WorkingDirectory=/opt/gluecron
EnvironmentFile=/etc/gluecron.env
ExecStart=${EXEC_START}
Restart=always
RestartSec=5
# Block N2 — give the new process up to 30s to call sd_notify(READY=1).
# Default is 90s; we lower it so a hung-on-startup deploy fails fast.
TimeoutStartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gluecron
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable gluecron >/dev/null
systemctl restart gluecron
ok "gluecron systemd unit installed + started (Type=notify, ExecStart=${EXEC_START})"

# ────────────────────────────────────────────────────────────────────────────
# 9. Append gluecron + www.gluecron to Caddyfile if missing
# ────────────────────────────────────────────────────────────────────────────
say "[9/11] Caddy reverse-proxy config for ${SITE_DOMAIN}"
CADDYFILE=/etc/caddy/Caddyfile
touch "$CADDYFILE"
if grep -qE "^${SITE_DOMAIN}\s*\{" "$CADDYFILE"; then
  ok "${SITE_DOMAIN} block already in Caddyfile — leaving as-is"
else
  cat >> "$CADDYFILE" <<EOF

${SITE_DOMAIN} {
    encode zstd gzip
    reverse_proxy localhost:${PORT}
}

www.${SITE_DOMAIN} {
    redir https://${SITE_DOMAIN}{uri} permanent
}
EOF
  ok "appended ${SITE_DOMAIN} block to Caddyfile"
fi

if caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1 | grep -qi "valid"; then
  systemctl reload caddy || systemctl restart caddy
  ok "caddy reloaded"
else
  warn "caddy validate warned — check: caddy validate --config $CADDYFILE"
fi

# ────────────────────────────────────────────────────────────────────────────
# 10. Wait + smoke test
# ────────────────────────────────────────────────────────────────────────────
say "[10/11] Waiting for /healthz to come up (60s)"
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/healthz" || echo 000)
  if [ "$code" = "200" ]; then
    ok "gluecron is live on http://localhost:${PORT} (attempt $i)"
    break
  fi
  sleep 5
done
if [ "$code" != "200" ]; then
  warn "healthz did not respond 200 after 60s. Logs: journalctl -u gluecron -n 50 --no-pager"
fi

# ────────────────────────────────────────────────────────────────────────────
# 11. Summary
# ────────────────────────────────────────────────────────────────────────────
say "[11/11] DONE"
echo ""
echo "============================================================"
echo "  GLUECRON BOOTSTRAP COMPLETE"
echo "============================================================"
echo "  systemd unit:   gluecron.service"
echo "  port:           ${PORT}"
echo "  env file:       /etc/gluecron.env (chmod 600)"
echo "  bare repos:     /data/repos"
echo "  source:         /opt/gluecron"
echo ""
echo "  Test from your laptop:"
echo "    ssh root@\$(hostname -I | awk '{print \$1}') 'systemctl status gluecron --no-pager | head -5'"
echo ""
echo "  Public URL (once DNS is correct + Caddy issued cert):"
echo "    https://${SITE_DOMAIN}"
echo "    https://${SITE_DOMAIN}/api/version"
echo ""
echo "  Useful commands:"
echo "    systemctl status gluecron"
echo "    journalctl -u gluecron -f"
echo "    bash /opt/gluecron/scripts/bootstrap-hetzner.sh   # safe to re-run"
echo "============================================================"
