#!/usr/bin/env bash
# Backup-restore drill. Proves the backup pipeline works end-to-end.
# See docs/BACKUP_RESTORE_DRILL.md for the full runbook.

set -uo pipefail

KEEP_DUMP=0
VERBOSE=0
for arg in "$@"; do
	case "$arg" in
		--keep-dump) KEEP_DUMP=1 ;;
		--verbose)   VERBOSE=1 ;;
		*) ;;
	esac
done

DATABASE_URL="${DATABASE_URL:-}"
SCRATCH_DATABASE_URL="${SCRATCH_DATABASE_URL:-}"

if [[ -z "$DATABASE_URL" || -z "$SCRATCH_DATABASE_URL" ]]; then
	echo "ERROR: DATABASE_URL and SCRATCH_DATABASE_URL must both be set." >&2
	exit 2
fi

if ! command -v pg_dump >/dev/null 2>&1; then
	echo "ERROR: pg_dump not found. apt-get install -y postgresql-client" >&2
	exit 2
fi
if ! command -v psql >/dev/null 2>&1; then
	echo "ERROR: psql not found." >&2
	exit 2
fi

ts="$(date +%s)"
start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
start_seconds="$(date +%s)"
dump="/tmp/gluecron-drill-${ts}.dump"
stamp_dir="/var/lib/gluecron"

log() {
	printf '[drill %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

log "dumping prod DB ..."
if [[ "$VERBOSE" -eq 1 ]]; then
	pg_dump --format=custom --no-owner --no-privileges --file="$dump" "$DATABASE_URL"
else
	pg_dump --format=custom --no-owner --no-privileges --file="$dump" "$DATABASE_URL" 2>/dev/null
fi

if [[ ! -s "$dump" ]]; then
	log "FATAL: dump file is empty or missing."
	exit 1
fi
dump_size=$(du -h "$dump" | cut -f1)
log "dump complete: ${dump_size} at $dump"

log "restoring into scratch ..."
# Wipe the scratch DB schema (public only). Idempotent.
psql -v ON_ERROR_STOP=1 "$SCRATCH_DATABASE_URL" >/dev/null <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO PUBLIC;
SQL

if [[ "$VERBOSE" -eq 1 ]]; then
	pg_restore --no-owner --no-privileges --dbname="$SCRATCH_DATABASE_URL" "$dump" || true
else
	pg_restore --no-owner --no-privileges --dbname="$SCRATCH_DATABASE_URL" "$dump" >/dev/null 2>&1 || true
fi
log "restore complete"

q() {
	local url="$1" sql="$2"
	psql -At "$url" -c "$sql" 2>/dev/null | tr -d '[:space:]'
}

compare() {
	local label="$1" sql="$2"
	local a b
	a="$(q "$DATABASE_URL" "$sql")"
	b="$(q "$SCRATCH_DATABASE_URL" "$sql")"
	if [[ "$a" == "$b" && -n "$a" ]]; then
		printf '  \033[32mPASS\033[0m  %-22s  prod=%-12s  scratch=%s\n' "$label" "$a" "$b"
		return 0
	fi
	printf '  \033[31mFAIL\033[0m  %-22s  prod=%-12s  scratch=%s\n' "$label" "$a" "$b"
	return 1
}

log "verification:"
fails=0
compare "users count"          "SELECT COUNT(*) FROM users;"                        || fails=$((fails+1))
compare "repositories count"   "SELECT COUNT(*) FROM repositories;"                 || fails=$((fails+1))
compare "site_admins count"    "SELECT COUNT(*) FROM site_admins;"                  || fails=$((fails+1))
compare "schema tables"        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" || fails=$((fails+1))

elapsed=$(( $(date +%s) - start_seconds ))

if [[ "$KEEP_DUMP" -ne 1 ]]; then
	rm -f "$dump"
fi

if [[ "$fails" -eq 0 ]]; then
	log "All checks passed. Took ${elapsed}s."
	mkdir -p "$stamp_dir" 2>/dev/null || true
	date +%s > "$stamp_dir/drill-last-success" 2>/dev/null || true
	exit 0
fi

log "${fails} check(s) failed. Investigate before trusting backups."
exit 1
