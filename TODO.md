# Gluecron Master To-Do List

Last updated: 2026-06-06

Track progress here. Check off items as they ship. Work top-to-bottom — priority order.

---

## 🔴 PRIORITY 1 — Revenue-Blocking (Do These First)

- [ ] **Stripe Checkout flow** — users cannot self-serve upgrade from Free to Pro/Team/Enterprise. Stripe webhook handler exists, plan tables exist, billing UI exists, but there is zero Stripe Checkout session. Wire `stripe.checkout.sessions.create`, redirect to `/settings/billing?success=1`, handle `checkout.session.completed` webhook to flip `userQuotas.plan`. Without this, zero revenue from the product.
- [ ] **Verify SSH git push works** — SSH keys are stored in the DB (`ssh_keys` table, `/settings` UI) but the documented protocol is Smart HTTP only. Test `git clone git@gluecron.com:user/repo.git` from a fresh machine. If broken, implement SSH git server (ssh2 library, key lookup, git-upload-pack/receive-pack subprocess). Many devs refuse HTTPS for git.
- [ ] **API usage dashboard for customers** — users on paid plans have no visibility into their AI token spend, rate limit history, or quota usage. Wire `aiCostEvents` table into a `/settings/usage` page with charts. Required before charging for AI usage.

---

## 🟡 PRIORITY 2 — Scale-Blocking (Required Before Heavy Traffic)

- [ ] **Redis-backed SSE fan-out** — live comment updates, PR live view, push watch all use single-process in-memory broadcaster (`src/lib/sse.ts`). In a multi-instance deploy, events only reach subscribers on the same process. Replace the in-process broadcaster with Redis pub/sub. Existing `sse.ts` interface stays the same — only the transport layer changes.
- [ ] **Workflow cache SAVE** — CI caching only does LOAD (`src/lib/actions/cache-action.ts` TODO(v2)). The save-on-job-success path is unimplemented. Every CI run after the first gets a cold cache. Wire the SAVE half of the cache action so `node_modules`, cargo registry, pip cache etc. actually persist between runs.
- [ ] **Pack-content ruleset enforcement** — `commit_message_pattern`, `blocked_file_paths`, `max_file_size` in repo rulesets (`src/lib/rulesets.ts`) still need actual git pack inspection to enforce at push time. Currently advisory for those rule types only. Implement pack-content scanning in `src/lib/push-policy.ts`.

---

## 🟠 PRIORITY 3 — Product Completeness (Next 6 Months)

### Hosting & Infrastructure
- [ ] **Container registry (Docker/OCI)** — npm package registry is shipped (`src/lib/packages.ts`). Schema is ready for containers but the OCI push/pull protocol is not implemented. Wire Docker-compatible registry: `GET /v2/`, `HEAD /v2/:name/blobs/:digest`, `POST /v2/:name/blobs/uploads/`, `PUT /v2/:name/manifests/:ref`. This is why many teams can't fully leave GitHub.
- [ ] **Server targets — customer-facing rollout** — SSH deploy targets (Block ST) are admin-only. Expose `/settings/deploy-targets` for all users: add SSH target (host, user, private key, deploy script), push-to-deploy pipeline from any branch. This is the "push to Gluecron, it lands on your Hetzner box in 30 seconds" pitch.
- [ ] **Sponsors payment rails** — `sponsorship_tiers` and `sponsorships` tables exist, UI exists, but payment is deferred. Wire Stripe Payment Links or Checkout for recurring sponsorships. Maintainers need to be able to actually receive money.
- [ ] **Workflow artifact retention policy** — workflow artifacts accumulate indefinitely. Add a retention window (default 90 days, configurable per repo) with an autopilot cleanup task.

### AI & Automation
- [ ] **Spec-to-Live full pipeline** — currently Spec→PR. Wire the remaining loop: PR→AI review approval→auto-merge→deploy→smoke test→email/sleep-mode notification "done". The K2/K3 auto-merge and L1 sleep-mode exist separately — connect them into one end-to-end flow.
- [ ] **AI budget enforcement** — `aiBudgets` table exists with monthly spend caps. Verify the enforcement is actually wired: when `aiCostEvents` total for the month exceeds the cap, AI features should degrade gracefully (return fallback, notify user) rather than silently continuing.
- [ ] **L7 skill files build step** — `scripts/install.sh` writes `.claude/skills/` SKILL.md bodies via inline heredocs that can drift from the canonical files. Add a build/release step that materialises the heredocs from the actual skill files so they stay in sync.
- [ ] **Imported repos get skill bundle** — L7 skill files are only bundled into this repo + L2-installed users. When a user imports a GitHub repo, the skills should be bundled into the imported repo's `.claude/settings.json`.

