# Gluecron Master To-Do List

Last updated: 2026-06-06 (rev 4 — full codebase audit complete, Bible is 35% of reality)

**IMPORTANT:** The BUILD_BIBLE.md documents ~35% of the actual codebase. 34 migrations (0043–0076) and 87+ lib files exist beyond what the Bible tracks. This list is based on direct code scanning, not the Bible.

Tick off items as they ship. Add `[x] YYYY-MM-DD commit:abc` when done.
Work top-to-bottom within each priority.

---

## 🔴 PRIORITY 1 — Configuration Blockers (Built, Just Not Configured)

These are NOT build tasks — the code is complete. They need ops/config action.

- [ ] **Verify SSH git push works end-to-end** — `src/lib/ssh-server.ts` is a full 545-line production implementation that starts at boot (`src/index.ts`). It handles `git-upload-pack` and `git-receive-pack`, does public-key auth against the `ssh_keys` table, and triggers post-receive hooks. Test from a clean machine: add an SSH key at `/settings`, then `git clone git@gluecron.com:user/repo.git`. If the SSH_PORT env var isn't set, default is 2222 — verify the port is open on the server.
- [ ] **Enable AI Trio Review** — Three-model parallel PR review (security / correctness / style) is fully built in `src/lib/ai-review-trio.ts` and wired into `src/lib/ai-review.ts`. Set `AI_TRIO_REVIEW_ENABLED=1` to activate. This is a genuine differentiator — no other platform has this.
- [x] 2026-06-06 **Fix duplicate migration number 0065** — Renamed `0065_auto_generate_tests.sql` to `0077_auto_generate_tests.sql` (was conflicting with `0065_ai_cost_events.sql`). Both migrations now have unique numbers.
- [ ] **Set SERVER_TARGETS_KEY** — Server targets encrypt SSH private keys via AES. If `SERVER_TARGETS_KEY` env var isn't set, deploy target creation will fail silently. Set a 32-byte hex key in production.
- [ ] **Set PREVIEW_DOMAIN** — Branch preview URLs are computed as `${branchSlug}-${repoSlug}.preview.gluecron.com` or `PREVIEW_DOMAIN` env var. Set this to match where previews will actually be served.

---

## 🟠 PRIORITY 2 — Genuine Code Gaps (Need Building)

These are confirmed missing by direct code inspection.

