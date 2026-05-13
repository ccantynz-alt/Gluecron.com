# Do this now (gluecron live + admin)

One page. Five steps. Copy-paste in order.

## 1. SSH to the metal box

```sh
ssh root@45.76.171.37
```

If SSH key-only is enabled and your key isn't loaded, use Vultr's vSerial
console from the dashboard — it accepts the root password from server
Overview → "Show Password".

## 2. Clone + configure (first-time only)

```sh
git clone https://github.com/ccantynz-alt/Gluecron.com.git /opt/gluecron
cd /opt/gluecron
git checkout claude/new-session-xk1l7   # the deploy + admin scripts live here
cp .env.example .env
vim .env   # set DATABASE_URL at minimum (Neon connection string)
```

Redeploy on later visits:

```sh
cd /opt/gluecron && git pull && docker compose up -d --build
```

## 3. Bring up the stack

```sh
docker compose up -d --build
docker compose logs -f caddy   # ctrl-c once you see "certificate obtained"
```

Then run migrations:

```sh
docker compose exec gluecron bun run db:migrate
```

## 4. Register your account

- Open https://gluecron.com/register in a browser
- Email + password. Use the same email you want to be admin under.
- First registered user auto-promotes per bootstrap rule — but to be safe:

## 5. Confirm + promote yourself to admin

```sh
docker compose exec gluecron bun run scripts/check-admin.ts you@example.com
```

If it says "NOT admin":

```sh
docker compose exec gluecron bun run scripts/promote-admin.ts you@example.com
```

Log out, log back in, visit https://gluecron.com/admin — should render.

## 6. Verify (optional but quick)

```sh
bash scripts/verify-deploy.sh https://gluecron.com
```

All lines should show OK. If any FAIL, look at the line and debug just that.

---

## Troubleshooting

**Caddy logs say "acme: error issuing certificate":** DNS is wrong or
Cloudflare proxy is on. Check `dig +short gluecron.com` returns
`45.76.171.37` and that the orange cloud is grey in Cloudflare.

**`docker compose exec` says "service is not running":** check
`docker compose ps`. If gluecron is restarting, `docker compose logs gluecron`.
Most common cause: `DATABASE_URL` wrong or Neon project paused.

**`/register` returns 500:** DB migrations probably weren't run. Re-run
`docker compose exec gluecron bun run db:migrate`.

**"Cannot find module 'src/db/client'":** the scripts assume the working
directory is the repo root inside the container, which is the default for
`docker compose exec`. If you're running them on the host, prefix with
`bun --cwd /opt/gluecron run scripts/...`.
