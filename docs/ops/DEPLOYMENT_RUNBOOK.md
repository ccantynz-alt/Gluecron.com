# Gluecron Deployment Runbook

Step-by-step guide for taking Gluecron from zero to running at
`gluecron.com`. This runbook targets **infrastructure deployment** —
Gluecron is deployed as free internal infrastructure for Craig's
ecosystem, **not** as a paid product.

---

## What Gluecron is today

- Git hosting (clone / push / fetch over Smart HTTP)
- Web UI: issues, PRs, code browser, webhooks, SSH keys, OAuth, 2FA
- Integrates with **GateTest** (scans on push) and **Crontech**
  (deploys on push to `main`)
- **Not a paid product.** No Stripe. No tiers. Free infrastructure
  for Craig's ecosystem.
- Pre-launch banner visible; public signups gated until owner review.

---

## Prerequisites

- **Neon** account (managed Postgres) — <https://neon.tech>
- **Fly.io** *or* **Railway** account (container deployment)
- Domain `gluecron.com` in hand (registrar access for DNS records)
- *(Optional)* **Resend** account for transactional email
- *(Optional)* **Anthropic** API key for AI features (copilot,
  changelog summarisation, semantic search)
- *(Optional)* **Voyage** API key for semantic code search embeddings
- Local tooling: `bun`, `git`, `flyctl` or `railway` CLI

---

## Phase 1 — Provision Postgres (Neon)

1. Sign in to <https://neon.tech> and create a project named
   `gluecron`.
2. From the project dashboard, copy the pooled connection string.
   It looks like:
   `postgresql://user:pass@ep-xxx.eu-west-2.aws.neon.tech/neondb?sslmode=require`
3. Save this value — it becomes `DATABASE_URL` in Phase 3.
4. **Do NOT run migrations yet.** The container runs them as its
   release step (see `fly.toml` → `[deploy] release_command`).

---

## Phase 2 — Choose a platform

Both platforms ship from the checked-in `Dockerfile`. Pick one.

### Option A — Fly.io (recommended; `fly.toml` already exists)

`fly.toml` already configures the persistent `gluecron_repos`
volume mounted at `/app/repos` and wires up migrations as the
release command.

```bash
fly auth login
fly launch --no-deploy                 # accept existing fly.toml
fly volumes create gluecron_repos --size 10 --region lhr
fly secrets set \
  DATABASE_URL="<DATABASE_URL_FROM_NEON>" \
  APP_BASE_URL="https://gluecron.com" \
  WEBAUTHN_RP_ID="gluecron.com" \
  WEBAUTHN_ORIGIN="https://gluecron.com" \
  WEBAUTHN_RP_NAME="gluecron" \
  GATETEST_URL="https://gatetest.io/api/scan/run" \
  GATETEST_API_KEY="..." \
  GATETEST_CALLBACK_SECRET="..." \
  GATETEST_HMAC_SECRET="..." \
  CRONTECH_DEPLOY_URL="https://crontech.ai/api/hooks/gluecron/push" \
  GLUECRON_WEBHOOK_SECRET="..." \
  CRONTECH_EVENT_TOKEN="..." \
  ANTHROPIC_API_KEY="..." \
  EMAIL_PROVIDER="resend" \
  RESEND_API_KEY="..." \
  EMAIL_FROM="gluecron <no-reply@gluecron.com>"
fly deploy
```

### Option B — Railway (`railway.toml` already exists)

1. <https://railway.app> → new project → **Deploy from GitHub**.
2. Select the Gluecron repo; Railway picks up the `Dockerfile`
   via `railway.toml`.
3. Add a persistent volume mounted at `/app/repos` (Railway UI
   → service → Volumes).
4. Set all environment variables from Phase 3 in the Railway
   dashboard.
5. Railway will run `bun run db:migrate` as the release command
   on deploy.

---

## Phase 3 — Environment variables

All variables that Gluecron reads from `process.env`, enumerated
from `src/lib/config.ts` and direct `process.env.*` references in
`src/`.

### Core runtime

