# Gluecron Audit v2 — 2026-05-16

Five parallel agents (schema-vs-code drift, route smoke crawl, form
submission, silent failures, deploy pipeline) audited the codebase
at commit `a358c63` after the AA-loop / Hetzner-deploy firefight.

## Headline

The codebase is **structurally sound** — schema matches code, forms are
correctly wired, route mounting is consistent. The user-visible
"website is broken" symptoms trace to a small set of **silent failure
modes** in observability, integrations, and the deploy pipeline.

## P0 — User-blocking, fix now

| # | Bug | File | Effect |
|---|---|---|---|
| 1 | `/orgs/:slug/people` null-deref on anonymous users | `src/routes/orgs.tsx:338` | 500 instead of 302 to login |
| 2 | `/settings` 500 from missing migration 0045 | n/a (deploy bug) | All `auto_close_stale_*` reads crash. **Fix shipped in `a358c63`** — next deploy applies it. |
| 3 | Email silently disabled when `RESEND_API_KEY` missing | `src/routes/auth.tsx:222`, `src/lib/email.ts:49-85` | Registration succeeds, verification email never sends, user locked out. No error surface. |
| 4 | AI review/triage comments swallowed on DB error | `src/lib/ai-review.ts:281,297,317`, `src/lib/pr-triage.ts:233` | DB blip → comments never appear → user thinks AI never ran |
| 5 | Deploy failure diagnostics curl wrong port | `.github/workflows/hetzner-deploy.yml:403` | Service runs on 3010, diagnostics check 3000 → every failure dump useless |
| 6 | Rollback `bun install` uses `\|\| true` | `.github/workflows/hetzner-deploy.yml:364` | Corrupted deps don't abort rollback → service restarted with broken node_modules |
| 7 | GateTest fires unauthenticated when `GATETEST_API_KEY` missing | `src/lib/gate.ts:128`, `src/lib/gate.ts:122` | 401 silent → scans never run |
| 8 | Crontech deploy webhook fires without signature when secret missing | `src/hooks/post-receive.ts:309` | Rejected silently → deploy looks fired, never landed |

## P1 — Real bugs, lower frequency

| # | Bug | File | Effect |
|---|---|---|---|
| 9 | Repo-scoped routes 500 instead of 404/empty on missing record | `issues.tsx`, `pulls.tsx`, `packages.tsx`, `releases.tsx`, etc. | DB blip → 500 instead of graceful degradation |
| 10 | No DB-blip protection — every page blocks 5-15s on a sick DB | All routes that read DB | Sick DB → site appears down instead of slow |
| 11 | Two deploy paths drifted | `scripts/self-deploy.sh` vs `.github/workflows/hetzner-deploy.yml` | One has compile/cache/verifier, the other doesn't. Inconsistent state on prod. |
| 12 | No Fly rollback path | `.github/workflows/fly-deploy.yml` | Bad Fly deploy = manual recovery |
| 13 | Deployment INSERT `.catch(() => {})` | `src/hooks/post-receive.ts:282-296` | If DB blip, deploy row never persists, Crontech callbacks for unknown deployId |
| 14 | PR close-keyword closing comment swallowed | `src/lib/pr-merge.ts:179-181` | Issue closes but no back-link comment posted on issue |
| 15 | Workflow log truncation has no UX warning | `src/lib/workflow-runner.ts:94-97` | User sees "[... truncated ...]" with no indication of how much was lost |

## P2 — Cleanup / risk

| # | Item | File | Notes |
|---|---|---|---|
| 16 | `pr_risk_scores` table is dead schema | `drizzle/0044_pr_risk_scores.sql` | Created, never written to or read |
| 17 | `scripts/deploy-crontech.sh` is dead code | `scripts/deploy-crontech.sh` | Referenced in comments, never invoked |
| 18 | Stripe webhook `continue-on-error: true` on volume creation | `.github/workflows/fly-deploy.yml:48` | Mountpoint can be wrong without alarm |
| 19 | `/admin/sso`, `/admin/github-oauth`, `/admin/mirrors/sync-all` use middleware `requireAuth` (not `requireAdmin`), gated only by inline `isSiteAdmin()` check | Multiple admin routes | Inconsistent pattern; current gate is correct but easy to forget on a new route |

## False alarms — investigated, no issue

- **Schema drift**: agents found zero columns the code reads that aren't in `schema.ts` and zero columns in `schema.ts` without a matching migration. All 54 migrations are consistent with the code.
- **Broken nav**: 172 routes, every internal `href` and every form `action` resolves to a registered handler. (Single exception was `/legal/terms` link from register form, fixed in `2e8a4d5`.)
- **Admin auth bypass**: every admin route is properly gated via either middleware or inline `isSiteAdmin()` check. Inconsistent pattern, not a security hole.
- **Form submission**: every form's POST handler exists, reads the right fields, redirects to a real page, persists data correctly.

## What the user experienced