- [x] 2026-06-06 **Container registry (Docker/OCI)** — `src/routes/oci-registry.ts` implements full OCI Distribution Spec v1.0: GET/HEAD/PUT/DELETE blobs, chunked PATCH uploads, GET/PUT/DELETE manifests, tags list, catalog. Blobs stored at `${OCI_STORE_PATH}/blobs/sha256/<digest>`. `drizzle/0084_oci_registry.sql` adds `oci_repositories` + `oci_tags`. Basic auth via `api_tokens` table.
- [x] 2026-06-06 **Redis SSE fan-out** — `src/lib/sse.ts` rewritten. When `REDIS_URL` or `VALKEY_URL` is set, uses two `Bun.RedisClient` instances (pub + sub) with `autoReconnect`. Topic-scoped SUBSCRIBE/UNSUBSCRIBE. On disconnect, re-subscribes all channels. Falls back to local delivery if Redis unreachable. In-memory path unchanged when no URL set. Zero API changes to callers.
- [x] 2026-06-06 **Workflow cache SAVE** — `saveCacheEntry()` implemented in `src/lib/actions/cache-action.ts`. DB-backed via `workflow_run_cache` Postgres table; tarballs paths, SHA-256 hashes, 100MB cap, upserts content. Wired in `src/lib/workflow-runner.ts` post-job. LOAD unchanged.
- [x] 2026-06-06 **Pack-content ruleset enforcement** — `commit_message_pattern`, `blocked_file_paths`, `max_file_size` now blocking at push time via pre-receive hook (`GIT_CONFIG_COUNT` env injection). Git commands: `git log --format="%H %s"`, `git diff --name-only`, `git cat-file -s`. Wired in `src/routes/git.ts` (HTTP) and `src/lib/ssh-server.ts` (SSH). All 10 push-policy + 23 ruleset tests pass.
- [x] 2026-06-06 commit:44ed968 **Branch preview expiry cleanup** — `expireOldPreviews()` wired as `preview-expiry` autopilot task in `src/lib/autopilot.ts`. Admin UI updated to show 10 tasks including `auto-merge-sweep`, `ai-build-from-issues`, and `preview-expiry`.
- [x] 2026-06-06 **Server targets → customer-facing** — `src/routes/deploy-targets.tsx` (414 lines). `GET/POST /settings/deploy-targets`, `POST /settings/deploy-targets/:id/delete`, `POST /settings/deploy-targets/:id/test`. AES-256-GCM encryption via `SERVER_TARGETS_KEY`. Ownership-gated. Added to settings subnav and registered in `src/app.tsx`.
- [x] 2026-06-06 **Claude Web Sessions → customer-facing** — `/:owner/:repo/claude` now open to all authenticated users with repo access. `listSessionsForUser()` scopes sessions to owner. Session list: colour-coded status badges, reverse-chron order. SSE stream via `GET /:owner/:repo/claude/:sessionId/stream?prompt=`. Spawns `claude --print --output-format stream-json`. "✨ Claude AI" sidebar card added to repo home (`src/routes/web.tsx`).
- [x] 2026-06-06 **AI budget hard enforcement** — `assertAiQuota(userId)` added to `src/lib/billing.ts` with 60s in-memory cache. Wired into `ai-review.ts` (posts skip comment), `ai-review-trio.ts` (fail-closed trio result), `ai-ci-healer.ts` (returns skipped), `spec-to-pr.ts` (returns error to UI). Warn at 90%, throw `AiQuotaExceededError` at 100%. Fails open on DB error.
- [x] 2026-06-06 **Spec-to-Live real-time progress UI** — `src/routes/specs.tsx` (+593 lines). POST redirects to `/:owner/:repo/spec/:jobId/progress`. Polling (2s, &lt;20 lines JS) as primary; SSE endpoint as secondary. 8-stage timeline: analyzing→writing→opening_pr→ai_reviewing→gates_running→merging→deploying→done. In-memory `SpecJob` Map with 10-min eviction. No-JS server-render fallback.
- [ ] **Agent marketplace — real listings** — Migration `0070_agent_marketplace.sql` is complete with full schema (listings, installs, reviews, 30% revenue cut built in). The route `src/routes/marketplace-agents.tsx` exists. But there are only seed listings. Write a "Publish an agent" guide, reach out to 10 developers, get 20+ real listings.

---

## 🟡 PRIORITY 3 — Messaging (Every Page Needs This)

- [x] 2026-06-06 **Landing hero** (`src/views/landing.tsx`) — H1: "Write the spec. Gluecron ships it." Subhead: "Spec to PR in 90 seconds. Push to live in 25. AI review, auto-merge, deploy — automatic." Sleep Mode demoted to single closing clause. Rail label: "deploys shipped".
- [x] 2026-06-06 **Landing "what's happening now" rail** — Rail label updated; "Three reasons" card 1 rewritten to lead with timing numbers. Sleep Mode demoted to one line.
- [x] 2026-06-06 **vs-github AI rows** (`src/routes/vs-github.tsx`) — All 10 AI-native rows now have latency numbers: "AI review fires the moment PR opens (~8s)", "auto-merge triggers the instant gates pass", "ai:build → draft PR in 90 seconds", etc. Sleep Mode renamed to "async batch digest" — framed as opt-in, not the headline.
- [x] 2026-06-06 **Demo page** (`src/routes/demo.tsx`) — Tile headings: "being built right now" / "merged the instant gates passed". Steps updated with real-time language. Live feed subtitle: "Happening right now". Empty states rewritten.
- [x] 2026-06-06 **Sleep Mode demoted** — Demoted across landing (one closing clause) and vs-github (async opt-in framing). Never leads anywhere.
- [x] 2026-06-06 **OG/meta descriptions** — All pages audited. Landing title/desc: "AI-native git host. Spec to PR in 90 seconds." Pricing, vs-github, demo, explore, help: descriptions added. Per-repo pages: dynamic description. "wake up to", "overnight", "while you sleep" stripped everywhere including landing-2030.tsx body copy. Tests updated.
- [x] 2026-06-06 **Pricing page** — Speed-first hero: monospace "Spec to PR in 90 seconds." accent stat, sub-copy with timing numbers. "Included in every plan" pill strip. All 4 plan card taglines mention AI review + auto-merge. OG/meta description added.

