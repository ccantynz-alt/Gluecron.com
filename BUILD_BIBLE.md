# GLUECRON BUILD BIBLE

**This file is the single source of truth for the GlueCron build.**

**Every Claude agent MUST read this file in full before touching code. No exceptions.**

GlueCron is a GitHub replacement — AI-native code intelligence, green ecosystem enforcement, git hosting, automated CI. It is production infrastructure for multiple downstream platforms. Production cannot stop.

---

## 1. AGENT POLICY (READ FIRST, FOLLOW ALWAYS)

### 1.1 Required reads at session start
1. `BUILD_BIBLE.md` (this file) — complete
2. `CLAUDE.md` — stack + architecture
3. `README.md` — user-facing overview
4. Most recent commit on the current branch (`git log -1 --stat`)

### 1.2 Do-not-undo rule
- Anything listed in **§4 LOCKED BLOCKS** is shipped and must not be deleted, renamed, or semantically altered without the owner's explicit written permission in the current session.
- "Refactor" is not permission. "Clean up" is not permission. "Simplify" is not permission.
- If a locked file seems wrong, open an issue in the plan and keep going on a new block.

### 1.3 Continuous-build rule
- The owner runs many parallel projects. Do not stop work to ask for clarification that can be inferred from this file.
- Default behaviour when a block is partially complete: **finish it, run tests, commit, push, start the next block**.
- Only stop for genuinely blocking decisions: destructive operations, architectural reversals, requests outside this plan, or repeated test failures you can't diagnose.
- Never stop because "the session might run out." Commit what works and keep building.

### 1.4 Branch + commit rules
- Development branch: whatever the current session was told (check session opening message). Fall back to `main` if none given.
- One commit per completed block. Message format: `feat(BLOCK-ID): <summary>`.
- Push after every commit with `git push -u origin <branch>`.
- Never force-push. Never `--no-verify`. Never amend published commits.

### 1.5 Quality bars (non-negotiable)
- `bun test` must pass before every commit.
- New features ship with tests in `src/__tests__/`.
- New routes use `softAuth` or `requireAuth` middleware.
- New DB tables have a corresponding migration in `drizzle/`.
- AI features use `isAiAvailable()` guards and degrade gracefully without `ANTHROPIC_API_KEY`.
- Every user-facing failure mode has a fallback — no 500s reach the UI.

### 1.6 Green-ecosystem-by-default
- Every new repo auto-configures: gates on, branch protection on, labels seeded, CODEOWNERS synced, welcome issue posted.
- Users can opt out per feature but defaults are maximum-green.
- Nothing broken ever reaches production, the website, or the customer.

---

## 2. GITHUB PARITY SCORECARD

Legend: ✅ shipped · 🟡 partial · ❌ not built

### 2.1 Repository hosting
| Feature | Status | Notes |
|---|---|---|
| Git Smart HTTP (clone / push / fetch) | ✅ | `src/routes/git.ts`, `src/git/protocol.ts` |
| SSH keys | ✅ | `ssh_keys` table, `src/routes/settings.tsx` |
| Public / private visibility | ✅ | `repositories.isPrivate` |
| Forking | ✅ | `src/routes/fork.ts` |
| Stars | ✅ | `stars` table, `/:owner/:repo/star` |
| Topics | ✅ | `repo_topics` table |
| Archive / disable repo | ❌ | schema has flags; no UI |
| Repository transfer | ❌ | — |
| Template repositories | ❌ | — |
| Repository mirroring | ❌ | — |

### 2.2 Code browsing
| Feature | Status | Notes |
|---|---|---|
| File tree browser | ✅ | `src/routes/web.tsx` |
| Syntax highlighting | ✅ | 40+ languages, `src/lib/highlight.ts` |
| Commit history | ✅ | |
| Diffs | ✅ | |
| Blame | ✅ | |
| Raw file download | ✅ | |
| Branch switcher | ✅ | |
| Tag listing | ✅ | new this build |
| Code search (ILIKE) | ✅ | per-repo + global |
| Semantic / embedding search | ❌ | pgvector not wired |
| Symbol / xref navigation | ❌ | — |

