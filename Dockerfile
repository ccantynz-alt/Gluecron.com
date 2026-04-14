# ---- build stage ----
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy lockfile and manifest first for layer caching
COPY package.json bun.lock ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# ---- production stage ----
# oven/bun:1-debian is based on Debian so apt is available
FROM oven/bun:1-debian AS runner

WORKDIR /app

# Install git (required for git CLI subprocess calls)
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source and migration files
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY package.json ./

# Create the repos directory and give ownership to the bun user
RUN mkdir -p /app/repos \
    && chown -R bun:bun /app

# Run as non-root user (provided by the base image)
USER bun

# Default environment variables
ENV GIT_REPOS_PATH=/app/repos \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
