# Deploying Gluecron

## The green ecosystem

Gluecron is part of a self-hosting triangle. Each service deploys or observes the others:

- **Crontech** is the deployment platform for Gluecron (and everything else).
- **Gluecron** hosts the source code for Crontech, GateTest, and itself.
- **GateTest** scans every push to Gluecron.

Dogfood end-to-end. **Crontech is the deployment target.** Do not deploy Gluecron to Vercel or Hetzner — they are not part of this stack.

---

## 1. Prerequisites

1. **Neon Postgres** — create a project at https://neon.tech and copy the pooled connection string. This becomes `DATABASE_URL`.
2. **Crontech account** — tenant + service permissions for the repo.
3. **(Recommended) Anthropic API key** — https://console.anthropic.com. Everything AI-flavoured degrades to safe fallbacks without it, but you'll want this for the differentiator features.

---

## 2. Deploy via Crontech

In Crontech, create a service pointing at this repo with:

- **Build:** `bun install --production`
- **Release:** `bun run db:migrate`
- **Start:** `bun run src/index.ts`
- **Port:** `3000`
- **Persistent volume:** mount `/data/repos` (bare git repos live on disk)

Route a subdomain (e.g. `gluecron.crontech.ai`) or a custom domain (e.g. `gluecron.com` via CNAME) to the service.

Crontech handles TLS termination, rollouts, and restart policy. Treat it as the primary control plane — do not bolt on nginx, systemd, or Docker Compose orchestration.

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

### Integrations
| Variable | Purpose |
|---|---|
| `GATETEST_URL` | Outbound push webhook. Default `https://gatetest.ai/api/events/push`. |
| `GATETEST_API_KEY` | Bearer sent on outbound GateTest posts. |
| `GATETEST_CALLBACK_SECRET` | Inbound bearer GateTest must present on result callbacks. See `GATETEST_HOOK.md`. |
| `GATETEST_HMAC_SECRET` | HMAC secret for inbound GateTest callbacks (alternative to bearer). |
| `CRONTECH_DEPLOY_URL` | Outbound deploy webhook. Default `https://crontech.ai/api/hooks/gluecron/push`. |
| `GLUECRON_WEBHOOK_SECRET` | Bearer sent on the outbound Crontech deploy webhook. |
| `CRONTECH_EVENT_TOKEN` | Bearer Crontech must present on `deploy.succeeded` / `deploy.failed` callbacks to `POST /api/events/deploy`. |
| `CRONTECH_STATUS_URL` / `GLUECRON_STATUS_URL` / `GATETEST_STATUS_URL` | Platform-status endpoints surfaced in the `/admin/platform` widget. |

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

Hook this into Crontech's release phase so every deploy self-migrates. First-time bootstrap: the release command will pick up `0000_init.sql` through the latest migration in order.

---

## 5. Post-deploy checklist

Verify these in order after the first deploy:

- [ ] **Migrations ran** — `db:migrate` reported success in release logs.
- [ ] **`/healthz` is green** — returns `{"ok": true, ...}` with a 200.
- [ ] **`/readyz` is green** — returns `{"ok": true}`, confirming DB connectivity.
- [ ] **`/metrics` responds** — basic process snapshot is emitted.
- [ ] **First admin bootstrap** — register the first account at `/register`. Per `src/lib/admin.ts`, while `site_admins` is empty the **oldest user** is treated as site admin. Register the intended admin account first so the bootstrap rule applies; subsequent admins can then be granted from `/admin/users`.
- [ ] **Smart HTTP works** — create a repo at `/new`, then `git clone https://<your-host>/<user>/<repo>.git` round-trips.
- [ ] **Push triggers the pipeline** — a `git push` fires GateTest, the secret scanner, and webhook fan-out (check `/:owner/:repo/gates` and `/:owner/:repo/settings/audit`).
- [ ] **Custom domain TLS** — certificate issued and `APP_BASE_URL` reflects the canonical host.
- [ ] **Autopilot state** — if you want the background ticker off, confirm `AUTOPILOT_DISABLED=1` is set; otherwise expect mirror syncs and weekly digests to fire on schedule.

---

## 6. Operations

### Logs
Crontech streams stdout/stderr from `bun run src/index.ts`. Every request carries an `X-Request-Id` header; grep logs by that ID when tracing a report.

### Restarts
Trigger from the Crontech dashboard. Rate-limit counters are in-memory and reset on restart — that is intentional.

### Rollbacks
Roll back via Crontech's release history. Database migrations are additive; rolling back the service does not roll back the schema. If a migration needs reverting, write a new forward-migration.

### Backups
Neon handles PITR + branch snapshots — configure retention in the Neon console. The bare repos on the persistent volume must be backed up separately (filesystem snapshot of `/data/repos`). See BUILD_BIBLE §2.6 for what still needs wiring on the observability side.

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
