# Gluecron Roadmap & Checklist

**Living document. Last updated: 2026-05-20. Edit as items move.**

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

## 📜 Platform Strategy Review — 2026-05-20 (external)

External spec review landed 2026-05-20. Two parts: tonight's fixes and a long-tail "20 killer moves" list. Track here so nothing falls through.

### Part 1 — Spec corrections (tonight)

- [x] **PR list pagination** — added `?limit` (default 30, max 100) + `?offset` to `GET /api/v2/repos/:owner/:repo/pulls` (commit `8c09fb9`)
- [ ] **Webhook retries + dead-letter** — in flight (agent on worktree). Exponential backoff (30s, 2m, 10m, 1h, 6h), max 6 attempts, status='dead' after that, new `webhook_deliveries` table
- [x] **OAuth admin scope** — verified `admin` is not in `SUPPORTED_SCOPES` (src/lib/oauth.ts:18-28). Third-party OAuth apps cannot acquire it; admin scope is PAT-only over session cookies
- [x] **GateTest timing** — verified runs as fire-and-forget post-receive (src/hooks/post-receive.ts:81-90). Never blocks the push, just notifies and updates commit status async
- [x] **Git credential security** — verified the codebase never exposes URL-embedded tokens to users (`src/lib/import-helper.ts:81-90` scrubs them from error output before display). Public integration spec updated to recommend git credential helper / Basic Auth password flow instead of URL-embed

### Part 2 — "20 killer moves" — graded by feasibility-from-here

Slotted into existing tiers above where overlapping, listed here when new.

**Native AI & agentic autonomy** (most strategic, partially built)
1. [ ] Deterministic agent runtimes — sandbox+repl in repo. Builds on existing workflow runner. **~12-16 hrs**
2. [ ] Push-time vector indexing — wire embeddings into `post-receive.ts`. Anthropic embeddings + pgvector. **~6-8 hrs**
3. [ ] Multi-file AST graph for MCP — extend the 15 MCP tools to expose structural deps. **~8-10 hrs**
4. [ ] Autonomous PR decoupling — new `ai/*` branch type that autopilot owns end-to-end. Pieces exist. **~6-8 hrs**
5. [ ] AI-driven taint patcher — extends `ai-review.ts`: when GateTest flags, Claude proposes the patch + opens a PR. **~4-6 hrs**

**High-performance self-hosting & independence**
6. [ ] Single-binary deploy — Bun's `bun build --compile`. Already feasible. **~2-3 hrs**
7. [ ] Multi-master replication — schema-level. Hard. **~weeks**
8. [ ] S3-backed git objects — git LFS-style with object storage. **~10-15 hrs**
9. [ ] Outbound-only tunnel — Cloudflare Tunnel template. **~2-3 hrs**
10. [ ] SSO on every tier — OIDC works; SAML + AD missing. **~6-8 hrs**

**Advanced CI/CD & security**
11. [ ] Local-runnable Actions — `gluecron act run` CLI mirroring runner image. **~6-8 hrs**
12. [ ] SLSA-style signed artifacts — sigstore + provenance attestation. **~4-6 hrs**
13. [ ] Sub-ms pre-receive secrets — true pre-receive, regex+entropy only (no taint). **~3-4 hrs**
14. [ ] Impact-aware CI scaling — runner pool by changeset size. **~6-8 hrs**
15. [ ] Compliance ledger export — `audit_log` exists. CSV/JSON export endpoint + retention policy. **~3-4 hrs**

**Developer experience & extensibility**
16. [ ] Realtime collaborative PRs — already Tier 3 #7 above
17. [ ] NNTP / IMAP / mailing-list bridge — wild but cheap. RFC-3977 NNTP server. **~10-12 hrs**
18. [ ] Programmable webhook pipelines — runs user JS/Wasm before delivery. Builds on the new retry queue. **~8-10 hrs**
19. [ ] Feature-flag controller — track flag state on merge. **~6-8 hrs**
20. [ ] Semantic code search — embeddings powered. Builds on #2 (push-time vector index). **~4-6 hrs**

---

## 🛰️ Spec Review Addendum — 2026-05-20 (Holden Mercer / agent-build API)