---

## 🔵 PRIORITY 4 — Polish & Customer Experience

### Onboarding
- [x] 2026-06-06 **Empty state for new repos** — 3-option panel in `src/routes/web.tsx`: git commands to push first commit, link to /import, link to /:owner/:repo/specs. Done in wave 1.
- [x] 2026-06-06 **Onboarding email sequence** — `drizzle/0081_onboarding_emails.sql` adds `onboarding_emails_sent jsonb`. `src/lib/onboarding-drip.ts`: T+0 welcome (fire-and-forget in `auth.tsx` POST /register), T+1d "Try Spec-to-PR", T+3d "Your AI is watching" via `onboarding-drip` autopilot task. Idempotent via jsonb key tracking. Skips when RESEND_API_KEY unset.
- [x] 2026-06-06 **Dashboard "AI just did this" widget** — `AiActivityWidget` added to `src/routes/dashboard.tsx`. Queries `audit_log` (auto_merge.merged, ai_build.dispatched) and `gate_runs` (status=repaired) for last 60 minutes. Shows per-category counts, item list with links, "All quiet — AI is watching." empty state.
- [x] 2026-06-06 **Push Watch → make it discoverable** — Pulsing "● Live" badge in `RepoHeader` (red + `pushWatchPulse` animation when &lt;5min, muted "○ Watch" when &lt;24hr). Query on `activity_feed` WHERE action='push'. Eye-icon watch link on every commit row. `src/views/components.tsx`, `src/views/layout.tsx`, `src/routes/web.tsx`.
- [x] 2026-06-06 **Repo overview AI stats strip** — `getRepoAiStats(repoId)` in `src/routes/web.tsx`. Shows "⚡ AI merged N PRs this week · Saved ~X hrs · N open security alerts" below file tree. Queries `activity_feed` (auto_merge), `pr_comments` (is_ai_review), `gate_runs` (security). Hidden when all zeros.

### Admin
- [x] 2026-06-06 **Admin > AI cost breakdown** — `/admin/ai-costs`: monthly total, breakdown by `category`, top 10 spenders with CSS bar chart. `ai_cost_events` JOIN `users`. Added to admin dashboard nav.
- [x] 2026-06-06 **Admin > Stripe sync** — `src/routes/admin-stripe.tsx` at `/admin/stripe`. Fetches non-free users from `user_quotas`, calls live Stripe API per user, flags plan mismatches. `POST /admin/stripe/:userId/sync` corrects local plan to match Stripe. Degrades gracefully without STRIPE_SECRET_KEY.
- [x] 2026-06-06 **Admin > Autopilot health** — `/admin/autopilot/health`: 10 tasks with last-tick status, duration, 24h success/error counts from `audit_log`. In-process `getLastTick()`/`getTickCount()` from autopilot.ts.
- [x] 2026-06-06 **Admin > User growth chart** — `/admin/growth`: daily signups last 30 days (`date_trunc('day', created_at)`), activation rate (users with ≥1 repo), CSS bar chart table.
- [x] 2026-06-06 commit:44ed968 **K3 tasks on `/admin/autopilot`** — `auto-merge-sweep` and `ai-build-from-issues` were already present; `preview-expiry` added. Badge updated to "10 tasks".

