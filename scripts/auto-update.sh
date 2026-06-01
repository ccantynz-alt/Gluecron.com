#!/usr/bin/env bash
#
# Fast auto-deploy for the standalone box. Installed as a ~60s systemd timer by
# scripts/standalone-deploy.sh. Polls the deploy branch; when new commits land,
# it pulls, rebuilds, and runs migrations. Push -> live in ~1-2 min, hands-off.
#
# Exits immediately (cheap) when there is nothing new, so a tight interval is fine.
set -euo pipefail

REPO_DIR="/opt/gluecron"
BRANCH="main"
COMPOSE="docker compose -f docker-compose.standalone.yml"

cd "$REPO_DIR"
git fetch origin "$BRANCH" --quiet

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse "origin/$BRANCH")
[ "$local_sha" = "$remote_sha" ] && exit 0

echo "$(date -Is) deploying $local_sha -> $remote_sha"
git reset --hard "origin/$BRANCH"     # untracked .env / backups are preserved

$COMPOSE up -d --build
sleep 5
$COMPOSE exec -T gluecron bun run db:migrate || true
docker image prune -f >/dev/null 2>&1 || true

echo "$(date -Is) deploy complete: $remote_sha"
