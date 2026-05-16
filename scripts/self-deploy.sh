#!/usr/bin/env bash
# =============================================================================
# BLOCK W — Gluecron self-deploy.
#
# Fired by:
#   - src/hooks/post-receive.ts when SELF_HOST_REPO matches the pushed repo
#     AND the ref is refs/heads/main
#   - the bare repo's hooks/post-receive (for SSH receive-pack)
#   - the optional .gluecron/workflows/deploy.yml on the workflow runner
#
# Contract:
#   - Detaches into the background via systemd-run (or nohup fallback) so
#     the caller's git push returns in ~1 second
#   - Logs every step to /var/log/gluecron-self-deploy.log
#   - Notifies /api/events/deploy/{started,step,finished} so /admin/deploys
#     streams the live timeline (same wire as the GitHub Actions workflow)
#   - Rolls back via git reflog if the post-deploy smoke fails
#
# Operator invariants:
#   - /etc/gluecron.env is the source of env truth (DATABASE_URL,
#     DEPLOY_EVENT_TOKEN, APP_BASE_URL, ANTHROPIC_API_KEY, …)
#   - /opt/gluecron is the working tree on the box, with git remote `origin`
#     pointing at https://gluecron.com/<owner>/<repo>.git (NOT GitHub)
#   - /opt/gluecron/.next/gluecron-server is the compiled Bun binary
#   - systemd unit `gluecron` is Type=notify and ExecStart=$EXEC_START
#
# TODO(ops): configure /etc/logrotate.d/gluecron-self-deploy for the log.
# =============================================================================

# `set -E` so traps propagate into subshells; `-x` traces every command
# to stderr (captured into $LOG via the `>>"$LOG" 2>&1` redirects on the
# detached re-exec line). Reliability sweep 2026-05-16: when this script
# fails, the trace tells us EXACTLY which line broke instead of leaving
# us guessing as we did for 17 hours of failed Hetzner deploys.
set -Eeuxo pipefail

WORKING_DIR="${GLUECRON_WORKING_DIR:-/opt/gluecron}"
LOG="${GLUECRON_SELF_DEPLOY_LOG:-/var/log/gluecron-self-deploy.log}"
ENV_FILE="${GLUECRON_ENV_FILE:-/etc/gluecron.env}"
BUN="${GLUECRON_BUN:-/root/.bun/bin/bun}"
HEALTHZ_URL="${GLUECRON_HEALTHZ_URL:-http://localhost:3010/healthz}"
PORT="${GLUECRON_PORT:-3010}"
DETACHED_FLAG="${1:-}"

