#!/usr/bin/env bash
#
# Daily Postgres backup for the standalone box. Installed as a systemd timer by
# scripts/standalone-deploy.sh. Keeps 14 days locally; optionally copies offsite
# and pings a dead-man's-switch monitor.
#
# Optional env (set in /opt/gluecron/.env):
#   BACKUP_RCLONE_REMOTE  e.g. r2:gluecron-backups   (needs rclone configured)
#   HEALTHCHECK_PING_URL  e.g. https://hc-ping.com/<uuid>  (healthchecks.io)
set -euo pipefail

REPO_DIR="/opt/gluecron"
BACKUP_DIR="$REPO_DIR/backups"
RETAIN_DAYS=14
COMPOSE="docker compose -f docker-compose.standalone.yml"

cd "$REPO_DIR"
mkdir -p "$BACKUP_DIR"
ts=$(date +%Y%m%d-%H%M%S)
out="$BACKUP_DIR/gluecron-$ts.sql.gz"

$COMPOSE exec -T postgres pg_dump -U gluecron gluecron | gzip > "$out"

# Retention
find "$BACKUP_DIR" -name 'gluecron-*.sql.gz' -mtime +$RETAIN_DAYS -delete

# Optional offsite copy
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$out" "$BACKUP_RCLONE_REMOTE" || echo "WARN: offsite copy failed"
fi

# Optional dead-man's-switch heartbeat (alerts you if a backup is ever missed)
if [ -n "${HEALTHCHECK_PING_URL:-}" ]; then
  curl -fsS -m 10 "$HEALTHCHECK_PING_URL" >/dev/null 2>&1 || true
fi

echo "$(date -Is) backup written: $out ($(du -h "$out" | cut -f1))"