| Variable | Required? | Example | Notes |
|---|---|---|---|
| `DATABASE_URL` | **Yes** | `<DATABASE_URL_FROM_NEON>` | Neon pooled connection string. |
| `PORT` | No | `3000` | Preset in `fly.toml` / `railway.toml`. |
| `GIT_REPOS_PATH` | **Yes** in prod | `/app/repos` | Must be a persistent volume — this is where bare repos live. |
| `NODE_ENV` | **Yes** in prod | `production` | Enables secure cookies and rate limiting. Preset in both configs. |
| `APP_BASE_URL` | **Yes** | `https://gluecron.com` | Canonical base URL; used in outbound webhooks and email links. No trailing slash. |

### WebAuthn (passkeys / 2FA)

| Variable | Required? | Example | Notes |
|---|---|---|---|
| `WEBAUTHN_RP_ID` | **Yes** | `gluecron.com` | Domain only, **no scheme, no port**. Passkeys are bound to this value; changing it invalidates existing keys. |
| `WEBAUTHN_ORIGIN` | **Yes** | `https://gluecron.com` | Full origin including scheme. Must match what the browser sees. |
| `WEBAUTHN_RP_NAME` | No | `gluecron` | Human-facing name shown by the browser. Default `gluecron`. |

### GateTest integration (scans on push)

| Variable | Required? | Example | Notes |
|---|---|---|---|
| `GATETEST_URL` | **Yes** (for integration) | `https://gatetest.io/api/scan/run` | Default `https://gatetest.ai/api/scan/run` — override to production host. |
| `GATETEST_API_KEY` | **Yes** | `gtk_...` | Outbound bearer token sent to GateTest. |
| `GATETEST_CALLBACK_SECRET` | **Yes** | *(random 32-byte hex)* | Bearer token GateTest uses when posting scan results back to Gluecron (`/hooks/gatetest`). |
| `GATETEST_HMAC_SECRET` | **Yes** | *(random 32-byte hex)* | HMAC signing secret for GateTest → Gluecron callbacks. |

### Crontech integration (deploys on push to main)

| Variable | Required? | Example | Notes |
|---|---|---|---|
| `CRONTECH_DEPLOY_URL` | **Yes** (for integration) | `https://crontech.ai/api/hooks/gluecron/push` | Outbound webhook target. |
| `GLUECRON_WEBHOOK_SECRET` | **Yes** | *(random 32-byte hex)* | Bearer token on outbound Crontech deploy webhook. Empty → Crontech returns 401 and deploys fail. |
| `CRONTECH_EVENT_TOKEN` | **Yes** | *(random 32-byte hex)* | Bearer token Crontech uses when posting deploy events back to Gluecron (`/api/deploy-events`). |

### Email (optional — `log` provider works without)

| Variable | Required? | Example | Notes |
|---|---|---|---|
| `EMAIL_PROVIDER` | No | `resend` or `log` | Default `log` (writes to stderr). Set `resend` for real sending. |
| `RESEND_API_KEY` | Only if `EMAIL_PROVIDER=resend` | `re_...` | Resend API key. |
| `EMAIL_FROM` | No | `gluecron <no-reply@gluecron.com>` | From header. Default `gluecron <no-reply@gluecron.local>`. |

### AI / semantic search (optional)

| Variable | Required? | Example | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | No | `sk-ant-...` | Enables copilot, PR review, changelog summarisation. |
| `VOYAGE_API_KEY` | No | `pa-...` | Enables Voyage embeddings for semantic code search. Falls back to a local model when absent. |

**Total: 18 required/useful env vars** (plus `NODE_ENV`, `PORT`,
`VOYAGE_API_KEY` as optional tuning).

---

## Phase 4 — Run migrations

On both Fly.io and Railway, `bun run db:migrate` is the release
command and runs automatically before traffic is routed to a new
revision. If you need to run it manually:

```bash
# Fly.io
fly ssh console
bun run db:migrate

# Railway
railway run bun run db:migrate
```

Verify the server starts cleanly — `bun run` should not error on
boot.

---

## Phase 5 — DNS

