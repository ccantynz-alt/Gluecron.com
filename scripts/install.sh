#!/usr/bin/env bash
# =============================================================================
# Gluecron one-command install.
#
#   curl -sSL https://gluecron.com/install | bash
#
# What it does (every step is idempotent + verbose):
#   1. Verify git, curl, jq are on PATH
#   2. Resolve Gluecron host (default https://gluecron.com, env override)
#   3. Locate Claude Desktop config (macOS / Linux / WSL)
#   4. Sign in (env vars or interactive prompt) and capture session cookie
#   5. Mint a fresh PAT via POST /api/v2/auth/install-token
#   6. Merge a 'gluecron' MCP server entry into claude_desktop_config.json
#   7. If we're inside a GitHub-origin repo, offer to import it
#   8. Print a "you're done" success banner
#
# No third-party tools beyond plain curl, jq, git. Idempotent. Safe to re-run.
# =============================================================================

set -euo pipefail

# ── pretty printers (match scripts/bootstrap-hetzner.sh style) ───────────────
say()  { printf "\n\033[1;34m> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32mv\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail() { printf "  \033[31mx\033[0m %s\n" "$*"; exit 1; }

# ── 1. Prerequisites ────────────────────────────────────────────────────────
say "[1/7] Checking prerequisites"
MISSING=()
for tool in git curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    MISSING+=("$tool")
  fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  warn "Missing tools: ${MISSING[*]}"
  echo "  Install them and re-run, e.g.:"
  for tool in "${MISSING[@]}"; do
    case "$tool" in
      jq)   echo "    macOS: brew install jq    |  Debian/Ubuntu: sudo apt-get install -y jq" ;;
      git)  echo "    macOS: xcode-select --install  |  Debian/Ubuntu: sudo apt-get install -y git" ;;
      curl) echo "    macOS: (preinstalled)     |  Debian/Ubuntu: sudo apt-get install -y curl" ;;
    esac
  done
  fail "Please install the missing tools above and re-run."
fi
ok "git, curl, jq present"

# ── 2. Host ─────────────────────────────────────────────────────────────────
say "[2/7] Resolving Gluecron host"
HOST="${GLUECRON_HOST:-https://gluecron.com}"
HOST="${HOST%/}" # strip trailing slash
ok "Using host: $HOST"

# ── 3. Locate Claude Desktop config ────────────────────────────────────────
say "[3/7] Locating Claude Desktop config"
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
MAC_CONF="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
LINUX_CONF="$HOME/.config/Claude/claude_desktop_config.json"
CLAUDE_CONF=""

case "$UNAME_S" in
  Darwin*)
    CLAUDE_CONF="$MAC_CONF"
    ;;
  Linux*)
    # WSL detection
    if grep -qi microsoft /proc/version 2>/dev/null; then
      if [ -d "$HOME/.config/Claude" ]; then
        CLAUDE_CONF="$LINUX_CONF"
      else
        CLAUDE_CONF="$LINUX_CONF"
        warn "WSL detected but no existing Claude config — using $CLAUDE_CONF"
      fi
    else
      CLAUDE_CONF="$LINUX_CONF"
    fi
    ;;
  *)
    warn "Unknown platform '$UNAME_S' — defaulting to macOS path."
    CLAUDE_CONF="$MAC_CONF"
    ;;
esac

mkdir -p "$(dirname "$CLAUDE_CONF")"
if [ ! -f "$CLAUDE_CONF" ]; then
  echo '{}' > "$CLAUDE_CONF"
  ok "Created empty $CLAUDE_CONF"
else
  ok "Found existing $CLAUDE_CONF"
fi

# ── 4. Sign in ──────────────────────────────────────────────────────────────
say "[4/7] Signing in to $HOST"
USERNAME="${GLUECRON_USERNAME:-}"
PASSWORD="${GLUECRON_PASSWORD:-}"
if [ -z "$USERNAME" ]; then
  if [ ! -t 0 ]; then
    fail "GLUECRON_USERNAME is unset and stdin is not a TTY. Re-run as: GLUECRON_USERNAME=you GLUECRON_PASSWORD=*** curl -sSL $HOST/install | bash"
  fi
  printf "  Gluecron username: "
  read -r USERNAME
fi
if [ -z "$PASSWORD" ]; then
  if [ ! -t 0 ]; then
    fail "GLUECRON_PASSWORD is unset and stdin is not a TTY."
  fi
  printf "  Gluecron password: "
  stty -echo
  read -r PASSWORD
  stty echo
  printf "\n"
fi

