#!/usr/bin/env bash
# Post-deploy smoke verifier. Runs the DEPLOY_CHECKLIST.md post-deploy
# smoke tests as a single command. Exits non-zero on any failure so it
# can be dropped into CI or a post-deploy hook.
#
# Usage:
#   bash scripts/verify-deploy.sh                          # defaults to https://gluecron.com
#   bash scripts/verify-deploy.sh https://staging.example  # override base URL
#   BASE_URL=https://gluecron.com bash scripts/verify-deploy.sh

set -uo pipefail

BASE_URL="${1:-${BASE_URL:-https://gluecron.com}}"
BASE_URL="${BASE_URL%/}"

fail=0

check() {
	local label="$1"
	local url="$2"
	local expect_status="${3:-200}"
	local match="${4:-}"

	local tmp status body
	tmp="$(mktemp)"
	status="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 10 "$url" || echo 000)"
	body="$(cat "$tmp")"
	rm -f "$tmp"

	if [[ "$status" != "$expect_status" ]]; then
		printf '  \033[31mFAIL\033[0m  %-32s  %s  (got %s, want %s)\n' \
			"$label" "$url" "$status" "$expect_status"
		fail=$((fail + 1))
		return
	fi

	if [[ -n "$match" && "$body" != *"$match"* ]]; then
		printf '  \033[31mFAIL\033[0m  %-32s  %s  (body missing %q)\n' \
			"$label" "$url" "$match"
		fail=$((fail + 1))
		return
	fi

	printf '  \033[32mOK\033[0m    %-32s  %s  (%s)\n' "$label" "$url" "$status"
}

echo "Verifying $BASE_URL ..."

check "healthz"          "$BASE_URL/healthz"   200
check "readyz"           "$BASE_URL/readyz"    200
check "status (html)"    "$BASE_URL/status"    200 "status"
check "status.svg"       "$BASE_URL/status.svg" 200 "<svg"
check "metrics"          "$BASE_URL/metrics"   200 "# HELP"
check "landing (/)"      "$BASE_URL/"          200

# www alias — only runs when the base URL has no www and is HTTPS
if [[ "$BASE_URL" =~ ^https://[^/]+$ ]] && [[ ! "$BASE_URL" =~ https://www\. ]]; then
	www_url="${BASE_URL/https:\/\//https:\/\/www.}"
	check "www alias /healthz"  "$www_url/healthz" 200
fi

if [[ "$fail" -eq 0 ]]; then
	printf '\n\033[32mAll checks passed.\033[0m\n'
	exit 0
fi

printf '\n\033[31m%d check(s) failed.\033[0m\n' "$fail"
exit 1
