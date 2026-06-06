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

- [ ] **Container registry (Docker/OCI)** — No files exist for this anywhere in the codebase. npm package registry is complete (`src/lib/packages.ts`). The OCI push/pull protocol needs implementing: `GET /v2/`, `HEAD /v2/:name/blobs/:digest`, `POST /v2/:name/blobs/uploads/`, `PUT /v2/:name/manifests/:ref`. Without Docker support, teams with containerised apps can't fully leave GitHub.
- [ ] **Redis SSE fan-out** — `src/lib/sse.ts` is a single-process in-memory broadcaster. The TODO(scale) is right in the code. Multi-instance deploys mean live comment updates, PR live view, and push watch only reach subscribers on the same process. Replace the internal broadcaster with Redis pub/sub behind the same interface.
- [ ] **Workflow cache SAVE** — `src/lib/actions/cache-action.ts` has an explicit TODO(v2) for the SAVE half. Only LOAD is implemented. Every CI run after the first runs cold. Wire save-on-job-success.
- [ ] **Pack-content ruleset enforcement** — `commit_message_pattern`, `blocked_file_paths`, `max_file_size` in `src/lib/rulesets.ts` need actual git pack inspection to enforce at push time. Currently those rule types are advisory only. Implement in `src/lib/push-policy.ts`.
- [x] 2026-06-06 commit:44ed968 **Branch preview expiry cleanup** — `expireOldPreviews()` wired as `preview-expiry` autopilot task in `src/lib/autopilot.ts`. Admin UI updated to show 10 tasks including `auto-merge-sweep`, `ai-build-from-issues`, and `preview-expiry`.
- [ ] **Server targets → customer-facing** — `src/routes/admin-server-targets.tsx` and migration `0073_server_targets.sql` exist but the routes are under `/admin/servers` — site-admin only. Build a customer-facing `/settings/deploy-targets` that lets any user add SSH deploy targets for their own repos. This is the push-to-your-own-server story.
- [ ] **Claude Web Sessions → customer-facing** — Migration `0074_claude_web_sessions.sql` exists with `claude_web_sessions` + `claude_web_messages` tables. Admin-only in v1 per migration notes. Build the customer UI at `/:owner/:repo/claude` — browser-based Claude Code sessions with persistent transcript. This is a massive differentiator.
- [ ] **AI budget hard enforcement** — `src/routes/billing-usage.tsx` confirms: the budget cap is advisory only ("Advisory cap; we warn when projected EOM exceeds it"). When a user's projected AI spend exceeds their cap, features should degrade gracefully. Wire `checkQuota()` from `src/lib/billing.ts` as a hard gate before AI feature calls.
- [ ] **Spec-to-Live real-time progress UI** — Spec→PR exists. The remaining loop is PR→AI review→auto-merge→deploy→notification. More importantly, the user submits a spec and sees a blank page or redirect. Wire a live progress view (SSE-backed) showing each stage as it happens: "Writing code... Opening PR... AI reviewing... Gates passing... Merged in 1m 52s." This is the "wow" moment.
- [ ] **Agent marketplace — real listings** — Migration `0070_agent_marketplace.sql` is complete with full schema (listings, installs, reviews, 30% revenue cut built in). The route `src/routes/marketplace-agents.tsx` exists. But there are only seed listings. Write a "Publish an agent" guide, reach out to 10 developers, get 20+ real listings.

---

## 🟡 PRIORITY 3 — Messaging (Every Page Needs This)