### Developer Experience
- [ ] **@mention in commit messages** — `src/lib/mention-autocomplete.ts` wires `@mention` on comment textareas. Extend to the web file editor commit message field and the PR/issue title field.
- [ ] **Bulk issue operations polish** — bulk close/reopen via `POST /:owner/:repo/issues/bulk` is shipped but the floating action bar and checkboxes are flagged in-flight. Verify this is fully working.
- [ ] **K3 tasks surface on `/admin/autopilot`** — `auto-merge-sweep` and `ai-build-from-issues` run every tick but aren't listed in the admin UI. Add them to the autopilot dashboard with last-run + count stats.
- [ ] **System/autopilot user** — K3 auto-merge and ai-build marker comments are posted with the PR/issue author's ID because no system user exists. Create a synthetic `system` user (or add `is_system_comment` boolean to `pr_comments`/`issue_comments`) so autopilot actions aren't credited to the wrong human.
- [ ] **L1 sleep-mode uses shared `last_digest_sent_at`** — sleep-mode digest (L1) and weekly email digest (I7) both update `users.last_digest_sent_at`, which means a user opted into both could starve one feed. Add `users.last_sleep_digest_sent_at` as a separate column.
- [ ] **GitHub unlink route** — `/settings/sso/unlink` removes any SSO link including GitHub. Add `/settings/github/unlink` as a dedicated cleaner UX for L6 GitHub OAuth users.
- [ ] **AI commit message audit** — `audit_log` entries for `ai.commit_message.generated` aren't emitted. Add `audit()` call in `src/lib/ai-generators.ts generateCommitMessage` so the L9 hours-saved counter works for this line item.

---

## 🔵 PRIORITY 4 — Customer-Facing Sections (Needs to Look Polished)

### Marketing & Acquisition
- [ ] **60-second demo video** — record "label an issue, go to sleep, wake up to merged PR." This does more than any feature page. Embed on landing, `/demo`, and `/vs-github`.
- [ ] **Shareable AI hours saved card** — L9 hours-saved counter is on the dashboard. Add a `/api/v2/me/ai-savings/share` endpoint that generates an OG-image card (e.g. "I saved 14 hours this week with Gluecron") for Twitter/LinkedIn sharing. Viral growth lever.
- [ ] **`/vs-github` ongoing maintenance** — 26-row comparison table. As GitHub ships features, update this. Make it a living document, not a snapshot.
- [ ] **Pricing page A/B** — `/pricing` exists. Test different price points and feature-gating messaging. The current copy is functional but not conversion-optimised.
- [ ] **Developer program page** — for Marketplace app builders. Registration, docs, revenue share terms, `gluecron-partner` badge. Required before the Marketplace can grow organically.

### Admin Panel
- [ ] **Admin > AI costs overview** — total AI spend across all users this month, top spenders, cost per feature type (review vs triage vs completion). Needed for unit economics tracking.
- [ ] **Admin > Stripe sync** — view of Stripe subscription status per user alongside the local `billing_plans` override. Flag mismatches (paid in Stripe but free locally, or vice versa).
- [ ] **Admin > Autopilot health** — last tick time, tasks completed per tick, error rates, average duration. Currently `/admin/autopilot` has basic info — expand with time-series.
- [ ] **Admin > Mirror status dashboard** — `repo_mirrors` + `repo_mirror_runs` data. Show failed mirrors, sync frequency, lag behind upstream.
- [ ] **Admin > Email deliverability** — sent/failed/bounced counts from Resend. Currently email is fire-and-forget with no visibility into delivery.

### User Dashboard
- [ ] **Dashboard "AI work done for you" widget** — summary of what autopilot did in the last 7 days: PRs auto-merged, issues built by AI, secrets auto-repaired. One prominent widget at the top of the dashboard.
- [ ] **Notification preferences overhaul** — current `/settings/notifications` is a flat checkbox list. Restructure into categories (AI activity, CI/CD, reviews, mentions) with per-category granularity.
- [ ] **Repository health score on repo overview** — `computeHealthScore` exists and the `/insights/health` page is shipped. Add a small health score badge to the repo overview page (top-right corner of RepoHeader).

