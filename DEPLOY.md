# Deploying Gluecron

Gluecron is a standalone product. It runs anywhere Bun runs. The repo ships a `fly.toml` for Fly.io as the documented primary target, and a `Dockerfile` for any other container host.

> **Already deployed?** Day-to-day operations (enable AI auto-merge, trigger a deploy, rollback) all live at [`/admin/ops`](https://gluecron.com/admin/ops). Live deploy progress streams to [`/admin/deploys`](https://gluecron.com/admin/deploys). No SSH required — see §6 below. This document covers first-time bootstrap and the terminal fallbacks.

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

### Web Push / PWA (Block M2)
| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY` | Base64url-encoded uncompressed P-256 public key (65 bytes). Sent to browsers as the `applicationServerKey` for `pushManager.subscribe()`. **If unset, a fresh keypair is generated in-memory at first use and every restart invalidates all existing subscriptions — production must set this.** |
| `VAPID_PRIVATE_KEY` | Base64url-encoded raw 32-byte private scalar paired with `VAPID_PUBLIC_KEY`. Used to ES256-sign the per-delivery JWT. Treat as a secret. |
| `VAPID_SUBJECT` | `mailto:` or `https:` URL identifying the app, included in every VAPID JWT. Defaults to `mailto:ops@gluecron.com`. |

To generate a fresh pair locally, run a one-off Bun snippet using Web Crypto's `subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])` and base64url-encode the raw public key + the JWK private scalar (`d`). The boot log emits the generated public key on first push send when env vars are absent.

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

## 6. Day-to-day operations

Every routine action is a button click on [`/admin/ops`](https://gluecron.com/admin/ops):

- **Enable AI auto-merge on main** — flips the per-repo opt-in covered in §8 below.
- **Trigger a deploy** — fires the same path as a push to the default branch.
- **Rollback to the previous successful release** — selects from the history shown on `/admin/deploys`.

Live deploy progress streams to [`/admin/deploys`](https://gluecron.com/admin/deploys) while the workflow runs. No SSH required for any of this.

**Post-deploy verification is automatic.** Every deploy runs a 15-endpoint smoke suite (`scripts/post-deploy-smoke.ts`) after `systemctl restart`. If any endpoint returns the wrong status or shape — including the case where migrations didn't apply and `/login` now 500s — the workflow auto-rolls back to the previous successful SHA and marks the deploy failed. You'll see this on `/admin/deploys` with a red status pill and a "ROLLED BACK" reason header. The same step also reads `_migrations` from the live DB and refuses to mark the deploy successful if the latest `drizzle/*.sql` file isn't recorded — closing the silent-migration-failure gap that broke gluecron.com for hours on 2026-05-13.

### Logs
Every request carries an `X-Request-Id` header. Grep `/admin/deploys` (per-deploy log panel) or your host's log stream for that ID when tracing a report.

### Restarts
Trigger from `/admin/ops` ("Trigger a deploy" — restart-equivalent) or your host's dashboard. Rate-limit counters are in-memory and reset on restart — that is intentional.

### Rollbacks
Use the "Rollback" button on `/admin/ops`. Database migrations are additive; rolling back the service does not roll back the schema. If a migration needs reverting, write a new forward-migration.

### Backups
Neon handles PITR + branch snapshots — configure retention in the Neon console. The bare repos on the persistent volume must be backed up separately (filesystem snapshot of the mount at `GIT_REPOS_PATH`; on Fly.io, snapshot the `gluecron_repos` volume). See BUILD_BIBLE §2.6 for what still needs wiring on the observability side.

<details>
<summary>Manual fallback (terminal)</summary>

Only needed for first-time box bootstrap or if `/admin/ops` is itself broken.

```bash
# Logs (Fly.io)
fly logs

# Restart (Fly.io)
fly apps restart

# Rollback (Fly.io)
fly releases
fly deploy --image <previous>

# Restart on Hetzner (matches scripts/bootstrap-hetzner.sh)
ssh root@gluecron.com 'systemctl restart gluecron'

# Rollback on Hetzner
ssh root@gluecron.com 'cd /opt/gluecron && git checkout <previous-sha> && systemctl restart gluecron'
```

</details>

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

---

## 8. Lightning-fast deploys (Block N1)

Once migration 0040 has been applied (the release command does this automatically), the operator can flip a single repo into "auto-merge mode" with a single click. From "feature description → live in ~6 minutes, zero clicks" goes from possible to the default.

### What it does

When `branch_protection.enable_auto_merge=true` on the matching rule, the K3 autopilot sweep (`auto-merge-sweep`, fires every 5 minutes) will auto-merge any PR that:

- Targets a branch matching the rule's `pattern`
- Is not a draft
- Passes every gate the manual-merge path enforces (green gates, AI approval, required checks)
- Is not flagged as `critical` by the M3 PR risk scorer

The merge is performed by the autopilot, not by any human click. Default-deny: this only fires on rules where the operator has explicitly opted in.

### Web flow (primary)

1. Go to [`/admin/ops`](https://gluecron.com/admin/ops).
2. Click **"Enable AI auto-merge"**, select the repo (e.g. `ccantynz/Gluecron.com`) and pattern (defaults to `main`).
3. The page runs the readiness check inline (migration 0040 applied, `ANTHROPIC_API_KEY` set, autopilot running, `auto-merge-sweep` registered) and shows red lines if anything is wrong.
4. Confirm. The page writes the `enable_auto_merge=true` flip and surfaces the resulting audit-log row.

Within 5 minutes (the autopilot sweep cadence), any qualifying PR on that branch will auto-merge with zero human clicks. Use the same screen's **"Disable"** toggle to revert.

<details>
<summary>Manual fallback (terminal)</summary>

Only needed if `/admin/ops` is broken. Otherwise prefer the web flow above.

#### Step 1 — Readiness check

```bash
# Fly.io
fly ssh console -C "bun run /opt/gluecron/scripts/check-auto-merge-readiness.ts"

# Hetzner (matches scripts/bootstrap-hetzner.sh)
ssh root@gluecron.com "cd /opt/gluecron && bun run scripts/check-auto-merge-readiness.ts"
```

The check verifies:
- Migration 0040 has been applied (`branch_protection.enable_auto_merge` column exists)
- `ANTHROPIC_API_KEY` is set (otherwise the AI approval gate blocks every candidate)
- The autopilot is running (`AUTOPILOT_DISABLED != 1`)
- The K3 `auto-merge-sweep` task is in `defaultTasks()`

Exit code 0 if all green; 1 if any check fails. Fix any red lines before continuing.

#### Step 2 — Flip the switch for a single repo

```bash
# Fly.io
fly ssh console -C "bun run /opt/gluecron/scripts/enable-auto-merge.ts ccantynz/Gluecron.com"

# Hetzner
ssh root@gluecron.com "cd /opt/gluecron && bun run scripts/enable-auto-merge.ts ccantynz/Gluecron.com"
```

By default this targets the `main` branch. Pass a second arg to target a different pattern, e.g. `release/*`:

```bash
bun run scripts/enable-auto-merge.ts ccantynz/Gluecron.com release/*
```

The script is idempotent:
- If a `branch_protection` row already exists for the (repo, pattern), it flips `enable_auto_merge=true` and preserves every other field.
- If no row exists, it inserts a fresh one with the documented safety defaults (`require_green_gates=true`, `require_ai_approval=true`, `require_human_review=false`, `required_approvals=0`).
- Running it twice in a row produces a "no-op" — no duplicate audit entry.

It prints a before / after diff so you see exactly what changed, and writes an `auto_merge.enabled_on_main` row to `audit_log` for traceability.

#### Revert

```bash
bun run scripts/enable-auto-merge.ts ccantynz/Gluecron.com --off
```

Or manually: `UPDATE branch_protection SET enable_auto_merge = false WHERE repository_id = ... AND pattern = 'main';`. The autopilot sweep is default-deny — it will stop firing the moment the column flips back to `false`.

#### Don'ts

- Do not run `enable-auto-merge.ts` without first running the readiness check. The AI approval gate silently fails closed when `ANTHROPIC_API_KEY` is missing, and you'll spend half an hour wondering why nothing auto-merges.
- The script intentionally does NOT auto-discover repos and flip them all. Explicit per-repo opt-in is the whole point — the operator decides which repos go on autopilot.

</details>
