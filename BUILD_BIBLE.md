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
| Archive / disable repo | ✅ | I1 — `src/routes/repo-settings.tsx` archive toggle; `RepoHeader` renders an "Archived" badge when `is_archived=true`. |
| Repository transfer | ✅ | I3 — `src/routes/repo-settings.tsx` transfer form + `POST /:owner/:repo/settings/transfer`; ownership change recorded in `repo_transfers` audit table. Reject conflicts (target owner already has a repo by that name) with a redirect. |
| Template repositories | ✅ | I2 — `drizzle/0022_repo_templates.sql` adds `is_template`. `src/routes/templates.ts` serves `POST /:owner/:repo/use-template` (git clone --bare into caller's namespace). "Use this template" CTA rendered on the public repo page. |
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
| Discussions / forums | ✅ | E2 — categorised threads, pinned/locked, q-and-a answers. `src/routes/discussions.tsx` + `drizzle/0013_discussions.sql` |
| Wikis | ✅ | E3 — markdown pages per repo with revision history + revert. DB-backed v1. `src/routes/wikis.tsx` + `drizzle/0016_wikis.sql` |
| Projects / kanban | ✅ | E1 — per-repo boards with auto-seeded To Do/In Progress/Done columns. Notes or linked issues/PRs. `src/routes/projects.tsx` + `drizzle/0015_projects.sql` |
| AI incident responder | ✅ | D4 — auto-issues on deploy fail, `src/lib/ai-incident.ts` |
| AI-generated test stubs | ✅ | D8 — `src/lib/ai-tests.ts`, `/:owner/:repo/ai/tests` |

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
| Code scanning UI | ✅ | I5 — `src/routes/code-scanning.tsx`, `GET /:owner/:repo/security`. Aggregates last-100 `gate_runs` matching `%scan%`/`%security%`, rolls up latest status per gate, shows failed/repaired/total cards + scanner status list + recent runs. |
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
| GitHub Apps equivalent | ✅ | H2 — `src/lib/marketplace.ts` `generateBearerToken`/`verifyInstallToken` (1h TTL, `ghi_` prefix, sha256 hashed). Each app gets a `<slug>[bot]` identity (`app_bots`). Permissions enforced via `hasPermission` (write implies read). |
| GraphQL API | ✅ | G2 — see 2.6 |
| Organizations + teams | ✅ | B1+B2+B3 shipped: `src/routes/orgs.tsx`, `src/lib/orgs.ts`; org-owned repos (`repositories.orgId`); team-based CODEOWNERS (`@org/team` resolution) |
| Enterprise SAML / SSO | ❌ | |
| 2FA / TOTP | ✅ | `src/routes/settings-2fa.tsx`, `src/lib/totp.ts`; `user_totp` + `user_recovery_codes` tables |
| Passkeys / WebAuthn | ✅ | `src/routes/passkeys.tsx`, `src/lib/webauthn.ts`; `user_passkeys` + `webauthn_challenges` tables |
| Packages registry (npm / docker / etc) | ✅ | `src/lib/packages.ts`, `src/routes/packages-api.ts`, `src/routes/packages.tsx`; npm protocol (packument, tarball, publish, yank); PAT (`glc_`) auth via Authorization header; container registry deferred |
| Pages / static hosting | ✅ | `src/lib/pages.ts`, `src/routes/pages.tsx`; serves blobs from bare git at latest `gh-pages` commit; per-repo settings (source branch/dir, custom domain); short-cache headers |
| Gists | ✅ | E4 — multi-file tiny repos with per-revision JSON snapshots + stars. `src/routes/gists.tsx` + `drizzle/0014_gists.sql` |
| Sponsors | ✅ | I6 — `src/routes/sponsors.tsx`, `drizzle/0023_sponsors.sql` (tables `sponsorship_tiers`, `sponsorships`). Public `/sponsors/:user` page with tier cards + recent public sponsors; maintainer view at `/settings/sponsors` with add/retire tiers. Payment rails deferred — captures intent + thank-you notes. |
| Marketplace | ✅ | H1 — `src/routes/marketplace.tsx` + `src/lib/marketplace.ts`, `drizzle/0021_marketplace_and_apps.sql` (5 tables: `apps`, `app_installations`, `app_bots`, `app_install_tokens`, `app_events`). Public `/marketplace` directory, `/marketplace/:slug` detail + install, `/settings/apps` personal installs, `/developer/apps-new` registration, `/developer/apps/:slug/manage` event log + token issuance. |
| Environments / deployment tracking | ✅ | `src/routes/deployments.tsx` — grouped by env, success-rate rollup, per-deploy detail. Protected environments (`src/routes/environments.tsx`, `src/lib/environments.ts`) with reviewer-gated approval, branch-glob restrictions, approve/reject decisions recorded in `deployment_approvals` |
| Merge queues | ✅ | E5 — serialised merge with re-test. `src/lib/merge-queue.ts`, `src/routes/merge-queue.tsx`, `drizzle/0017_merge_queue.sql`; per `(repo, base_branch)` queue, owner-only process-next re-runs gates against latest base before merging. |
| Required checks matrix | ✅ | E6 — per branch-protection named check list. `src/routes/required-checks.tsx`, `drizzle/0018_required_checks.sql`; `listRequiredChecks` + `passingCheckNames` helpers in `src/lib/branch-protection.ts`; merge handler verifies every required name has a passing gate_run or workflow_run. |
| Protected tags | ✅ | E7 — owners can mark tag patterns (`v*`, `release-*`) protected. `src/lib/protected-tags.ts`, `src/routes/protected-tags.tsx`, `drizzle/0019_protected_tags.sql`; advisory enforcement via post-receive audit log (v1). |

### 2.6 Observability + safety
| Feature | Status | Notes |
|---|---|---|
| Rate limiting | ✅ | `src/middleware/rate-limit.ts` |
| Request-ID tracing | ✅ | `src/middleware/request-context.ts` |
| Health / readiness / metrics | ✅ | `/healthz` `/readyz` `/metrics` |
| Audit log (table) | ✅ | `audit_log` table |
| Audit log UI | ✅ | `/settings/audit` (personal) + `/:owner/:repo/settings/audit` (per-repo, owner-only) |
| Traffic analytics per repo | ✅ | F1 — `src/lib/traffic.ts` + `src/routes/traffic.tsx`, `drizzle/0020_analytics_and_admin.sql`; owner-only 7/14/30/90d windows, ascii-bar daily chart. SHA-256-truncated IP for unique visitors. Fire-and-forget wiring in `web.tsx` + `git.ts`. |
| Org insights dashboard | ✅ | F2 — `src/routes/org-insights.tsx`; `computeOrgInsights(orgId)` rollup of gate green-rate + PR/issue counts + per-repo breakdown. `GET /orgs/:slug/insights`. |
| Site admin panel | ✅ | F3 — `src/lib/admin.ts` + `src/routes/admin.tsx`, tables `site_admins` + `system_flags`. Bootstrap rule (oldest user wins until `site_admins` populated). Flags: registration_locked, site_banner_*, read_only_mode. |
| Billing + quotas | ✅ | F4 — `src/lib/billing.ts` + `src/routes/billing.tsx`, tables `billing_plans` + `user_quotas` seeded free/pro/team/enterprise. `/settings/billing` personal view + `/admin/billing` site-admin override. |
| Email notifications | ✅ | opt-in per kind (mention/assign/gate-fail) via `/settings`; provider-pluggable `src/lib/email.ts` (log default, resend in prod) |
| Email digest | ✅ | I7 — `src/lib/email-digest.ts` + `drizzle/0024_email_digest.sql` (`users.notify_email_digest_weekly` + `last_digest_sent_at`). `composeDigest` pulls notifications + failed/repaired gates + merged PRs over last 7d, renders text + escaped HTML. `/settings/digest/preview` for self-preview; `/admin/digests` dashboard + `POST /admin/digests/run` fires `sendDigestsToAll`; `POST /admin/digests/preview` sends to one user. Never throws. |
| Mobile PWA | ✅ | G1 — `src/routes/pwa.ts` serves `/manifest.webmanifest` + `/sw.js` + `/icon.svg`; Layout injects manifest link + SW registration. Offline-capable (network-first for HTML). |
| GraphQL API | ✅ | G2 — `src/lib/graphql.ts` parser + executor, `src/routes/graphql.ts` endpoint at `POST /api/graphql`, GraphiQL-lite explorer at `GET /api/graphql`. Queries only (viewer/user/repository/search/rateLimit). |
| Official CLI | ✅ | G3 — `cli/gluecron.ts` Bun-compilable single binary. REST + GraphQL client, `~/.gluecron/config.json` 0600. |
| VS Code extension | ✅ | G4 — `vscode-extension/` with commands for explain / open-on-web / semantic search / generate tests. |
| Native mobile apps | ❌ | |
| Dark mode | ✅ | default |
| Light-mode toggle | ✅ | `/theme/toggle` + `theme` cookie, pre-paint script avoids FOUC, nav sun/moon icon |
| Keyboard shortcuts | ✅ | `/shortcuts` page |
| Command palette | ✅ | I4 — `src/views/layout.tsx` injects a Cmd+K palette with ~20 canonical destinations, arrow-key navigation + fuzzy match. Backdrop click or Esc closes. |

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
- **D4** — AI incident responder → ✅ shipped. `src/lib/ai-incident.ts` exports `onDeployFailure(args)` — on deploy-fail hooks, samples ~10 recent commits, calls Sonnet 4 for a structured root-cause JSON, opens an issue (number via `serial`), best-effort attaches `incident` label, sets `deployments.blockedReason="auto-issue #N"`. Wired from `src/hooks/post-receive.ts triggerCrontechDeploy` (fire-and-forget) and from `POST /:owner/:repo/deployments/:id/retry-incident` (owner-only re-run button on the deployment detail page). Never throws; degrades to deterministic body when no `ANTHROPIC_API_KEY`.
- **D5** — AI code reviewer blocks merges → ✅ shipped. `src/lib/branch-protection.ts` exports `matchProtection(repoId, branch)` (exact > glob, reuses `matchGlob` from environments.ts), `evaluateProtection(rule, ctx)` pure decision helper (checks `requireAiApproval` / `requireGreenGates` / `requireHumanReview` / `requiredApprovals`), and `countHumanApprovals(prId)` (LGTM/`+1`/approved heuristic on non-AI PR comments). Wired into `src/routes/pulls.tsx` merge handler after the existing hard-gate filter — blocks merge with readable reasons when rule fails. 8 unit tests in `src/__tests__/branch-protection.test.ts`.
- **D6** — AI "explain this codebase" → ✅ shipped. `src/lib/ai-explain.ts` + `src/routes/ai-explain.tsx`. Samples up to ~25 representative files (~60KB cap), generates a Markdown explanation via Sonnet 4, caches per (repo, commit sha) in `codebase_explanations`. `GET /:owner/:repo/explain` + owner-only `POST /:owner/:repo/explain/regenerate`. Explain link added to `RepoNav`.
- **D7** — AI changelog for every commit range → ✅ shipped. `src/routes/ai-changelog.tsx`. `GET /:owner/:repo/ai/changelog?from=&to=(&format=markdown)` — runs `git log` on the range, calls existing `generateChangelog`, renders form + rendered Markdown + copy-box; `format=markdown` returns `text/markdown` for CLI/CI consumers. Caps at 500 commits.
- **D8** — AI-generated test suite → ✅ shipped. `src/lib/ai-tests.ts` exports `detectLanguage(path)`, `detectTestFramework(repo tree)`, `buildTestsPrompt(...)`, `suggestedTestPath(...)`, `generateTestStub({path, content, framework, language})` (returns `{code:"", framework:"fallback"}` when AI unavailable), `contentTypeFor(path)`. Route `src/routes/ai-tests.tsx` adds `GET /:owner/:repo/ai/tests` (form + file picker), `GET /:owner/:repo/ai/tests?format=raw` (raw text with correct MIME), `POST /:owner/:repo/ai/tests/generate` (requireAuth, renders highlighted source + generated failing test, copy button). Stubs are intentionally failing so the author fills them in.
- **D9** — Copilot-style completion endpoint → ✅ shipped. `src/lib/ai-completion.ts` + `src/routes/copilot.ts`. `POST /api/copilot/completions` (requireAuth accepts PAT/OAuth/session), `GET /api/copilot/ping`. Claude Haiku; in-memory LRU (size 200, 5-min TTL); code-fence stripping; 60/min rate limit per caller.

### BLOCK E — Collaboration parity
- **E1** — Projects / kanban boards → ✅ shipped. `src/routes/projects.tsx`, tables `projects`/`project_columns`/`project_items` (migration 0015). Create creates three default columns (To Do/In Progress/Done); cards carry note or issue/pr link; one-click move between columns; owner-only close.
- **E2** — Discussions (forum threads per repo) → ✅ shipped. `src/routes/discussions.tsx`, tables `discussions`/`discussion_comments` (migration 0013). Categorised (general/q-and-a/ideas/announcements/show-and-tell), pinnable, lockable, q-and-a answers.
- **E3** — Wikis → ✅ shipped as DB-backed v1. `src/routes/wikis.tsx`, tables `wiki_pages`/`wiki_revisions` (migration 0016). Slug auto-derived; every edit bumps revision + appends a revision row; owner can revert. Git-backed mirror deferred.
- **E4** — Gists → ✅ shipped. `src/routes/gists.tsx`, tables `gists`/`gist_files`/`gist_revisions`/`gist_stars` (migration 0014). Multi-file; each edit takes a JSON snapshot into `gist_revisions` keyed on revision number; stars toggle; secret gists hidden from non-owners.
- **E5** — Merge queues → ✅ shipped. `src/lib/merge-queue.ts`, `src/routes/merge-queue.tsx`, table `merge_queue_entries` (migration 0017). Per `(repo, base_branch)` FIFO queue; `POST /:owner/:repo/pulls/:n/enqueue` adds from the PR page; owner-only `POST /queue/process-next` re-runs gates against latest base before merging the head. Entries have queued | running | merged | failed | dequeued states.
- **E6** — Required status checks matrix → ✅ shipped. `src/routes/required-checks.tsx`, table `branch_required_checks` (migration 0018); helpers `listRequiredChecks` + `passingCheckNames` in `src/lib/branch-protection.ts`. Settings UI at `/:owner/:repo/gates/protection/:id/checks`; merge handler (`src/routes/pulls.tsx`) loads required names + computes passing set from `gate_runs` (passed/repaired) + `workflow_runs` (success) and blocks if any required name is missing.
- **E7** — Protected tags → ✅ shipped. `src/lib/protected-tags.ts`, `src/routes/protected-tags.tsx`, table `protected_tags` (migration 0019). Settings CRUD at `/:owner/:repo/settings/protected-tags`; patterns use same glob syntax as branch protection. v1 enforcement is advisory: post-receive logs audit entries (`protected_tags.{create|update|delete}_violation_candidate`) so owners can see violations; pre-receive blocking is future work.

### BLOCK F — Observability + admin
- **F1** — Traffic analytics per repo → ✅ shipped. `src/lib/traffic.ts` + `src/routes/traffic.tsx`, table `repo_traffic_events` (migration 0020). `track`/`trackView`/`trackClone`/`trackByName` are fire-and-forget; SHA-256 of IP truncated to 16 chars for unique-visitor approximation. Owner-only `GET /:owner/:repo/traffic` renders 7/14/30/90 day windows with an ascii-bar daily chart. Wired into `src/routes/web.tsx` repo overview + `src/routes/git.ts` git-upload-pack handler.
- **F2** — Org-wide insights → ✅ shipped. `src/routes/org-insights.tsx` exports `computeOrgInsights(orgId)`. `GET /orgs/:slug/insights` requires org membership; aggregates gate green-rate, open/merged PR counts, open issue count, and per-repo rows sorted by activity. No new tables — live rollup across existing `repositories`, `gate_runs`, `pull_requests`, `issues`.
- **F3** — Admin / superuser panel → ✅ shipped. `src/lib/admin.ts` + `src/routes/admin.tsx`, tables `site_admins` + `system_flags` (migration 0020). `isSiteAdmin(userId)` with bootstrap rule (empty `site_admins` table → oldest user wins); `KNOWN_FLAGS` = { registration_locked, site_banner_text, site_banner_level, read_only_mode }. Routes: `GET /admin` (dashboard), `GET /admin/users` + toggle grant/revoke, `GET /admin/repos` + nuclear delete, `GET /admin/flags` + save. All mutations audit-logged.
- **F4** — Billing + quotas → ✅ shipped. `src/lib/billing.ts` + `src/routes/billing.tsx`, tables `billing_plans` + `user_quotas` (migration 0020, seeded with free/pro/team/enterprise). `FALLBACK_PLANS` mirror the seeds so billing works pre-migration. Helpers: `getUserQuota` (auto-initialises free row on first read), `bumpUsage`, `checkQuota` (fail-open), `wouldExceedRepoLimit`, `resetIfCycleExpired`. Routes: `GET /settings/billing` (personal view with usage bars + plan cards), `GET /admin/billing` (site-admin plan override), `POST /admin/billing/:userId/plan`.

### BLOCK G — Mobile + client
- **G1** — PWA manifest + service worker → ✅ shipped. `src/routes/pwa.ts` serves `/manifest.webmanifest`, `/sw.js`, `/icon.svg`; `Layout` injects `<link rel="manifest">` + a tiny SW registration script. Service worker is network-first for HTML + skips `.git/`/`/api/`/`/login*` routes.
- **G2** — GraphQL API mirror of REST → ✅ shipped. `src/lib/graphql.ts` is a dependency-free recursive-descent parser + executor over a fixed schema (viewer, user, repository, search, rateLimit). `src/routes/graphql.ts` serves `POST /api/graphql` + a GraphiQL-lite explorer at `GET /api/graphql`. Queries only; writes stay on REST.
- **G3** — Official CLI (`gluecron`) → ✅ shipped. `cli/gluecron.ts` is a Bun-compilable single-file CLI. Commands: `login`, `whoami`, `repo ls/show/create`, `issues ls`, `gql`, `host`, `version`. Config in `~/.gluecron/config.json` (0600). Talks to the server via REST + GraphQL.
- **G4** — VS Code extension → ✅ shipped. `vscode-extension/` contains package.json + `src/extension.ts`. Commands: `gluecron.explainFile`, `gluecron.openOnWeb`, `gluecron.searchSemantic`, `gluecron.generateTests`. Detects Gluecron remotes via `git config remote.origin.url`. Settings: `gluecron.host` + `gluecron.token`.

### BLOCK I — Filling parity gaps
- **I1** — Archive / unarchive repository → ✅ shipped. `src/routes/repo-settings.tsx` archive/unarchive toggle (existing `repositories.is_archived` column). `RepoHeader` surfaces an "Archived" badge.
- **I2** — Template repositories → ✅ shipped. `drizzle/0022_repo_templates.sql` adds `is_template` column + partial index. `src/routes/templates.ts` serves `POST /:owner/:repo/use-template` (git clone --bare into caller's namespace, fresh `activity_feed` entry). Settings UI gains a "Mark as template" toggle. Public repo page renders a prominent "Use this template" CTA for non-owners.
- **I3** — Repository transfer → ✅ shipped. `drizzle/0022_repo_templates.sql` adds `repo_transfers` audit table. `src/routes/repo-settings.tsx` `POST /:owner/:repo/settings/transfer` (validate target user exists, reject name conflicts, update `owner_id`, log to `repo_transfers`).
- **I4** — Generic command palette → ✅ shipped. `src/views/layout.tsx` injects a Cmd+K palette with ~20 canonical destinations (Dashboard, Explore, Notifications, Ask AI, Create repo, Marketplace, Installed apps, Register app, Shortcuts, Settings, 2FA, Passkeys, PATs, Billing, Audit, Gists, GraphQL, Admin, Theme). Fuzzy-match, arrow-key navigation, Esc/backdrop to close.
- **I5** — Code scanning UI → ✅ shipped. `src/routes/code-scanning.tsx` `GET /:owner/:repo/security` aggregates `gate_runs` matching `%scan%`/`%security%` (last 100), computes latest-per-gate status, renders failed/repaired/total summary cards + per-scanner status list + recent-runs table. Private-repo visibility enforced. Zero new tables — pure surfacing layer.
- **I6** — Sponsors → ✅ shipped. `drizzle/0023_sponsors.sql` adds `sponsorship_tiers` (maintainer_id, name, monthly_cents, one_time_allowed, is_active) + `sponsorships` (sponsor_id, maintainer_id, tier_id, amount_cents, kind, note, is_public, cancelled_at). `src/routes/sponsors.tsx` serves public `/sponsors/:username` (tier cards + recent public sponsors join) + maintainer `/settings/sponsors` (tier CRUD, soft-retire via is_active=false, activity list). Payment rails deferred — v1 captures intent + thank-you notes.
- **I7** — Weekly email digest → ✅ shipped. `drizzle/0024_email_digest.sql` adds `users.notify_email_digest_weekly` + `last_digest_sent_at`. `src/lib/email-digest.ts` exposes `composeDigest`/`sendDigestForUser`/`sendDigestsToAll` (never-throws). Pulls notifications + failed/repaired gate_runs + merged PRs from the last 7d, composes escaped HTML + plaintext, and sends via the shared email provider. `/settings/digest/preview` renders the digest inline for self-preview; `/admin/digests` gives site admins a "Send now" trigger + single-user preview, audit-logged as `admin.digests.run`/`admin.digests.preview`.

### BLOCK H — Marketplace
- **H1** — App marketplace → ✅ shipped. `src/routes/marketplace.tsx` + `src/lib/marketplace.ts` + `drizzle/0021_marketplace_and_apps.sql` (5 tables: `apps`, `app_installations`, `app_bots`, `app_install_tokens`, `app_events`). Routes: `GET /marketplace` (public directory with search), `GET /marketplace/:slug` (detail + install CTA), `POST /marketplace/:slug/install` (user-target install in v1), `POST /marketplace/installations/:id/uninstall`, `GET /settings/apps` (personal list), `GET+POST /developer/apps-new` (register), `GET /developer/apps/:slug/manage` (event log + install count), `POST /developer/apps/:slug/tokens/new` (show-once token). Install idempotent via soft-update on existing non-uninstalled row.
- **H2** — GitHub Apps equivalent (bot identities + installation tokens) → ✅ shipped. Same schema as H1: every app gets a `<slug>[bot]` row in `app_bots`. `generateBearerToken()` produces `ghi_`-prefixed bearers; `hashBearer` (sha256) is the only form persisted. `verifyInstallToken(token)` returns `{installation, app, botUsername, permissions}` or `null` (checks revoked/expired/uninstalled/suspended). Permission vocabulary: `contents:read/write`, `issues:read/write`, `pulls:read/write`, `checks:read/write`, `deployments:read/write`, `metadata:read` — `hasPermission` implements write→read implication.

---

## 4. LOCKED BLOCKS (DO NOT UNDO)

Everything below is committed, tested, and load-bearing. **Do not delete, rename, or semantically change without owner permission.**

### 4.1 Infrastructure (locked)
- `src/app.tsx` — route composition, middleware order, error handlers
- `src/index.ts` — Bun server entry
- `src/lib/config.ts` — env getters (late-binding)
- `src/db/schema.ts` — 81 tables. New tables only via new migration.
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
- `drizzle/0013_discussions.sql` (Block E2) — migration, never edited in place. Adds `discussions`, `discussion_comments`.
- `drizzle/0014_gists.sql` (Block E4) — migration, never edited in place. Adds `gists`, `gist_files`, `gist_revisions`, `gist_stars`.
- `drizzle/0015_projects.sql` (Block E1) — migration, never edited in place. Adds `projects`, `project_columns`, `project_items`.
- `drizzle/0016_wikis.sql` (Block E3) — migration, never edited in place. Adds `wiki_pages`, `wiki_revisions`.
- `drizzle/0017_merge_queue.sql` (Block E5) — migration, never edited in place. Adds `merge_queue_entries` (with partial unique index on `pull_request_id WHERE state IN ('queued','running')`).
- `drizzle/0018_required_checks.sql` (Block E6) — migration, never edited in place. Adds `branch_required_checks`.
- `drizzle/0019_protected_tags.sql` (Block E7) — migration, never edited in place. Adds `protected_tags`.
- `drizzle/0020_analytics_and_admin.sql` (Block F) — migration, never edited in place. Adds `repo_traffic_events`, `system_flags`, `site_admins`, `billing_plans` (seeded free/pro/team/enterprise), `user_quotas`.
- `drizzle/0021_marketplace_and_apps.sql` (Block H) — migration, never edited in place. Adds `apps`, `app_installations` (partial unique index on `(app_id, target_type, target_id) WHERE uninstalled_at IS NULL`), `app_bots` (one-per-app, `<slug>[bot]` username), `app_install_tokens` (sha256 hash, expires_at, revoked_at), `app_events` (audit trail).
- `drizzle/0022_repo_templates.sql` (Block I2+I3) — migration, never edited in place. Adds `repositories.is_template` (partial index where true) + `repo_transfers` audit table.
- `drizzle/0023_sponsors.sql` (Block I6) — migration, never edited in place. Adds `sponsorship_tiers` + `sponsorships` tables.
- `drizzle/0024_email_digest.sql` (Block I7) — migration, never edited in place. Adds `users.notify_email_digest_weekly` + `users.last_digest_sent_at`.

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
- `src/lib/ai-incident.ts` (Block D4) — `onDeployFailure({deploymentId, reason, logs?})` and pure helper `summariseCommitsForIncident(commits)`. Sonnet 4 structured JSON RCA → opens `issues` row, attaches `incident` label if present, sets `deployments.blockedReason`. Never throws; deterministic fallback body when no API key. Wired from `post-receive.ts triggerCrontechDeploy` + `deployments.tsx retry-incident`.
- `src/lib/ai-tests.ts` (Block D8) — pure helpers `detectLanguage`, `detectTestFramework`, `buildTestsPrompt`, `suggestedTestPath`, `generateTestStub`, `contentTypeFor`. Returns `{code:"", framework:"fallback"}` on no API key. Never throws.
- `src/lib/branch-protection.ts` (Block D5) — `matchProtection(repoId, branch)` (exact wins; deterministic glob sort), `evaluateProtection(rule, ctx)` (pure — checks `requireAiApproval | requireGreenGates | requireHumanReview | requiredApprovals`), `countHumanApprovals(prId)` (LGTM/+1/approved heuristic). Never throws. Enforcement is in `src/routes/pulls.tsx` merge handler, after existing hard-gate filter.

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
- `src/routes/ai-tests.tsx` (Block D8) — `GET /:owner/:repo/ai/tests` (softAuth form + picker), `GET /:owner/:repo/ai/tests?format=raw` (raw text w/ MIME), `POST /:owner/:repo/ai/tests/generate` (requireAuth, renders highlighted source + AI-generated failing test with copy button).
- `src/routes/discussions.tsx` (Block E2) — full discussion CRUD + categories + q-and-a answers + lock/pin. Exports `isValidCategory(c)` helper. Owner-only lock/pin; owner-or-author can close/toggle.
- `src/routes/gists.tsx` (Block E4) — `GET /gists` discover, `/gists/new|:slug|:slug/edit|:slug/delete|:slug/star|:slug/revisions|:slug/revisions/:rev` + `/:username/gists`. Exports `generateSlug()` (8-hex) and `snapshotOf(files)` JSON serializer. Retries on slug collision up to 5x.
- `src/routes/projects.tsx` (Block E1) — kanban board CRUD. Auto-seeds three default columns on project create. `/:owner/:repo/projects/:number/items/:itemId/move` recomputes position via `max+1` of target column.
- `src/routes/wikis.tsx` (Block E3) — DB-backed wiki with revision history + revert. Exports `slugifyTitle(title)` (lowercase alphanumerics joined by single dashes, trimmed). Every edit appends a `wiki_revisions` row; revert creates a new revision.
- `src/routes/merge-queue.tsx` (Block E5) — `GET /:owner/:repo/queue` list, `POST /:owner/:repo/pulls/:n/enqueue` (requireAuth), `POST /:owner/:repo/queue/:id/dequeue` (owner-or-enqueuer), `POST /:owner/:repo/queue/process-next?base=X` (owner-only, re-runs gates against base then updates base ref). PR page has an extra "Add to merge queue" button.
- `src/lib/merge-queue.ts` (Block E5) — `enqueuePr`, `dequeueEntry`, `peekHead`, `markHeadRunning`, `completeEntry`, `isQueued`, `queueDepth`, `listQueue`, `listQueueWithPrs`. No side effects beyond the `merge_queue_entries` table; callers own gate execution + git updates.
- `src/routes/required-checks.tsx` (Block E6) — `/:owner/:repo/gates/protection/:id/checks` CRUD (owner-only, requireAuth). "Required checks" link added on gates settings UI next to each branch protection rule.
- `src/lib/branch-protection.ts` extends for E6 — `listRequiredChecks(branchProtectionId)`, `passingCheckNames(repositoryId, commitSha)` (scans `gate_runs` + `workflow_runs`), and `evaluateProtection(rule, ctx, requiredChecks[])` now takes a third param + reports `missingChecks`.
- `src/routes/protected-tags.tsx` (Block E7) — `/:owner/:repo/settings/protected-tags` CRUD (owner-only, requireAuth).
- `src/lib/protected-tags.ts` (Block E7) — `matchProtectedTag`, `isProtectedTag`, `canBypassProtectedTag`, `listProtectedTags`, `addProtectedTag`, `removeProtectedTag`, `userIdFromUsername`. Matching uses `matchGlob` from environments.ts with `refs/tags/` prefix stripped. Post-receive hook writes audit log entries (`protected_tags.{create|update|delete}_violation_candidate`) on matched pushes.
- `src/lib/traffic.ts` (Block F1) — `track`, `trackView`, `trackClone`, `trackByName(owner, repo, kind, meta)`, `summarise(repoId, windowDays=14)`, pure `bucketDaily(events)`. SHA-256-truncated IP hashing (16 hex) for unique-visitor approximation. All callers use `.catch(() => {})` fire-and-forget.
- `src/routes/traffic.tsx` (Block F1) — `GET /:owner/:repo/traffic` (owner-only) with 7/14/30/90d windows, ascii-bar daily chart, top referers, unique visitors.
- `src/routes/org-insights.tsx` (Block F2) — exports `computeOrgInsights(orgId)` returning `OrgInsightsSummary` (repoCount, gateRunsTotal, greenRate, openIssues, openPrs, mergedPrs30d, perRepo[]). `GET /orgs/:slug/insights` requires org membership. No new tables.
- `src/lib/admin.ts` (Block F3) — `isSiteAdmin(userId)` with bootstrap rule (empty `site_admins` → oldest user wins), `listSiteAdmins`, `grantSiteAdmin`, `revokeSiteAdmin`, `getFlag`, `setFlag`, `listFlags`, `KNOWN_FLAGS = { registration_locked, site_banner_text, site_banner_level, read_only_mode }`. All helpers swallow DB errors.
- `src/routes/admin.tsx` (Block F3) — `GET /admin` dashboard (user/repo/admin counts + recent signups), `/admin/users` + toggle grant/revoke, `/admin/repos` + nuclear delete, `/admin/flags` form. All mutations audit-logged via `audit()`. Gated through a `gate(c)` helper that returns `{user} | Response`.
- `src/lib/billing.ts` (Block F4) — plan + quota helpers. `FALLBACK_PLANS` (free/pro/team/enterprise) mirror the seed rows. `getUserQuota(userId)` auto-initialises free row. `bumpUsage`, `checkQuota` (fail-open), `wouldExceedRepoLimit`, `resetIfCycleExpired`, `formatPrice`. Never throws into request path.
- `src/routes/billing.tsx` (Block F4) — `GET /settings/billing` (personal view with usage bars + plan cards), `GET /admin/billing` (site-admin user/plan table), `POST /admin/billing/:userId/plan` (override plan, audit-logged).
- `src/routes/pwa.ts` (Block G1) — `/manifest.webmanifest`, `/sw.js`, `/icon.svg`. Exports `MANIFEST`, `SERVICE_WORKER_SRC`, `PWA_REGISTER_SNIPPET` for testing. SW deliberately skips `.git/`, `/api/`, `/login*`, `/register`, `/logout`.
- `src/lib/graphql.ts` (Block G2) — hand-rolled recursive-descent parser (`parseQuery`) + executor (`execute`) over a fixed schema. Zero dependencies. Root fields: viewer, user, repository, search, rateLimit. No mutations.
- `src/routes/graphql.ts` (Block G2) — `POST /api/graphql` JSON endpoint + `GET /api/graphql` GraphiQL-lite explorer (Cmd+Enter to run).
- `cli/gluecron.ts` (Block G3) — single-file Bun CLI. Exports `dispatch(argv, out)` for programmatic use, `HELP` constant, `loadConfig`/`saveConfig`. Config at `~/.gluecron/config.json` (0600). Compile: `bun build cli/gluecron.ts --compile --outfile gluecron`.
- `vscode-extension/` (Block G4) — VS Code extension with `package.json` declaring four commands (explainFile, openOnWeb, searchSemantic, generateTests) + `gluecron.host` / `gluecron.token` settings. Detects Gluecron remotes via `git config remote.origin.url`.
- `src/lib/marketplace.ts` (Block H1+H2) — marketplace + app identity surface. `KNOWN_PERMISSIONS` (10 scopes), `KNOWN_EVENTS` (8 kinds). Pure helpers: `slugify` (40-char cap), `botUsername` (`<slug>[bot]`), `normalisePermissions` (drops unknown, de-dupes), `parsePermissions` (JSON), `hasPermission` (write→read implication), `permissionsSubset`, `generateBearerToken` (`ghi_` prefix + 24-byte hex), `hashBearer` (sha256). DB helpers: `listPublicApps(query)`, `getAppBySlug`, `createApp` (retries slug collisions, creates matching bot row), `installApp` (idempotent soft-update), `uninstallApp` (revokes all tokens), `issueInstallToken` (1h TTL default), `verifyInstallToken` (checks revoked/expired/uninstalled/suspended), `listInstallationsForApp`, `listInstallationsForTarget`, `listEventsForApp`, `countInstalls`. Never throws into request path.
- `src/routes/marketplace.tsx` (Block H1+H2) — public marketplace + developer UX. `GET /marketplace` (directory + search), `GET /marketplace/:slug` (detail + install form), `POST /marketplace/:slug/install` (v1 user-target only), `POST /marketplace/installations/:id/uninstall` (installer-only), `GET /settings/apps` (personal list), `GET+POST /developer/apps-new` (register), `GET /developer/apps/:slug/manage` (event log + install count, owner-only), `POST /developer/apps/:slug/tokens/new` (show-once `ghi_` token). All mutations audit-logged.
- `src/routes/code-scanning.tsx` (Block I5) — `GET /:owner/:repo/security` (softAuth, private-repo visibility enforced). Aggregates last-100 scan-related `gate_runs`, builds `latestByName` map, renders summary cards + scanner status list + recent runs.
- `src/routes/sponsors.tsx` (Block I6) — public `/sponsors/:username` + maintainer `/settings/sponsors` (requireAuth). Tier CRUD (`POST /settings/sponsors/tiers/new`, soft-retire via `is_active=false` on delete). Exports `sponsorshipTotalForUser(userId)` helper and `__internal.formatCents` for tests.
- `src/lib/email-digest.ts` (Block I7) — `composeDigest(userId, since?)` (never throws, null on failure), `sendDigestForUser(userId)` (opt-out check + updates `last_digest_sent_at` on success), `sendDigestsToAll()` (iterates opted-in users). Pulls notifications + owned-repo gate_runs (failed/repaired) + merged PRs over last 7d. Builds text + escaped HTML body. Exports `__internal = { textToHtml, escapeHtml, fmtRange }` for tests.
- `src/routes/admin.tsx` (extends Block F3 for I7) — adds `GET /admin/digests` (opted-in count + recently sent list), `POST /admin/digests/run` (calls `sendDigestsToAll`, audit-logged with counts), `POST /admin/digests/preview` (sends to one user by username, audit-logged). New "Email digests" tile on the /admin dashboard grid.
- `src/routes/settings.tsx` (extends for I7) — adds `notify_email_digest_weekly` checkbox to email prefs + handler wiring in `POST /settings/notifications`, and `GET /settings/digest/preview` (renders `composeDigest` output inline via `raw(body.html)` with Hono's `hono/html`).

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
bun test         # 570 tests currently pass
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
