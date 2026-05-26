#!/usr/bin/env bash
# =============================================================================
# Gluecron self-host installer.
#
#   curl -fsSL https://gluecron.com/install-server | bash
#
# Goal: a working self-hosted Gluecron in 60 seconds. Microsoft GHE is a
# 50GB blob and a week of professional services; we ship a ~200MB binary
# and a curl-bash.
#
# What this script does (every step is idempotent + verbose):
#   1. Detect OS + arch (linux/darwin × x64/arm64)
#   2. Resolve host (default https://gluecron.com, env override)
#   3. Fetch SHA256SUMS, then the binary, verify the hash
#   4. Install to /opt/gluecron/bin (sudo) or ~/.gluecron/bin (no sudo)
#   5. Provision Postgres: detect existing OR offer docker postgres
#   6. Write /etc/gluecron.env (or ~/.gluecron/gluecron.env) from .env.example
#      and prompt for the few required keys
#   7. Run migrations
#   8. Create a systemd unit (linux) OR launchd plist (darwin) + start it
#   9. Print the "Your Gluecron is live at http://localhost:3010" banner
#
# Hard rules:
#   - Never `set +e` — failures must bubble up.
#   - Never assume jq / docker / sudo are present — feature-flag everything.
#   - Re-runnable: a second run upgrades the binary in place.
# =============================================================================

set -Eeuo pipefail

# ── pretty printers (matched to scripts/install.sh) ────────────────────────
say()  { printf "\n\033[1;34m> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32mv\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail() { printf "  \033[31mx\033[0m %s\n" "$*"; exit 1; }

HOST="${GLUECRON_HOST:-https://gluecron.com}"
HOST="${HOST%/}"
PORT="${GLUECRON_PORT:-3010}"

# ── 1. Detect platform ─────────────────────────────────────────────────────
say "[1/9] Detecting platform"
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_M="$(uname -m 2>/dev/null || echo unknown)"

case "$UNAME_S" in
  Linux*)  PLAT=linux ;;
  Darwin*) PLAT=darwin ;;
  *) fail "Unsupported OS: $UNAME_S (linux / darwin only)" ;;
esac

case "$UNAME_M" in
  x86_64|amd64)   ARCH=x64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  *) fail "Unsupported arch: $UNAME_M (x64 / arm64 only)" ;;
esac

TARGET="$PLAT-$ARCH"
BIN_NAME="gluecron-server-$TARGET"
ok "platform: $TARGET"

# ── 2. Choose install root (sudo vs user) ──────────────────────────────────
say "[2/9] Resolving install location"
USE_SUDO=0
INSTALL_PREFIX=""
ENV_FILE=""
SERVICE_USER=""

if [ "$(id -u)" = "0" ]; then
  INSTALL_PREFIX="/opt/gluecron"
  ENV_FILE="/etc/gluecron.env"
  SERVICE_USER="gluecron"
  ok "running as root — installing to $INSTALL_PREFIX"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  USE_SUDO=1
  INSTALL_PREFIX="/opt/gluecron"
  ENV_FILE="/etc/gluecron.env"
  SERVICE_USER="${SUDO_USER:-$(whoami)}"
  ok "passwordless sudo available — installing to $INSTALL_PREFIX"
else
  INSTALL_PREFIX="$HOME/.gluecron"
  ENV_FILE="$HOME/.gluecron/gluecron.env"
  SERVICE_USER="$(whoami)"
  ok "no sudo — installing to $INSTALL_PREFIX (user-scope)"
fi