---

## 🟣 PRIORITY 5 — Strategic / Long-Term Moat

### Compliance & Enterprise
- [ ] **SOC 2 Type II preparation** — without this certification, no mid-market or enterprise deal closes. Engage an auditor, scope the controls (access control, encryption, incident response, change management, availability). Estimated 6–9 months.
- [ ] **EU data residency option** — enterprises need to know their code stays in the EU. Evaluate Neon postgres EU region + Fly.io EU region. Surface a "data region" selector at org creation.
- [ ] **GDPR account deletion** — verify the full deletion cascade: repos (with bare git dir), issues, PRs, comments, tokens, audit log anonymisation. There may be a grace period implementation already — confirm it's complete.
- [ ] **Audit log SIEM export** — the audit log UI exists. Add `GET /api/v2/audit?since=&format=json` for SIEM integration (Splunk, Datadog, etc.). Required for enterprise security teams.

### Platform Expansion
- [ ] **Native iOS app** — the only ❌ in the entire platform scorecard. PWA covers most of the ground but push notifications + Face ID login require native. Minimum viable: repo browser, notifications, PR approval. React Native or Swift.
- [ ] **Native Android app** — same as iOS. Could share React Native codebase.
- [ ] **Multi-agent workflow** — multiple AI agents collaborating: one writes, one reviews, one deploys, one monitors. The `agentSessions` + `agentLeases` tables exist. Wire a UI for defining multi-agent pipelines per repo.
- [ ] **AI pair programmer (browser-based)** — real-time collaborative coding session with Claude in the browser. Different from the file editor — think Cursor-in-a-tab. Uses the web editor + AI completion endpoint + SSE for live edits.
- [ ] **Dependency network graph UI** — `repositoriesDependingOn(ecosystem, name)` is implemented in `src/lib/deps.ts`. Wire a "who depends on me?" page at `/:owner/:repo/dependencies/dependents` showing the reverse graph. Big for open source maintainers.

### Ecosystem
- [ ] **GitHub Actions compatibility layer** — auto-translate `.github/workflows/*.yml` to `.gluecron/workflows/*.yml` at import time. Removes the biggest migration friction.
- [ ] **VS Code extension — publish to marketplace** — `vscode-extension/` is built. Package it (`vsce package`) and publish to VS Code Marketplace. Discovery is free distribution.
- [ ] **CLI — publish to npm/brew** — `cli/gluecron.ts` is built. Publish `gluecron` to npm (`npx gluecron`) and add a Homebrew formula. Zero-install entry point for new users.
- [ ] **JetBrains plugin** — after VS Code, JetBrains IDEs (IntelliJ, WebStorm, GoLand) are the next biggest developer surface. Kotlin plugin exposing the same four commands as the VS Code extension.

---

## ✅ COMPLETED (Reference)

Everything in the BUILD_BIBLE §2 marked ✅ is done. Key highlights:
- Git hosting, forking, stars, topics, archiving, templates, mirroring, transfer
- File browser, syntax highlighting, blame, diff, raw, branch switcher, tags
- Issues, PRs, inline comments, draft PRs, reactions, mentions, notifications
- Discussions, wikis, gists, projects/kanban, milestones
- GitHub Actions equivalent (workflow runner, secrets, matrix, caching LOAD)
- Package registry (npm), Pages (static hosting), Environments, Merge queues
- AI: code review, PR/issue triage, changelogs, test gen, spec-to-PR, auto-merge, autopilot
- MCP server (K1), Claude Code skills (L7), VS Code extension (G4), CLI (G3)
- Sleep Mode (L1), AI hours saved (L9), demo page (L3), vs-github page (L5)
- Organizations, teams, SSO/OIDC, 2FA/TOTP, WebAuthn/passkeys, OAuth provider
- DORA metrics, velocity, health score, hot files, pulse, traffic analytics
- Admin panel, billing infrastructure, audit logs, rate limiting, observability
- GraphQL API, REST v2, API docs, PWA manifest, SEO

---

## Notes

- Work through this top-to-bottom. Priority 1 before Priority 2, etc.
- When an item ships: replace `- [ ]` with `- [x]` and add the date and commit/PR reference.
- When a new gap is discovered: add it to the appropriate priority section.
- This file lives on branch `claude/platform-analysis-roadmap-1nUGL`. Merge to main after first review.
