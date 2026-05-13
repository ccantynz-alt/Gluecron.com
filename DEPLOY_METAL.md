# DEPLOY_METAL.md — Hetzner Gluecron-1 deploy

Prod home: **Hetzner Cloud server `Gluecron-1`** at `178.104.208.252`
(Falkenstein, eu-central, CPX22 x86 80GB). Replaces the obsolete Vultr
box at `45.76.171.37`.

This is the shortest path to gluecron.com being live on Hetzner. The
`Dockerfile`, `docker-compose.yml`, and `Caddyfile` in the repo bring
up the app + reverse proxy + auto-HTTPS in one command. Cloudflare DNS
remains the resolver; Cloudflare proxying stays OFF so Let's Encrypt
can complete HTTP-01.

## What's already in place

- DNS target: `gluecron.com` + `www.gluecron.com` A-records should point at
  `178.104.208.252`, proxy status "DNS only" (grey cloud) in Cloudflare.
  If they still point at `45.76.171.37`, fix that first.
- `Dockerfile`, `docker-compose.yml`, `Caddyfile` are all in the repo.
  `docker compose up -d` brings up both the app and Caddy (auto-HTTPS
  via Let's Encrypt).
- App exposes `/healthz`, `/readyz`, `/status`, `/metrics`.

## One-time box setup

1. SSH in: `ssh root@178.104.208.252` (or use the Hetzner Console "Open Console" button)
2. Install Docker (skip if already installed):
   ```sh
   command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
   ```
3. Clone the repo:
   ```sh
   git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
   cd /opt/gluecron
   git checkout claude/new-session-xk1l7   # while this branch is the deploy target
   ```
4. Create `.env` (copy from `.env.example` and fill real values — at
   minimum `DATABASE_URL` pointing at Neon):
   ```sh
   cp .env.example .env
   nano .env
   ```

## Deploy

```sh
cd /opt/gluecron
git pull
docker compose up -d --build
```

First run: Caddy requests Let's Encrypt certs. Watch:
```sh
docker compose logs -f caddy
```

Once you see `certificate obtained successfully`, hit:
- `https://gluecron.com/healthz` → `ok`
- `https://gluecron.com/readyz` → `ok`
- `https://gluecron.com/status` → status page
- `https://gluecron.com/metrics` → Prometheus-format metrics

## First-time DB migration

```sh
docker compose exec gluecron bun run db:migrate
```

## Later redeploys

```sh
cd /opt/gluecron && git pull && docker compose up -d --build
```

## Rollback

```sh
cd /opt/gluecron && git checkout <prev-sha> && docker compose up -d --build
```

## Decommission the old Vultr box

The Vultr server at `45.76.171.37` was the previous home and now serves
stale content. Once Hetzner Gluecron-1 is serving correctly and DNS has
fully propagated (check from a phone on cellular), destroy the Vultr
box via its provider dashboard.

## When Crontech absorbs hosting

Gluecron stays where it is. Crontech-prod-01 (Hetzner, `178.156.251.6`,
Ashburn) becomes the deploy target for additional empire projects via
the BLK-009 git-push pipeline. Gluecron-1 keeps serving the git host +
CI surface; Crontech keeps serving the deploy + runtime surface.
