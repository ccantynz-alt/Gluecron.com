# gluecron

AI-native code intelligence platform — git hosting, automated CI, and green ecosystem enforcement.

## Agent Policy — NEVER IDLE

**This is a revenue-generating product. Idle time = lost revenue.**

Every session must ship value. The rules:

1. **See something broken? Fix it.** Don't report it and wait — fix it, commit, push.
2. **See a missing feature that would advance the platform? Build it.** Don't ask permission for obvious improvements.
3. **Finished a task? Start the next one.** Audit the codebase for gaps, performance issues, missing tests, broken flows. Always have the next thing queued.
4. **Run tests after every change.** `bun test` must pass before pushing. If tests break, fix them immediately.
5. **Commit and push frequently.** Small, focused commits. Don't batch 10 features into one push.
6. **Prioritize by impact:** Security fixes > broken functionality > performance > new features > polish.
7. **When in doubt, build.** The worst outcome is sitting idle. The second worst is asking "should I?" when the answer is obviously yes.

## READ FIRST — every session

**`BUILD_BIBLE.md` is mandatory reading for every Claude agent before any code changes.**

It contains:
- Agent policy (do-not-undo rule, continuous-build rule)
- GitHub parity scorecard (what's shipped vs missing)
- Numbered build plan (Blocks A–H)
- Locked components that cannot be altered without owner permission
- Session workflow

Do not skip it. Do not refactor locked files. Do not stop mid-block.

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
  index.ts                Entry point (Bun server)
  app.tsx                 Hono app composition + error handlers
  lib/
    config.ts             Environment config (getters, reads env at access time)
    auth.ts               Password hashing (bcrypt), session tokens
    highlight.ts          Syntax highlighting (highlight.js, 40+ languages)
    markdown.ts           Markdown rendering (GFM + syntax highlighting)
  db/
    schema.ts             Drizzle schema (all tables)
    index.ts              Lazy DB connection (proxy pattern)
    migrate.ts            Migration runner
  git/
    repository.ts         Git operations (tree, blob, commits, diff, branches, blame, search, raw)
    protocol.ts           Smart HTTP protocol (pkt-line, service RPC)
  hooks/
    post-receive.ts       GateTest + Crontech webhooks on push
  middleware/
    auth.ts               softAuth + requireAuth middleware
  routes/
    git.ts                Git HTTP endpoints (clone/push)
    api.ts                REST API (repo CRUD, setup)
    auth.tsx              Register, login, logout (web + API)
    web.tsx               Web UI (file browser, commits, diffs, search, blame, raw)
    issues.tsx            Issue tracker (CRUD, comments, close/reopen)
    pulls.tsx             Pull requests (create, review, merge, close)
    editor.tsx            Web file editor (create/edit via git plumbing)
    compare.tsx           Branch comparison (diff + commit list)
    settings.tsx          User settings (profile, SSH keys)
    repo-settings.tsx     Repository settings (description, visibility, delete)
    webhooks.tsx          Webhook management + delivery engine
    fork.ts               Repository forking
    explore.tsx           Explore/discover public repos
    tokens.tsx            Personal access tokens
    contributors.tsx      Contributor list + commit activity graph
  views/
    layout.tsx            HTML shell + CSS (dark theme) + auth-aware nav
    components.tsx        UI components (file table, commit list, diff viewer, etc.)
```

## Database Schema

- `users` — accounts with bcrypt password hashing
- `sessions` — cookie-based auth sessions (30 day expiry)
- `repositories` — repos with fork tracking, star/fork/issue counts
- `stars` — user-repo star relationships
- `issues` — issue tracker with open/closed state
- `issue_comments` — threaded comments on issues
- `labels` + `issue_labels` — issue categorization
- `pull_requests` — PRs with base/head branches, open/closed/merged state
- `pr_comments` — PR comments with AI review flag + file/line annotations
- `activity_feed` — event log for repos
- `webhooks` — registered webhook URLs with HMAC secret + event filtering
- `api_tokens` — personal access tokens with SHA-256 hashing
- `repo_topics` — repository tags for discoverability
- `ssh_keys` — user SSH public keys

## Integrations

- **GateTest:** POST `https://gatetest.ai/api/scan/run` on every `git push`
- **Crontech:** POST `https://crontech.ai/api/trpc/tenant.deploy` on push to main
- **Webhooks:** POST to registered URLs on push/issue/PR/star events with HMAC signatures

## Environment Variables

See `.env.example` for required variables. Key ones:
- `DATABASE_URL` — Neon PostgreSQL connection string
- `GIT_REPOS_PATH` — directory for bare git repos (default: `./repos`)
- `PORT` — HTTP port (default: 3000)
