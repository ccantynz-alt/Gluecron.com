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

### 1.7 Parallelism rule (added per owner request)
- **Default to spawning sub-agents whenever work can be parallelised.** Owner-cost of an idle main thread is high; owner-cost of an extra agent is near-zero.
- Independent files = parallel agents. Schema-only edits, new route files, doc updates, test additions, codebase research — all of these run in parallel by default unless they collide.
- Coordinate file ownership: one agent per file. Never let two agents edit the same file. Mounting + middleware integration stay on the main thread to avoid merge conflicts.
- When launching multiple agents, send them in a single message with multiple Agent tool calls so they actually run concurrently.
- The main thread is responsible for: reviewing each agent's output before integrating, running the test suite, and committing. Trust-but-verify — read the changes, don't just rely on the agent's summary.

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
| Semantic / embedding search | ✅ | D1 — `code_chunks` table + lexical fallback, optional Voyage `voyage-code-3`; `src/lib/semantic-search.ts`, `src/routes/semantic-search.tsx` |
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
| AI changelogs | ✅ | auto on release create; arbitrary-range viewer at `/:owner/:repo/ai/changelog?from=&to=` (D7) |
| AI code review | ✅ | `src/lib/ai-review.ts` |
| AI merge conflict resolver | ✅ | `src/lib/merge-resolver.ts` |
| AI chat (global + repo) | ✅ | `src/routes/ask.tsx` |
| AI explain-this-codebase | ✅ | D6 — per-commit cached markdown, `GET /:owner/:repo/explain`, `src/lib/ai-explain.ts` + `src/routes/ai-explain.tsx` |
| AI PR triage | ✅ | D3 — Claude Haiku suggests labels/reviewers/priority as an AI comment on PR create; `triagePullRequest` in `src/lib/ai-generators.ts`, wired in `src/routes/pulls.tsx` |
| GitHub Actions equivalent (workflow runner) | ✅ | `src/lib/workflow-parser.ts`, `src/lib/workflow-runner.ts`, `src/routes/workflows.tsx`; `.gluecron/workflows/*.yml` auto-discovered on push; Bun subprocess executor, per-step timeouts, size-capped logs |
| Dependabot equivalent (AI dep bumper) | ✅ | D2 — `dep_update_runs` table, npm registry fetch, plan + apply bumps, creates `gluecron/dep-update-*` branch + PR row via git plumbing. `src/lib/dep-updater.ts`, `src/routes/dep-updater.tsx`, settings UI at `/:owner/:repo/settings/dep-updater`. |
| Code scanning UI | 🟡 | data exists, no dedicated UI page |
| Copilot code completion | ✅ | D9 — `POST /api/copilot/completions` (PAT/OAuth/session), `GET /api/copilot/ping`. `src/lib/ai-completion.ts`, `src/routes/copilot.ts`. LRU-cached, rate-limited 60/min. |
| Semantic code search | ✅ | D1 — see 2.2 |

