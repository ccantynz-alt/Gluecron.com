#!/bin/bash
set -euo pipefail

# ============================================
# Gluecron Deploy Script
# One command to deploy to production.
# ============================================

APP_NAME="gluecron"
APP_DIR="/opt/gluecron"
REPO_URL="https://github.com/ccantynz-alt/Gluecron.com.git"
BRANCH="${BRANCH:-main}"

# NOTE: For the production Crontech bare-metal box (45.76.171.37 → gluecron.com),
# prefer scripts/deploy-crontech.sh — it knows about Caddy, /etc/gluecron.env, and
# the systemd unit. This deploy.sh is the generic single-server bootstrapper.

echo "=========================================="
echo "  Deploying $APP_NAME"
echo "=========================================="

# 1. Check prerequisites
command -v git >/dev/null 2>&1 || { echo "git required"; exit 1; }
command -v bun >/dev/null 2>&1 || {
  echo "Installing Bun..."
  curl -fsSL --output /tmp/bun-install.sh https://bun.sh/install
  bash /tmp/bun-install.sh
  rm -f /tmp/bun-install.sh
  export PATH="$HOME/.bun/bin:$PATH"
}

# 2. Check for DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f "$APP_DIR/.env" ]; then
    export $(grep -v '^#' "$APP_DIR/.env" | xargs)
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set."
  echo "Set it in $APP_DIR/.env or export it."
  echo ""
  echo "Get a free database at https://neon.tech"
  echo "Then: echo 'DATABASE_URL=postgresql://...' > $APP_DIR/.env"
  exit 1
fi

# 3. Clone or update repo
if [ -d "$APP_DIR" ]; then
  echo "Updating existing installation..."
  cd "$APP_DIR"
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "Fresh install..."
  sudo mkdir -p "$APP_DIR"
  sudo chown "$(whoami)" "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# 4. Install dependencies
echo "Installing dependencies..."
bun install --frozen-lockfile --production

# 5. Run database migration
echo "Running database migration..."
psql "$DATABASE_URL" -f drizzle/0000_init.sql 2>/dev/null || {
  echo "psql not found or migration failed — trying via bun..."
  bun run -e "
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    const fs = require('fs');
    const migration = fs.readFileSync('drizzle/0000_init.sql', 'utf-8');
    // Split by semicolons and execute each statement
    const statements = migration.split(';').filter(s => s.trim());
    (async () => {
      for (const stmt of statements) {
        try { await sql(stmt); } catch(e) { /* table may already exist */ }
      }
      console.log('Migration complete');
    })();
  "
}

# 6. Create repos directory
mkdir -p /data/repos 2>/dev/null || mkdir -p "$APP_DIR/repos"
export GIT_REPOS_PATH="${GIT_REPOS_PATH:-/data/repos}"

# 7. Set up systemd service
echo "Setting up systemd service..."
sudo tee /etc/systemd/system/gluecron.service > /dev/null << UNIT
[Unit]
Description=Gluecron - AI-native code intelligence
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(which bun) run src/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable gluecron
sudo systemctl restart gluecron

echo ""
echo "=========================================="
echo "  $APP_NAME is now running!"
echo "=========================================="
echo ""
echo "  URL: http://$(hostname -I | awk '{print $1}'):3000"
echo "  Logs: journalctl -u gluecron -f"
echo "  Status: systemctl status gluecron"
echo ""
echo "  Next steps:"
echo "  1. Set up reverse proxy (nginx/caddy) for HTTPS"
echo "  2. Point gluecron.com DNS to this server"
echo "  3. Register your admin account at /register"
echo ""
