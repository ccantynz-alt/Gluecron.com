# Deploying Gluecron

Gluecron is a standalone product. It runs anywhere Bun runs. The repo ships a `fly.toml` for Fly.io as the documented primary target, and a `Dockerfile` for any other container host.

---

## 1. Prerequisites

1. **Neon Postgres** — create a project at https://neon.tech and copy the pooled connection string. This becomes `DATABASE_URL`.
2. **Fly.io account** (or any Docker-compatible host) — `flyctl` installed locally if you're using Fly.
3. **(Recommended) Anthropic API key** — https://console.anthropic.com. Everything AI-flavoured degrades to safe fallbacks without it, but you'll want this for the differentiator features.

---

## 2. Deploy to Fly.io

The repo includes a ready `fly.toml`. First-time setup:

```bash
fly launch       # adopts the existing fly.toml; pick an app name and region
fly deploy       # builds via the in-repo Dockerfile and releases
```

The shipped `fly.toml` already wires up:

- **Release command:** `bun run db:migrate` (runs before each deploy cuts over)
- **Persistent volume:** `gluecron_repos` mounted at `/app/repos` (bare git repos live on disk)
- **HTTP service** on port 3000 with forced HTTPS

Set secrets before the first deploy:

```bash
fly secrets set DATABASE_URL="..." APP_BASE_URL="https://your-app.fly.dev" ANTHROPIC_API_KEY="..."
```

Route a custom domain via `fly certs add your-domain.com` if you want something other than `*.fly.dev`.

### Other Docker hosts

Any platform that runs the in-repo `Dockerfile` works. Required wiring:

- **Build:** `docker build .`
- **Release (pre-start):** `bun run db:migrate`
- **Start:** `bun run src/index.ts`
- **Port:** `3000`
- **Persistent volume:** mount the path set by `GIT_REPOS_PATH` (default `/app/repos`)

---

## 3. Environment variables

Full reference is in [`.env.example`](./.env.example); cross-reference BUILD_BIBLE §5.2 for anything not listed here.

### Required
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string (pooled). |
| `GIT_REPOS_PATH` | Where bare repos live on disk (e.g. `/data/repos`). |
| `PORT` | HTTP port. Default `3000`. |
| `APP_BASE_URL` | Canonical public URL, used when composing outbound emails and webhooks. |

### Strongly recommended
| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Unlocks AI review, triage, chat, incident responder, auto-repair, completions. |
| `EMAIL_PROVIDER` | `log` (default, writes to stderr) or `resend` (production). |
| `EMAIL_FROM` | Sender identity on outbound mail. |
| `RESEND_API_KEY` | Required when `EMAIL_PROVIDER=resend`. |
| `VOYAGE_API_KEY` | Upgrades semantic search to Voyage `voyage-code-3` embeddings; without it, a deterministic hashing embedder is used. |

### Integrations (all optional)
| Variable | Purpose |
|---|---|
| `GATETEST_URL` | Outbound push webhook to the GateTest third-party security scanner. Default `https://gatetest.ai/api/events/push`. |
| `GATETEST_API_KEY` | Bearer sent on outbound GateTest posts. |
| `GATETEST_CALLBACK_SECRET` | Inbound bearer GateTest must present on result callbacks. See `GATETEST_HOOK.md`. |
| `GATETEST_HMAC_SECRET` | HMAC secret for inbound GateTest callbacks (alternative to bearer). |
| `CRONTECH_DEPLOY_URL` | Optional outbound deploy webhook. When set, pushes to the default branch POST here. |
| `GLUECRON_WEBHOOK_SECRET` | Bearer sent on the outbound deploy webhook above. |
| `CRONTECH_EVENT_TOKEN` | Bearer an external deploy service must present on `deploy.succeeded` / `deploy.failed` callbacks to `POST /api/events/deploy`. |
| `CRONTECH_STATUS_URL` / `GLUECRON_STATUS_URL` / `GATETEST_STATUS_URL` | Third-party platform-status endpoints surfaced in the `/admin/platform` widget. |

