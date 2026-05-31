# DEPLOY_VULTR.md — Gluecron on the Vultr box (149.28.119.158)

Current production home: **Vultr server at `149.28.119.158`**, which also
runs another platform. That platform's **custom Bun service owns ports 80/443
and terminates TLS**, so Gluecron does **not** use its bundled Caddy here.
Instead Gluecron runs as an app-only container on `127.0.0.1:3000` and the
existing Bun service reverse-proxies `gluecron.com` to it.

```
Internet ──443──> custom Bun service (existing) ──> 127.0.0.1:3000 (gluecron app)
```

## 1. DNS (Cloudflare, "DNS only" / grey cloud)

| Type | Name           | Content           |
|------|----------------|-------------------|
| A    | `gluecron.com` | `149.28.119.158`  |
| A    | `www.gluecron.com` | `149.28.119.158` |

Remove the old Vercel `www` CNAME and the `_vercel` TXT verification record.

## 2. One-time box setup

```sh
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
cd /opt/gluecron
git checkout claude/site-migration-vercel-XstpK
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL (Neon) and APP_BASE_URL=https://gluecron.com
nano .env
```

## 3. Deploy (app only — bundled Caddy is skipped)

`docker-compose.override.yml` publishes the app on `127.0.0.1:3000` and
disables git-over-SSH. Bring up only the `gluecron` service:

```sh
docker compose up -d --build gluecron
docker compose exec gluecron bun run db:migrate   # first deploy only
curl -s localhost:3000/healthz                     # -> ok
```

## 4. Point the existing Bun proxy at it

Add a virtual-host route in the custom Bun service so requests for
`gluecron.com` (and `www.gluecron.com`) proxy to `http://127.0.0.1:3000`.
The Bun service keeps owning TLS on :443.

## 5. Verify

```sh
curl -sI https://gluecron.com/healthz   # 200 ok, served via the Bun proxy
```

- `https://gluecron.com/healthz` → `ok`
- `https://gluecron.com/readyz`  → `ok`
- `https://gluecron.com/status`  → status page

## Later redeploys

```sh
cd /opt/gluecron && git pull && docker compose up -d --build gluecron
```

## Rollback

```sh
cd /opt/gluecron && git checkout <prev-sha> && docker compose up -d --build gluecron
```
