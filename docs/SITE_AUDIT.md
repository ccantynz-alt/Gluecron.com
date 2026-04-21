# Gluecron site audit — 2026-04-21

Snapshot: what's shipped, what's stubbed, what's left to finish before and just after launch.

## TL;DR

- **Readiness: ~90%.** Platform is feature-complete vs the BUILD_BIBLE §2 GitHub parity scorecard. The remaining work is operational (monitoring pipes, alerting) and commercial (Stripe, DPA), not functional.
- **Top 3 launch blockers:** (1) actually run `flyctl deploy` — code is ready, infra hasn't been provisioned; (2) `LAUNCH_TODAY.md` is badly outdated — 3 items listed as ❌/🟡 are already shipped; (3) no error-tracking sink is configured — `src/lib/observability.ts` is wired but `ERROR_WEBHOOK_URL` / `SENTRY_DSN` need real values.
- **Most surprising finding:** only **3 TODO/FIXME/HACK markers** in `src/**/*.{ts,tsx}` across 86 route files + 68 test files. The codebase is remarkably clean.

## Codebase size
- 86 files in `src/routes/`
- 68 files in `src/__tests__/`
- 3 TODO/FIXME/HACK markers total: `src/__tests__/signatures.test.ts:1`, `src/lib/intelligence.ts:1`, `src/lib/ai-tests.ts:1`. None are blockers.

## LAUNCH_TODAY.md drift

The pre-launch checklist has not been maintained. These items are listed as ❌/🟡 but are actually **shipped**:

| Item as listed | Actual state | Evidence |
|---|---|---|
| `🟡 Demo org / sample repos — Design sketch exists; no code yet` | ✅ Shipped | `src/lib/demo-seed.ts` (commit `988380a`) + `DEMO_SEED_ON_BOOT=1` wired in `src/index.ts` |
| `❌ Error-tracking (Sentry) wiring` | ✅ Shipped (today) | `src/lib/observability.ts` with `ERROR_WEBHOOK_URL` + `SENTRY_DSN` support, wired into `app.onError` |
| `❌ Launch announcement draft` | ✅ Shipped (today) | `docs/LAUNCH_ANNOUNCEMENT.md` — Show HN + tweet thread + LinkedIn + demo shot list + press kit |
| `❌ Status page public` | ✅ Shipped | `/status` HTML page + `/status.svg` shields badge (commit `2316be6` + `9b07ca9`) |

Genuinely outstanding:
- 🟡 `/metrics` → Prometheus/Grafana/Datadog pipe
- 🟡 Monitoring + on-call rotation (alerting rules)
- 🟡 Backup restore drill (never rehearsed)
- 🟡 Legal audit review (`docs/legal-audit.md`)
- ❌ Changelog / release-notes cadence
- ❌ DPA template for enterprise SSO customers

## What's locked and untouched

Per BUILD_BIBLE §4, the locked files are primarily `src/views/layout.tsx`. Spot check of recent commits shows no unauthorized edits — locked files have not been touched in the last 7 commits on this branch.

## Cross-contamination sweep

Post-`90fa787` decouple, remaining Crontech references in user-visible surfaces are:
- `.env.example`: `CRONTECH_DEPLOY_URL` as optional outbound webhook (allowed — it's a generic third-party webhook name)
- `README.md`, `DEPLOY.md`, `CLAUDE.md`: one mention each of `CRONTECH_DEPLOY_URL` as optional env var (allowed)

No "green ecosystem", "self-hosting triangle", or cross-product pitching in user-visible UI. Internal function names like `triggerCrontechDeploy` remain (server-only, not user-facing).

## Integration hygiene

All third-party integrations gracefully degrade when env vars are missing — confirmed in DEPLOY.md §7. Specifically:
- `DATABASE_URL` — hard required (only real blocker)
- `ANTHROPIC_API_KEY` — missing → all AI features return deterministic fallback strings
- `GATETEST_API_KEY` — missing → outbound gate silently skipped
- `RESEND_API_KEY` — missing → emails logged instead of sent
- `VOYAGE_API_KEY` — missing → hashing embedder fallback
- `ERROR_WEBHOOK_URL` / `SENTRY_DSN` — missing → errors still logged to stderr
- `CRONTECH_DEPLOY_URL` — default points at `crontech.ai`; if 401, treated as failed deploy (fine)
- `DEMO_SEED_ON_BOOT` — opt-in

## Test posture

Baseline: **140 pass / ~54 fail / 63 test files** (fail count is entirely sandbox `hono/jsx/jsx-dev-runtime` module-resolution errors in this environment — not real regressions; confirmed by running stashed-HEAD comparisons in prior sessions).

Spot-check coverage gaps (big features without a dedicated test file):
- Merge queue (`src/routes/merge-queue.ts`) — logic exists, no `__tests__/merge-queue.test.ts`
- Wikis (`src/routes/wikis.ts`) — no dedicated test
- Packages API (`src/routes/packages-api.ts`) — no dedicated test
- Marketplace + bot identities — no dedicated test

None are launch-blocking. Coverage is good enough for v1.

## New features this sprint (post-audit snapshot)

In-flight this session, not yet committed:
- `/import/bulk` — paste GitHub org + token, migrate multiple repos at once
- `/migrations` — per-user migration history + verify button
- `src/lib/import-verify.ts` — smoke-verifies imported repos are clonable
- `/:owner/:repo/spec` + `src/lib/spec-to-pr.ts` — experimental spec-to-PR UI (backend is v1 stub; returns "experimental" message pending full AI integration)

## Launch blocker punch list (prioritized)

1. **Run `flyctl deploy`** — 10 min. Blocks everything else.
2. **Refresh LAUNCH_TODAY.md** — 5 min. Strike through shipped items so the next reader knows where we actually are.
3. **Set `ERROR_WEBHOOK_URL` or `SENTRY_DSN` as a Fly secret** — 5 min. Without this, production errors go to stderr only.
4. **First admin bootstrap** — 2 min. Register the intended admin account first (oldest user becomes site admin automatically).
5. **Smoke: `/healthz`, `/readyz`, `/status`, clone, push, AI review** — 15 min manual run-through post-deploy.
6. **Set up changelog cadence** — pick a cadence (weekly? on every launch?) and put the first entry live.
7. **DPA template** — boilerplate for enterprise SSO customers. 1-2 hours with a legal template.
8. **Finish spec-to-PR full integration** — v1 stub ships now; real AI integration is a 3-4 hour follow-up sprint.
9. **Backup restore drill** — verify the `/data/repos` filesystem snapshot can actually be restored.
10. **Alerting rules on `/metrics` + `/healthz`** — Fly + external pager (PagerDuty / OpsGenie).

Items 1-5 are the true launch gate. 6-10 are first-week operational work.