### 2.3 Collaboration
| Feature | Status | Notes |
|---|---|---|
| Issues (CRUD / comments / labels / close) | ✅ | |
| Milestones | ✅ | `src/routes/insights.tsx` |
| Pull requests (CRUD / review / merge) | ✅ | |
| PR inline comments | ✅ | file+line anchored |
| Draft PRs | ✅ | create as draft, ready-for-review toggle, dedicated tab, merge blocked until ready |
| Reactions (emoji) | ✅ | 8 reactions, toggle via `POST /api/reactions/:t/:id/:emoji/toggle` on issues + PRs + comments |
| Mentions + notifications | ✅ | `src/routes/notifications.tsx` |
| Code owners | ✅ | `src/lib/codeowners.ts` |
| Issue templates | ✅ | `.github/ISSUE_TEMPLATE.md` auto-prefills new issues; frontmatter stripped; `src/lib/templates.ts` |
| PR templates | ✅ | `.github/PULL_REQUEST_TEMPLATE.md` auto-prefills new PRs; `src/lib/templates.ts` |
| Saved replies | ✅ | per-user canned comments, unique-shortcut, `/settings/replies`, `/api/user/replies` |
| Discussions / forums | ❌ | |
| Wikis | ❌ | |
| Projects / kanban | ❌ | |

### 2.4 Automation + AI
| Feature | Status | Notes |
|---|---|---|
| Webhooks (outbound, HMAC signed) | ✅ | `src/routes/webhooks.tsx` |
| GateTest inbound callback | ✅ | `POST /api/hooks/gatetest`, bearer or HMAC |
| Backup PAT-auth gate ingest | ✅ | `POST /api/v1/gate-runs` |
| Gate runs (test / secret / AI review) | ✅ | `gate_runs` table, `src/routes/gates.tsx` |
| Branch protection | ✅ | `branch_protection` table + UI |
| Auto-repair engine | ✅ | `src/lib/auto-repair.ts` |
| Secret scanner | ✅ | 15 patterns, `src/lib/security-scan.ts` |
| AI security review | ✅ | Sonnet 4, `src/lib/security-scan.ts` |
| AI commit messages | ✅ | `src/lib/ai-generators.ts` |
| AI PR summaries | ✅ | |
| AI changelogs | ✅ | auto on release create |
| AI code review | ✅ | `src/lib/ai-review.ts` |
| AI merge conflict resolver | ✅ | `src/lib/merge-resolver.ts` |
| AI chat (global + repo) | ✅ | `src/routes/ask.tsx` |
| GitHub Actions equivalent (workflow runner) | ❌ | GateTest integrated, no generic runner |
| Dependabot equivalent (AI dep bumper) | ❌ | |
| Code scanning UI | 🟡 | data exists, no dedicated UI page |
| Copilot code completion | ❌ | |

### 2.5 Platform
| Feature | Status | Notes |
|---|---|---|
| Dashboard | ✅ | `src/routes/dashboard.tsx` |
| Explore / discover | ✅ | |
| Global search | ✅ | repos / users / issues / PRs |
| Insights (graph, contributors, green rate) | ✅ | `src/routes/insights.tsx` |
| Releases + tags | ✅ | AI changelog |
| Personal access tokens | ✅ | SHA-256 hashed |
| OAuth app provider | ❌ | |
| GitHub Apps equivalent | ❌ | |
| GraphQL API | ❌ | REST only |
| Organizations + teams | ❌ | user-owned only |
| Enterprise SAML / SSO | ❌ | |
| 2FA / TOTP | ❌ | |
| Passkeys / WebAuthn | ❌ | |
| Packages registry (npm / docker / etc) | ❌ | |
| Pages / static hosting | ❌ | |
| Gists | ❌ | |
| Sponsors | ❌ | |
| Marketplace | ❌ | |
| Environments / deployment tracking | ✅ | `src/routes/deployments.tsx` — grouped by env, success-rate rollup, per-deploy detail |
| Merge queues | ❌ | |
| Required checks matrix | 🟡 | branch_protection has single flag, no matrix |

