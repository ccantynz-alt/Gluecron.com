# Do this now (gluecron live + admin)

One page. Five steps. Copy-paste in order.

Prod box: **Hetzner Gluecron-1 at `178.104.208.252`** (Falkenstein, eu-central).
DNS target: `gluecron.com` + `www.gluecron.com` A-records → `178.104.208.252`,
proxy status DNS only.

## 1. SSH to the Hetzner box

```sh
ssh root@178.104.208.252
```

If SSH key isn't loaded, use the Hetzner Console's **"Open Console"**
button on the server detail page — it gives a browser-based root shell.

## 2. Install Docker (first-time only)

```sh
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
```

## 3. Clone + configure (first-time only)

```sh
git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
cd /opt/gluecron
git checkout claude/new-session-xk1l7
cp .env.example .env
nano .env   # set DATABASE_URL (Neon connection string) — required
```

Later redeploy:

```sh
cd /opt/gluecron && git pull && docker compose up -d --build
```

## 4. Bring up the stack

```sh
docker compose up -d --build
docker compose logs -f caddy   # ctrl-c once you see "certificate obtained"
docker compose exec gluecron bun run db:migrate
```

If the cert handshake fails: confirm DNS resolves correctly
(`dig +short gluecron.com` should print `178.104.208.252`), and that
Cloudflare proxy is OFF (grey cloud) so Let's Encrypt can hit port 80
directly.

## 5. Register your account

- Open https://gluecron.com/register
- Email + password. Use the email you want to be admin under.

## 6. Confirm + promote yourself to admin

```sh
docker compose exec gluecron bun run scripts/check-admin.ts you@example.com
```

If it says NOT admin:

```sh
docker compose exec gluecron bun run scripts/promote-admin.ts you@example.com
```

Log out, log back in, visit https://gluecron.com/admin.

## 7. Verify (optional but quick)

```sh
bash scripts/verify-deploy.sh https://gluecron.com
```

## 8. Decommission the obsolete box

Once DNS resolves correctly to `178.104.208.252` and gluecron.com works
from multiple networks (your phone on 4G is a good cache-bust), the old
Vultr box at `45.76.171.37` can be destroyed via the Vultr dashboard.
Don't rush this — give DNS 1–2 hours after the change.

---

## Troubleshooting

**Caddy logs say "acme: error issuing certificate":** DNS is wrong or
Cloudflare proxy is on. Check `dig +short gluecron.com` returns
`178.104.208.252` and that the orange cloud is grey in Cloudflare.

**`docker compose exec` says "service is not running":** check
`docker compose ps`. If gluecron is restarting, `docker compose logs gluecron`.
Most common cause: `DATABASE_URL` wrong or Neon project paused.

**`/register` returns 500:** DB migrations probably weren't run. Re-run
`docker compose exec gluecron bun run db:migrate`.

**Site still shows old content after DNS flip:** Cloudflare or local DNS
cache. Check from a phone on cellular (`https://gluecron.com`) to
bypass home/office caches.