External addendum asked for the API surface an AI build agent needs to:
read files, write multi-file atomic commits, dispatch background builds.
12 endpoints across 3 groups. Status:

### Group 1 — File contents
- [x] `GET    /api/v2/repos/:owner/:repo/contents/:path` (was already built)
- [x] `PUT    /api/v2/repos/:owner/:repo/contents/:path` (was already built)
- [ ] `DELETE /api/v2/repos/:owner/:repo/contents/:path` (in flight tonight)

### Group 2 — Git plumbing (atomic multi-file commits)
- [x] `POST   /api/v2/repos/:owner/:repo/git/refs` (creating branches — already built)
- [ ] `GET    /api/v2/repos/:owner/:repo/git/refs/heads/:branch` (in flight tonight)
- [ ] `GET    /api/v2/repos/:owner/:repo/git/commits/:sha` (in flight tonight)
- [ ] `POST   /api/v2/repos/:owner/:repo/git/blobs` (in flight tonight)
- [ ] `POST   /api/v2/repos/:owner/:repo/git/trees` (in flight tonight)
- [ ] `POST   /api/v2/repos/:owner/:repo/git/commits` (in flight tonight)
- [ ] `PATCH  /api/v2/repos/:owner/:repo/git/refs/heads/:branch` (in flight tonight)

### Group 3 — Actions / workflows
- [ ] `POST /api/v2/repos/:owner/:repo/actions/workflows/:filename/dispatches` (in flight tonight)
- [ ] `GET  /api/v2/repos/:owner/:repo/actions/workflows/:filename/runs` (in flight tonight)
- [ ] `GET  /api/v2/repos/:owner/:repo/actions/runs/:run_id` (in flight tonight)
- [ ] `GET  /api/v2/repos/:owner/:repo/actions/runs/:run_id/logs` (zip) (in flight tonight)
- [ ] `POST /api/v2/repos/:owner/:repo/actions/runs/:run_id/cancel` (in flight tonight)

Helpers verified available: `getBlob`, `getTree`, `getCommit`, `resolveRef`,
`updateRef`, `writeBlob`, `refExists`, `objectExists`, `getBlobShaAtPath`,
`createOrUpdateFileOnBranch`, `enqueueRun`. Auth uses existing `requireApiAuth` +
`requireScope("repo")`. No schema changes needed.

---

## 🛸 "2030 KILLER MOVES" — 2026-05-20 (external strategic doc, 30 items)

Triaged for feasibility from current architecture. Tagged: **[NOW]** = can
build inside the current platform with no new infra; **[NEXT]** = needs
one major piece of new infra (vector store, edge runtime, enclave); **[FAR]**
= multi-quarter or requires partner ecosystem.

### Next-gen security & agent scoping
- [ ] **[NOW]** 1. Token-level identity binding — `agent_session` tokens scoped to a single branch/issue. Builds on existing PAT scopes — add a `target_ref` field to `api_tokens`. **~4-6 hrs**
- [ ] **[NOW]** 2. Ephemeral branch sandboxes — `refs/scratch/*` exempt from CI, pruned after merge. **~4-6 hrs**
- [ ] **[NOW]** 3. Nonce-enforced PUT queries — `If-Match: <blob_sha>` semantics. Group 1 PUT/DELETE already needs `sha`; lift to an HTTP header. **~2-3 hrs**
- [ ] **[NOW]** 4. Byte-range content patching — `PATCH /contents/:path` with RFC-6902 JSON patch or unified-diff body. **~4-6 hrs**
- [ ] **[NEXT]** 5. Semantic content hashing — AST-aware hash to suppress comment/whitespace CI. Needs per-language parsers. **~10-15 hrs**

### AI-native git data layer
- [ ] **[NOW]** 6. LLM-native content bundling — `GET /contents/:path?format=llm-xml`. Existing repo-walker + XML wrap. **~3-4 hrs**
- [ ] **[NEXT]** 7. On-the-fly dependency analysis on commit POST. Needs language-aware parsers. **~8-10 hrs**
- [ ] **[NOW]** 8. Graph-native history walks — `?depth=10&include_diffs=true` on `/git/commits/:sha`. **~3-4 hrs**
- [ ] **[NOW]** 9. Auto-clustered staging trees — agents stream blobs, server batches into one commit on `flush`. Sits next to Group 2 tree builder. **~6-8 hrs**
- [ ] **[NEXT]** 10. Intent metadata + pre-receive intent matcher. Needs semantic-diff infra. **~10-12 hrs**

