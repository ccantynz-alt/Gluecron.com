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
#   8. Drop the Claude Code skill bundle into ~/.claude/skills/
#   9. Print a "you're done" success banner
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
say "[1/8] Checking prerequisites"
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
say "[2/8] Resolving Gluecron host"
HOST="${GLUECRON_HOST:-https://gluecron.com}"
HOST="${HOST%/}" # strip trailing slash
ok "Using host: $HOST"

# ── 3. Locate Claude Desktop config ────────────────────────────────────────
say "[3/8] Locating Claude Desktop config"
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
say "[4/8] Signing in to $HOST"
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
say "[5/8] Minting a fresh PAT"
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
say "[6/8] Wiring Claude Desktop -> Gluecron MCP"
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
say "[7/8] Repo import (optional)"
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

# ── 8. Claude Code skill bundle ─────────────────────────────────────────────
# Drop the gluecron-pr / gluecron-issue / gluecron-review skills into
# ~/.claude/skills/ so they appear as slash commands inside Claude Code.
# Idempotent: each write overwrites the existing file.
say "[8/8] Installing Claude Code skill bundle (~/.claude/skills/)"
SKILLS_ROOT="$HOME/.claude/skills"
mkdir -p "$SKILLS_ROOT/gluecron-pr" "$SKILLS_ROOT/gluecron-issue" "$SKILLS_ROOT/gluecron-review"

cat > "$SKILLS_ROOT/gluecron-pr/SKILL.md" <<'GLUECRON_SKILL_PR_EOF'
---
name: gluecron-pr
description: Open, list, fetch, comment on, merge, or close pull requests on a Gluecron-hosted repository. Use this skill whenever the user references a Gluecron repo (origin URL contains "gluecron.com" or matches the GLUECRON_HOST env var) and asks to "open a PR", "merge", "review", "comment on PR #N", "list open PRs", or "close PR #N" on a repo that is NOT hosted on GitHub.
tools:
  - gluecron_create_pr
  - gluecron_get_pr
  - gluecron_list_prs
  - gluecron_comment_pr
  - gluecron_merge_pr
  - gluecron_close_pr
  - Bash
---

When invoked, drive the Gluecron MCP write surface to manage pull
requests on the active Gluecron-hosted repo. Detect owner/repo from
`git config --get remote.origin.url` (shapes:
`https://<HOST>/<owner>/<repo>.git`, `git@<HOST>:<owner>/<repo>.git` —
strip the `.git`). Default base branch:
`git symbolic-ref refs/remotes/origin/HEAD` (fall back to `main`).
Always read `git diff origin/<base>...HEAD` before opening a PR so the
title and body match the diff. See the bundled SKILL.md in this repo's
`.claude/skills/gluecron-pr/` for the full recipe and example prompts.
GLUECRON_SKILL_PR_EOF

cat > "$SKILLS_ROOT/gluecron-issue/SKILL.md" <<'GLUECRON_SKILL_ISSUE_EOF'
---
name: gluecron-issue
description: Create, list, comment on, close, or reopen issues on a Gluecron-hosted repository. Use this skill whenever the user is on a Gluecron repo (origin URL contains "gluecron.com" or matches the GLUECRON_HOST env var) and asks to "open an issue", "file a bug", "comment on #N", "close #N", or "reopen #N" on a repo that is NOT hosted on GitHub.
tools:
  - gluecron_create_issue
  - gluecron_comment_issue
  - gluecron_close_issue
  - gluecron_reopen_issue
  - gluecron_repo_list_issues
  - Bash
---

When invoked, drive the Gluecron MCP write surface to manage issues on
the active Gluecron-hosted repo. Detect owner/repo from
`git config --get remote.origin.url`. Common ops: file an issue with a
Markdown body (What happened / Expected / Repro), comment on an existing
issue, close, reopen, list open issues. Never bulk-close more than 5
issues in one tool sequence without re-confirming with the user.
GLUECRON_SKILL_ISSUE_EOF

cat > "$SKILLS_ROOT/gluecron-review/SKILL.md" <<'GLUECRON_SKILL_REVIEW_EOF'
---
name: gluecron-review
description: Act as a secondary AI code reviewer on a Gluecron-hosted pull request. Use this skill when the user asks Claude to "review PR #N", "give a second-opinion review", or "leave inline comments" on a Gluecron pull request. Complements Gluecron's built-in AI review.
tools:
  - gluecron_get_pr
  - gluecron_list_prs
  - gluecron_comment_pr
  - Bash
---

When invoked, act as a secondary reviewer on top of Gluecron's built-in
AI review pass (`src/lib/ai-review.ts`, marker
`<!-- gluecron-ai-review:summary -->`). Flow: fetch the PR via
`gluecron_get_pr`, fetch the diff locally via `git diff
origin/<base>...origin/<head>`, post one `gluecron_comment_pr` per
finding (file + line + suggestion), then a summary comment prefixed
with `<!-- claude-secondary-review:summary -->` and a verdict line
("**Verdict:** approved" or "**Verdict:** changes requested"). Do not
call `gluecron_merge_pr` from this skill.
GLUECRON_SKILL_REVIEW_EOF

ok "Wrote $SKILLS_ROOT/gluecron-pr/SKILL.md"
ok "Wrote $SKILLS_ROOT/gluecron-issue/SKILL.md"
ok "Wrote $SKILLS_ROOT/gluecron-review/SKILL.md"

# ── Done ────────────────────────────────────────────────────────────────────
printf "\n"
printf "\033[1;32m============================================================\033[0m\n"
printf "\033[1;32m  GLUECRON INSTALL COMPLETE\033[0m\n"
printf "\033[1;32m============================================================\033[0m\n"
printf "  Host:           %s\n" "$HOST"
printf "  PAT prefix:     %s...\n" "$PAT_PREFIX"
printf "  MCP config:     %s\n" "$CLAUDE_CONF"
printf "  Skills:         %s/{gluecron-pr,gluecron-issue,gluecron-review}\n" "$SKILLS_ROOT"
printf "\n"
printf "  v Done. Restart Claude Desktop and try:\n"
printf "      \"Open a PR on this repo with a one-line README fix\"\n"
printf "\n"
printf "  Tip: if you also use Claude Code in this repo, the\n"
printf "  .claude/settings.json at the repo root auto-configures\n"
printf "  the Gluecron MCP server. Set GLUECRON_PAT in your shell\n"
printf "  and future Code sessions wire up with no further config.\n"
printf "\n"