### 2.5 Platform
| Feature | Status | Notes |
|---|---|---|
| Dashboard | ✅ | `src/routes/dashboard.tsx` |
| Explore / discover | ✅ | |
| Global search | ✅ | repos / users / issues / PRs |
| Insights (graph, contributors, green rate) | ✅ | `src/routes/insights.tsx` |
| Releases + tags | ✅ | AI changelog |
| Personal access tokens | ✅ | SHA-256 hashed |
| OAuth app provider | ✅ | `src/routes/oauth.tsx`, `src/routes/developer-apps.tsx`, `src/lib/oauth.ts`; `oauth_apps` + `oauth_authorizations` + `oauth_access_tokens` tables |
| GitHub Apps equivalent | ❌ | |
| GraphQL API | ❌ | REST only |
| Organizations + teams | ✅ | B1+B2+B3 shipped: `src/routes/orgs.tsx`, `src/lib/orgs.ts`; org-owned repos (`repositories.orgId`); team-based CODEOWNERS (`@org/team` resolution) |
| Enterprise SAML / SSO | ❌ | |
| 2FA / TOTP | ✅ | `src/routes/settings-2fa.tsx`, `src/lib/totp.ts`; `user_totp` + `user_recovery_codes` tables |
| Passkeys / WebAuthn | ✅ | `src/routes/passkeys.tsx`, `src/lib/webauthn.ts`; `user_passkeys` + `webauthn_challenges` tables |
| Packages registry (npm / docker / etc) | ✅ | `src/lib/packages.ts`, `src/routes/packages-api.ts`, `src/routes/packages.tsx`; npm protocol (packument, tarball, publish, yank); PAT (`glc_`) auth via Authorization header; container registry deferred |
| Pages / static hosting | ✅ | `src/lib/pages.ts`, `src/routes/pages.tsx`; serves blobs from bare git at latest `gh-pages` commit; per-repo settings (source branch/dir, custom domain); short-cache headers |
| Gists | ❌ | |
| Sponsors | ❌ | |
| Marketplace | ❌ | |
| Environments / deployment tracking | ✅ | `src/routes/deployments.tsx` — grouped by env, success-rate rollup, per-deploy detail. Protected environments (`src/routes/environments.tsx`, `src/lib/environments.ts`) with reviewer-gated approval, branch-glob restrictions, approve/reject decisions recorded in `deployment_approvals` |
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
- **B1** — Organizations (schema: `organizations`, `org_members`, `teams`, `team_members`) → ✅ shipped (`6563f0a`)
  - Helpers in `src/lib/orgs.ts`: slug validation, role rank, reserved-slug set, loaders
  - Routes in `src/routes/orgs.tsx`: list / create / profile / people / teams / team detail
  - Role-based guards: admin adds members, owner grants owner, last-owner demote/remove blocked
  - All sensitive actions `audit()`'d (org.create, member.add/role/remove, team.create, team.member.add/remove)
- **B2** — Repos owned by orgs (nullable `repositories.orgId`) → ✅ shipped (`7437605`)
- **B3** — Team-based CODEOWNERS (`@org/team` resolution) → ✅ shipped (`40d3e3f`)
- **B4** — 2FA / TOTP (enroll, recovery codes) → ✅ shipped (`7298a17`)
- **B5** — WebAuthn / passkeys → ✅ shipped (`2df1f8c`)
- **B6** — OAuth 2.0 provider (third-party apps can request access) → ✅ shipped (pending final commit)

### BLOCK C — Runtime + hosting
- **C1** — Actions-equivalent workflow runner → ✅ shipped (`eafe8c6`)
  - Workflow YAML parser (`src/lib/workflow-parser.ts`) — hand-rolled subset
  - Background worker (`src/lib/workflow-runner.ts`) — Bun.spawn, size-capped logs, SIGTERM→SIGKILL timeouts
  - Auto-discovery from `.gluecron/workflows/*.yml` on default-branch push
  - UI at `/:owner/:repo/actions` with manual trigger + cancel
- **C2** — Package registry (npm protocol) → ✅ shipped
  - Packument + tarball + publish + yank via `PUT /npm/<name>` + `GET /npm/<name>`
  - PAT (`glc_`) bearer auth for CLI clients; add `//host/npm/:_authToken=<PAT>` to .npmrc
  - Container registry deferred (schema ready for it)
- **C3** — Pages / static hosting → ✅ shipped
  - Serves `/:owner/:repo/pages/*` from the latest successful `pages_deployments` row
  - Auto-records on push to the repo's configured source branch (default `gh-pages`)
  - Settings UI at `/:owner/:repo/settings/pages` + manual redeploy
- **C4** — Environments with protected approvals → ✅ shipped
  - Per-repo `environments` with reviewer list + branch-glob allowlist
  - Auto-deploy on main is gated by `requiresApprovalFor()`; pending rows show status `pending_approval`
  - Approve/reject at `POST /:owner/:repo/deployments/:id/approve|reject`

