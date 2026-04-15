# LAUNCH TODAY — exact steps to get GlueCron live

The app is deploy-ready. Tests pass (76/76). Boot verified. Migrations included. Dockerfile + Railway + Fly configs shipped.

You need **two secrets** and **one deploy command**. That's it.

---

## A. What you need (3 minutes)

1. **Neon Postgres database** — free tier at https://neon.tech
   - Create a project → copy the "pooled" connection string.
   - This becomes `DATABASE_URL`.
2. **Anthropic API key** — https://console.anthropic.com
   - Create a key → `ANTHROPIC_API_KEY` (optional: all AI features gracefully degrade without it, but you'll want this for the differentiator features).
3. **A deploy target** — pick one:
   - Railway (easiest, `railway.toml` already configured)
   - Fly.io (has `fly.toml` with persistent volume for git repos)
   - Any Docker host (Render, Koyeb, DO App Platform, a VPS — `Dockerfile` works anywhere)

---

## B. Railway (fastest path — ~5 minutes)

```bash
# 1. Install Railway CLI (one-time)
npm i -g @railway/cli

# 2. From the repo root
railway login
railway link              # create or pick a project
railway variables set DATABASE_URL="postgresql://..."
railway variables set ANTHROPIC_API_KEY="sk-ant-..."
railway up                # builds Dockerfile, runs db:migrate via releaseCommand, starts server
```

Railway gives you a live URL like `https://gluecron-production.up.railway.app`.

Add your custom domain (`gluecron.com`) in the Railway dashboard → Settings → Networking.

---

## C. Fly.io (persistent volume for git repos — ~8 minutes)

```bash
# 1. Install flyctl (one-time)
curl -L https://fly.io/install.sh | sh

# 2. From the repo root
fly auth login
fly launch --no-deploy    # accepts existing fly.toml
fly volumes create gluecron_repos --size 10 --region lhr
fly secrets set DATABASE_URL="postgresql://..."
fly secrets set ANTHROPIC_API_KEY="sk-ant-..."
fly deploy
```

Fly gives you `https://gluecron.fly.dev`. Point your domain with:
```bash
fly certs add gluecron.com
```

---

## D. Any Docker host

```bash
docker build -t gluecron .
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://..." \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  -v gluecron_repos:/app/repos \
  gluecron

# Run migrations once:
docker run --rm \
  -e DATABASE_URL="postgresql://..." \
  gluecron bun run db:migrate
```

---

## E. First-boot checklist (after deploy)

1. Visit `https://your-url/healthz` → `{"ok":true,...}`
2. Visit `https://your-url/readyz` → `{"ok":true}` (confirms DB connectivity)
3. Visit `https://your-url/register` → create the first admin account
4. Visit `https://your-url/new` → create a repo (auto-configures with green defaults)
5. Clone it: `git clone https://your-url/<owner>/<repo>.git` — confirms Smart HTTP works
6. Push a commit → post-receive hook fires GateTest + secret scan + webhook fan-out

---

## F. Custom domain (gluecron.com)

DNS:
- `A` or `CNAME` → your deploy host (Railway / Fly / Docker box)
- If using Railway, they issue the cert automatically
- If using Fly, run `fly certs add gluecron.com` after DNS is pointed
- If using a VPS, terminate TLS with Caddy / nginx / Cloudflare in front

---

## G. Post-launch hardening (day 1–3)

These are already shipped and will just start working:
- ✅ Rate limiting (`/api/*` 120/min, `/login` 20/min, `/register` 10/min)
- ✅ Health + readiness + metrics endpoints
- ✅ Request-ID tracing on every response
- ✅ Secret scanner on every push
- ✅ AI security review on every push (if `ANTHROPIC_API_KEY` set)
- ✅ Auto-repair engine (if `ANTHROPIC_API_KEY` set)
- ✅ CODEOWNERS auto-sync
- ✅ Notifications + dashboard + audit log

Observability you might want to add later (Block F in BUILD_BIBLE.md):
- Ship `/metrics` to Grafana / Datadog / Prometheus
- Wire error tracking (Sentry) — one-file addition
- Email digests (currently in-app only)

---

## H. What fails gracefully if you skip secrets

| Missing | Effect |
|---|---|
| `DATABASE_URL` | App boots, `/healthz` returns 200, any DB route returns 500. Don't deploy without it. |
| `ANTHROPIC_API_KEY` | All AI features return safe fallback strings. Site fully usable as a git host. |
| `GATETEST_API_KEY` | GateTest integration silently skipped. Local gates still run. |

---

## I. If anything goes wrong

- Check `/readyz` — tells you if DB is reachable.
- Check `/metrics` — process health snapshot.
- Container logs show every request with latency + status.
- Every request has `X-Request-Id` header — grep logs by that ID.
- `bun test` in the container proves the build is sound.
