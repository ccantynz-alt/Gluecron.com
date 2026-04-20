# gluecron

A GitHub replacement. AI-native code intelligence, git hosting, automated CI, and a self-hostable platform built to keep every push production-ready. Every repo ships with gates, branch protection, CODEOWNERS sync, and an AI reviewer on by default — opt out per feature, never by default. Deploy anywhere Bun runs — fly.toml is in-repo, Dockerfile for any container host. Backed by Neon Postgres.

## Features

### Code hosting
- Git Smart HTTP (clone / push / fetch) — subprocess-backed
- SSH keys, personal access tokens, OAuth 2.0 provider
- Public / private repos, forks, stars, topics, archive, transfer, template repos
- Pull-style repository mirroring (upstream git URL, periodic fetch + audit log)
- Releases, tags, protected tags
- Repository rulesets — push policy engine covering commit/branch/tag patterns, blocked paths, file-size caps, force-push forbiddance

### Code browsing
- File tree, syntax highlighting (40+ languages), commit log, unified diffs, blame, raw
- Branch + tag switcher, contributor list, commit activity graph
- Code search (ILIKE) — per-repo and global
- Semantic code search — Voyage `voyage-code-3` when `VOYAGE_API_KEY` is set, deterministic hashing fallback otherwise
- Symbol / xref navigation across ts/js/py/rs/go/rb/java/kt/swift
- Dependency graph — npm / pip / poetry / go / cargo / rubygems / composer
- Commit signature verification — GPG + SSH "Verified" badges

### Collaboration
- Issues, labels, milestones, issue templates, saved replies
- Pull requests: inline review, draft PRs, AI triage on create, merge queues, required-checks matrix
- Discussions (forum threads, q-and-a, pinned/locked)
- Wikis (DB-backed, revision history + revert)
- Projects / kanban boards
- Gists (multi-file, per-revision snapshots, stars, secret)
- Reactions (8 canonical emoji) on issues, PRs, and comments
- Mentions, notifications, personalised activity feed, user follows, profile READMEs
- Closing keywords auto-close issues on PR merge

### AI-native
- AI code review blocks merges on fail (`requireAiApproval` branch protection)
- AI security review (Sonnet 4) + 15-pattern secret scanner on every push
- AI commit messages, PR summaries, changelogs (per-range viewer + on release)
- AI merge-conflict resolver, AI incident responder (auto-issue on deploy fail)
- AI explain-this-codebase (per-commit cached Markdown)
- AI-generated failing test stubs
- AI dependency updater (opens a PR with a bump table)
- Copilot-style completion endpoint (`POST /api/copilot/completions`, Haiku, LRU-cached)
- AI chat — global and repo-scoped

### Automation
- Workflow runner — `.gluecron/workflows/*.yml` auto-discovered on push, Bun subprocess executor, per-step timeouts, size-capped logs
- Outbound webhooks (HMAC-signed) on push / issue / PR / star
- Inbound GateTest callback (bearer or HMAC)
- Commit status API — external CI POSTs per-commit statuses, combined rollup
- Auto-repair engine (rewrites broken commits when `ANTHROPIC_API_KEY` is set)
- Autopilot background ticker — mirror sync, merge-queue processing, weekly email digests, advisory rescans (opt out via `AUTOPILOT_DISABLED=1`)
- Dependabot-equivalent dep bumper + security advisories scanner
- CODEOWNERS auto-sync with team-based resolution (`@org/team`)

### Platform
- Organizations + teams (owner / admin / member roles, team-based CODEOWNERS)
- 2FA / TOTP with recovery codes
- WebAuthn / passkeys
- Enterprise SSO via OIDC (Okta, Azure AD, Auth0, Google Workspace)
- App marketplace + GitHub-Apps-equivalent bot identities (`ghi_` install tokens, scoped permissions)
- Package registry (npm protocol — packument / tarball / publish / yank)
- Pages / static hosting (serves from `gh-pages` branch)
- Environments with protected approvals (reviewer-gated deploys, branch-glob restrictions)
- Sponsors (tier management — payment rails deferred)
- Personal dashboard, explore, global search, insights, releases
- REST + GraphQL APIs (queries only on GraphQL)
- Official CLI (`cli/gluecron.ts`) — single-file Bun binary
- VS Code extension (`vscode-extension/`) — explain / open-on-web / semantic search / test generation
- Mobile PWA (manifest + offline-capable service worker). Native iOS/Android apps are not built.
- Command palette (Cmd+K), keyboard shortcuts, dark + light themes

### Observability
- Rate limiting, request-ID tracing, `/healthz`, `/readyz`, `/metrics`
- Audit log (personal + per-repo)
- Traffic analytics per repo (views + clones, 7/14/30/90d windows, SHA-truncated IP uniqueness)
- Org-wide insights dashboard (green rate, PR/issue counts, per-repo breakdown)
- Site admin panel — user management, system flags (`registration_locked`, `site_banner_*`, `read_only_mode`), billing overrides
- Billing + quotas (free / pro / team / enterprise seeded plans)
- Email notifications (provider-pluggable: log default, Resend in prod) + opt-in weekly digest

For the full shipped-vs-missing scorecard and internal roadmap, see [`BUILD_BIBLE.md`](./BUILD_BIBLE.md).

## Quick start

```bash
bun install
bun dev            # hot-reload dev server
bun run db:migrate # run database migrations
bun test           # run the test suite
```

Then visit `http://localhost:3000` to register and create your first repository.

You'll need at minimum a `DATABASE_URL` pointing at Postgres. Everything AI-flavoured gracefully degrades without `ANTHROPIC_API_KEY`. See [`.env.example`](./.env.example) for the full list.

## Stack

- **Runtime:** Bun
- **Framework:** Hono (with JSX for server-rendered views)
- **Database:** Drizzle ORM + Neon (PostgreSQL)
- **Git:** Smart HTTP protocol via git CLI subprocesses

## Architecture (top-level)

```
src/
  index.ts          Bun server entry
  app.tsx           Hono composition + error handlers
  db/               Drizzle schema + lazy connection + migrations
  git/              repository.ts (tree/blob/commits/diff/blame/...) + protocol.ts
  hooks/            post-receive (GateTest, outbound deploy webhook, webhooks, CODEOWNERS)
  lib/              auth, config, markdown, highlight, AI helpers, autopilot, ...
  middleware/       softAuth / requireAuth / rate-limit / request-context
  routes/           git, api, web, issues, pulls, editor, settings, webhooks, ...
  views/            layout, components, landing, reactions
```

Full file inventory lives in [`CLAUDE.md`](./CLAUDE.md).

## Integrations

- **GateTest** — optional third-party security scanner. When `GATETEST_URL` is set, every `git push` POSTs to it; inbound results accepted at `POST /api/hooks/gatetest` (bearer or HMAC).
- **Webhooks** — user-registered URLs receive HMAC-signed payloads on push / issue / PR / star events.
- **Outbound deploy webhook** — optional. Set `CRONTECH_DEPLOY_URL` (or any URL) to receive a POST on pushes to the default branch. Opt out per repo via `autoDeployEnabled`.

## Deployment

Gluecron runs anywhere Bun runs. The repo ships a `fly.toml` for Fly.io and a `Dockerfile` for any container host, with Neon Postgres as the database. See [`DEPLOY.md`](./DEPLOY.md) for step-by-step instructions, environment variables, and the post-deploy verification checklist.

## License

See [`LICENSE`](./LICENSE).
