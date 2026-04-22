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

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
