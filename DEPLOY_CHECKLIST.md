# Deploy checklist

Scannable go-live runbook for the metal-box deploy at `45.76.171.37`.
For the compose + Caddy setup, see `DEPLOY_METAL.md`. For the (deferred)
Fly.io path, see `DEPLOY.md`.

## Pre-deploy

- [ ] `DATABASE_URL` set to a live Neon PostgreSQL connection string (hard-required)
- [ ] `.env` populated on the box from `.env.example`; optional keys
      (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `GATETEST_API_KEY`, `VOYAGE_API_KEY`)
      set or consciously skipped
- [ ] `ERROR_WEBHOOK_URL` **or** `SENTRY_DSN` set (without this, errors log to stderr only)
- [ ] `AUTOPILOT_DISABLED` decision made (default: enabled)
- [ ] `DEMO_SEED_ON_BOOT` decision made (default: off)
- [ ] `APP_BASE_URL=https://gluecron.com`
- [ ] Local: `bun run preflight` green
- [ ] Local: `bun test` clean on the deploy commit
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry for this deploy
- [ ] Cloudflare DNS confirmed: `gluecron.com` + `www.gluecron.com`
      A-records point at `45.76.171.37`, proxy status "DNS only"

## Deploy (metal box, `45.76.171.37`)

```sh
ssh root@45.76.171.37
git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron  # first time
cd /opt/gluecron && git pull
cp .env.example .env && vim .env   # first time only
docker compose up -d --build
docker compose logs -f caddy        # watch for cert issuance
```

- [ ] Repo cloned / updated at `/opt/gluecron`
- [ ] `.env` present and populated
- [ ] `docker compose up -d --build` exits clean
- [ ] Caddy logs show `certificate obtained successfully` for
      `gluecron.com` AND `www.gluecron.com`
- [ ] `docker compose ps` shows both services `Up (healthy)`

## First-run DB migration

```sh
docker compose exec gluecron bun run db:migrate
```

- [ ] Exits with code 0
- [ ] No "column already exists" / "missing relation" warnings

## Post-deploy smoke

Run the one-command verifier:

```sh
bash scripts/verify-deploy.sh https://gluecron.com
```

Or tick manually:

- [ ] `GET https://gluecron.com/healthz` → 200 `ok`
- [ ] `GET https://gluecron.com/readyz` → 200 (DB + git reachable)
- [ ] `GET https://gluecron.com/status` renders the HTML status page
- [ ] `GET https://gluecron.com/status.svg` returns a shields-style badge
- [ ] `GET https://gluecron.com/metrics` returns Prometheus-format metrics
- [ ] `GET https://www.gluecron.com/healthz` → 200 (no cert error)
- [ ] Register a new user via `/register`
- [ ] First user auto-promoted to site admin (`/admin` loads for that account)
- [ ] Create a repo via `/new`
- [ ] `git clone` over HTTPS succeeds against the new repo
- [ ] `git push` succeeds; post-receive pipeline runs (GateTest callback + webhooks)
- [ ] AI review path exercised if `ANTHROPIC_API_KEY` is set
- [ ] Sentry / error-webhook sink receives a forced test error

## First-day operations

- [ ] Admin bootstrap: oldest row in `users` is the intended admin —
      register that account **first** (see `src/routes/admin.ts` bootstrap rule)
- [ ] Site banner / motd configured in `/admin` if needed for launch
- [ ] Billing plans seeded (free/pro/team/enterprise) — verify in `/admin`
- [ ] Autopilot ticker heartbeat visible in logs (unless `AUTOPILOT_DISABLED=1`)
- [ ] `docs/LAUNCH_ANNOUNCEMENT.md` queued for Show HN / social
- [ ] Point Alertmanager at `infra/alerts/gluecron.rules.yml` (see `infra/alerts/README.md`)
- [ ] Dated entry added to `CHANGELOG.md`; tag a release
- [ ] Monitor `/metrics`, `/healthz`, and the error sink for the first hour

## Redeploy

```sh
ssh root@45.76.171.37
cd /opt/gluecron && git pull && docker compose up -d --build
docker compose exec gluecron bun run db:migrate   # if migrations changed
bash scripts/verify-deploy.sh https://gluecron.com
```

## Rollback

```sh
ssh root@45.76.171.37
cd /opt/gluecron
git log --oneline -10                  # find last known-good sha
git checkout <prev-sha>
docker compose up -d --build
```

DNS is unchanged, so rollback = ~60s of rebuild time with no
Cloudflare/registrar changes required.
