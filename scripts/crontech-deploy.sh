#!/bin/bash
set -euo pipefail

# ============================================
# Gluecron via Crontech Deployment
#
# This deploys gluecron through the Crontech ecosystem.
# Crontech handles routing, SSL, and domain management.
# gluecron hosts the code. GateTest scans it.
# The ecosystem feeds itself.
# ============================================

APP_NAME="gluecron"

echo "=========================================="
echo "  Deploying $APP_NAME via Crontech"
echo "=========================================="

# Check DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: Set DATABASE_URL first."
  echo "  export DATABASE_URL='postgresql://...'"
  exit 1
fi

# Run database migration
echo "Running database migration..."
if command -v psql &>/dev/null; then
  psql "$DATABASE_URL" -f drizzle/0000_init.sql 2>&1 | tail -5
  echo "Migration complete."
else
  echo "psql not found — run drizzle/0000_init.sql manually against your Neon DB."
  echo "You can do this from Neon's web console (SQL Editor)."
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  bun install --production
fi

# Create repos directory
mkdir -p "${GIT_REPOS_PATH:-./repos}"

echo ""
echo "=========================================="
echo "  Ready for Crontech deployment"
echo "=========================================="
echo ""
echo "  Start command: bun run src/index.ts"
echo "  Port: ${PORT:-3000}"
echo "  Repos dir: ${GIT_REPOS_PATH:-./repos}"
echo ""
echo "  Environment variables needed:"
echo "    DATABASE_URL     = (your Neon connection string)"
echo "    GIT_REPOS_PATH   = /data/repos (or persistent volume)"
echo "    PORT             = 3000"
echo "    NODE_ENV         = production"
echo ""
echo "  If Crontech routes via subdomain:"
echo "    gluecron.crontech.ai -> this service"
echo ""
echo "  If Crontech routes via custom domain:"
echo "    gluecron.com -> this service"
echo "    (Crontech handles SSL + DNS)"
echo ""
