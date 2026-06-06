# Gluecron Master To-Do List

Last updated: 2026-06-06 (rev 3 — full expanded list)

Tick off items as they ship. Add date + commit ref next to each completed item.
Work top-to-bottom within each priority section.

---

## 🔴 PRIORITY 1 — Revenue (Money In, Do First)

- [ ] **Stripe Checkout flow** — no user can self-serve upgrade today. Stripe webhook handler exists, plan tables exist, billing UI exists, zero checkout session. Wire `stripe.checkout.sessions.create`, handle `checkout.session.completed` to flip plan. Without this: zero revenue.
- [ ] **Stripe customer portal** — let paying users manage/cancel their subscription without emailing support. One Stripe API call (`stripe.billingPortal.sessions.create`), redirect from `/settings/billing`.
- [ ] **Sponsors payment rails** — `sponsorship_tiers` and `sponsorships` tables exist, UI exists, payment deferred. Wire Stripe Payment Links or Checkout for recurring sponsorships. Maintainers need to actually receive money.
- [ ] **Pricing page conversion** — `/pricing` exists but copy is not conversion-optimised. Lead with the 90-second spec-to-PR number. Add a comparison table that makes Free look good (drives signups) and Pro look obvious (drives upgrades). Remove all "sleep/wake up" language.
- [ ] **API usage dashboard** — `/settings/usage` page wiring `aiCostEvents` table. Paid users have no visibility into token spend, rate limit history, or quota usage. Required before charging per-AI-call.
- [ ] **AI budget enforcement** — `aiBudgets` table exists with monthly spend caps. Verify enforcement is actually wired: when cap is hit, AI features degrade gracefully (return fallback, notify user) rather than silently continuing and racking up cost.
- [ ] **Free tier viral loop** — make every free user a growth channel. After each AI action, surface a shareable card: "AI just merged my PR in 90 seconds on @gluecron". `/api/v2/me/ai-savings/share` OG-image endpoint. Twitter/LinkedIn share buttons on the AI hours-saved dashboard widget.

---

## 🟠 PRIORITY 2 — Messaging (Affects Every Page, Fix Fast)

The current pitch ("label an issue, walk away, wake up to a merged PR") positions Gluecron as slow and async. Developers sit at their computer and want it done NOW. Every page needs to lead with speed.

- [ ] **Landing hero rewrite** (`src/views/landing.tsx`) — new headline: "Write the spec. Gluecron ships it." Subhead: "Spec to PR in 90 seconds. Push to live in 25. AI review, gates, merge — all automatic." Remove async framing. Add live counter showing specs-to-PRs fired today.
- [ ] **Landing "what just happened" rail** — replace any async/overnight copy with real-time event examples: "PR #47 auto-merged 12 seconds ago", "AI flagged a secret in push 3 minutes ago", "Spec shipped to PR in 1m 43s". Makes it feel alive and instant.
- [ ] **vs-github AI rows rewrite** (`src/routes/vs-github.tsx`) — reframe the 10 AI-native rows around latency not capability. GitHub Copilot waits for you to type. Gluecron acts in seconds. Add actual timing numbers to each row.
- [ ] **Demo page rewrite** (`src/routes/demo.tsx`) — replace "watch autopilot work" framing with a live ticker of things happening right now: PRs merging, AI reviews posting, specs being built. Make it feel like a stock ticker for developer productivity.
- [ ] **Sleep Mode demoted** (`src/routes/sleep-mode.tsx`) — move sleep mode marketing to the bottom of feature pages only. It's a useful secondary feature, never the headline. Primary pitch everywhere = instant results.
- [ ] **All OG/meta descriptions** — audit every `<meta description>` and OG tag across the app. Strip "wake up to" and replace with speed language.
- [ ] **Email templates** — the transactional emails (notifications, digests) likely echo the async pitch. Update to celebrate what just happened instantly, not what built up overnight.

---

## 🟡 PRIORITY 3 — Product: Verify What's Built (Routes Exist, Status Unknown)

The codebase has many routes that aren't in the BUILD_BIBLE scorecard. Each needs to be opened in a browser, tested end-to-end, and confirmed working or flagged as broken/stub.