### BLOCK D — AI-native differentiation
This is where GlueCron beats GitHub outright. **Priority: ship these loud.**
- **D1** — Semantic code search → ✅ shipped. `src/lib/semantic-search.ts` + `src/routes/semantic-search.tsx`. `code_chunks` table stores chunk embeddings as JSON (upgrade path to `pgvector`). Embedding provider: Voyage AI `voyage-code-3` when `VOYAGE_API_KEY` is set, otherwise deterministic 512-dim hashing fallback. Index via `POST /:owner/:repo/search/semantic/reindex` (owner-only).
- **D2** — AI dependency updater → ✅ shipped. `src/lib/dep-updater.ts` + `src/routes/dep-updater.tsx`. `dep_update_runs` table tracks run history. Parses `package.json`, queries `registry.npmjs.org`, plans bumps (skips workspace/github specs + downgrades), writes an `gluecron/dep-update-<ts>` branch via git plumbing (`hash-object` + `mktree` + `commit-tree` + `update-ref`), inserts a pull_requests row with a markdown bump table. Settings UI at `/:owner/:repo/settings/dep-updater` with "Run now".
- **D3** — AI PR triage → ✅ shipped. `triagePullRequest` in `src/lib/ai-generators.ts`; hooked into PR create in `src/routes/pulls.tsx` (fire-and-forget). Posts a non-applied "## AI Triage" comment with suggested labels, reviewers, priority, and risk area. Suggestions only — PR author stays in control.
- **D4** — AI incident responder (on deploy failure, opens issue with root cause) — NOT STARTED
- **D5** — AI code reviewer that blocks merges (enforced via branch protection "AI approval required") — PARTIAL (AI review exists; no branch-protection hook yet)
- **D6** — AI "explain this codebase" → ✅ shipped. `src/lib/ai-explain.ts` + `src/routes/ai-explain.tsx`. Samples up to ~25 representative files (~60KB cap), generates a Markdown explanation via Sonnet 4, caches per (repo, commit sha) in `codebase_explanations`. `GET /:owner/:repo/explain` + owner-only `POST /:owner/:repo/explain/regenerate`. Explain link added to `RepoNav`.
- **D7** — AI changelog for every commit range → ✅ shipped. `src/routes/ai-changelog.tsx`. `GET /:owner/:repo/ai/changelog?from=&to=(&format=markdown)` — runs `git log` on the range, calls existing `generateChangelog`, renders form + rendered Markdown + copy-box; `format=markdown` returns `text/markdown` for CLI/CI consumers. Caps at 500 commits.
- **D8** — AI-generated test suite (reads public API, generates failing tests) — NOT STARTED
- **D9** — Copilot-style completion endpoint → ✅ shipped. `src/lib/ai-completion.ts` + `src/routes/copilot.ts`. `POST /api/copilot/completions` (requireAuth accepts PAT/OAuth/session), `GET /api/copilot/ping`. Claude Haiku; in-memory LRU (size 200, 5-min TTL); code-fence stripping; 60/min rate limit per caller.

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
- `drizzle/0004_org_owned_repos.sql` (Block B2) — migration, never edited in place
- `drizzle/0005_totp_2fa.sql` (Block B4) — migration, never edited in place
- `drizzle/0006_webauthn_passkeys.sql` (Block B5) — migration, never edited in place
- `drizzle/0007_oauth_provider.sql` (Block B6) — migration, never edited in place
- `drizzle/0008_workflows.sql` (Block C1) — migration, never edited in place
- `drizzle/0009_packages.sql` (Block C2) — migration, never edited in place
- `drizzle/0010_pages.sql` (Block C3) — migration, never edited in place
- `drizzle/0011_environments.sql` (Block C4) — migration, never edited in place
- `drizzle/0012_ai_native.sql` (Block D) — migration, never edited in place. Adds `codebase_explanations`, `dep_update_runs`, `code_chunks`.

### 4.2 Git layer (locked)
- `src/git/repository.ts` — tree / blob / commits / diff / branches / blame / search / raw / tags / commitsBetween
- `src/git/protocol.ts` — Smart HTTP pkt-line
- `src/hooks/post-receive.ts` — CODEOWNERS sync, gates, auto-deploy, webhook fan-out