# ── helpers ────────────────────────────────────────────────────────────────
ts() { date +'%Y-%m-%dT%H:%M:%S%z'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG" >&2; }

notify_step() {
  local NAME="$1" STATUS="$2" DUR="${3:-}"
  if [ -z "${DEPLOY_EVENT_TOKEN:-}" ] || [ -z "${APP_BASE_URL:-}" ]; then
    return 0
  fi
  local DUR_FIELD=""
  if [ -n "$DUR" ]; then DUR_FIELD=",\"duration_ms\":$DUR"; fi
  curl --silent --show-error --max-time 5 \
    -X POST "$APP_BASE_URL/api/events/deploy/step" \
    -H "authorization: Bearer $DEPLOY_EVENT_TOKEN" \
    -H "content-type: application/json" \
    --data "{\"run_id\":\"$RUN_ID\",\"sha\":\"$NEW_SHA\",\"step_name\":\"$NAME\",\"status\":\"$STATUS\"$DUR_FIELD}" \
    >/dev/null 2>&1 || true
}

# ── re-exec into the background unless already detached ──────────────────
# When the post-receive hook calls this script, git push is blocked on the
# child's stdout/stderr. We re-exec ourselves through systemd-run so the
# original SSH/HTTP receive-pack process can return immediately.
if [ "$DETACHED_FLAG" != "--inline" ] && [ -z "${GLUECRON_SELF_DEPLOY_DETACHED:-}" ]; then
  export GLUECRON_SELF_DEPLOY_DETACHED=1
  if command -v systemd-run >/dev/null 2>&1; then
    systemd-run --quiet --unit="gluecron-self-deploy-$(date +%s)" \
      --collect --no-block \
      bash "$0" --inline "$@" || nohup bash "$0" --inline "$@" >>"$LOG" 2>&1 &
  else
    nohup bash "$0" --inline "$@" >>"$LOG" 2>&1 &
    disown || true
  fi
  exit 0
fi

# Everything below runs in the detached process.
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
touch "$LOG" 2>/dev/null || true

log "==> gluecron self-deploy starting (pid $$)"

# ── 1. Source env ──────────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  log "    v sourced $ENV_FILE"
else
  log "    ! $ENV_FILE not found — relying on inherited env"
fi

cd "$WORKING_DIR"

# ── 2. Capture pre-deploy SHA for rollback ────────────────────────────────
PREV_SHA="$(git rev-parse HEAD 2>/dev/null || echo '')"
log "    v previous SHA: $PREV_SHA"

# ── 3. Pull latest main ────────────────────────────────────────────────────
GP_START=$(date +%s)
notify_step "git-pull" "in_progress"
git fetch --prune origin main 2>&1 | tee -a "$LOG"
git reset --hard origin/main 2>&1 | tee -a "$LOG"
NEW_SHA="$(git rev-parse HEAD)"
RUN_ID="self-${NEW_SHA:0:12}-$(date +%s)"
log "    v pulled to $NEW_SHA (run_id=$RUN_ID)"
notify_step "git-pull" "succeeded" "$(( ( $(date +%s) - GP_START ) * 1000 ))"

# ── 3.5 Notify deploy started (now that we have NEW_SHA + RUN_ID) ─────────
if [ -n "${DEPLOY_EVENT_TOKEN:-}" ] && [ -n "${APP_BASE_URL:-}" ]; then
  curl --silent --show-error --max-time 10 \
    -X POST "$APP_BASE_URL/api/events/deploy/started" \
    -H "authorization: Bearer $DEPLOY_EVENT_TOKEN" \
    -H "content-type: application/json" \
    --data "{\"sha\":\"$NEW_SHA\",\"run_id\":\"$RUN_ID\",\"source\":\"self-deploy\"}" \
    >>"$LOG" 2>&1 || log "    ! deploy/started notify failed (non-fatal)"
fi

START_EPOCH=$(date +%s)
DEPLOY_FAILED=0
FAIL_REASON=""

# ── 4. bun install --frozen-lockfile ───────────────────────────────────────
BI_START=$(date +%s)
notify_step "bun-install" "in_progress"
if "$BUN" install --frozen-lockfile >>"$LOG" 2>&1; then
  log "    v bun install ok"
  notify_step "bun-install" "succeeded" "$(( ( $(date +%s) - BI_START ) * 1000 ))"
else
  log "    x bun install FAILED"
  DEPLOY_FAILED=1
  FAIL_REASON="bun install failed"
  notify_step "bun-install" "failed" "$(( ( $(date +%s) - BI_START ) * 1000 ))"
fi

# ── 5. DB migrations (fail loud) ───────────────────────────────────────────
if [ "$DEPLOY_FAILED" = "0" ]; then
  DM_START=$(date +%s)
  notify_step "db-migrate" "in_progress"
  if "$BUN" run src/db/migrate.ts >>"$LOG" 2>&1; then
    log "    v db migrate ok"
    notify_step "db-migrate" "succeeded" "$(( ( $(date +%s) - DM_START ) * 1000 ))"
  else
    log "    x db migrate FAILED"
    DEPLOY_FAILED=1
    FAIL_REASON="bun run db:migrate failed"
    notify_step "db-migrate" "failed" "$(( ( $(date +%s) - DM_START ) * 1000 ))"
  fi
fi

# ── 6. Build the static binary ─────────────────────────────────────────────
if [ "$DEPLOY_FAILED" = "0" ]; then
  BD_START=$(date +%s)
  notify_step "build" "in_progress"
  mkdir -p .next
  COMPILED=.next/gluecron-server
  COMPILED_TMP=.next/gluecron-server.new
  if "$BUN" build --compile --outfile "$COMPILED_TMP" src/index.ts >>"$LOG" 2>&1; then
    mv -f "$COMPILED_TMP" "$COMPILED"
    chmod +x "$COMPILED"
    log "    v compiled $COMPILED"
    notify_step "build" "succeeded" "$(( ( $(date +%s) - BD_START ) * 1000 ))"
  else
    rm -f "$COMPILED_TMP"
    log "    ! bun build --compile failed — systemd will fall back to bun run"
    notify_step "build" "succeeded" "$(( ( $(date +%s) - BD_START ) * 1000 ))"
  fi
fi

# ── 6.5 Pin BUILD_SHA into the systemd unit so the running process can
# report it and the SW versioning rotates exactly per-deploy. Drop-in
# survives daemon-reload; the OLD file is overwritten on every deploy.
# Without this, src/routes/pwa.ts falls back to a stable "dev-stable"
# string and the browser SW never invalidates between real deploys.
if [ "$DEPLOY_FAILED" = "0" ]; then
  DROPIN_DIR=/etc/systemd/system/gluecron.service.d
  mkdir -p "$DROPIN_DIR"
  cat > "$DROPIN_DIR/build-sha.conf" <<EOF
[Service]
Environment="BUILD_SHA=$NEW_SHA"
Environment="BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EOF
  systemctl daemon-reload >>"$LOG" 2>&1 || log "    ! daemon-reload non-fatal warning"
  log "    v pinned BUILD_SHA=${NEW_SHA:0:12} in systemd drop-in"
fi

# ── 7. systemctl restart (blocks on sd_notify READY=1) ────────────────────
if [ "$DEPLOY_FAILED" = "0" ]; then
  RS_START=$(date +%s)
  notify_step "restart-service" "in_progress"
  if systemctl restart gluecron >>"$LOG" 2>&1; then
    log "    v systemctl restart gluecron ok"
    notify_step "restart-service" "succeeded" "$(( ( $(date +%s) - RS_START ) * 1000 ))"
  else
    log "    x systemctl restart FAILED"
    DEPLOY_FAILED=1
    FAIL_REASON="systemctl restart failed"
    notify_step "restart-service" "failed" "$(( ( $(date +%s) - RS_START ) * 1000 ))"
  fi
fi

# ── 8. Wait for /healthz to be green (up to 30s) ──────────────────────────
if [ "$DEPLOY_FAILED" = "0" ]; then
  HZ_START=$(date +%s)
  notify_step "healthz" "in_progress"
  green=0
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTHZ_URL" || echo "000")
    log "    healthz attempt $i: $code"
    if [ "$code" = "200" ]; then green=1; break; fi
    sleep 2
  done
  if [ "$green" = "1" ]; then
    log "    v /healthz green"
    notify_step "healthz" "succeeded" "$(( ( $(date +%s) - HZ_START ) * 1000 ))"
  else
    log "    x /healthz did not return 200 within 30s"
    DEPLOY_FAILED=1
    FAIL_REASON="/healthz timeout"
    notify_step "healthz" "failed" "$(( ( $(date +%s) - HZ_START ) * 1000 ))"
  fi
fi

# ── 9. Post-deploy smoke suite ────────────────────────────────────────────
if [ "$DEPLOY_FAILED" = "0" ]; then
  PS_START=$(date +%s)
  notify_step "full-smoke" "in_progress"
  export GLUECRON_HOST="http://localhost:${PORT}"
  if "$BUN" run scripts/post-deploy-smoke.ts >>"$LOG" 2>&1; then
    log "    v post-deploy smoke green"
    notify_step "full-smoke" "succeeded" "$(( ( $(date +%s) - PS_START ) * 1000 ))"
  else
    log "    x post-deploy smoke FAILED"
    DEPLOY_FAILED=1
    FAIL_REASON="post-deploy smoke failed"
    notify_step "full-smoke" "failed" "$(( ( $(date +%s) - PS_START ) * 1000 ))"
  fi
fi

# ── 10. Rollback on failure ───────────────────────────────────────────────
if [ "$DEPLOY_FAILED" = "1" ] && [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$NEW_SHA" ]; then
  notify_step "rollback" "in_progress"
  log "    ! rolling back to $PREV_SHA (reason: $FAIL_REASON)"
  git reset --hard "$PREV_SHA" >>"$LOG" 2>&1 || true
  systemctl restart gluecron >>"$LOG" 2>&1 || true
  sleep 3
  rb_green=0
  for i in 1 2 3; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTHZ_URL" || echo "000")
    log "    rollback healthz attempt $i: $code"
    if [ "$code" = "200" ]; then rb_green=1; break; fi
    sleep 2
  done
  if [ "$rb_green" = "1" ]; then
    notify_step "rollback" "succeeded"
    log "    v rollback green"
  else
    notify_step "rollback" "failed"
    log "    x ROLLBACK FAILED — human intervention required"
  fi
fi

# ── 11. Notify deploy finished ────────────────────────────────────────────
DUR_MS=$(( ( $(date +%s) - START_EPOCH ) * 1000 ))
if [ -n "${DEPLOY_EVENT_TOKEN:-}" ] && [ -n "${APP_BASE_URL:-}" ]; then
  if [ "$DEPLOY_FAILED" = "0" ]; then
    curl --silent --show-error --max-time 10 \
      -X POST "$APP_BASE_URL/api/events/deploy/finished" \
      -H "authorization: Bearer $DEPLOY_EVENT_TOKEN" \
      -H "content-type: application/json" \
      --data "{\"run_id\":\"$RUN_ID\",\"sha\":\"$NEW_SHA\",\"status\":\"succeeded\",\"duration_ms\":$DUR_MS}" \
      >>"$LOG" 2>&1 || true
  else
    ERR_PAYLOAD="$(printf '%s' "${FAIL_REASON:-deploy failed}" | head -c 512)"
    if command -v jq >/dev/null 2>&1; then
      ERR_JSON=$(printf '%s' "$ERR_PAYLOAD" | jq -Rs '.')
    else
      ERR_JSON="\"${ERR_PAYLOAD//\"/\\\"}\""
    fi
    curl --silent --show-error --max-time 10 \
      -X POST "$APP_BASE_URL/api/events/deploy/finished" \
      -H "authorization: Bearer $DEPLOY_EVENT_TOKEN" \
      -H "content-type: application/json" \
      --data "{\"run_id\":\"$RUN_ID\",\"sha\":\"$NEW_SHA\",\"status\":\"failed\",\"duration_ms\":$DUR_MS,\"error\":$ERR_JSON}" \
      >>"$LOG" 2>&1 || true
  fi
fi

if [ "$DEPLOY_FAILED" = "0" ]; then
  log "==> gluecron self-deploy SUCCESS in ${DUR_MS}ms (sha=$NEW_SHA)"
  exit 0
else
  log "==> gluecron self-deploy FAILED in ${DUR_MS}ms (reason=$FAIL_REASON)"
  exit 1
fi
