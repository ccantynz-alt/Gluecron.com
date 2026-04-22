# DEPLOY_METAL.md — metal-box deploy (interim)

This is the shortest path to gluecron.com being live on the existing Vultr
box at `45.76.171.37`. It's a stop-gap — everything migrates onto Crontech
once Crontech is absorbing hosting, and DNS gets flipped (to Fly.io briefly
or straight to Crontech) at that point. Don't polish this; throw it away
later.

## What's already in place

- DNS: `gluecron.com` and `www.gluecron.com` A records point at
  `45.76.171.37`. Proxy status is "DNS only" in Cloudflare — keep it that
  way for the cert handshake.
- `Dockerfile`, `docker-compose.yml`, and `Caddyfile` are all in the repo.
  `docker compose up -d` brings up both the app and Caddy (auto-HTTPS via
  Let's Encrypt).
- App exposes `/healthz`, `/readyz`, `/status` per BUILD_BIBLE §2.6.

## One-time box setup

1. SSH in: `ssh root@45.76.171.37`
2. Install Docker (skip if already installed):
   ```sh
   curl -fsSL https://get.docker.com | sh
   ```
3. Clone the repo:
   ```sh
   git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
   cd /opt/gluecron
   ```
4. Create `.env` (copy from `.env.example` and fill the real values — at
   minimum `DATABASE_URL` pointing at Neon):
   ```sh
   cp .env.example .env
   vim .env
   ```

## Deploy

```sh
cd /opt/gluecron
git pull
docker compose up -d --build
```

First run: Caddy requests a Let's Encrypt cert. Watch:
```sh
docker compose logs -f caddy
```

Once you see `certificate obtained successfully`, hit:
- `https://gluecron.com/healthz` → `ok`
- `https://gluecron.com/readyz` → `ok`
- `https://gluecron.com/status` → status page

## First-time DB migration

After the container is up:
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

## When Crontech absorbs this

1. Point DNS at the Crontech edge (Caddy on the Crontech box, or whatever
   Crontech routes through).
2. Push gluecron.com via git to Crontech — BLK-009 deploy pipeline builds
   and serves it.
3. Tear down this box. Nothing here is worth preserving.
