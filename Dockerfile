FROM oven/bun:1.3 AS base
WORKDIR /app

# Install git (required for ALL git operations — clone, push, branch/tree
# listing, diffs), zip (used to package the Claude Desktop .dxt bundle at
# build time), and wget (the compose healthcheck calls it — without it the
# container is permanently "unhealthy" and autoheal restart-loops it).
# Verify git landed: a missing binary here must fail the build loudly rather
# than ship an image that 500s on every repo page.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates zip wget \
  && rm -rf /var/lib/apt/lists/* \
  && git --version \
  && wget --version | head -1

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY scripts/ ./scripts/
COPY extension/ ./extension/
COPY public/ ./public/
COPY tsconfig.json drizzle.config.ts ./
COPY legal/ ./legal/
COPY CLAUDE.md LICENSE ./

# Refresh the Claude Desktop (.dxt) bundle from source into public/ so GET
# /gluecron.dxt serves a real file instead of 404ing (which also kept tripping
# the synthetic uptime monitor). The committed public/gluecron.dxt is the
# fallback; this rebuild keeps it in sync with the manifest. Best-effort — a
# glitch here must not fail the whole image.
RUN bash scripts/build-dxt.sh || echo "WARN: .dxt bundle build skipped"

# Create repos directory
RUN mkdir -p /data/repos

ENV GIT_REPOS_PATH=/data/repos
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as non-root user for security
RUN chown -R bun:bun /app /data/repos
USER bun

CMD ["bun", "run", "src/index.ts"]
