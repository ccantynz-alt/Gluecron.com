# Gluecron Audit — 2026-05-16

Comprehensive end-to-end audit run on branch `claude/fix-aa-loop-issue-PonMQ`
at commit `67f64a3`. Four parallel agents covered: route inventory, link/form
target validation, automated checks (bun test + tsc + smoke crawl), and
critical-user-journey code-path tracing.

## Health snapshot

| Check | Result |
|---|---|
| `bun test` | **1995 pass / 0 fail / 2 skip** across 143 files |
| `bunx tsc --noEmit` | **clean — zero errors** |
| Registered HTTP routes | **172** |
| Broken internal `href` | **1** — register form links to non-existent `/legal/*` |
| Broken form actions | 0 |
| Broken client `fetch()` calls | 0 |
| Routes hanging on stub DB | 2 — `/` and `/status` |
| Routes 500ing on stub DB | 1 — `/explore` |

## Verified bugs (severity-ranked)

### P0 — Fixed this session

1. **AA reload loop on admin dashboard.** Layout registered `/sw.js` and
   `/sw-push.js` at the same scope `/`; the SW spec only allows one
   active SW per scope, so each registration kept replacing the other and
   the `updatefound → reload` hook fired on every page load. Cause of the
   "deploy pill flashing" / "typing wiped" / "buttons don't work"
   symptoms. **Commit `d7ba05d`.** Includes regression test.

2. **AI code review silently auto-approves PRs.** `src/lib/ai-review.ts`
   `reviewDiff()` returned `{ approved: true }` whenever Claude's output
   couldn't be parsed as JSON. Combined with the `approved: parsed.approved
   !== false` defaulting, **a missing field or any parse failure became an
   approval signal**, which feeds the K2 auto-merge gate. Fail-open on a
   security-relevant decision. Now fails closed: explicit `approved: true`
   required, otherwise returns `false` with a parseable failure summary.
   **(committed in this batch.)**

3. **Broken legal links in register form.** `src/routes/auth.tsx` linked
   to `/legal/terms` and `/legal/privacy`; mounted routes are `/terms`,
   `/privacy`, `/acceptable-use` (no `/legal/` prefix). 404 on click.
   Fixed to use the live paths. **(committed in this batch.)**

4. **`drizzle.config.ts` crashes obscurely without `DATABASE_URL`.**
   Non-null assertion → undefined → deep parser crash. Now throws a
   clean, actionable error at the top of the run. **Commit `67f64a3`.**

### P1 — Real bugs, not yet fixed

5. **`src/routes/legal/` is an orphan subdirectory.** Contains
   `terms.tsx`, `privacy.tsx`, `acceptable-use.tsx`, `dmca.tsx`. None of
   them are mounted in `src/app.tsx`. Self-reference `/legal/*` paths
   internally. Either mount them (and drop `legal.tsx`), or delete them.
   Currently dead code that wastes reviewer attention.

6. **Duplicate route registration on `/:owner/:repo/dependencies`.**
   Registered in both `src/routes/deps.tsx:45` and
   `src/routes/insights.tsx:183`. Hono is first-wins, and `insightRoutes`
   mounts first (line 372 vs 411 in `app.tsx`), so the `deps.tsx` handler
   is **unreachable dead code**.

7. **`/explore` 500s with no DB.** No defensive error boundary around
   the public repo-list query. Means a Neon hiccup takes the public
   discovery page down hard rather than degrading. Same pattern as
   `public-stats.ts` already handles; copy that approach.

8. **`/` and `/status` hang indefinitely on DB failure.** The home page
   handler blocks on `computePublicStats()` (and that file already has a
   "degraded to zeros" fallback) but the underlying query path can hang
   when the connection refuses rather than fails. Needs an explicit
   `Promise.race` against a 3–5s timeout so the page renders cached or
   zero data instead of timing out at the proxy.

### P1 — Silent failures across journeys (from critical-path audit)

9. **Post-receive hook silent failures.** `src/hooks/post-receive.ts`
   fires auto-repair, analysis, health-score updates as fire-and-forget
   with `.catch(() => {})`. User's push reports green from git but
   downstream automation may have crashed. No surface on the repo page.

10. **Import-bulk has no input validation, no size limits.** A 10GB repo
    can be cloned into RAM with no progress feedback or timeout
    (`src/routes/import-bulk.tsx`, `src/lib/import-helper.ts`). Git stderr
    is truncated to 200 bytes, so real errors are illegible.

11. **`releaseExpiredWaitTimers` `.set is not a function`** at
    `src/lib/environments.ts:376`. Caught and silently logged in tests;
    in production this means env-approval wait timers never release.
    Looks like a stale Drizzle call after a schema change.

### P2 — Style / pattern issues (lower priority)

12. **Admin auth is inconsistent.** Some admin routes use `requireAdmin`
    middleware, others use inline `gate()` helpers that call
    `isSiteAdmin()`. **All routes audited are properly admin-gated** —
    the route auditor flagged false positives on `mirrors`,
    `github-oauth`, `sso`, but all three have explicit `isSiteAdmin()`
    checks inside the handler. The inconsistency is a maintenance hazard,
    not a security hole.

13. **Many helpers `return null` instead of returning a `Response` or
    throwing.** Pattern in `ai-tests.tsx`, `ai-explain.tsx`,
    `discussions.tsx`, `issues.tsx`, `admin-ops.tsx`. Non-standard
    semantics that could mask bugs. Not a current crash source.

14. **Silent `.catch(() => {})` patterns.** Several auth flows swallow
    notification and audit-log failures without logging. Appropriate for
    best-effort side effects but lack of observability means operational
    issues are invisible.

## Verdict

The codebase is **substantially more solid than the user's framing
suggested**. 1995 tests pass, navigation has zero broken links/forms, all
admin routes are properly authenticated. The user-visible symptoms ("loop",
"buttons don't work") trace to a single root cause (the SW scope collision)
which is now fixed.

The genuine P0s are concentrated in two areas:
- The **AI auto-merge pipeline** (now fixed — review can no longer fake
  approval through JSON parse failure)
- **Failure surfaces** — post-receive, imports, and env approvals fail
  silently rather than reporting to the user

What this is **not**: a beginner codebase. It is an ambitious one with
~170 routes and significant feature breadth (SSO, OAuth, GraphQL, MCP,
marketplace, AI review, etc.). The fragility comes from surface area, not
craftsmanship.

## What's still needed for "usable as a normal website"

1. Deploy `d7ba05d` + the fixes in this batch to prod.
2. Run a golden-path smoke test manually: register → create repo → `git
   push` → file an issue → open a PR. Each step that fails gets a fix.
3. Address P1 items as discovered during the smoke test, in order of
   user-visible impact.

Visibility sweep (activity drawer, live admin, repo activity rail, run
pages) is a separate effort and belongs on a fresh branch after the
golden-path is green.