- [x] 2026-06-06 **Landing hero** (`src/views/landing.tsx`) — H1: "Write the spec. Gluecron ships it." Subhead: "Spec to PR in 90 seconds. Push to live in 25. AI review, auto-merge, deploy — automatic." Sleep Mode demoted to single closing clause. Rail label: "deploys shipped".
- [x] 2026-06-06 **Landing "what's happening now" rail** — Rail label updated; "Three reasons" card 1 rewritten to lead with timing numbers. Sleep Mode demoted to one line.
- [x] 2026-06-06 **vs-github AI rows** (`src/routes/vs-github.tsx`) — All 10 AI-native rows now have latency numbers: "AI review fires the moment PR opens (~8s)", "auto-merge triggers the instant gates pass", "ai:build → draft PR in 90 seconds", etc. Sleep Mode renamed to "async batch digest" — framed as opt-in, not the headline.
- [x] 2026-06-06 **Demo page** (`src/routes/demo.tsx`) — Tile headings: "being built right now" / "merged the instant gates passed". Steps updated with real-time language. Live feed subtitle: "Happening right now". Empty states rewritten.
- [x] 2026-06-06 **Sleep Mode demoted** — Demoted across landing (one closing clause) and vs-github (async opt-in framing). Never leads anywhere.
- [ ] **OG/meta descriptions** — Audit every page's `<meta description>` and OG tags. Strip "wake up to" and replace with speed language.
- [ ] **Pricing page** (`src/routes/pricing.tsx`) — CTAs currently link to `/settings/billing?plan=X` not directly to checkout. Fine functionally but lead copy needs to hit the speed angle. Add the "spec to PR in 90 seconds" stat to the hero.

---

## 🔵 PRIORITY 4 — Polish & Customer Experience

### Onboarding
- [ ] **Empty state for new repos** — Push your first commit / Import from GitHub / Try Spec-to-PR. Not a blank page.
- [ ] **Onboarding email sequence** — T+0 welcome, T+1 day "try spec-to-PR", T+3 days "here's what AI did for similar repos". Resend sequences.
- [ ] **Dashboard "AI just did this" widget** — What autopilot did in the last hour (not 7 days). PRs auto-merged, specs shipped, CI healed, secrets repaired. Real-time feel.
- [ ] **Push Watch → make it discoverable** — The page (`/:owner/:repo/push/:sha`) exists and is polished. Add a "Live" pulsing link on the repo header that activates after every push. This is the first "wow" moment new users need to see.
- [ ] **Repo overview AI stats strip** — Below the file tree: "AI merged 3 PRs this week · Saved ~4.5 hrs · 0 open security alerts." Makes AI value visible at a glance.

### Admin
- [ ] **Admin > AI cost breakdown** — Total AI spend this month, per feature (review/triage/CI healer/spec-to-PR/chat), top spenders. `aiCostEvents` table has everything needed. Unit economics.
- [ ] **Admin > Stripe sync** — Stripe subscription status per user vs local plan. Flag mismatches. Link to Stripe dashboard.
- [ ] **Admin > Autopilot health** — Last tick time, per-task success/error counts, average tick duration. Expose the CI healer, proactive monitor, stale sweep, and preview expiry tasks alongside existing tasks.
- [ ] **Admin > User growth chart** — Signups over time, activation rate (created a repo), conversion rate (free→paid).
- [x] 2026-06-06 commit:44ed968 **K3 tasks on `/admin/autopilot`** — `auto-merge-sweep` and `ai-build-from-issues` were already present; `preview-expiry` added. Badge updated to "10 tasks".

### Developer Experience
- [ ] **System/autopilot user** — K3 posts marker comments credited to the PR/issue author. Create `gluecron[bot]` synthetic user row. Autopilot actions should show a bot avatar.
- [ ] **Notification preferences** — Flat checkbox list currently. Restructure into categories: AI activity, CI/CD, code review, mentions. Per-category toggle.
- [ ] **Repo health badge on repo overview** — `computeHealthScore` exists, health page exists. Add a small badge to `RepoHeader`.
- [ ] **AI Trio Review UI indicator** — When trio review is enabled, show three separate verdict pills on the PR (Security ✓, Correctness ✓, Style ✓) not one combined comment. The data is already structured that way.
- [ ] **L1 sleep-mode column split** — `sleep_mode_digest` and weekly digest share `last_digest_sent_at`. Add `last_sleep_digest_sent_at` column.
- [ ] **GitHub unlink route** — `/settings/sso/unlink` removes any SSO link. Add dedicated `/settings/github/unlink`.
- [ ] **Branch preview expiry UX** — previews.tsx shows status pills (building/ready/failed/expired). Once expiry cleanup is wired, test the "expired" state renders correctly.