### 2.6 Observability + safety
| Feature | Status | Notes |
|---|---|---|
| Rate limiting | ✅ | `src/middleware/rate-limit.ts` |
| Request-ID tracing | ✅ | `src/middleware/request-context.ts` |
| Health / readiness / metrics | ✅ | `/healthz` `/readyz` `/metrics` |
| Audit log (table) | ✅ | `audit_log` table |
| Audit log UI | ✅ | `/settings/audit` (personal) + `/:owner/:repo/settings/audit` (per-repo, owner-only) |
| Traffic analytics per repo | ❌ | |
| Email notifications | ✅ | opt-in per kind (mention/assign/gate-fail) via `/settings`; provider-pluggable `src/lib/email.ts` (log default, resend in prod) |
| Email digest | ❌ | |
| Mobile PWA | 🟡 | responsive CSS, no manifest |
| Native mobile apps | ❌ | |
| Dark mode | ✅ | default |
| Light-mode toggle | ✅ | `/theme/toggle` + `theme` cookie, pre-paint script avoids FOUC, nav sun/moon icon |
| Keyboard shortcuts | ✅ | `/shortcuts` page |
| Command palette | 🟡 | Cmd+K → Ask AI, no generic palette |

---

## 3. BUILD PLAN (BLOCKS)

Each block is a self-contained unit. Order matters for dependencies. Each block ends with tests + commit + push.

### BLOCK A — Hardening the current surface
Polish what's shipped before adding more. **Priority: do this first if parity gaps are minor.**
- **A1** — Dark/light theme toggle (cookie, CSS variable swap) ✅
- **A2** — Audit log UI page (`/settings/audit` + `/:owner/:repo/settings/audit`) ✅
- **A3** — Reactions UI on issues / PRs / comments (data exists) ✅
- **A4** — Draft PR toggle + filter ✅
- **A5** — Issue + PR templates (`.github/*_TEMPLATE.md` auto-prefill) ✅
- **A6** — Saved replies per user ✅
- **A7** — Environments + deployment history UI (`deployments` table) ✅
- **A8** — Email notifications (opt-in, provider-pluggable) ✅

**BLOCK A COMPLETE.** Next: BLOCK B (Identity + orgs).

### BLOCK B — Identity + orgs
- **B1** — Organizations (schema: `organizations`, `org_members`, `teams`, `team_members`)
- **B2** — Repos owned by orgs (nullable `repositories.orgId`)
- **B3** — Team-based CODEOWNERS (`@org/team` resolution)
- **B4** — 2FA / TOTP (enroll, recovery codes)
- **B5** — WebAuthn / passkeys
- **B6** — OAuth 2.0 provider (third-party apps can request access)

### BLOCK C — Runtime + hosting
- **C1** — Actions-equivalent workflow runner
  - Workflow YAML parser (`.gluecron/workflows/*.yml`)
  - Job queue + worker pool (Bun subprocesses)
  - Artifact storage + log streaming
  - Integrates with gates
- **C2** — Package registry (npm + container protocol)
- **C3** — Pages / static hosting (`gh-pages` branch → served at `<owner>.<repo>.pages.gluecron.com`)
- **C4** — Environments (prod/staging/preview) with protected approvals

### BLOCK D — AI-native differentiation
This is where GlueCron beats GitHub outright. **Priority: ship these loud.**
- **D1** — Semantic code search (pgvector + Claude embeddings)
- **D2** — AI dependency updater (reads lockfile, opens PRs, verifies green)
- **D3** — AI PR triage agent (auto-assigns reviewers, labels, milestones)
- **D4** — AI incident responder (on deploy failure, opens issue with root cause)
- **D5** — AI code reviewer that blocks merges (enforced via branch protection "AI approval required")
- **D6** — AI "explain this codebase" on repo landing (auto-generated, cached)
- **D7** — AI changelog for every commit range (`/:owner/:repo/ai/changelog?from=...&to=...`)
- **D8** — AI-generated test suite (reads public API, generates failing tests)
- **D9** — Copilot-style completion endpoint for IDE plugins