1. **PWA reload loop** — fixed (commits `d7ba05d`, `904927d`, `44fe49b` ripped out PWA, added kill-switch).
2. **"Buttons don't work"** — root cause was the reload loop cancelling clicks before they fired. Fixed by the above.
3. **`/settings` 500** — root cause was deploy pipeline silently failing for 17 hours, so migration 0045 never ran on prod. Fixed by `a358c63` (re-added migration step to deploy).
4. **Hours of "still broken"** — root cause was the deploy pipeline being non-functional (Hetzner git remote 404, silent script abort, no migration step). Fixed by `ec16b67`, `d8b9606`, `a358c63`.

## Roadmap

This commit adds AUDIT-v2.md. The next batch of commits will burn
through P0s 1, 3, 4, 5, 6, 7, 8 — each as a small commit pushed
straight to main. P1s and P2s will get their own session.

---

## RELIABILITY SWEEP — 2026-05-16 (executed)

After AUDIT-v2.md landed, a four-phase reliability sweep targeting
the systemic issues was executed in a single session. All P0s above
are fixed; key P1s and Level 1–4 of the AI-intelligent-server stack
shipped:

### Phase A — Silent failure sweep (Level 1) — `a28cede`
Replaced every `.catch(() => {})` in production code (~30 sites across
18 files) with structured `console.warn` calls that include the
operation name, relevant identifier, and error message. Operators can
now `journalctl -u gluecron | grep '\[<component>\]'` to find why
something stopped working, instead of guessing. Sites: boot path,
auth surface, git surface, AI flows, auto-repair, background workers,
SSO, MCP tools, action cleanup.

### Phase B — `/admin/health` + JSON endpoint (Level 2) — `115c66b`
Built on the existing `/admin/diagnose` traffic-light dashboard:
  - Added `/admin/health` as a friendly alias (302 to /admin/diagnose)
  - Added `/admin/diagnose.json` for programmatic monitoring (same
    site-admin gate — never leaks deploy state)
  - Added 4 new health checks: Autopilot (background loop ticking on
    schedule), Latest deploy (red on failed / yellow if > 48h stale),
    Workflow queue (red if > 25 queued), Crontech webhook (red on
    misconfigured HMAC)
  - Updated /admin dashboard button: "Diagnose" → "Health / Diagnose"
  - Regression test in `src/__tests__/admin-health.test.ts`

External monitors can now poll `GET /admin/diagnose.json` every
minute and alert on any red status. The "17 hours of silent deploy
failure" failure mode is mitigated by the autopilot + deploy-staleness
checks visible in one URL.

### Phase C — AI incident responder for platform deploys (Level 3) — `89a0761`
`src/lib/ai-incident.ts` previously had `onDeployFailure` for
downstream-app deploys only. Added sibling `analyzePlatformDeployFailure`
that targets the `platform_deploys` table (populated by
hetzner-deploy.yml). When a deploy event with status="failed" arrives
at `/deploy/finished`:
  1. Loads last 10 commits to main from the box-side repo
  2. Calls Claude Sonnet for a structured RCA (title, likely cause,
     suspected commit, remediation)
  3. Logs the analysis as `[platform-incident]` to journalctl
  4. Inserts an `audit_log` row with action=`platform.deploy.failed`
     containing the run_id, sha, error excerpt, and AI RCA

Degrades gracefully when ANTHROPIC_API_KEY is unset (falls back to
deterministic markdown with raw error + recent commits, marked
"AI unavailable"). Operators get the diagnosis at the same moment
the failure happens — no manual investigation required.

### Phase D — Deploy path unification (Level 4 partial) — `ff4423b`
`scripts/self-deploy.sh` and `.github/workflows/hetzner-deploy.yml`
had drifted into two divergent deploy scripts. Collapsed them: the
GH workflow now does `cd /opt/gluecron && git fetch + reset && bash
scripts/self-deploy.sh --inline`. The script is the single source of
truth, invoked by both the GH workflow and the post-receive hook on
the gluecron-hosted git server. No more drift.

Bonus: `self-deploy.sh` gains `set -x` tracing (was opaque on
failure). And the GH workflow gains the script's full robustness:
real post-deploy smoke suite, healthz polling, bun build --compile,
automatic rollback to previous SHA on failure.

### What's still open (P1 follow-ups not in this sweep)

- Repo-scoped routes that 500 instead of 404/empty on missing record
  (issues.tsx, pulls.tsx, packages.tsx, releases.tsx, etc.) — each
  needs a try/catch around the drizzle query
- Request-level resilience middleware (catch DB connection errors,
  return graceful 503) — design + implementation
- No Fly rollback path (`fly-deploy.yml` doesn't have one yet)
- Workflow log truncation has no UX warning
- Dead schema (`pr_risk_scores` table)
- Dead code (`scripts/deploy-crontech.sh`)

These are tractable individually but didn't fit in this session.