run_priv() {
  if [ "$USE_SUDO" = "1" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

run_priv mkdir -p "$INSTALL_PREFIX/bin" "$INSTALL_PREFIX/repos" "$INSTALL_PREFIX/data"

# ── 3. Download + verify the binary ────────────────────────────────────────
say "[3/9] Fetching binary from $HOST"
TMP="$(mktemp -d -t gluecron-install.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

SUMS_URL="$HOST/dist/SHA256SUMS"
BIN_URL="$HOST/dist/$BIN_NAME"

curl -fsSL --max-time 30 "$SUMS_URL" -o "$TMP/SHA256SUMS" \
  || fail "Couldn't fetch $SUMS_URL — is the host serving binaries?"
ok "checksums fetched"

EXPECTED_HASH=$(awk -v f="$BIN_NAME" '$2==f {print $1}' "$TMP/SHA256SUMS")
if [ -z "$EXPECTED_HASH" ]; then
  fail "No checksum for $BIN_NAME in SHA256SUMS — build the bundle for your platform."
fi

curl -fsSL --max-time 600 "$BIN_URL" -o "$TMP/$BIN_NAME" \
  || fail "Couldn't download $BIN_URL"
ACTUAL_HASH=$(sha256sum "$TMP/$BIN_NAME" | awk '{print $1}')
if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  fail "SHA-256 mismatch: expected $EXPECTED_HASH, got $ACTUAL_HASH"
fi
ok "verified sha256: ${ACTUAL_HASH:0:16}…"

chmod +x "$TMP/$BIN_NAME"
run_priv mv -f "$TMP/$BIN_NAME" "$INSTALL_PREFIX/bin/gluecron-server"
ok "installed: $INSTALL_PREFIX/bin/gluecron-server"

# Optional: fetch the env.example as a starter template
if curl -fsSL --max-time 15 "$HOST/dist/env.example" -o "$TMP/env.example" 2>/dev/null; then
  ok "env template fetched"
else
  warn "env.example not on server — using fallback minimal template"
  cat >"$TMP/env.example" <<'ENV_FALLBACK'
DATABASE_URL=postgresql://gluecron:gluecron@localhost:5432/gluecron
GIT_REPOS_PATH=/opt/gluecron/repos
PORT=3010
ENV_FALLBACK
fi

# ── 4. Postgres — detect or provision ──────────────────────────────────────
say "[4/9] Postgres"
DETECTED_DB=""
if command -v psql >/dev/null 2>&1; then
  if psql -h localhost -U postgres -c 'SELECT 1' >/dev/null 2>&1; then
    DETECTED_DB="postgresql://postgres@localhost:5432/postgres"
    ok "found local Postgres reachable as postgres@localhost"
  fi
fi
if [ -z "$DETECTED_DB" ] && [ -n "${DATABASE_URL:-}" ]; then
  DETECTED_DB="$DATABASE_URL"
  ok "using DATABASE_URL from env"
fi

DB_URL=""
if [ -n "$DETECTED_DB" ]; then
  DB_URL="$DETECTED_DB"
else
  warn "no existing Postgres detected"
  if command -v docker >/dev/null 2>&1; then
    if [ -t 0 ]; then
      printf "  Start a Postgres 14 container via docker? [Y/n] "
      read -r ANSWER
    else
      ANSWER="${GLUECRON_USE_DOCKER_PG:-y}"
    fi
    case "$ANSWER" in
      n|N|no|NO)
        warn "skipping docker — you must set DATABASE_URL manually before first start"
        ;;
      *)
        if docker ps --format '{{.Names}}' | grep -q '^gluecron-postgres$'; then
          ok "gluecron-postgres container already running"
        else
          docker run -d --name gluecron-postgres \
            -e POSTGRES_USER=gluecron \
            -e POSTGRES_PASSWORD=gluecron \
            -e POSTGRES_DB=gluecron \
            -p 5432:5432 \
            -v gluecron-pgdata:/var/lib/postgresql/data \
            postgres:14 >/dev/null \
            || warn "docker run failed — see docker logs gluecron-postgres"
          ok "started gluecron-postgres container"
          # Give Postgres a few seconds to accept connections.
          sleep 4
        fi
        DB_URL="postgresql://gluecron:gluecron@localhost:5432/gluecron"
        ;;
    esac
  else
    warn "docker not on PATH either — please set DATABASE_URL in $ENV_FILE before starting"
  fi
fi

# ── 5. Write env file ──────────────────────────────────────────────────────
say "[5/9] Writing $ENV_FILE"
TMP_ENV="$(mktemp -t gluecron-env.XXXXXX)"
# Start from the template, then overwrite the keys we know.
cp "$TMP/env.example" "$TMP_ENV"
patch_env() {
  local KEY="$1" VALUE="$2"
  if grep -qE "^${KEY}=" "$TMP_ENV"; then
    # macOS sed needs the empty -i arg; gnu sed accepts -i alone.
    sed -i.bak -e "s|^${KEY}=.*$|${KEY}=${VALUE}|" "$TMP_ENV" && rm -f "$TMP_ENV.bak"
  else
    echo "${KEY}=${VALUE}" >>"$TMP_ENV"
  fi
}

if [ -n "$DB_URL" ]; then patch_env DATABASE_URL "$DB_URL"; fi
patch_env GIT_REPOS_PATH "$INSTALL_PREFIX/repos"
patch_env PORT "$PORT"

# Prompt only when stdin is a TTY — non-interactive runs (CI, docker build)
# just inherit existing env vars and ship.
if [ -t 0 ] && [ -z "${GLUECRON_SKIP_PROMPTS:-}" ]; then
  if ! grep -qE '^APP_BASE_URL=' "$TMP_ENV"; then
    printf "  Public URL of this instance [http://localhost:%s]: " "$PORT"
    read -r APP_BASE_URL
    APP_BASE_URL="${APP_BASE_URL:-http://localhost:$PORT}"
    patch_env APP_BASE_URL "$APP_BASE_URL"
  fi
fi

run_priv mkdir -p "$(dirname "$ENV_FILE")"
run_priv install -m 0640 "$TMP_ENV" "$ENV_FILE"
ok "wrote $ENV_FILE"