### Real-time observability & build fabric
- [ ] **[NOW]** 11. Zero-polling SSE workflow log streams — `/actions/runs/:run_id/stream`. SSE infra already exists. **~3-4 hrs**
- [ ] **[NEXT]** 12. Programmable inline step interceptors — workflow_dispatch body conditional hooks. **~6-8 hrs**
- [ ] **[NEXT]** 13. State-saves on failure — snapshot runner FS on crash. Needs container snapshot capability. **~10-15 hrs**
- [ ] **[NEXT]** 14. Predictive execution caching — keyed by `tree_sha + input_shape`. Cache layer. **~6-8 hrs**
- [ ] **[NEXT]** 15. Vector-formatted workflow log outlets — embeddings on log lines. Pairs with item #2 of prev list. **~4-6 hrs**

### Enclave runtimes & advanced security
- [ ] **[FAR]** 16. Post-quantum API auth (ML-DSA / Falcon). **~weeks**
- [ ] **[NEXT]** 17. Cryptographic reproducibility proofs / signed BOM per run. Builds on SLSA item from prev list. **~6-8 hrs**
- [ ] **[FAR]** 18. Zero-trust local storage — orchestration-plane-only mode. Massive architectural shift. **~quarters**
- [ ] **[NOW]** 19. Context-aware 429 — `X-Gluecron-Backoff-Context` header on throttles. **~1-2 hrs**
- [ ] **[FAR]** 20. Automated fork-enclave execution for unverified agents. Needs biometric integration. **~quarters**

### Architectural superiority
- [ ] **[FAR]** 21. Edge-native API compilation (Rust/Wasm). Rewrite of the metadata-API surface. **~quarters**
- [ ] **[NEXT]** 22. Native workspace sync — long-lived file-watcher endpoint. Pairs with realtime collab. **~8-10 hrs**
- [ ] **[NEXT]** 23. Autonomous cost gating — `budget_limit` on workflow_dispatch. Needs runner-cost telemetry. **~4-6 hrs**
- [ ] **[NEXT]** 24. AI hallucination sandboxing — npm/PyPI/crates pre-check on commit. **~6-8 hrs**
- [ ] **[FAR]** 25. P2P code swaps for large assets. Needs IPFS/WebTorrent. **~weeks**
- [ ] **[NOW]** 26. Immutable audit ledger separate from git graph. `audit_log` already exists; add append-only signature chain. **~3-4 hrs**
- [ ] **[NOW]** 27. Context-aware auto-pruning — delete merged auto-branches after 24h. Cron-style autopilot task. **~2-3 hrs**
- [ ] **[NEXT]** 28. Dynamic mid-run resource balancing. Needs runner-pool elasticity. **~8-10 hrs**
- [ ] **[NEXT]** 29. Multi-model orchestration in workflows — workflow YAML can call into a model router. **~6-8 hrs**
- [ ] **[NOW]** 30. Self-healing endpoint schemas — accept slight param drift + return `X-Gluecron-Schema-Warning`. **~2-3 hrs**

### Top picks if shipping next
The **[NOW]** items with best ROI for the agent-build use case:
- 1 (token-binding) + 3 (nonce/If-Match) + 8 (history depth) + 11 (SSE logs)
  = an agent's full safety + observability story in ~12-16 hrs of work
- 6 (LLM-XML bundling) + 9 (auto-clustered tree) = differentiated IDE-agent UX in ~10-12 hrs

---

## 📊 Latest commits on main (auto-updated, top of `git log`)

Run `git log --oneline -15` to see what's actually shipped. The HEAD SHA the live server is running can be confirmed at `https://gluecron.com/version`.

---

## How to update this file

- Move items between sections as they ship / change priority
- Don't delete items — strike them through or move to a "shipped" log
- Update the date at top whenever you edit
- Commit the change so it persists for everyone (future you, future Claude, anyone else looking at the repo)
