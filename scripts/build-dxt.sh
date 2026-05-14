#!/usr/bin/env bash
# =============================================================================
# BLOCK Q1 — Claude Desktop (.dxt) extension build script.
#
#   bash scripts/build-dxt.sh
#
# What it does:
#   1. Validates extension/gluecron.dxt/manifest.json is parseable JSON
#   2. Regenerates placeholder icon.png + screenshot-1.png (idempotent)
#   3. Zips everything under extension/gluecron.dxt/ into public/gluecron.dxt
#   4. Prints the size + path
#
# Output:
#   public/gluecron.dxt  — the user-facing extension bundle, served by
#                          GET /gluecron.dxt (see src/routes/dxt.ts).
#
# Re-runnable. Safe to call on every deploy. No third-party deps beyond
# system `zip` (available on macOS, Linux, WSL).
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/extension/gluecron.dxt"
OUT_DIR="$ROOT/public"
OUT_FILE="$OUT_DIR/gluecron.dxt"

# ── pretty printers ─────────────────────────────────────────────────────────
say()  { printf "\n\033[1;34m> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32mv\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail() { printf "  \033[31mx\033[0m %s\n" "$*"; exit 1; }

# ── 1. Prerequisites ────────────────────────────────────────────────────────
say "[1/4] Checking prerequisites"
command -v zip >/dev/null 2>&1 || fail "zip is not on PATH — install it (apt: zip / brew: zip) and retry"
ok "zip found: $(command -v zip)"

[[ -d "$SRC_DIR" ]] || fail "extension/gluecron.dxt/ missing — bad checkout?"
[[ -f "$SRC_DIR/manifest.json" ]] || fail "manifest.json missing under $SRC_DIR"
ok "source tree at $SRC_DIR"

# ── 2. Validate manifest is parseable JSON ─────────────────────────────────
say "[2/4] Validating manifest.json"
if command -v bun >/dev/null 2>&1; then
  bun -e "JSON.parse(require('fs').readFileSync('$SRC_DIR/manifest.json','utf8'))" \
    || fail "manifest.json is not valid JSON"
elif command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync('$SRC_DIR/manifest.json','utf8'))" \
    || fail "manifest.json is not valid JSON"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import json,sys;json.load(open('$SRC_DIR/manifest.json'))" \
    || fail "manifest.json is not valid JSON"
else
  warn "no bun/node/python3 — skipping JSON validation"
fi
ok "manifest.json is valid"

# ── 3. Regenerate placeholder assets if bun is available ───────────────────
say "[3/4] Refreshing placeholder assets"
if command -v bun >/dev/null 2>&1 && [[ -f "$ROOT/scripts/build-dxt-assets.ts" ]]; then
  bun run "$ROOT/scripts/build-dxt-assets.ts"
  ok "assets refreshed"
else
  warn "bun missing or build-dxt-assets.ts not found — using committed PNGs as-is"
fi

# ── 4. Zip → public/gluecron.dxt ────────────────────────────────────────────
say "[4/4] Packaging gluecron.dxt"
mkdir -p "$OUT_DIR"
# `zip -j` would flatten paths; we want manifest.json at the ZIP root so
# Claude Desktop finds it. Use a clean temp dir + `cd` to keep the archive
# rooted at the bundle directory itself.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
cp -R "$SRC_DIR/." "$TMP_DIR/"
# Remove the previous archive so `zip` doesn't try to update an existing one.
rm -f "$OUT_FILE"
( cd "$TMP_DIR" && zip -q -r "$OUT_FILE" . )
ok "wrote $OUT_FILE"

SIZE=$(wc -c < "$OUT_FILE" | tr -d ' ')
HUMAN=$(printf "%.1f KB" "$(echo "scale=1; $SIZE/1024" | bc 2>/dev/null || echo "$SIZE")" 2>/dev/null || echo "$SIZE bytes")
ok "size: $HUMAN ($SIZE bytes)"

printf "\nDone. Test locally:\n  curl -I http://localhost:3000/gluecron.dxt\n\n"