### BLOCK E — Collaboration parity
- **E1** — Projects / kanban boards (`projects`, `project_items`, `project_fields`)
- **E2** — Discussions (forum threads per repo)
- **E3** — Wikis (git-backed, separate bare repo per repo)
- **E4** — Gists (user-owned tiny repos)
- **E5** — Merge queues (serialised merge with re-test)
- **E6** — Required status checks matrix (multiple named checks per branch protection rule)
- **E7** — Protected tags

### BLOCK F — Observability + admin
- **F1** — Traffic analytics per repo (views, clones, unique visitors)
- **F2** — Org-wide insights (green rate across all repos)
- **F3** — Admin / superuser panel (user moderation, repo audit)
- **F4** — Billing + quotas (storage, AI tokens, bandwidth)

### BLOCK G — Mobile + client
- **G1** — PWA manifest + service worker
- **G2** — GraphQL API mirror of REST
- **G3** — Official CLI (`gluecron` binary in Bun)
- **G4** — VS Code extension

### BLOCK H — Marketplace
- **H1** — App marketplace (install third-party apps against a repo)
- **H2** — GitHub Apps equivalent (bot identities with scoped permissions)

---

## 4. LOCKED BLOCKS (DO NOT UNDO)

Everything below is committed, tested, and load-bearing. **Do not delete, rename, or semantically change without owner permission.**

### 4.1 Infrastructure (locked)
- `src/app.tsx` — route composition, middleware order, error handlers
- `src/index.ts` — Bun server entry
- `src/lib/config.ts` — env getters (late-binding)
- `src/db/schema.ts` — 27 tables. New tables only via new migration.
- `src/db/index.ts` — lazy proxy DB connection
- `src/db/migrate.ts` — migration runner
- `drizzle/0000_initial.sql`, `drizzle/0001_green_ecosystem.sql` — migrations

### 4.2 Git layer (locked)
- `src/git/repository.ts` — tree / blob / commits / diff / branches / blame / search / raw / tags / commitsBetween
- `src/git/protocol.ts` — Smart HTTP pkt-line
- `src/hooks/post-receive.ts` — CODEOWNERS sync, gates, auto-deploy, webhook fan-out

### 4.3 Auth + security (locked)
- `src/lib/auth.ts` — bcrypt, session tokens
- `src/middleware/auth.ts` — softAuth + requireAuth
- `src/middleware/rate-limit.ts` — fixed-window limiter
- `src/middleware/request-context.ts` — request-ID
- `src/lib/security-scan.ts` — `SECRET_PATTERNS` (exported) + `scanForSecrets` + `aiSecurityScan`
- `src/lib/codeowners.ts` — parser + `ownersForPath` (last-match-wins)

### 4.4 AI layer (locked)
- `src/lib/ai-client.ts` — Anthropic client + model constants
- `src/lib/ai-generators.ts` — commit / PR / changelog / issue-triage
- `src/lib/ai-chat.ts` — conversational chat
- `src/lib/ai-review.ts` — PR code review
- `src/lib/auto-repair.ts` — worktree-backed repair commits
- `src/lib/merge-resolver.ts` — AI merge conflict resolution

### 4.5 Platform (locked)
- `src/lib/notify.ts` — notification creation + audit log (swallow-failures pattern). Also fans out email to opted-in recipients for `mention|review_requested|assigned|gate_failed`. Exports `__internal` for tests.
- `src/lib/email.ts` — provider-pluggable email sender (`log`|`resend`). `sendEmail()` never throws. `absoluteUrl()` joins paths against `APP_BASE_URL`.
- `src/lib/templates.ts` — `loadIssueTemplate` / `loadPrTemplate`. Checks standard paths (`.github/`, `.gluecron/`, root, `docs/`) on the default branch, strips YAML frontmatter, 16KB cap, returns null on any failure.
- `src/lib/unread.ts` — unread count helper (never throws)
- `src/lib/repo-bootstrap.ts` — green defaults on repo creation
- `src/lib/gate.ts` — gate orchestration + persistence
- `src/lib/cache.ts` — LRU cache, git-cache invalidation
- `src/lib/reactions.ts` — `summariseReactions`, `toggleReaction`, `ALLOWED_EMOJIS`, `EMOJI_GLYPH`, `isAllowedEmoji`, `isAllowedTarget`