COOKIE_JAR="$(mktemp -t gluecron-cookies.XXXXXX)"
trap 'rm -f "$COOKIE_JAR"' EXIT

LOGIN_BODY="username=$(printf %s "$USERNAME" | jq -sRr @uri)&password=$(printf %s "$PASSWORD" | jq -sRr @uri)"
LOGIN_STATUS=$(
  curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -c "$COOKIE_JAR" \
    --data "$LOGIN_BODY" \
    "$HOST/login" || echo 000
)
if ! grep -q "session" "$COOKIE_JAR" 2>/dev/null; then
  fail "Login failed (HTTP $LOGIN_STATUS). Check username/password."
fi
ok "Signed in as $USERNAME"

# ── 5. Mint PAT ─────────────────────────────────────────────────────────────
say "[5/7] Minting a fresh PAT"
SHORT_TS=$(date +%s | tail -c 7)
MINT_BODY=$(jq -nc --arg name "gluecron-install-$SHORT_TS" --arg scope "admin" \
  '{name: $name, scope: $scope}')
MINT_RESPONSE=$(
  curl -sS \
    -X POST \
    -H "Content-Type: application/json" \
    -b "$COOKIE_JAR" \
    --data "$MINT_BODY" \
    "$HOST/api/v2/auth/install-token"
)
PAT=$(printf %s "$MINT_RESPONSE" | jq -r '.token // empty')
if [ -z "$PAT" ]; then
  ERR=$(printf %s "$MINT_RESPONSE" | jq -r '.error // .hint // .')
  fail "PAT mint failed: $ERR"
fi
PAT_PREFIX=$(printf %s "$PAT" | cut -c1-12)
ok "Created PAT $PAT_PREFIX..."

# ── 6. Merge MCP server entry into Claude Desktop config ───────────────────
say "[6/7] Wiring Claude Desktop -> Gluecron MCP"
TMP_CONF="$(mktemp -t gluecron-conf.XXXXXX)"
jq --arg url "$HOST/mcp" --arg auth "Bearer $PAT" '
  . as $root
  | (.mcpServers // {}) as $servers
  | $root
  | .mcpServers = ($servers + {
      "gluecron": {
        "transport": "http",
        "url": $url,
        "headers": { "Authorization": $auth }
      }
    })
' "$CLAUDE_CONF" > "$TMP_CONF"
mv "$TMP_CONF" "$CLAUDE_CONF"
ok "Updated $CLAUDE_CONF"

# ── 7. Optional repo import ─────────────────────────────────────────────────
say "[7/7] Repo import (optional)"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  ORIGIN_URL=$(git config --get remote.origin.url || true)
  if [ -n "$ORIGIN_URL" ] && printf %s "$ORIGIN_URL" | grep -q "github.com"; then
    if [ -t 0 ]; then
      printf "  Import this repo (%s) to Gluecron? [y/N] " "$ORIGIN_URL"
      read -r ANSWER
    else
      ANSWER="${GLUECRON_IMPORT:-n}"
    fi
    case "$ANSWER" in
      y|Y|yes|YES)
        IMPORT_BODY="repo_url=$(printf %s "$ORIGIN_URL" | jq -sRr @uri)"
        IMPORT_STATUS=$(
          curl -sS -o /dev/null -w "%{http_code}" \
            -X POST \
            -H "Authorization: Bearer $PAT" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            --data "$IMPORT_BODY" \
            "$HOST/import/github/repo" || echo 000
        )
        case "$IMPORT_STATUS" in
          2*|3*) ok "Import dispatched (HTTP $IMPORT_STATUS)" ;;
          *)     warn "Import returned HTTP $IMPORT_STATUS — you can re-run from $HOST/import" ;;
        esac
        ;;
      *)
        ok "Skipped import"
        ;;
    esac
  else
    ok "No GitHub origin detected — skipping import"
  fi
else
  ok "Not inside a git repo — skipping import"
fi

# ── Done ────────────────────────────────────────────────────────────────────
printf "\n"
printf "\033[1;32m============================================================\033[0m\n"
printf "\033[1;32m  GLUECRON INSTALL COMPLETE\033[0m\n"
printf "\033[1;32m============================================================\033[0m\n"
printf "  Host:           %s\n" "$HOST"
printf "  PAT prefix:     %s...\n" "$PAT_PREFIX"
printf "  MCP config:     %s\n" "$CLAUDE_CONF"
printf "\n"
printf "  v Done. Restart Claude Desktop and try:\n"
printf "      \"Open a PR on this repo with a one-line README fix\"\n"
printf "\n"