1. Point `gluecron.com` at your platform:
   - **Fly.io**: `fly ips list` → create `A` and `AAAA` records
     to the IPv4/IPv6 shown. Alternatively
     `fly certs add gluecron.com` and follow the CNAME/ALIAS
     instructions.
   - **Railway**: add `gluecron.com` in the service → Settings →
     Domains. Railway prints the target `CNAME`.
2. Wait for Let's Encrypt to provision the certificate (usually
   under 5 minutes). Verify:

```bash
curl -I https://gluecron.com/
```

---

## Phase 6 — Smoke test

- [ ] Visit <https://gluecron.com/> — pre-launch banner is visible.
- [ ] Register an account via email / OAuth.
- [ ] Log in, visit **Settings → SSH keys**, add an SSH public key.
- [ ] Create a repository from the UI.
- [ ] `git clone https://gluecron.com/<you>/<repo>.git` — must
      succeed (this was the Smart HTTP bug fixed in commit
      `676be75`).
- [ ] `git push` — verify it triggers a GateTest scan (if
      `GATETEST_URL` is set).
- [ ] `git push` to `main` — verify it triggers a Crontech deploy
      (if `CRONTECH_DEPLOY_URL` is set).

---

## Phase 7 — Integration wires with GateTest & Crontech

The three apps share secrets pairwise. Each secret value **must be
identical on both sides of the wire**.

| Secret | Set on Gluecron | Set on the other side |
|---|---|---|
| `GATETEST_API_KEY` | outbound auth to GateTest | GateTest validates this on its `/api/scan/run` endpoint |
| `GATETEST_CALLBACK_SECRET` | validates callbacks from GateTest | GateTest sends as bearer on scan-result POSTs |
| `GATETEST_HMAC_SECRET` | verifies signatures on GateTest callbacks | GateTest signs outbound callbacks with this |
| `GLUECRON_WEBHOOK_SECRET` | outbound auth to Crontech | Crontech validates this on `/api/hooks/gluecron/push` |
| `CRONTECH_EVENT_TOKEN` | validates deploy-event POSTs from Crontech | Crontech sends as bearer on `/api/deploy-events` |

**Rule of thumb:** generate each secret once with
`openssl rand -hex 32`, then copy the same value into the matching
variable on both services.

---

## Phase 8 — Pre-launch → launch

When Craig is ready to open signups:

1. Remove the pre-launch banner — revert the `.prelaunch-banner`
   block in `src/views/layout.tsx` that was added in commit
   `4a52a98`.
2. Commit: `feat(launch): remove pre-launch banner`.
3. Push — the container redeploys automatically.

---

## Known limitations at launch

- **No legal pages** — see `docs/legal-audit.md`; needs an owner
  decision on ToS / Privacy before broad public signups.
- **No billing** — free forever, or bolt on Stripe later.
- **18 remaining `tsc` errors in locked files** — they don't block
  runtime; clean-up tracked separately.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `git clone` reports "empty repo" | The repo has no commits. | Push at least one commit first — an empty bare repo has no refs to advertise. |
| Smart HTTP returns `404` on `info/refs` | `GIT_REPOS_PATH` is wrong or the volume isn't mounted with write access. | Check the volume mount in `fly.toml` / Railway; confirm the container user can read the bare repo dir. |
| WebAuthn / passkey registration fails | `WEBAUTHN_RP_ID` doesn't match the domain, or includes a scheme/port. | Must be the bare host (`gluecron.com`); ensure `WEBAUTHN_ORIGIN` matches what the browser sees, including `https://`. |
| GateTest callbacks rejected with `401` | `GATETEST_CALLBACK_SECRET` mismatch between Gluecron and GateTest. | Re-generate the secret and set the same value on both services. |
| Crontech deploys fail with `401` | `GLUECRON_WEBHOOK_SECRET` is empty or mismatched. | Set to the same value on both services; the config default is empty, which Crontech rejects. |
| Outbound emails don't arrive | `EMAIL_PROVIDER` defaults to `log`. | Set `EMAIL_PROVIDER=resend` and configure `RESEND_API_KEY` + `EMAIL_FROM`. |

---

*Last reviewed: 2026-04-16.*