#!/usr/bin/env bash
# =============================================================================
# scripts/build-self-host-binary.sh
#
# Builds the single-binary Gluecron server distribution that ships behind
# `curl -fsSL https://gluecron.com/install-server | bash`. Microsoft GHE is
# a 50GB blob; this is a ~200MB binary that runs the whole platform.
#
# Output layout (relative to repo root, all under dist/):
#
#   dist/
#     gluecron-server-linux-x64         (executable)
#     gluecron-server-linux-arm64       (executable)
#     gluecron-server-darwin-x64        (executable)
#     gluecron-server-darwin-arm64      (executable)
#     gluecron-server-<plat>-<arch>.sha256   (one per binary)
#     SHA256SUMS                        (combined manifest, served by /dist/SHA256SUMS)
#     post-receive                      (the bundled git hook)
#     env.example                       (default .env shipped with installs)
#     migrations.tar.gz                 (drizzle/ archive — seed schema)
#     VERSION                           (package.json version)
#     MANIFEST.txt                      (human-readable index)
#
# Usage:
#   scripts/build-self-host-binary.sh                # builds all 4 targets
#   GLUECRON_BUILD_TARGETS="linux-x64,linux-arm64" \
#     scripts/build-self-host-binary.sh              # subset (CI matrix)
#
# Cross-compilation uses bun's `--target` flag. Bun ≥1.1 supports
# bun-{linux,darwin}-{x64,arm64} as compile targets.
# =============================================================================

set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── pretty printers (match scripts/install.sh style) ────────────────────────
say()  { printf "\n\033[1;34m> %s\033[0m\n" "$*"; }
ok()   { printf "  \033[32mv\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
fail() { printf "  \033[31mx\033[0m %s\n" "$*"; exit 1; }

# ── 0. Prereqs ──────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || fail "bun not on PATH (https://bun.sh)"

DIST="$ROOT/dist"
mkdir -p "$DIST"

ALL_TARGETS=("linux-x64" "linux-arm64" "darwin-x64" "darwin-arm64")
if [ -n "${GLUECRON_BUILD_TARGETS:-}" ]; then
  IFS=',' read -r -a TARGETS <<<"$GLUECRON_BUILD_TARGETS"
else
  TARGETS=("${ALL_TARGETS[@]}")
fi

VERSION=$(node -p "require('./package.json').version" 2>/dev/null \
  || bun -e "console.log(require('./package.json').version)" 2>/dev/null \
  || echo "0.0.0-dev")
say "Building Gluecron self-host binaries (v$VERSION)"
ok  "Targets: ${TARGETS[*]}"
ok  "Output:  $DIST"

# ── 1. Compile each target ──────────────────────────────────────────────────
build_one() {
  local PLAT_ARCH="$1"
  local BUN_TARGET
  case "$PLAT_ARCH" in
    linux-x64)    BUN_TARGET="bun-linux-x64" ;;
    linux-arm64)  BUN_TARGET="bun-linux-arm64" ;;
    darwin-x64)   BUN_TARGET="bun-darwin-x64" ;;
    darwin-arm64) BUN_TARGET="bun-darwin-arm64" ;;
    *) fail "unknown target $PLAT_ARCH" ;;
  esac

  local OUT="$DIST/gluecron-server-$PLAT_ARCH"
  say "[build] $PLAT_ARCH → $OUT"
  # `--compile` produces a standalone executable bundling the bun runtime +
  # all JS/TS source. `--minify` shaves ~15% off the binary. `--sourcemap`
  # is intentionally omitted — we want the small ship size, and stack traces
  # already include enough information from bun's frame info.
  if bun build \
      --compile \
      --target="$BUN_TARGET" \
      --minify \
      --outfile "$OUT" \
      src/index.ts; then
    chmod +x "$OUT"
    local SIZE
    SIZE=$(du -h "$OUT" | awk '{print $1}')
    ok "compiled $PLAT_ARCH ($SIZE)"
  else
    warn "compile failed for $PLAT_ARCH (continuing)"
    return 1
  fi
}

FAILED=()
for T in "${TARGETS[@]}"; do
  if ! build_one "$T"; then
    FAILED+=("$T")
  fi
done

# ── 2. Bundle ancillary assets ──────────────────────────────────────────────
say "[bundle] hook + migrations + env.example"

# post-receive hook (compiled to a single self-contained JS file the host
# can drop into <repo>.git/hooks/). We ship the source TS too so operators
# can audit the contents.
cp -f src/hooks/post-receive.ts "$DIST/post-receive" || warn "post-receive copy failed"
chmod +x "$DIST/post-receive" 2>/dev/null || true
ok "post-receive hook → dist/post-receive"

# Seed migrations — every SQL + migration runner needed for a fresh box.
if [ -d drizzle ]; then
  tar -czf "$DIST/migrations.tar.gz" drizzle
  ok "migrations → dist/migrations.tar.gz"
else
  warn "drizzle/ directory missing — skipped migrations bundle"
fi

# Default .env.example
if [ -f .env.example ]; then
  cp -f .env.example "$DIST/env.example"
  ok ".env.example → dist/env.example"
else
  warn ".env.example missing — skipped"
fi

# ── 3. Checksums ────────────────────────────────────────────────────────────
say "[checksums] SHA-256 for each binary"
SUMFILE="$DIST/SHA256SUMS"
: >"$SUMFILE"
for T in "${TARGETS[@]}"; do
  BIN="$DIST/gluecron-server-$T"
  if [ -f "$BIN" ]; then
    HASH=$(sha256sum "$BIN" | awk '{print $1}')
    echo "$HASH  gluecron-server-$T" >>"$SUMFILE"
    echo "$HASH" >"$BIN.sha256"
    ok "sha256 $T  ${HASH:0:12}…"
  fi
done

# Include bundled ancillary assets in the combined manifest so the installer
# can verify the env.example + migrations tarball too.
for EXTRA in post-receive migrations.tar.gz env.example; do
  if [ -f "$DIST/$EXTRA" ]; then
    HASH=$(sha256sum "$DIST/$EXTRA" | awk '{print $1}')
    echo "$HASH  $EXTRA" >>"$SUMFILE"
  fi
done
ok "manifest: $SUMFILE"

# ── 4. VERSION + MANIFEST ───────────────────────────────────────────────────
echo "$VERSION" >"$DIST/VERSION"

{
  echo "gluecron self-host bundle"
  echo "version: $VERSION"
  echo "built:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "files:"
  (cd "$DIST" && ls -lh) | sed 's/^/  /'
} >"$DIST/MANIFEST.txt"
ok "manifest: dist/MANIFEST.txt"

if [ "${#FAILED[@]}" -gt 0 ]; then
  warn "Some targets failed to compile: ${FAILED[*]}"
  warn "The bundle is incomplete but usable for the targets that succeeded."
fi

printf "\n"
printf "\033[1;32m================================================================\033[0m\n"
printf "\033[1;32m  GLUECRON SELF-HOST BUNDLE READY  (v%s)\033[0m\n" "$VERSION"
printf "\033[1;32m================================================================\033[0m\n"
printf "  dist:    %s\n" "$DIST"
printf "  publish: copy dist/ to the running gluecron host so it serves\n"
printf "           /dist/<filename> from the binary release route.\n"
printf "\n"
