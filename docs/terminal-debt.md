# Terminal debt

Operational paths that still require the terminal because no web UI
equivalent exists yet (or because the path is genuinely
bootstrap-only and a web UI would be inappropriate). Each entry is a
follow-up block.

## No web UI yet — needs one

- `bun run scripts/reset-admin-password.ts <user> <email> <pw>` —
  recover lost site-admin access. Needs an
  `/admin/users/:id/reset-password` button (only callable by another
  site admin) OR a `/recover` flow with email challenge for the
  "every admin locked out" case.

- `bun run scripts/check-auto-merge-readiness.ts` — readiness preflight
  for the auto-merge flip. `/admin/ops` runs the equivalent inline
  when the operator clicks "Enable AI auto-merge", but there is no
  standalone "run readiness check" button if an operator wants to
  poke the box without flipping anything. Low priority — fold into
  `/admin/ops` as a "Check readiness" link if it gets asked for.

## Terminal-only by design (bootstrap)

These do **not** need a web UI — they run before the service is up
or are intended to repair a broken service:

- `bash scripts/bootstrap-hetzner.sh` — first-time box setup. Runs
  before `gluecron` is installed, so there is no `/admin/ops` to
  click. Stay terminal.

- `fly launch` / `fly deploy` (first deploy) — same reason; the box
  doesn't exist yet.

- `ssh root@gluecron.com 'systemctl restart gluecron'` and the
  Hetzner rollback `git checkout <previous-sha> && systemctl restart
  gluecron` — these are documented as fallbacks in `DEPLOY.md` §6
  under `<details>` blocks for the case where `/admin/ops` itself is
  broken. They must remain terminal-accessible because they are the
  recovery path **for** `/admin/ops`.

- `fly ssh console -C "bun run db:migrate"` and
  `railway run bun run db:migrate` — only invoked manually if the
  release command fails to fire during a deploy and the operator
  needs to re-run migrations out-of-band. The normal path (re-trigger
  deploy from `/admin/ops`) handles this; documented as a fallback in
  `docs/ops/DEPLOYMENT_RUNBOOK.md` Phase 4.