### Operational flags
| Variable | Purpose |
|---|---|
| `AUTOPILOT_DISABLED=1` | Opt out of the 5-minute autopilot ticker (mirror sync, merge-queue processing, weekly digests, advisory rescans). Default: enabled. |
| `DEMO_SEED_ON_BOOT=1` | Idempotently create a `demo` user plus three public sample repos (`hello-python`, `todo-api`, `design-docs`) on server start. Safe to leave enabled — a second run is a near-instant no-op. Site admins can also trigger a reseed manually from `/admin`. |

---

## 4. Database migrations

Migrations are checked into `drizzle/` and run via:

```bash
bun run db:migrate
```

Hook this into your host's release phase so every deploy self-migrates. On Fly.io the in-repo `fly.toml` already wires this up via `[deploy].release_command`. First-time bootstrap: the release command will pick up `0000_init.sql` through the latest migration in order.

---

## 5. Post-deploy checklist

Verify these in order after the first deploy:

- [ ] **Release command ran successfully** — `bun run db:migrate` reported success in the release logs.
- [ ] **`/healthz` is green** — returns `{"ok": true, ...}` with a 200.
- [ ] **`/readyz` is green** — returns `{"ok": true}`, confirming DB connectivity.
- [ ] **`/metrics` responds** — basic process snapshot is emitted.
- [ ] **First admin bootstrap** — register the first account at `/register`. Per `src/lib/admin.ts`, while `site_admins` is empty the **oldest user** is treated as site admin. Register the intended admin account first so the bootstrap rule applies; subsequent admins can then be granted from `/admin/users`.
- [ ] **Smart HTTP works** — create a repo at `/new`, then `git clone https://<your-host>/<user>/<repo>.git` round-trips.
- [ ] **Push triggers the pipeline** — a `git push` fires the secret scanner, webhook fan-out, and (if configured) the outbound GateTest post (check `/:owner/:repo/gates` and `/:owner/:repo/settings/audit`).
- [ ] **Custom domain TLS** — certificate issued and `APP_BASE_URL` reflects the canonical host.
- [ ] **Autopilot state** — if you want the background ticker off, confirm `AUTOPILOT_DISABLED=1` is set; otherwise expect mirror syncs and weekly digests to fire on schedule.

---

## 6. Operations

### Logs
Your host streams stdout/stderr from `bun run src/index.ts` (on Fly.io: `fly logs`). Every request carries an `X-Request-Id` header; grep logs by that ID when tracing a report.

### Restarts
Trigger from your host's dashboard or CLI (on Fly.io: `fly apps restart`). Rate-limit counters are in-memory and reset on restart — that is intentional.

### Rollbacks
Roll back via your host's release history (on Fly.io: `fly releases` + `fly deploy --image <previous>`). Database migrations are additive; rolling back the service does not roll back the schema. If a migration needs reverting, write a new forward-migration.

### Backups
Neon handles PITR + branch snapshots — configure retention in the Neon console. The bare repos on the persistent volume must be backed up separately (filesystem snapshot of the mount at `GIT_REPOS_PATH`; on Fly.io, snapshot the `gluecron_repos` volume). See BUILD_BIBLE §2.6 for what still needs wiring on the observability side.

---

## 7. Graceful-degradation matrix

| Missing secret | Effect |
|---|---|
| `DATABASE_URL` | App boots, `/healthz` returns 200, any DB-backed route returns 500. Do not deploy without it. |
| `ANTHROPIC_API_KEY` | AI review, chat, triage, incident, completions, explain, test-gen, merge resolver all return deterministic fallback strings. Site remains fully usable as a plain git host. |
| `GATETEST_API_KEY` | Outbound GateTest integration silently skipped. Local secret scanner + gate runner still execute. |
| `RESEND_API_KEY` (with `EMAIL_PROVIDER=resend`) | `sendEmail()` still never throws; emails are logged instead of delivered. |
| `VOYAGE_API_KEY` | Semantic search falls back to the deterministic hashing embedder. Quality drops; feature still works. |

Every missing integration follows the same rule: **never break the primary request path**. See BUILD_BIBLE §4.9 for the full invariant list.
