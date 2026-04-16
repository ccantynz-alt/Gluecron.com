# gluecron

AI-native code intelligence platform — git hosting, automated CI, and green ecosystem enforcement.

## Section 0 — SESSION START PROTOCOL (mandatory)

Every session begins by loading memory. Do these in order:

1. Read `.memory/project-state.md` — current status snapshot
2. Read `.memory/last-session.md` — what was just built, what's next
3. Read `.memory/open-questions.md` — anything needing owner input
4. Run `git log --oneline -5` — verify branch state
5. Run `bun test 2>&1 | tail -3` — verify tests pass

If any file is missing, note it and proceed. Never ask the user to provide context you can read from these files.

## Section 1 — HARD RULES

### Rule 1: Never forget context
- Session memory lives in `.memory/`. Read it. Use it. Update it.
- If you don't know something, check memory files before asking.
- Cross-session continuity is non-negotiable.

### Rule 2: Never sit idle
- This is a revenue-generating product. Idle time = lost revenue.
- See something broken? Fix it. See a gap? Build it. Finished a task? Start the next one.
- Prioritize: Security fixes > broken functionality > performance > new features > polish.
- When in doubt, build. The worst outcome is sitting idle.

### Rule 3: Never ship broken code
- `bun test` must pass before every commit.
- Run tests after every change. If tests break, fix them immediately.
- Commit and push frequently. Small, focused commits.
- Every user-facing failure mode has a fallback — no 500s reach the UI.

## Section 2 — SESSION END PROTOCOL (mandatory)

Before the session ends or context compacts:

1. Update `.memory/last-session.md` with: what was built, what was fixed, branch state, what's next
2. Update `.memory/project-state.md` if architecture changed
3. Append new decisions to `.memory/decisions-log.md`
4. Update `.memory/open-questions.md` if new questions arose
5. Commit memory files with message: `chore: update session memory`

## Section 3 — Agent Policy — NEVER IDLE

**This is a revenue-generating product. Idle time = lost revenue.**

Every session must ship value. The rules:

1. **See something broken? Fix it.** Don't report it and wait — fix it, commit, push.
2. **See a missing feature that would advance the platform? Build it.** Don't ask permission for obvious improvements.
3. **Finished a task? Start the next one.** Audit the codebase for gaps, performance issues, missing tests, broken flows. Always have the next thing queued.
4. **Run tests after every change.** `bun test` must pass before pushing. If tests break, fix them immediately.
5. **Commit and push frequently.** Small, focused commits. Don't batch 10 features into one push.
6. **Prioritize by impact:** Security fixes > broken functionality > performance > new features > polish.
7. **When in doubt, build.** The worst outcome is sitting idle. The second worst is asking "should I?" when the answer is obviously yes.

## Section 4 — READ FIRST — every session

**`BUILD_BIBLE.md` is mandatory reading for every Claude agent before any code changes.**

It contains:
- Agent policy (do-not-undo rule, continuous-build rule)
- GitHub parity scorecard (what's shipped vs missing)
- Numbered build plan (Blocks A–H)
- Locked components that cannot be altered without owner permission
- Session workflow

Do not skip it. Do not refactor locked files. Do not stop mid-block.

## Section 5 — Stack

- **Runtime:** Bun
- **Framework:** Hono (with JSX for server-rendered views)
- **Database:** Drizzle ORM + Neon (PostgreSQL)
- **Git:** Smart HTTP protocol via git CLI subprocesses

## Section 6 — Development

```bash
bun install        # install dependencies
bun dev            # start dev server (hot reload)
bun test           # run tests
bun run db:migrate # run database migrations
```

## Section 7 — Architecture

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

## Section 8 — ESCAPE HATCHES

User can override any rule at any time:

- `just do X` — skip memory protocol and just do the thing
- `rule check` — agent re-reads CLAUDE.md and confirms compliance
- `memory check` — agent reads all .memory/ files and summarizes current state
- `skip tests` — commit without running tests (use sparingly)
- `stop` — end the session immediately, update memory first

## Section 9 — DRIFT PREVENTION

Every 10 tool calls, silently verify:
1. Am I still following the hard rules?
2. Has the conversation drifted from the build plan?
3. Are tests still passing?

If drift is detected, self-correct without being asked. If tests are failing, fix before continuing.

## Section 10 — COMPETITIVE INTELLIGENCE

The mission: **annihilate GitHub**. Continuously evaluate:
- What does GitHub charge enterprise prices for that we ship free?
- What is GitHub slow at that we can make instant?
- What manual workflow can we automate with AI?
- What's missing from every code hosting platform that developers wish existed?

Every session should advance at least one competitive advantage.