### 4.6 Routes (locked endpoints — behaviour must be preserved)
- `src/routes/git.ts` — Smart HTTP (clone/push)
- `src/routes/api.ts` — REST (`POST /api/repos`, `GET /api/users/:u/repos`, `GET /api/repos/:o/:n`, `POST /api/setup`)
- `src/routes/hooks.ts` — `POST /api/hooks/gatetest` (bearer/HMAC), `GET /api/hooks/ping`, `POST /api/v1/gate-runs` (PAT backup), `GET /api/v1/gate-runs`. See `GATETEST_HOOK.md`.
- `src/routes/theme.ts` — `GET /theme/toggle`, `GET /theme/set?mode=`. Writes `theme` cookie (`dark`|`light`, 1-year). Layout reads via pre-paint inline script.
- `src/routes/audit.tsx` — `GET /settings/audit` (personal) + `GET /:owner/:repo/settings/audit` (owner-only).
- `src/routes/saved-replies.tsx` — `GET/POST /settings/replies`, `POST /settings/replies/:id`, `POST /settings/replies/:id/delete`, `GET /api/user/replies`. Unique constraint `saved_replies_user_shortcut`.
- `src/routes/deployments.tsx` — `GET /:owner/:repo/deployments` (grouped by env, success-rate rollup), `GET /:owner/:repo/deployments/:id` (detail).
- `src/routes/reactions.ts` — `POST /api/reactions/:targetType/:targetId/:emoji/toggle` (authed, form- or fetch-compatible), `GET /api/reactions/:targetType/:targetId`. Targets: `issue|pr|issue_comment|pr_comment`. Emojis: 8 canonical.
- `src/routes/auth.tsx` — register / login / logout
- `src/routes/web.tsx` — home / new / browse / blob / commits / raw / blame / star / search / profile
- `src/routes/issues.tsx` — issue CRUD + comments + labels + lock
- `src/routes/pulls.tsx` — PR CRUD + review + merge + close
- `src/routes/editor.tsx` — web file editor
- `src/routes/compare.tsx` — base...head diff
- `src/routes/settings.tsx` — profile + password + email notification preferences (`POST /settings/notifications`)
- `src/routes/repo-settings.tsx` — repo settings + delete
- `src/routes/webhooks.tsx` — webhook CRUD + test + `fireWebhooks`
- `src/routes/fork.ts` — fork
- `src/routes/explore.tsx` — discover
- `src/routes/tokens.tsx` — personal access tokens
- `src/routes/contributors.tsx` — contributor list
- `src/routes/notifications.tsx` — inbox + unread API
- `src/routes/dashboard.tsx` — authed home (`renderDashboard` exported)
- `src/routes/ask.tsx` — global + repo AI chat + explain
- `src/routes/releases.tsx` — tags + AI changelog
- `src/routes/gates.tsx` — history + settings + branch protection UI
- `src/routes/insights.tsx` — insights + milestones
- `src/routes/search.tsx` — global search + `/shortcuts`
- `src/routes/health.ts` — `/healthz` `/readyz` `/metrics`

### 4.7 Views (locked contracts)
- `src/views/layout.tsx` — `Layout` accepts `title`, `user`, `notificationCount`
- `src/views/components.tsx` — `RepoHeader`, `RepoNav` (active: `code|issues|pulls|commits|releases|gates|insights|...`), `RepoCard`, etc.
- `src/views/reactions.tsx` — `ReactionsBar` (no-JS compatible, form-per-emoji)
- Nav links: logo · search · theme-toggle · Explore · Ask · Notifications · New · Profile (or Sign in / Register)
- Keyboard chords: `/`, `Cmd+K`, `?`, `n`, `g d`, `g n`, `g e`, `g a`

