# Deploy checklist

Scannable go-live runbook. For detailed rationale + per-variable docs, see `DEPLOY.md`.

## Pre-deploy

- [ ] `DATABASE_URL` set to a live Neon PostgreSQL connection string (hard-required)
- [ ] `GIT_REPOS_PATH` points at a persistent volume (Fly: `/app/repos` via `gluecron_repos`)
- [ ] Secrets reviewed in `.env.example`; optional keys (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `GATETEST_API_KEY`, `VOYAGE_API_KEY`) set or consciously skipped
- [ ] `ERROR_WEBHOOK_URL` **or** `SENTRY_DSN` set as a Fly secret (without this, errors log to stderr only)
- [ ] `AUTOPILOT_DISABLED` decision made (default: enabled)
- [ ] `DEMO_SEED_ON_BOOT` decision made (default: off)
- [ ] Run `bun run preflight` locally — green before shipping
- [ ] `bun test` clean on the deploy commit
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry for this deploy

## Deploy

- [ ] `flyctl deploy` from the repo root
- [ ] Release command runs `bun run db:migrate` automatically (configured in `fly.toml`); confirm it succeeded in the release logs
- [ ] Fly machine reaches healthy state; no boot-loop
- [ ] Persistent volume mounted and writable at the configured `GIT_REPOS_PATH`

## Post-deploy smoke

- [ ] `GET /healthz` → 200
- [ ] `GET /readyz` → 200 (DB + git reachable)
- [ ] `GET /status` renders; `GET /status.svg` returns a shields badge
- [ ] Register a new user via `/register`
- [ ] First user auto-promoted to site admin (check `/admin`)
- [ ] Create a repo via `/new`
- [ ] `git clone` over HTTPS succeeds
- [ ] `git push` succeeds; post-receive pipeline runs (GateTest callback + webhooks)
- [ ] AI review path exercised if `ANTHROPIC_API_KEY` is set
- [ ] Sentry/webhook sink receives a forced test error

## First-day operations

- [ ] Admin bootstrap: oldest row in `users` is the intended admin — register that account **first** (see `src/routes/admin.ts` bootstrap rule)
- [ ] Site banner / motd configured in `/admin` if needed for launch
- [ ] Billing plans seeded (free/pro/team/enterprise) — verify in `/admin`
- [ ] Autopilot ticker heartbeat visible (unless `AUTOPILOT_DISABLED=1`)
- [ ] `docs/LAUNCH_ANNOUNCEMENT.md` queued for Show HN / social
- [ ] Add a dated entry to `CHANGELOG.md` and tag a release
- [ ] Monitor `/metrics`, `/healthz`, and the error sink for the first hour