### 4.3 Auth + security (locked)
- `src/lib/auth.ts` — bcrypt, session tokens
- `src/middleware/auth.ts` — softAuth + requireAuth. Accepts three auth inputs: session cookie (web), OAuth access token (`glct_` prefix, Block B6), and personal access token (`glc_` prefix, Block C2). Invalid bearer → 401 JSON. Cookie flow → /login redirect.
- `src/middleware/rate-limit.ts` — fixed-window limiter
- `src/middleware/request-context.ts` — request-ID
- `src/lib/security-scan.ts` — `SECRET_PATTERNS` (exported) + `scanForSecrets` + `aiSecurityScan`
- `src/lib/codeowners.ts` — parser + `ownersForPath` (last-match-wins); team expansion helpers for `@org/team` (Block B3)
- `src/lib/totp.ts` (Block B4) — TOTP enroll / verify / recovery codes
- `src/lib/webauthn.ts` (Block B5) — WebAuthn registration + assertion helpers
- `src/lib/oauth.ts` (Block B6) — OAuth 2.0 provider: authorization code grant, token issuance, scope enforcement
- `src/lib/workflow-parser.ts` (Block C1) — YAML subset parser for `.gluecron/workflows/*.yml`. Exports `parseWorkflow(src)` returning `{ ok, workflow | error }`. Never throws.
- `src/lib/workflow-runner.ts` (Block C1) — shell executor. Exports `executeRun`, `drainOneRun`, `enqueueRun`, `startWorker`. Clones repo to tmpdir, runs each job via `Bun.spawn(["bash","-c",step.run])` with SIGTERM→SIGKILL timeouts, size-capped stdout/stderr, cleans up in `finally`.
- `src/lib/packages.ts` (Block C2) — npm protocol helpers: `parsePackageName`, `computeShasum` (sha1), `computeIntegrity` (sha512 base64), `buildPackument`, `resolveRepoFromPackageJson`, `parseRepoUrl`, `tarballFilename`. Pure functions.
- `src/lib/pages.ts` (Block C3) — `onPagesPush` (never throws), `resolvePagesPath` (probe list including pretty URLs + traversal strip), `contentTypeFor` (MIME).
- `src/lib/environments.ts` (Block C4) — `matchGlob`, `listEnvironments`, `getOrCreateEnvironment`, `getEnvironmentByName`, `isReviewer`, `reviewerIdsOf`, `allowedBranchesOf`, `computeApprovalState`, `reduceApprovalState`, `recordApproval`, `requiresApprovalFor`. Empty reviewers list → repo owner approves. Any rejection hard-stops.