### 4.8 Tests (locked)
- `src/__tests__/green-ecosystem.test.ts` — secret scanner, codeowners, AI fallback, health, rate-limit headers, `/shortcuts`, `/search`
- All other existing test files — do not delete without owner permission

### 4.9 Invariants (never break these)
- `isAiAvailable()` guard returns true fallback strings when no ANTHROPIC_API_KEY. AI features degrade gracefully.
- `getUnreadCount` never throws; returns 0 on any error.
- Rate-limit middleware adds `X-RateLimit-Limit` + `X-RateLimit-Remaining` to every response, including 500s.
- `c.header("X-Request-Id", ...)` set by request-context on every response.
- Secret scanner skips binary/lock paths (`shouldSkipPath`).
- `SECRET_PATTERNS` is an exported array. Its shape is `{ type, regex, severity }`.
- Theme routes live outside `/settings/*` (they must work for logged-out visitors). Cookie name: `theme`, values: `dark|light`.
- Draft PRs cannot be merged — `/pulls/:n/merge` returns a redirect with the draft error when `pr.isDraft=true`.
- Reactions API accepts only `ALLOWED_EMOJIS` and `ALLOWED_TARGETS`. Toggle is idempotent per (user, target, emoji).
- `sendEmail()` never throws — always resolves to `{ ok, provider, ... }`. Email failures never break notification delivery or the primary request path.
- Email fan-out in `notify()` is scoped to kinds in `EMAIL_ELIGIBLE` (mention / review_requested / assigned / gate_failed). Each eligible kind maps to exactly one user preference column.
- Issue + PR template loading must return `null` on any git-subprocess failure (templates are a convenience, not a requirement). Forms always render.

---

## 5. OPERATIONAL NOTES

### 5.1 Running locally
```bash
bun install
bun dev          # hot reload
bun test         # 99 tests currently pass
bun run db:migrate
```

### 5.2 Environment
- `DATABASE_URL` — Neon Postgres
- `ANTHROPIC_API_KEY` — unlocks AI features
- `GIT_REPOS_PATH` — default `./repos`
- `PORT` — default 3000
- `EMAIL_PROVIDER` — `log` (default, stderr-only) or `resend`
- `EMAIL_FROM` — sender address for outbound mail
- `RESEND_API_KEY` — required when `EMAIL_PROVIDER=resend`
- `APP_BASE_URL` — canonical URL used to build absolute links in emails

### 5.3 Models
- `claude-sonnet-4-20250514` — code review, security, chat
- `claude-haiku-4-5-20251001` — commit messages, summaries, light tasks
- Swap via `MODEL_SONNET` / `MODEL_HAIKU` constants in `src/lib/ai-client.ts`

### 5.4 Deployment
- `railway.toml` / `fly.toml` present
- Crontech deploy on green push to default branch (can opt out via `autoDeployEnabled`)

---

## 6. SESSION WORKFLOW (WHAT THE NEXT AGENT DOES)

1. Read this file, `CLAUDE.md`, `README.md`, `git log -1 --stat`.
2. Check `git status` + current branch.
3. Pick the next unfinished block from §3 (lowest letter + number first, unless owner specifies).
4. Create a todo list that mirrors the sub-items of that block.
5. Build. Write tests. Run `bun test`.
6. Commit with `feat(<BLOCK-ID>): ...`.
7. Push.
8. Update this file:
   - Move the block's row in §2 to ✅ where applicable.
   - Add the block's files to §4 LOCKED BLOCKS.
   - Commit + push again.
9. Start the next block. **Do not stop to ask.**

If a block is too large for a single session, split it into a sub-plan at the top of the session, ship what you can, and document what's left at the end of this file under a `## 7. IN-FLIGHT` section.

---

## 7. IN-FLIGHT

(Intentionally empty. Add here if a block is partially complete at session end.)
