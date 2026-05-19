# Gluecron Roadmap & Checklist

**Living document. Last updated: 2026-05-17. Edit as items move.**

This is the single source of truth for what's done, what's in flight, what's
critical for the next demo, and what's queued for after. If it's not on this
list, it's either not real or not committed to. Update it every time we
ship something or learn something new.

---

## 🚨 BLOCKING — must do before tomorrow's onboarding

These take ~10 minutes total. Without them the demo doesn't show what gluecron actually is.

- [ ] **SSH to Hetzner box, edit `/etc/gluecron.env`, add:**
  - [ ] `ANTHROPIC_API_KEY=sk-ant-...` (from console.anthropic.com)
    - Without this: AI PR review, AI incident responder, AI commit messages, AI auto-merge, AI spec-to-PR are ALL silent no-ops. The entire "AI-native git host" pitch is dark.
  - [ ] `EMAIL_PROVIDER=resend`
  - [ ] `RESEND_API_KEY=re_...` (from resend.com — free tier covers thousands of emails)
  - [ ] `EMAIL_FROM=noreply@gluecron.com` (or whatever domain you have set up)
  - [ ] `GATETEST_API_KEY=...` (so push-time security scans actually run instead of silent no-op)
  - [ ] `DEPLOY_EVENT_TOKEN=$(openssl rand -hex 32)` (also add the SAME value to GitHub repo Settings → Secrets → Actions)
  - [ ] `SELF_HOST_REPO=ccantynz-alt/Gluecron.com` (fixes the "platform repo not found" warn)
- [ ] `systemctl restart gluecron` to pick up the env vars
- [ ] Open `/admin/health` — confirm everything turns green/non-red

- [ ] **Configure social sign-in (optional but valuable):**
  - [ ] `/admin/google-oauth` — paste Google OAuth Client ID + Secret
  - [ ] `/admin/github-oauth` — paste GitHub OAuth Client ID + Secret

- [ ] **Dry-run the demo in incognito:**
  - [ ] Sign up as a fake user
  - [ ] Verify the auto-verify fallback works (no email needed)
  - [ ] Create a repo
  - [ ] Push some code (use a small public repo)
  - [ ] File an issue labelled `ai:build` — confirm autopilot picks it up
  - [ ] Open a PR — confirm AI review fires (now that ANTHROPIC_API_KEY is set)
  - [ ] Merge the PR

---

## 🟡 IN FLIGHT — finishing now

- [ ] **4 polish agents still running:**
  - [ ] Agent J — `/help` page polish
  - [ ] Agent K — marketing pages (`/features`, `/about`, `/vs-github`)
  - [ ] Agent L — `/settings/tokens` (PAT creation)
  - [ ] Agent M — `/:owner/:repo/compare` (branch compare for new PRs)
- [ ] **Agent N (repo settings)** committed `c14f275` to worktree — cherry-pick onto main with the others when batch completes

---

## ✅ DONE this session (commits already on main)

