# GlueCron — Last Session Summary

> Overwritten each session. Previous session's content moves to session-history.md.

## Session Date: 2026-04-16

## What Was Built
1. **Flywheel learning system** — 3 new DB tables (review_outcomes, review_patterns, gate_metrics), learning engine at src/lib/flywheel.ts, context injection into AI review prompts. Migration: drizzle/0034_flywheel_learning.sql
2. **SSE real-time streaming** — src/lib/sse.ts (channel pub/sub), src/routes/events.ts (stream endpoint), gate.ts wired to broadcast start/completion events
3. **SBOM export** — src/lib/sbom.ts (SPDX 2.3 + CycloneDX 1.5), download buttons on deps page, API at /api/repos/:owner/:repo/sbom
4. **License compliance scanner** — src/lib/license-scan.ts, visual page at /:owner/:repo/dependencies/licenses, API endpoint
5. **161 TypeScript error fixes** — JSX method casing, git.ts param parsing, repository.ts null safety, graphql.ts visibility→isPrivate, open redirect security fix
6. **Agent policy in CLAUDE.md** — "Never idle" rules encoded for all future sessions
7. **Memory system** — .memory/ directory with project-state.md, decisions-log.md, last-session.md, open-questions.md

## What Was Fixed
- Open redirect vulnerability in src/routes/auth.tsx (all redirects now through safeRedirect())
- repositories.visibility references in graphql.ts, packages-api.ts, admin.tsx (field doesn't exist, should be isPrivate)
- Git route param parsing in src/routes/git.ts (Hono parses /:repo.git as "repo.git" not "repo")

## Branch State
- Branch: `claude/resume-previous-work-KzyLw`
- Commits: 6 ahead of main
- All 767 tests passing
- 10 remaining TypeScript errors (Bun Uint8Array compat only)

## What's Next (priority order)
1. GateTest self-healing loop — continuous test → auto-fix → resubmit
2. Web Push notification wiring
3. Streaming AI responses through SSE
4. Developer velocity metrics dashboard