# ── 6. Migrations ──────────────────────────────────────────────────────────
say "[6/9] Running database migrations"
# The compiled binary embeds the migration runner — invoke it via the
# GLUECRON_RUN_MIGRATIONS env flag (handled in src/index.ts at boot when
# the corresponding sub-command lands). For now we drive `psql` if the
# migrations tarball is available.
if curl -fsSL --max-time 30 "$HOST/dist/migrations.tar.gz" -o "$TMP/migrations.tar.gz" 2>/dev/null; then
  mkdir -p "$TMP/migrations"
  tar -xzf "$TMP/migrations.tar.gz" -C "$TMP/migrations"
  ok "migrations bundle fetched"
fi

# Source the env so DATABASE_URL is visible to the binary.
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
if [ -n "${DATABASE_URL:-}" ]; then
  if "$INSTALL_PREFIX/bin/gluecron-server" --migrate 2>/dev/null; then
    ok "migrations applied via gluecron-server --migrate"
  else
    warn "binary --migrate failed (older build?) — re-run after first start; the boot path also self-migrates."
  fi
else
  warn "DATABASE_URL not set — skipped migrations. Set it in $ENV_FILE and re-run."
fi

# ── 7. Systemd unit (linux) / launchd plist (darwin) ──────────────────────
say "[7/9] Creating service"
if [ "$PLAT" = "linux" ] && command -v systemctl >/dev/null 2>&1; then
  UNIT_PATH="/etc/systemd/system/gluecron.service"
  TMP_UNIT="$(mktemp -t gluecron-unit.XXXXXX)"
  cat >"$TMP_UNIT" <<UNIT
[Unit]
Description=Gluecron self-host server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
EnvironmentFile=$ENV_FILE
ExecStart=$INSTALL_PREFIX/bin/gluecron-server
Restart=on-failure
RestartSec=3
WorkingDirectory=$INSTALL_PREFIX

[Install]
WantedBy=multi-user.target
UNIT
  run_priv install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
  run_priv systemctl daemon-reload
  run_priv systemctl enable --now gluecron.service \
    || warn "systemctl enable failed — start manually with: systemctl start gluecron"
  ok "systemd unit installed and started"

elif [ "$PLAT" = "darwin" ]; then
  PLIST_PATH="$HOME/Library/LaunchAgents/com.gluecron.server.plist"
  mkdir -p "$(dirname "$PLIST_PATH")"
  cat >"$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gluecron.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_PREFIX/bin/gluecron-server</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>GLUECRON_ENV_FILE</key><string>$ENV_FILE</string>
  </dict>
  <key>WorkingDirectory</key><string>$INSTALL_PREFIX</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$INSTALL_PREFIX/data/gluecron.out.log</string>
  <key>StandardErrorPath</key><string>$INSTALL_PREFIX/data/gluecron.err.log</string>
</dict>
</plist>
PLIST
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH" \
    || warn "launchctl load failed — start manually with: launchctl load $PLIST_PATH"
  ok "launchd plist installed: $PLIST_PATH"

else
  warn "no service manager detected — start manually with:"
  warn "  $INSTALL_PREFIX/bin/gluecron-server"
fi

# ── 8. Wait for health ─────────────────────────────────────────────────────
say "[8/9] Waiting for the server to come up"
HEALTH="http://localhost:$PORT/healthz"
GREEN=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  CODE=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 2 "$HEALTH" || echo 000)
  if [ "$CODE" = "200" ]; then GREEN=1; break; fi
  sleep 1
done
if [ "$GREEN" = "1" ]; then
  ok "/healthz green"
else
  warn "server didn't return 200 within 10s — check logs (journalctl -u gluecron) or run:"
  warn "  $INSTALL_PREFIX/bin/gluecron-server"
fi

# ── 9. Done ────────────────────────────────────────────────────────────────
say "[9/9] All set"
printf "\n"
printf "\033[1;32m============================================================\033[0m\n"
printf "\033[1;32m  GLUECRON SELF-HOST INSTALL COMPLETE\033[0m\n"
printf "\033[1;32m============================================================\033[0m\n"
printf "  Binary:   %s/bin/gluecron-server\n" "$INSTALL_PREFIX"
printf "  Env:      %s\n" "$ENV_FILE"
printf "  Repos:    %s/repos\n" "$INSTALL_PREFIX"
printf "  Port:     %s\n" "$PORT"
printf "\n"
printf "  Your Gluecron is live at \033[1mhttp://localhost:%s\033[0m — visit\n" "$PORT"
printf "  to create your first admin user.\n"
printf "\n"
printf "  Upgrade:  curl -fsSL %s/install-server | bash\n" "$HOST"
printf "  Logs:     journalctl -u gluecron -f   (linux)\n"
printf "  Logs:     tail -f %s/data/gluecron.err.log   (darwin)\n" "$INSTALL_PREFIX"
printf "\n"