### Reliability sweep (Phase 1)
- [x] AA reload loop killed (PWA ripped out, kill-switch shipped) — `d7ba05d`, `44fe49b`, `904927d`
- [x] Hetzner deploy git-remote URL fixed (was 404'ing 17h) — `ec16b67`
- [x] Minimum-viable Hetzner script with `set -x` tracing — `d8b9606`
- [x] Migration step re-added to deploy — `a358c63`
- [x] AUDIT.md + AUDIT-v2.md produced (4-agent + 5-agent audits)
- [x] Silent failure sweep across 18 files — `a28cede`
- [x] `/admin/health` + JSON endpoint + autopilot/deploy/queue/crontech checks — `115c66b`
- [x] AI incident responder for platform deploy failures — `89a0761`
- [x] Deploy paths unified (`scripts/self-deploy.sh` is canonical) — `ff4423b`
- [x] `/admin/diagnose` auto-merge check uses SELF_HOST_REPO — `a3b6378`

### Polish — marketing surfaces (Phase 2.1)
- [x] Web fonts (Inter + Inter Tight + JetBrains Mono) — `3a5755e`
- [x] Animated hero blobs + bigger headline — `3a5755e`
- [x] Pricing: "One subscription. Replaces three on GitHub." + bundle-math card — `13ac035`
- [x] Login + Register premium gateway feel — `98f45b4`
- [x] Global page entrance animation + accent focus rings — `ed6e438`

### Polish — auth + dashboard (Phase 2.2)
- [x] Real Sign in with Google (`/admin/google-oauth` + login button + tests) — `582cdac`
- [x] Dashboard: greeting eyebrow + gradient title + animated orb — `a004c46`

### Polish — app-level surfaces (parallel batch 1)
- [x] Repo home page (`/:owner/:repo`) — `544d842`
- [x] Issues UI (list + detail, AI-comment treatment) — `f7ad7b8`
- [x] Pull requests UI (list + detail, gate-status + merge card) — `b078860`
- [x] User settings (8 section cards + danger zone) — `98eb360`

### Polish — onboarding surfaces (parallel batch 2)
- [x] Code browse (file viewer + commit detail + new repo + profile + per-repo search) — `efb11c5`
- [x] Notifications page (hero + filter pills + AI-row treatment) — `fd8be1f`
- [x] Import flow (`/import` + `/import/bulk`) — `7a99d47`
- [x] Discovery (`/explore` + `/search`) — `283fbc2`
- [x] Admin panel (hero + stat cards + 11-tile action grid) — `07f4b70`

**Cumulative this session: 20+ commits on main. 2011/2011 tests pass. TypeScript clean.**

---

## 🟢 SHOULD ship tonight if time (high leverage, low risk)

- [ ] **Build `/admin/integrations` page** — env vars via UI instead of SSH'ing to the box. ~1.5 hrs.
  - DB-stored config (encrypted secret column)
  - `getConfigValue(key)` helper that checks DB first, env var fallback
  - Site-admin gated form for ANTHROPIC_API_KEY, RESEND_API_KEY, GATETEST_URL+KEY, CRONTECH_DEPLOY_URL+SECRET, DEPLOY_EVENT_TOKEN
  - Audit log every change
  - Demo moment: paste ANTHROPIC_API_KEY in admin UI → watch AI features turn green on `/admin/health` live
- [ ] **Sub-30s deploys for code changes:**
  - [ ] Lockfile-hash cached `bun install` (skip when bun.lock unchanged) — ~10 min
  - [ ] Migration skip when no new `drizzle/*.sql` files — ~10 min
  - [ ] CSS-only fast path (if diff is only in `src/views/`, skip migrations + smoke) — ~15 min

---

## 📋 KNOWN BUGS (from AUDIT-v2.md P1 list — not yet fixed)

- [ ] Repo-scoped routes 500 instead of 404 on missing record (issues, pulls, packages, releases, security, symbols, sponsors) — each needs a try/catch
- [ ] No DB-blip resilience middleware — every page blocks 5-15s on a sick DB
- [ ] No Fly rollback path (Hetzner has one, Fly doesn't)
- [ ] Workflow log truncation has no UX warning
- [ ] Dead schema: `pr_risk_scores` table never written to
- [ ] Dead code: `scripts/deploy-crontech.sh` not invoked
- [ ] `/admin/sso`, `/admin/github-oauth`, `/admin/mirrors/sync-all` use middleware `requireAuth` but rely on inline `isSiteAdmin()` — inconsistent pattern, not insecure
- [ ] Documentation drift: BUILD_BIBLE.md (4500 lines) and CLAUDE.md both contain claims that don't match code

---

## 🎨 SURFACES still unpolished (post-tomorrow polish queue)

### Repo-scoped features
- [ ] `DiffView` component itself (used inside polished commit + PR pages — only surrounding card is polished)
- [ ] Releases (`releases.tsx`)
- [ ] Contributors / Insights (`contributors.tsx`, `insights.tsx`)
- [ ] Traffic analytics (`traffic.tsx`)
- [ ] Dependencies (`deps.tsx`)
- [ ] Security advisories / code scanning (`advisories.tsx`, `code-scanning.tsx`)
- [ ] Symbols / xref nav (`symbols.tsx`)
- [ ] AI features pages (`ask.tsx`, `ai-changelog.tsx`, `ai-explain.tsx`, `ai-tests.tsx`)
- [ ] Workflows / Actions (`workflows.tsx`)
- [ ] Gates / branch protection / rulesets / required checks / protected tags (`gates.tsx`, `rulesets.tsx`, `required-checks.tsx`, `protected-tags.tsx`)
- [ ] Environments + Deployments (`environments.tsx`, `deployments.tsx`)
- [ ] Webhooks (`webhooks.tsx`)
- [ ] Web file editor (`editor.tsx`)

### Settings sub-pages
- [ ] 2FA setup (`settings-2fa.tsx`)
- [ ] Passkeys (`passkeys.tsx`)
- [ ] Developer apps / OAuth apps (`developer-apps.tsx`)
- [ ] Audit log (`audit.tsx`)
- [ ] Sponsors (`sponsors.tsx`)
- [ ] Saved replies (`saved-replies.tsx`)
- [ ] Marketplace (`marketplace.tsx`)
- [ ] Workflow secrets (`workflow-secrets.tsx`)
- [ ] Signing keys (`signing-keys.tsx`)

### Specialized routes
- [ ] Orgs (new, view, members, teams) — `orgs.tsx`, `org-insights.tsx`
- [ ] Wiki pages — `wikis.tsx`
- [ ] Discussions / forums — `discussions.tsx`
- [ ] Project boards / kanban — `projects.tsx`
- [ ] Gists — `gists.tsx`
- [ ] Packages — `packages.tsx`
- [ ] Playground (`/play` — anonymous try-it) — `playground.tsx`
- [ ] Demo (`/demo` — live demo with tiles) — `demo.tsx`

### Admin sub-pages
- [ ] `/admin/ops` (Operations console) — `admin-ops.tsx`
- [ ] `/admin/deploys` (deploy timeline) — `admin-deploys-page.tsx`
- [ ] `/admin/status` (synthetic monitor) — `admin-status.tsx`
- [ ] `/admin/self-host` (self-host config) — `admin-self-host.tsx`
- [ ] `/admin/sso` (Enterprise SSO config) — `sso.tsx`
- [ ] `/admin/github-oauth` (already styled — minor polish only)

### Cross-cutting
- [ ] Loading skeletons (`skeleton.tsx` exists, not used everywhere)
- [ ] Empty states across niche routes
- [ ] Error pages 404 / 500 / 403 (`error-page.tsx`)
- [ ] Mobile responsive audit pass — ALL polished surfaces work on mobile but haven't been audited

---

## 🧪 UNTESTED categories

- [ ] **E2E browser flows** — no real-browser test runner wired (chromium download blocked in this Anthropic container)
- [ ] **Mobile responsive on real devices** — works on Chrome DevTools mobile sim, no physical device test
- [ ] **Accessibility (axe / Lighthouse)** — needs browser
- [ ] **Load test (k6 / locust)** — needs live infra hammering
- [ ] **Real security pentest** — GateTest configured but API key not set, scans silently no-op
- [ ] **Cross-browser** (Safari, Firefox, Edge) — one container, one engine

---

## 🚀 "LIGHTNING YEARS AHEAD" roadmap (post-onboarding)

Ordered by **leverage per hour**. The first 3 are the differentiators that competitors don't have.

### Tier 1 — true product differentiators
1. [ ] **GateTest aggregation platform** — extend GateTest to be the unified scan-results surface. Playwright (E2E), k6 (load), axe (a11y), and the existing GateTest static scanner all POST results to the same `/api/v1/gate-runs` endpoint. One UI shows everything. Genuinely new product positioning. **~3-4 hrs.**
2. [ ] **Multi-agent CI on every PR** — code reviewer (exists), security reviewer (new), QA agent that tries to break the PR (new), all run in parallel. Surfaces three independent AI perspectives. **~4-6 hrs.**
3. [ ] **AI proactive monitoring** — hourly autopilot task that reads recent logs + audit_log via Claude and opens issues like "I noticed memory growth on workflow-runner". Goes from reactive to proactive. **~3-4 hrs.**

### Tier 2 — speed + polish wins
4. [ ] **Sub-30s deploys** (already partially listed under "Should ship tonight")
5. [ ] **Mobile responsive pass** — design audit + fix across all polished surfaces. **~3-4 hrs.**
6. [ ] **`DiffView` component rebuild** — the diff renderer used in commit/PR pages. Currently plain. Make it Vercel-quality. **~2-3 hrs.**

### Tier 3 — new capabilities
7. [ ] **Realtime collaboration on issues/PRs** — multiple users editing same draft simultaneously. SSE infra exists, needs the merge layer. **~6-8 hrs.**
8. [ ] **Visual workflow editor** — DAG editor for `.gluecron/workflows/*.yml` instead of YAML. **~10-15 hrs.**
9. [ ] **Time-travel state explorer** — replay any past state of an issue/PR/repo. Differentiation nobody has. **~10-15 hrs.**
10. [ ] **Self-host one-click installer** — `curl gluecron.com/install-server | bash` for a full gluecron on any Linux box in 60s. **~6-8 hrs.**

### Tier 4 — infrastructure / enterprise
11. [ ] **Edge-network deploy** — Cloudflare Workers in front of Hetzner. Sub-100ms anywhere on earth.
12. [ ] **Comprehensive API docs site** — `/api-docs` exists but plain. Should be Stripe-quality.
13. [ ] **Localization** — English-only today.
14. [ ] **SOC2 compliance path** — for enterprise customers.
15. [ ] **Mobile PWA done right** — properly architected this time (not the broken one we ripped out).

---

## 📊 Latest commits on main (auto-updated, top of `git log`)

Run `git log --oneline -15` to see what's actually shipped. The HEAD SHA the live server is running can be confirmed at `https://gluecron.com/version`.

---

## How to update this file

- Move items between sections as they ship / change priority
- Don't delete items — strike them through or move to a "shipped" log
- Update the date at top whenever you edit
- Commit the change so it persists for everyone (future you, future Claude, anyone else looking at the repo)
