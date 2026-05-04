FROM oven/bun:1.3 AS base
WORKDIR /app

# Install git (required for git operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY tsconfig.json drizzle.config.ts ./
COPY legal/ ./legal/
COPY CLAUDE.md LICENSE ./

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