- [ ] **Voice-to-PR** (`src/routes/voice-to-pr.tsx`, 1072 lines) — record voice, get a draft PR. Huge UX differentiator. Is this actually working? Test the full flow: record → transcribe → spec → PR. If broken, fix or remove the route.
- [ ] **Per-repo AI chat** (`src/routes/repo-chat.tsx`) — chat with Claude about a specific repo. Distinct from the global `/ask`. Test: open a repo, go to chat, ask a code question, verify context is scoped to that repo.
- [ ] **Personal cross-repo chat** (`src/routes/personal-chat.tsx`) — chat with Claude across all your repos. Test the context window and repo-switching.
- [ ] **Standup reports** (`src/routes/standups.tsx`) — auto-generated standup from recent activity. What does it generate? Is it useful? Test for a real repo with recent commits/PRs.
- [ ] **Multi-repo refactoring** (`src/routes/refactors.tsx`) — AI-driven refactor that opens PRs across multiple repos simultaneously. Verify `multiRepoRefactors` + `multiRepoRefactorPrs` tables are wired. Test the full flow.
- [ ] **Build agent spec** (`src/routes/build-agent-spec.tsx`) — AI spec builder UI. Is this the same as spec-to-PR or a different flow? Clarify and document.
- [ ] **Migration assistant** (`src/routes/migration-assistant.tsx`) — AI-assisted migration tool. What does it migrate? Code patterns, framework versions? Test and document.
- [ ] **Comment moderation** (`src/routes/comment-moderation.tsx`) — spam/abuse filtering queue. Test: post a spam comment, verify it enters the moderation queue, approve/reject works.
- [ ] **Interactive playground** (`src/routes/playground.tsx`) — what is this? Test it. If it's a Claude Code sandbox, make it prominent. If it's broken, fix or remove.
- [ ] **PR live co-editing** (`src/routes/pr-live.ts`) — `prLiveSessions` table exists. Real-time cursor sharing on PRs? Test with two browsers simultaneously.
- [ ] **Hosted Claude loops** (`src/routes/claude-deploy.tsx`, `hostedClaudeLoops` table) — Claude agents running as persistent loops on user repos. Verify the UI, test creating a loop, verify it runs, verify cost is tracked in `aiCostEvents`.
- [ ] **Cloud dev environments** (`src/routes/dev-env.tsx`, `devEnvs` table) — Codespaces equivalent. Massive feature if working. Test: create a dev env for a repo, verify it spins up (or that it's a stub that needs implementation).
- [ ] **Branch preview URLs** (`src/routes/previews.tsx`, `branchPreviews` table) — per-branch preview deployments. Verify this is wired to the workflow runner and actually generates live URLs.
- [ ] **PR sandbox** (`src/routes/pr-sandbox.ts`, `prSandboxes` table) — runnable PR environment. Test: open a PR, create sandbox, verify it runs.
- [ ] **Slack/Discord/Teams integration** (`src/routes/integrations-chat.ts`, `chatIntegrations` table) — notifications into chat channels. Test connecting a Slack workspace, push an event, verify message arrives.
- [ ] **Google OAuth login** (`src/routes/google-oauth.tsx`) — sign in with Google. Test the full OAuth flow: click → Google → callback → logged in.
- [ ] **Connect Claude** (`src/routes/connect-claude.tsx`) — distinct from `/connect/claude-guide`. What does this do? Clarify.
- [ ] **Import secrets** (`src/routes/import-secrets.tsx`) — import secrets from GitHub/Vault/env file into workflow secrets. Test the full flow.
- [ ] **Agent settings** (`src/routes/settings-agents.tsx`) — per-user agent configuration. What settings exist? Verify UI is complete.
- [ ] **Integration settings** (`src/routes/settings-integrations.tsx`) — user-level integrations (Slack, Linear, etc.). Verify complete.
- [ ] **Activity feed** (`src/routes/activity.tsx`) — distinct from the dashboard feed. Test and verify it's showing meaningful data.
- [ ] **Message inbox** (`src/routes/inbox.tsx`) — distinct from notifications. What goes here? Verify it's working.
- [ ] **Admin > Diagnose** (`src/routes/admin-diagnose.tsx`, 1337 lines) — stale issue/PR detection, suspicious pattern detection. Test each diagnostic and verify results are accurate.
- [ ] **Admin > Self-host wizard** (`src/routes/admin-self-host.tsx`, 1240 lines) — bootstrap automation for self-hosting. Test the full setup flow.
- [ ] **Admin > Server targets** (`src/routes/admin-server-targets.tsx`) — SSH deploy targets UI. Verify admin can add a target and trigger a deploy.
- [ ] **Admin > Advancement flags** (`src/routes/admin-advancement.tsx`) — per-block feature gating. Verify all flags are wired to their features.
- [ ] **Admin > Integration secrets** (`src/routes/admin-integrations.tsx`) — admin sets Anthropic API key, Resend key, GitHub OAuth keys from the UI. Verify each saves correctly and the feature it powers activates.
- [ ] **2030 landing page** (`src/views/landing-2030.tsx`) — future landing page in the codebase. What is this? Is it a planned redesign? Decide: ship it or delete it.
- [ ] **Legal pages** — terms, privacy, DMCA, acceptable-use exist as routes. Verify: (1) actual legal text is there (not placeholder), (2) linked from footer, (3) accessible to logged-out users.

---

## 🟢 PRIORITY 4 — Product: Known Gaps (Confirmed Not Built)

### Core Infrastructure
- [ ] **SSH git push** — SSH keys stored in DB, Smart HTTP documented, but `git clone git@gluecron.com:user/repo.git` may not work. Test from a clean machine. If broken: implement SSH server (ssh2 library, key lookup, `git-upload-pack`/`git-receive-pack` subprocess). Many devs refuse HTTPS for git.
- [ ] **Container registry (Docker/OCI)** — npm registry shipped, schema ready for containers, OCI protocol not implemented. Wire: `GET /v2/`, blob upload/download, manifest push/pull. Without this, Docker users cannot fully leave GitHub.
- [ ] **Server targets — customer rollout** — SSH deploy targets (Block ST) are admin-only. Expose `/settings/deploy-targets` for all users: add target (host, user, private key, deploy script), push-to-deploy from any branch. The "push and it's live in 25 seconds" story needs this for customer repos, not just Gluecron.com itself.
- [ ] **Redis SSE** — live comment updates, PR live view, push watch use single-process in-memory broadcaster. Multi-instance deploys break it. Replace with Redis pub/sub behind the same `sse.ts` interface.
- [ ] **Workflow cache SAVE** — CI caching only does LOAD. Save-on-job-success unimplemented. Every CI run after the first is cold. Wire the SAVE half of the cache action.
- [ ] **Pack-content ruleset enforcement** — `commit_message_pattern`, `blocked_file_paths`, `max_file_size` in rulesets need actual git pack inspection. Currently advisory for those types. Implement in `src/lib/push-policy.ts`.

### AI & Automation
- [ ] **Spec-to-Live full pipeline** — currently Spec→PR. Wire the rest: PR opens → AI review fires → gates run → auto-merge → deploy → real-time browser notification showing elapsed time "merged in 1m 52s". Make the whole loop visible in the browser while it happens.
- [ ] **L7 skill files build step** — `scripts/install.sh` writes skill file bodies via heredocs that drift from canonical `.claude/skills/` files. Add a release step that materialises heredocs from actual files.
- [ ] **Skill bundle on import** — when a user imports a GitHub repo, the Claude Code skills should be bundled into the imported repo's `.claude/settings.json` automatically.
- [ ] **GitHub Actions → Gluecron YAML translator** — auto-translate `.github/workflows/*.yml` to `.gluecron/workflows/*.yml` at import time. Removes the biggest migration blocker.

### Developer Experience
- [ ] **Spec-to-PR real-time progress UI** — the spec form submits and... what does the user see? Wire a live progress view: "Analysing repo → Writing code → Creating branch → Opening PR → Done." This makes the 90-second wait feel fast, not slow.
- [ ] **Bulk issue operations polish** — bulk close/reopen is in-flight per the BUILD_BIBLE. Verify the floating action bar and checkboxes are complete and working.
- [ ] **K3 tasks on `/admin/autopilot`** — `auto-merge-sweep` and `ai-build-from-issues` run every tick but aren't in the admin UI. Add them with last-run time and count stats.
- [ ] **System/autopilot user** — K3 posts marker comments credited to the PR/issue author. Create a synthetic `gluecron[bot]` user row so autopilot actions show a bot avatar, not a human's name.
- [ ] **@mention autocomplete on commit messages** — mention-autocomplete wires textareas. Extend to the web editor commit message field.
- [ ] **Workflow artifact retention policy** — artifacts accumulate forever. Add 90-day default with per-repo override and autopilot cleanup task.
- [ ] **L1 sleep-mode column** — sleep-mode digest and weekly digest share `last_digest_sent_at`. Split to `last_sleep_digest_sent_at` to avoid starving one feed.
- [ ] **GitHub unlink route** — `/settings/sso/unlink` removes any SSO link. Add `/settings/github/unlink` for GitHub OAuth users specifically.
- [ ] **AI commit message audit events** — `audit()` call missing from `generateCommitMessage`. Adds the L9 hours-saved counter line item for commit message generation.

---

## 🔵 PRIORITY 5 — Customer-Facing Sections (Must Look Complete and Polished)

### The "Now" Dashboard Experience
- [ ] **Dashboard "AI just did this" widget** — top of dashboard, shows what autopilot did in the last hour: PRs auto-merged, specs shipped, secrets repaired, AI reviews posted. Real-time feel. Not "last 7 days" — "last hour."
- [ ] **Push Watch → make it prominent** (`/:owner/:repo/push/:sha`) — the page exists. Add a "Live" link directly on the repo header that lights up after every push and shows the push-to-live progress bar. This is the "wow" moment new users need to see.
- [ ] **Repo overview: health badge + AI stats** — health score badge top-right of repo header. Below the file tree: "AI merged 3 PRs this week · Saved ~4.5 hrs · 0 open security alerts." Makes AI value visible at a glance.
- [ ] **Notification preferences overhaul** — `/settings/notifications` is a flat list. Restructure into categories: AI activity, CI/CD, code review, mentions/assigns. Per-category email + push + in-app toggle.

### Admin Panel (Must Be Production-Grade)
- [ ] **Admin > AI cost breakdown** — total AI spend this month, cost per feature type (review vs triage vs completion vs chat), top spenders. Unit economics tracking.
- [ ] **Admin > Stripe sync view** — Stripe subscription status per user vs local plan. Flag mismatches. Allow manual sync.
- [ ] **Admin > Autopilot health dashboard** — last tick time, tasks completed per tick, error rates, average tick duration. Time-series chart showing autopilot activity.
- [ ] **Admin > Mirror status** — failed mirrors, sync lag, last successful sync. Alert column for repos that haven't synced in 24h.
- [ ] **Admin > Email deliverability** — sent/bounced/failed counts from Resend. Currently fire-and-forget with zero visibility.
- [ ] **Admin > User growth chart** — signups over time, activation rate (users who created a repo), conversion rate (free → paid). Business health at a glance.
- [ ] **Admin > Revenue dashboard** — MRR, new subscribers this month, churn, plan distribution. Pull from Stripe API.

### Onboarding Flow
- [ ] **Onboarding email sequence** — after signup, users should get: (1) welcome + quick start at T+0, (2) "try spec-to-PR" prompt at T+1 day, (3) "here's what AI did for repos like yours" at T+3 days. Resend sequences.
- [ ] **Empty state for new repos** — new repo with no code should show: "Push your first commit" with exact git commands + "Or import from GitHub" + "Or try Spec-to-PR to let AI write your first feature." Not a blank page.
- [ ] **Onboarding checklist widget on dashboard** — for users who haven't done: ☐ push a repo ☐ open a PR ☐ try spec-to-PR ☐ enable auto-merge. Disappears once complete.
- [ ] **`curl | bash` install flow** — `curl -sSL gluecron.com/install | bash` (L2) exists. Test on a clean machine. Verify it: signs in, mints PAT, writes Claude Desktop config, imports a repo. Fix any broken steps.

### Help & Documentation
- [ ] **Documentation site** — `/help` exists as a migration cheatsheet. Need a proper docs site: Getting Started, CLI reference, API reference, MCP server setup, workflow YAML syntax, migration guide. Could be `/docs` served from git or a separate subdomain.
- [ ] **Changelog / what's new** — users have no way to know what shipped. Add `/changelog` showing recent releases with AI-generated notes. Feeds trust.
- [ ] **In-app contextual help** — "?" icons next to non-obvious features (DORA metrics, rulesets, merge queues) that expand a tooltip or link to docs.
- [ ] **Status page completeness** — `/status` and `/status.svg` exist. Verify: uptime history, incident history, subscribe-to-alerts link. Make it look like Atlassian Status Page quality.

---

## 🟣 PRIORITY 6 — Growth & Ecosystem

### Acquisition
- [ ] **60-second demo video** — screen record: type a spec → watch AI write code → PR opens → AI review posts → gates pass → merged. Show the elapsed time counter. No voiceover. Embed on landing, `/demo`, `/vs-github`. This is the single highest-ROI marketing asset.
- [ ] **Zero-friction GitHub migration** — import page already exists but make it the primary CTA on landing for GitHub users. Add: "Migrate your entire GitHub org in 60 seconds" with a big button. The bulk import is built — just needs prominence.
- [ ] **`/vs-github` ongoing maintenance** — living document. As GitHub ships, update the table. Set a monthly reminder to review it.
- [ ] **HackerNews / dev community launch** — plan a Show HN post. The platform is substantial enough. Need: a live demo URL, the 60-second video, a clear "what's different" paragraph. Time it with the demo video completion.
- [ ] **Developer program page** — `/developer-program`: register as a marketplace app builder, revenue share terms, `gluecron-partner` badge, dedicated support. Required before the marketplace can grow organically.
- [ ] **Blog / devlog** — even a simple `/blog` with monthly updates. Developers follow platforms that ship visibly. Show the build.

### Distribution
- [ ] **VS Code extension → publish to VS Code Marketplace** — `vscode-extension/` is built. Run `vsce package`, publish. Free discovery from millions of VS Code users.
- [ ] **CLI → publish to npm** — `cli/gluecron.ts` is built. Publish as `gluecron` npm package. `npx gluecron login` as zero-install entry point.
- [ ] **CLI → Homebrew formula** — add to homebrew-core or a tap. `brew install gluecron`. Mac developer standard.
- [ ] **JetBrains plugin** — IntelliJ, WebStorm, GoLand users. Kotlin plugin, same four commands as VS Code extension. Covers the second-largest IDE population.

### Platform Expansion
- [ ] **Agent marketplace — real listings** — currently 4 seed listings. Need 20+ real agents with real installs. Reach out to 10 developers to build and list agents. Create a "build an agent" tutorial.
- [ ] **Dependency network graph UI** — `repositoriesDependingOn()` is implemented in `src/lib/deps.ts`. Wire `/:owner/:repo/dependencies/dependents` — "who depends on me?" page. Big for open source maintainers.
- [ ] **Multi-agent pipeline UI** — `agentSessions` + `agentLeases` tables exist. Wire a UI to define pipelines: Agent A writes, Agent B reviews, Agent C deploys. The future of automated software teams.
- [ ] **AI pair programmer (browser)** — real-time Claude session in the browser alongside the file editor. Think Cursor-in-a-tab. Uses web editor + AI completion endpoint + SSE for live edits. Biggest competitive moat against Cursor/Copilot.

---

## ⚫ PRIORITY 7 — Strategic / Long-Term

### Enterprise
- [ ] **SOC 2 Type II** — engage an auditor, scope controls, begin evidence collection. 6–9 months to certification. Without it: no mid-market or enterprise deals close, regardless of features.
- [ ] **EU data residency** — Neon postgres EU region + Fly.io EU region. "Data region" selector at org creation. Enterprise legal requirement in many EU companies.
- [ ] **GDPR full deletion cascade** — verify: repo bare git dir deleted, issues/PRs/comments purged or anonymised, tokens revoked, audit log entries anonymised. Confirm grace period implementation is complete.
- [ ] **Audit log SIEM export** — `GET /api/v2/audit?since=&format=json` for Splunk/Datadog/Elastic integration. Required by enterprise security teams.
- [ ] **Enterprise sales page** — `/enterprise`: custom pricing, SSO/SAML, dedicated support SLA, audit log export, data residency. Contact form → Calendly.
- [ ] **99.9% SLA commitment** — write it down, publish it. Enterprises need a contractual uptime commitment before signing.

### Mobile
- [ ] **Native iOS app** — the only ❌ in the entire platform scorecard. Minimum viable: repo browser, notifications, PR approve/reject, AI chat. React Native for code share with Android.
- [ ] **Native Android app** — same codebase as iOS via React Native.
- [ ] **PWA push notification fix** — Web Push (M8) is implemented. Verify push notifications actually arrive on mobile browsers (iOS Safari is particularly finicky with Web Push standards).

### Reliability
- [ ] **End-to-end test suite** — unit tests are 1491 passing. But is there a full E2E suite (Playwright/Puppeteer) covering: register → create repo → push code → open PR → AI review fires → merge? This is what catches regressions in the full flow.
- [ ] **Load testing** — what happens at 1000 concurrent git pushes? At 10k concurrent web sessions? Run k6 or Artillery before any growth push.
- [ ] **Database connection pooling** — Neon + Drizzle direct connection. Under load, connection limits become the bottleneck. Verify PgBouncer or Neon's built-in pooling is configured correctly.
- [ ] **Backup and recovery verification** — Neon has backups. Test restoration. Document the RTO/RPO. Required for SOC 2 and for not losing customer code.

---

## ✅ COMPLETED (Reference — Do Not Redo)

Everything in `BUILD_BIBLE.md §2` marked ✅ is shipped. Key capabilities:

**Git hosting:** clone, push, fetch, SSH key storage, forking, stars, topics, archiving, templates, mirroring, repository transfer, public/private visibility

**Code browsing:** file tree, syntax highlighting (40+ languages), blame, diff, raw, branch/tag switcher, commit history, semantic search, symbol navigation, dependency graph, security advisories, commit signature verification, repository rulesets

**Collaboration:** issues, PRs, inline comments, draft PRs, reactions, mentions, notifications, discussions, wikis, gists, projects/kanban, milestones, code owners, issue/PR templates, saved replies, merge queues, required checks, protected tags

**CI/CD:** workflow runner (GitHub Actions equivalent), workflow secrets, matrix builds, caching (LOAD), environments with approval gates, deployment tracking, branch protection, gate runs, auto-repair, secret scanner

**AI (all wired, not stubs):** code review (blocks merges), PR/issue triage, changelogs, test generation, spec-to-PR, auto-merge (K2), AI build from issues (K3), codebase explanation, dependency updater, merge conflict resolver, commit message suggestion, PR description suggestion, copilot completions, sleep-mode digest (L1), AI hours saved (L9)

**Platform:** organizations, teams, SSO/OIDC, 2FA/TOTP, WebAuthn/passkeys, OAuth 2.0 provider, GitHub sign-in (L6), MCP server (K1), Claude Code skills (L7), VS Code extension (G4), CLI (G3), GraphQL API, REST v2, package registry (npm), static hosting (Pages), marketplace, DORA metrics, velocity, health score, hot files, pulse, traffic analytics, admin panel, billing infrastructure, audit logs, rate limiting, observability, PWA, SEO

**Marketing shipped:** landing hero (L10), vs-github page (L5), pricing page (L8), demo page (L3), public stats counters (L4), install script (L2), onboarding flow, help page, keyboard shortcuts, command palette

---

## How to Use This File

- `- [ ]` = not started
- `- [x] YYYY-MM-DD commit:abc1234` = done
- Add new gaps here as they're discovered
- When in doubt about priority, Revenue (P1) > Messaging (P2) > Verify existing (P3) > Build new (P4+)