### Developer Experience
- [x] 2026-06-06 **System/autopilot user** — `drizzle/0078_bot_user.sql` seeds `gluecron[bot]` (empty password_hash, non-loginable). `src/lib/bot-user.ts` lazy-caches the UUID. 10 comment call sites updated across `stale-sweep.ts`, `ai-review.ts`, `ai-review-trio.ts`, `autopilot.ts`. 🤖 bot pill shown in PR/issue comment headers.
- [x] 2026-06-06 **Notification preferences** — Restructured into 4 categories in `src/routes/settings.tsx`: AI activity, CI/CD, Code review, Mentions. All existing `name=` attrs preserved — POST handler unchanged. Email pill count updated to 5 events.
- [x] 2026-06-06 **Repo health badge on repo overview** — Health score badge added to `RepoHeader` in `src/routes/web.tsx`. Grade colours: Elite=green, Strong=blue, Improving=yellow, Needs Attention=red. Links to /:owner/:repo/insights/health. Done in wave 1.
- [x] 2026-06-06 **AI Trio Review UI indicator** — `TrioVerdictPills` component added to `src/routes/pulls.tsx`. Three pills (Security/Correctness/Style) in the PR header meta div. Feature-flagged on `AI_TRIO_REVIEW_ENABLED=1`. Pills link to `#trio-review-section`. No extra DB query — reads from already-fetched `prComments`.
- [x] 2026-06-06 **L1 sleep-mode column split** — `drizzle/0079_sleep_digest_column.sql` adds `last_sleep_digest_sent_at`. Schema updated. `sleep-mode.ts` and `autopilot.ts` now write/read the dedicated column. Tests updated. (Renamed from 0077 to avoid collision with `0077_auto_generate_tests.sql`.)
- [x] 2026-06-06 **GitHub unlink route** — `POST /settings/github/unlink` deletes `sso_user_links` rows with `subject` starting `"github:"`. "Disconnect GitHub" button shown on settings page when GitHub is linked. Audited via `auth.github.unlink`.
- [x] 2026-06-06 **Branch preview expiry UX** — `src/routes/previews.tsx`: expired cards get `.preview-card.is-expired`, strikethrough muted URL, "↺ Rebuild" button linking to `/previews/rebuild?branch=`. `expireOldPreviews()` confirmed to set `status='expired'` correctly.

### Documentation & Help
- [x] 2026-06-06 **Docs site** — `src/routes/docs.tsx` (1600 lines). Routes: /docs, /docs/getting-started, /docs/workflow-yaml, /docs/mcp-server, /docs/api, /docs/agents. All 15 MCP tool names from mcp-tools.ts, real rate limits, real workflow YAML examples, agent.json manifest format. Footer "Docs" link updated.
- [x] 2026-06-06 **Changelog page** — `src/routes/changelog.tsx` at `/changelog`. June + May 2026 releases listed. "Subscribe to updates" CTA → `/settings/notifications`. Changelog link added to footer in `layout.tsx`.
- [ ] **Legal pages attorney review** — All four legal pages (`terms`, `privacy`, `dmca`, `acceptable-use`) are substantive drafts marked "DRAFT — requires attorney review." Get legal sign-off before any paid launch.
- [x] 2026-06-06 **Status page — polish** — `drizzle/0080_incidents_and_status_subscribers.sql` adds `incidents` + `status_subscribers` tables. `src/routes/status.tsx` rewritten: overall status banner, 6 service uptime rows, last-10 incident history table, subscribe form with confirm/unsubscribe token flow.

---

## 🟣 PRIORITY 5 — Growth & Distribution