### 4.4 AI layer (locked)
- `src/lib/ai-client.ts` — Anthropic client + model constants
- `src/lib/ai-generators.ts` — commit / PR / changelog / issue-triage / **pull-request-triage (D3)**
- `src/lib/ai-chat.ts` — conversational chat
- `src/lib/ai-review.ts` — PR code review
- `src/lib/auto-repair.ts` — worktree-backed repair commits
- `src/lib/merge-resolver.ts` — AI merge conflict resolution
- `src/lib/ai-explain.ts` (Block D6) — `explainCodebase(...)` + `getCachedExplanation(...)`. Samples up to ~25 representative files (~60KB cap), Sonnet 4, upserts into `codebase_explanations`. Fallback to README-ish synthesis when no key. Never throws.
- `src/lib/ai-completion.ts` (Block D9) — `completeCode({prefix, suffix?, language?, maxTokens?, repoHint?})` via Haiku. Inline LRU (size 200, 5-min TTL) keyed on sha256 of prefix+suffix+language. Code-fence stripping. Never throws. `__test` bundle exposed.
- `src/lib/dep-updater.ts` (Block D2) — `parseManifest`, `queryNpmLatest`, `planUpdates` (injectable `fetchLatest`), `applyBumps`, `runDepUpdateRun`. Creates `gluecron/dep-update-<ts>` branch via git plumbing + opens a PR row. Never throws.
- `src/lib/semantic-search.ts` (Block D1) — `tokenize`, `hashEmbed` (512-dim L2-normalised FNV-1a + sign trick), `embedBatch` (Voyage `voyage-code-3` when `VOYAGE_API_KEY` set, else fallback), `chunkFile`, `isCodeFile`, `indexRepository`, `searchRepository`, `cosine`, `isEmbeddingsProviderAvailable`, `__test` bundle.

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
- `src/routes/orgs.tsx` — `/orgs` list, `/orgs/new` create, `/orgs/:slug` profile, `/orgs/:slug/people` + add/role/remove, `/orgs/:slug/teams` + create, `/orgs/:slug/teams/:teamSlug` + member add/remove. All require auth. Role guards via `orgRoleAtLeast`; last-owner cannot be demoted or removed; every write path `audit()`'d.
- `src/lib/orgs.ts` (Block B1) — `isValidSlug` (rejects reserved + too-short/long + consecutive/leading/trailing hyphens), `normalizeSlug`, `orgRoleAtLeast` (owner>admin>member), `isValidOrgRole`, `isValidTeamRole`, `loadOrgForUser`, `listOrgsForUser`, `listOrgMembers`, `listTeamsForOrg`, `listTeamMembers`, `__test` export for unit tests.
- `src/routes/settings-2fa.tsx` (Block B4) — TOTP enroll / verify / disable + recovery codes UI. All require auth.
- `src/routes/passkeys.tsx` (Block B5) — WebAuthn passkey registration / assertion / management. All require auth.
- `src/routes/oauth.tsx` (Block B6) — OAuth 2.0 authorize + token + userinfo endpoints.
- `src/routes/developer-apps.tsx` (Block B6) — developer-facing OAuth app CRUD (`/settings/developer/apps`), client secret rotation, audit-logged.
- `src/routes/workflows.tsx` (Block C1) — Actions UI. `GET /:owner/:repo/actions`, `GET /:owner/:repo/actions/runs/:runId`, `POST /:owner/:repo/actions/:workflowId/run` (auth+owner), `POST /:owner/:repo/actions/runs/:runId/cancel` (auth+owner). Manual runs are `event=manual`, ref=default branch.
- `src/routes/packages-api.ts` (Block C2) — npm protocol: `GET/PUT/DELETE /npm/*` (packument, tarball, publish, yank); JSON helpers at `/api/packages/:owner/:repo/...`. PAT (`glc_`) bearer auth.
- `src/routes/packages.tsx` (Block C2) — UI: `/:owner/:repo/packages` list + `/:owner/:repo/packages/:pkgName` detail.
- `src/routes/pages.tsx` (Block C3) — `GET /:owner/:repo/pages/*` serves static files from latest gh-pages commit (binary via `getRawBlob`, text via `getBlob`). `GET/POST /:owner/:repo/settings/pages` settings + redeploy.
- `src/routes/environments.tsx` (Block C4) — settings CRUD at `/:owner/:repo/settings/environments`; approval endpoints at `/:owner/:repo/deployments/:id/{approve,reject}`.
- `src/routes/ai-explain.tsx` (Block D6) — `GET /:owner/:repo/explain` (softAuth), `POST /:owner/:repo/explain/regenerate` (requireAuth, owner-only).
- `src/routes/ai-changelog.tsx` (Block D7) — `GET /:owner/:repo/ai/changelog` (softAuth). Form + rendered output; `?format=markdown` returns `text/markdown`.
- `src/routes/copilot.ts` (Block D9) — `POST /api/copilot/completions` (requireAuth, 60/min rate limit), `GET /api/copilot/ping` (public).
- `src/routes/dep-updater.tsx` (Block D2) — `GET /:owner/:repo/settings/dep-updater` + `POST /:owner/:repo/settings/dep-updater/run` (requireAuth, owner-only).
- `src/routes/semantic-search.tsx` (Block D1) — `GET /:owner/:repo/search/semantic?q=` (softAuth) + `POST /:owner/:repo/search/semantic/reindex` (requireAuth, owner-only).

### 4.7 Views (locked contracts)
- `src/views/layout.tsx` — `Layout` accepts `title`, `user`, `notificationCount`
- `src/views/components.tsx` — `RepoHeader`, `RepoNav` (active: `code|issues|pulls|commits|releases|actions|gates|insights|explain|changelog|semantic`), `RepoCard`, etc.
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
- `VOYAGE_API_KEY` — optional; when set, D1 semantic search uses Voyage `voyage-code-3` embeddings. Otherwise falls back to a deterministic 512-dim hashing embedder.

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