### Documentation & Help
- [ ] **Docs site** — `/help` exists as a migration cheatsheet. Need: Getting Started, API reference, MCP server setup, Workflow YAML syntax, Agent publishing guide. Could be `/docs` served from the self-hosted repo.
- [ ] **Changelog page** — `/changelog` with recent releases + AI-generated notes. Users have no way to know what shipped.
- [ ] **Legal pages attorney review** — All four legal pages (`terms`, `privacy`, `dmca`, `acceptable-use`) are substantive drafts marked "DRAFT — requires attorney review." Get legal sign-off before any paid launch.
- [ ] **Status page — polish** — `/status` and `/status.svg` exist. Add incident history, subscribe-to-alerts, make it look production-grade.

---

## 🟣 PRIORITY 5 — Growth & Distribution

- [ ] **60-second demo video** — Screen record: type a spec → AI writes code → PR opens → trio review posts → gates pass → auto-merged. Show elapsed time counter. No voiceover. Embed everywhere.
- [ ] **VS Code extension → publish** — `vscode-extension/` is built. Run `vsce package`, publish to VS Code Marketplace. Free discovery.
- [ ] **CLI → publish to npm** — `cli/gluecron.ts` is built. Publish as `gluecron` npm package. `npx gluecron login` as zero-install entry.
- [ ] **CLI → Homebrew formula** — `brew install gluecron`. Mac developer standard.
- [ ] **JetBrains plugin** — Same four commands as VS Code. Kotlin plugin. Covers IntelliJ, WebStorm, GoLand.
- [ ] **GitHub migration as primary CTA** — Bulk import is built (`src/routes/import-bulk.tsx`). Make "Migrate your GitHub org in 60 seconds" the hero CTA for GitHub users, not buried in the nav.
- [ ] **Developer program page** — `/developer-program`: publish an agent, revenue share (30% platform cut is already in the schema), `gluecron-partner` badge, docs.
- [ ] **Shareable AI hours saved card** — OG-image endpoint for Twitter/LinkedIn: "I saved 14 hours this week with Gluecron". Viral growth lever.
- [ ] **Blog / devlog** — Monthly shipping updates. Developers follow platforms that ship visibly.

---

## ⚫ PRIORITY 6 — Strategic / Long-Term

- [ ] **SOC 2 Type II** — Engage auditor, scope controls. 6–9 months. No enterprise deals without it.
- [ ] **EU data residency** — Neon postgres EU region + Fly.io EU region. "Data region" selector at org creation.
- [ ] **GDPR account deletion verification** — Migration `0049_account_deletion.sql` adds `deleted_at` and `deletion_scheduled_for`. Verify the full cascade is implemented: bare git repo deletion, related rows purged, audit log anonymised.
- [ ] **Audit log SIEM export** — `GET /api/v2/audit?since=&format=json`. Required by enterprise security teams (Splunk, Datadog, Elastic).
- [ ] **Enterprise sales page** — `/enterprise`: custom pricing, SSO, dedicated support SLA, data residency. Contact form → Calendly.
- [ ] **Native iOS app** — Minimum viable: repo browser, notifications, PR approve/reject, AI chat. React Native.
- [ ] **Native Android app** — Share React Native codebase with iOS.
- [ ] **Multi-agent pipeline UI** — `agent-multiplayer.ts` and `agent_sessions`/`agent_leases` tables are complete. Wire a UI to define pipelines: Agent A writes, Agent B reviews, Agent C deploys.
- [ ] **AI pair programmer (browser)** — Claude Code session embedded in a browser tab alongside the file editor. `claude_web_sessions` schema is ready (migration 0074), `src/routes/claude-web.tsx` exists — make it customer-facing.
- [ ] **End-to-end test suite** — Playwright covering register → push → PR → AI review → merge. Catches flow regressions that unit tests miss.
- [ ] **Load testing** — k6 or Artillery before any growth push. What happens at 1000 concurrent git pushes?
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
