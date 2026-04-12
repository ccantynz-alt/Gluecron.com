# gluecron

AI-native code intelligence platform — git hosting, automated CI, and green ecosystem enforcement.

## Stack

- **Runtime:** Bun
- **Framework:** Hono (with JSX for server-rendered views)
- **Database:** Drizzle ORM + Neon (PostgreSQL)
- **Git:** Smart HTTP protocol via git CLI subprocesses

## Development

```bash
bun install        # install dependencies
bun dev            # start dev server (hot reload)
bun test           # run tests
bun run db:migrate # run database migrations
```

## Architecture

```
src/
  index.ts           Entry point (Bun server)
  app.ts             Hono app composition
  lib/config.ts      Environment config (getters, reads env at access time)
  db/
    schema.ts        Drizzle schema (users, repositories, ssh_keys)
    index.ts         Lazy DB connection (proxy pattern)
    migrate.ts       Migration runner
  git/
    repository.ts    Git operations (tree, blob, commits, diff, branches)
    protocol.ts      Smart HTTP protocol (pkt-line, service RPC)
  hooks/
    post-receive.ts  GateTest + Crontech webhooks on push
  routes/
    git.ts           Git HTTP endpoints (clone/push)
    api.ts           REST API (repo CRUD, setup)
    web.tsx          Web UI (file browser, commits, diffs)
  views/
    layout.tsx       HTML shell + CSS
    components.tsx   UI components (file table, commit list, diff viewer)
```

## Integrations

- **GateTest:** POST `https://gatetest.ai/api/scan/run` on every `git push`
- **Crontech:** POST `https://crontech.ai/api/trpc/tenant.deploy` on push to main

## Environment Variables

See `.env.example` for required variables. Key ones:
- `DATABASE_URL` — Neon PostgreSQL connection string
- `GIT_REPOS_PATH` — directory for bare git repos (default: `./repos`)
- `PORT` — HTTP port (default: 3000)