- [ ] **60-second demo video** — Screen record: type a spec → AI writes code → PR opens → trio review posts → gates pass → auto-merged. Show elapsed time counter. No voiceover. Embed everywhere.
- [ ] **VS Code extension → publish** — `vscode-extension/` is built. Run `vsce package`, publish to VS Code Marketplace. Free discovery.
- [ ] **CLI → publish to npm** — `cli/gluecron.ts` is built. Publish as `gluecron` npm package. `npx gluecron login` as zero-install entry.
- [ ] **CLI → Homebrew formula** — `brew install gluecron`. Mac developer standard.
- [x] 2026-06-06 **JetBrains plugin** — `jetbrains-plugin/` skeleton (14 files). Gradle + IntelliJ Platform Plugin 1.16.1, targets 2023.1+. 4 actions: Open PRs, Create Issue, Merge PR (API call), View Health. `GluecronUtil.kt` detects owner/repo from git remote. `./gradlew buildPlugin` → zip. Publish to JetBrains Marketplace manually.
- [x] 2026-06-06 **GitHub migration as primary CTA** — "Migrate from GitHub →" button added to landing hero and logged-out nav (accent pill). "Coming from GitHub?" callout card on explore page. Import page headline: "Migrate your GitHub org in 60 seconds."
- [x] 2026-06-06 **Developer program page** — `src/routes/developer-program.tsx` at `/developer-program`. Hero: "Build on Gluecron. Earn revenue." Publish agent / 70% revenue share / partner badge sections. Partner application form (POST logs + redirects). Footer link added.
- [x] 2026-06-06 **Shareable AI hours saved card** — `src/routes/share.tsx`: SVG OG image at `/share/hours-saved?user=:username` (1200×630, dark bg, green glow number). HTML share page at `/share/:username` with og:image, Twitter pre-fill, copy-link button. "Share your AI stats" link added to billing usage page. Hours: PRs×1.5 + reviews×0.5 + heals×0.3.
- [x] 2026-06-06 **Blog / devlog** — `src/routes/blog.tsx` at `/blog` + `/blog/:slug`. 3 posts: "30 features in one session", "Why we killed the overnight pitch", "Spec to PR in 90 seconds". Footer "Blog" link added. No DB dependency.

---

## ⚫ PRIORITY 6 — Strategic / Long-Term

- [ ] **SOC 2 Type II** — Engage auditor, scope controls. 6–9 months. No enterprise deals without it.
- [x] 2026-06-06 **EU data residency** — `drizzle/0083_data_region.sql` adds `data_region` to `repositories`. Dropdown on repo creation (US/EU Frankfurt). Read-only pill in repo settings. "EU data residency" added to Pro tier on pricing page + FAQ.
- [x] 2026-06-06 **GDPR account deletion verification** — Two gaps fixed in `src/lib/account-deletion.ts`: disk repo cleanup (rm each `repositories.diskPath` + user dir) and Stripe subscription cancellation. DB CASCADE already handled sessions/ssh_keys/api_tokens etc. `audit_log.user_id` ON DELETE SET NULL anonymises rows. New `/admin/deletions` page + force-purge button.
- [x] 2026-06-06 **Audit log SIEM export** — `GET /api/v2/audit` in `src/routes/api-v2.ts`. Admin Bearer auth, params: since/until/limit/cursor/actor/action/resource_type. Returns `{events, nextCursor, hasMore}` + `X-Total-Count` header. Each event: id, action, actor_username, resource_type, metadata, created_at, ip_address.
- [x] 2026-06-06 **Enterprise sales page** — `src/routes/enterprise.tsx` at `/enterprise`. Sections: custom pricing, SSO (SAML/OIDC), SLA, data residency, SOC 2, SIEM. Contact form `POST /enterprise/contact` → `enterprise_leads` table (migration 0082). Footer "Enterprise" link added.
- [ ] **Native iOS app** — Minimum viable: repo browser, notifications, PR approve/reject, AI chat. React Native.
- [ ] **Native Android app** — Share React Native codebase with iOS.
- [x] 2026-06-06 **Multi-agent pipeline UI** — `src/routes/agent-pipelines.tsx` (1100 lines). Routes: `/:owner/:repo/agents` (list), `/agents/new` (builder, JS-free ?stages=N pattern), `POST /agents` (creates session + lease rows), `/:sessionId` (live view, 5s meta-refresh), `/:sessionId/cancel`. "Agents" tab added to RepoNav.
- [x] 2026-06-06 **AI pair programmer (browser)** — Covered by "Claude Web Sessions → customer-facing" above. `/:owner/:repo/claude` open to all authenticated users. SSE streaming via `claude --print --output-format stream-json`. "✨ Claude AI" sidebar card on repo home.
- [x] 2026-06-06 **End-to-end test suite** — 38 Playwright tests across `e2e/`: auth (7), repo (9), pulls (6), issues (8), settings (8). `e2e/fixtures.ts` shared helpers with real git push via `Bun.spawn`. `bun run e2e` script added. `@playwright/test ^1.49.0` in devDependencies.
- [x] 2026-06-06 **Load testing** — `scripts/load-test.js` (100 VUs, p95&lt;500ms threshold, tests landing/explore/blog/pricing). `scripts/load-test-git.js` (150 VUs + spike, tests Smart HTTP info/refs and git-upload-pack). Run with `k6 run scripts/load-test.js`.
- [ ] **Database connection pooling verification** — Confirm PgBouncer or Neon pooling is correctly configured for multi-instance load.

---

## ✅ CONFIRMED COMPLETE (Direct Code Verification)

Verified by reading actual files — not just the Bible.

**Revenue/Billing:**
- Stripe Checkout + webhook + customer portal — complete, needs env vars only
- Billing plans, quotas, usage tracking — complete
- Billing UI with usage bars, plan cards, upgrade flow — complete
- AI cost events + per-call tracking (`ai_cost_events` table) — complete
- Budget cap warning system — complete (advisory; hard enforcement is a gap above)

**Auth & Identity:**
- SSH git push — complete (ssh-server.ts, 545 lines, wired at boot)
- Password reset, email verification, magic link sign-in — complete
- Google OAuth — complete
- Playground anonymous accounts — complete
- Account deletion with grace period — complete
- Terms acceptance audit trail — complete

**AI Features (all wired, not stubs):**
- AI CI healer (auto-fixes failed workflow runs) — complete, runs every 5 min
- AI proactive monitor (platform health surveillance) — complete, runs hourly
- Stale PR/issue sweep (two-stage poke + auto-close) — complete, runs every 5 min
- AI trio review (three-model parallel: security/correctness/style) — complete, opt-in
- AI standup generation (daily/weekly briefs) — complete
- Repair flywheel (learning cache for patches) — complete
- Voice-to-PR — complete (1092 lines)
- Multi-repo refactoring — complete
- Migration assistant (AI-driven major dep upgrades) — complete

**Developer Experience:**
- Per-repo AI chat — complete (repo-chat.tsx, 967 lines)
- Personal cross-repo AI chat — complete (personal-chat.tsx, 1137 lines)
- Hosted Claude loops (deploy Claude agents as endpoints) — complete
- Cloud dev environments (browser IDE) — complete (schema + routes, feature-flagged)
- Branch preview URLs — complete (URL gen; expiry cleanup missing — see Priority 2)
- PR sandboxes — complete (4h TTL, auto-provision on PR open)
- PR live co-editing with cursor presence — complete
- Comment moderation queue — complete
- Import secrets from GitHub — complete
- Agent multiplayer (sessions, leases, budgets) — complete

**Integrations:**
- Slack/Discord/Teams chat notifications — complete
- Durable webhook delivery with exponential backoff retry — complete
- Synthetic uptime monitoring — complete
- Deploy timeline + step streaming — complete

**Admin:**
- /admin/diagnose — 14 system health checks — complete
- /admin/self-host — self-hosting wizard — complete
- /admin/servers — SSH deploy targets — complete (admin-only; customer rollout is a gap)

**Everything in BUILD_BIBLE §2 marked ✅** is confirmed present in the codebase. The Bible claims 100% accuracy for what it documents — no phantom features found.

---

## 💳 LAST — Stripe/Billing Configuration (When Platform Is Ready)

These are NOT build tasks — the code is 100% complete. Do these only after the platform is stable and ready for paying customers.

- [ ] **Set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in production** — Stripe Checkout, customer portal, and webhook handler are 100% built (`src/lib/stripe.ts`, `src/routes/billing.tsx`, `src/routes/stripe-webhook.ts`). The billing UI even shows a warning when the key is missing. Run `scripts/stripe-bootstrap.ts` to create products/prices in Stripe with the right lookup keys (`gluecron_pro_monthly` etc), then set the secrets on Fly.io. Zero code changes needed.

---

## Notes

- `- [ ]` = not started / not configured
- `- [x] YYYY-MM-DD commit:abc` = done
- Bible is accurate but covers only ~35% of the codebase by file count
- 34 migrations beyond 0042 represent major post-Bible development
- When in doubt: scan the code, don't trust the Bible
