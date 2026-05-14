# Gluecron self-host — eating our own dog food

> BLOCK W. The moment Gluecron's own source code stops living on GitHub
> and starts living on Gluecron itself.

## Why

Today every push to `ccantynz-alt/Gluecron.com` on GitHub fires the
`hetzner-deploy.yml` workflow, which SSHes into the box and runs a deploy
script. Every red Action means a manual SSH deploy. Every AI safeguard
(auto-merge, AI review, gate enforcement) only applies to **Gluecron-
hosted repos** — so the platform's own source has been the one repo where
none of the safety net runs.

After this block lands and the operator runs the bootstrap, `git push`
fires the deploy directly via Gluecron's own post-receive hook in ~25
seconds. No GitHub Actions in the middle, no SSH retries, no missing AI
safeguards.

The pitch to customers writes itself: *"Gluecron deploys Gluecron with
Gluecron."*

## Pre-flight (do this BEFORE the bootstrap)

1. **You have site-admin access.** Confirm `/admin/ops` renders for your
   account.
2. **You have root SSH to the production box.** The bootstrap must run on
   the box where `/opt/gluecron` lives, because it writes to
   `$GIT_REPOS_PATH` and to `/opt/gluecron/repos/<owner>/<repo>.git/hooks/`.
3. **`DATABASE_URL` points at the live Neon DB.** Source
   `/etc/gluecron.env` before running the script: `set -a && source
   /etc/gluecron.env && set +a`.
4. **`git` is on PATH and the box can reach `github.com`.** The bootstrap
   clones the GitHub source over HTTPS before push-mirroring it into the
   local bare repo.
5. **Disk: ~200 MB free** for the temp mirror clone + the bare repo
   itself.
6. **No SSH key required from your laptop yet.** Gluecron's git is HTTPS-
   only for now; cutover is `https://gluecron.com/<owner>/<repo>.git`.

## 1. Run the bootstrap

On the box, as root:

```bash
cd /opt/gluecron
set -a; source /etc/gluecron.env; set +a
bun run scripts/self-host-bootstrap.ts
```

Optional flags:

```bash
bun run scripts/self-host-bootstrap.ts \
  --owner=ccantynz \
  --name=Gluecron.com \
  --source=https://github.com/ccantynz-alt/Gluecron.com.git \
  --dry-run            # print what would happen, change nothing
```

What happens (every step prints v/x/!):

1. Looks up the operator — first row in `site_admins`, falling back to
   the oldest user (the bootstrap admin).
2. INSERTs `repositories(name='Gluecron.com', ownerId=<operator>,
   isPrivate=false, defaultBranch='main', diskPath=<computed>)`. Skips
   if a row already exists.
3. `git init --bare /opt/gluecron/repos/ccantynz/Gluecron.com.git` —
   skips if the bare repo already exists.
4. `git clone --mirror` the GitHub source into a temp dir, then `git
   push --mirror` into the bare repo. Every branch, tag, and commit is
   transferred.
5. Writes `hooks/post-receive` on the bare repo: a one-line bash script
   that invokes `scripts/self-deploy.sh` when ref is `refs/heads/main`.
6. Prints cutover instructions.

The script is idempotent — re-run anytime. It only fails if a step
truly cannot proceed (no users in DB, mirror push rejected, etc.).

## 2. Cutover

### On your laptop

```bash
cd ~/code/Gluecron.com
git remote set-url origin https://gluecron.com/ccantynz/Gluecron.com.git
```

### On the production box

```bash
cd /opt/gluecron
git remote set-url origin https://gluecron.com/ccantynz/Gluecron.com.git
```

### Flip the self-host env var

Add to `/etc/gluecron.env`:

```
SELF_HOST_REPO=ccantynz/Gluecron.com
```

Then reload systemd so the live process picks it up:

```bash
systemctl restart gluecron
```

## 3. Verify

1. Open `/admin/self-host` in the browser. All three status pills should
   be green: **Mirrored**, **Installed**, **Set**.
2. From your laptop, push an empty commit:

   ```bash
   git commit --allow-empty -m "self-host smoke"
   git push
   ```

3. Watch `/admin/deploys` — a new row appears with `source='self-deploy'`
   and streams through `git-pull → bun-install → db-migrate → build →
   restart-service → healthz → full-smoke`.
4. Tail the log on the box: `tail -f /var/log/gluecron-self-deploy.log`.

Total wall-clock: push to live ≈ 20–30 seconds.

## 4. Rollback plan

If a self-deploy breaks the site:

- **Automatic:** `scripts/self-deploy.sh` runs `post-deploy-smoke.ts`
  after every restart. On failure it `git reset --hard <PREV_SHA>` and
  restarts. The previous-good SHA is captured *before* `git pull`, so
  rollback is reflog-safe.
- **Manual fallback to GitHub:** change the remote back and re-fire the
  old workflow.

  ```bash
  # on laptop AND on the box
  git remote set-url origin https://github.com/ccantynz-alt/Gluecron.com.git
  ```

  The GitHub mirror remains the canonical history for at least 30 days
  after cutover — we don't deprecate `hetzner-deploy.yml` until the
  self-host path has run a full week without intervention.

## 5. Deprecating GitHub Actions

After 7 days of green self-deploys:

1. Set the workflow `on:` trigger to `workflow_dispatch:` only (no push
   trigger) so it stays available for emergencies but doesn't fire on
   every push.
2. After 30 days, remove the `.github/workflows/hetzner-deploy.yml` file
   entirely.

Until then it's a free hot-spare deploy path.

## Operator footnotes

- **Log rotation:** `/var/log/gluecron-self-deploy.log` is appended to
  forever. Add a `/etc/logrotate.d/gluecron-self-deploy` entry — TODO.
- **Permissions:** `scripts/self-deploy.sh` runs as root (it has to,
  because of `systemctl restart`). The bare-repo post-receive hook
  inherits whatever user the HTTP receive-pack runs under (usually root
  in our setup); SSH receive-pack will eventually need a `git` user with
  passwordless `sudo systemctl restart gluecron`.
- **Self-deploy is gated by `SELF_HOST_REPO`.** Customer repos named
  `Gluecron.com` are safe — only the exact `<owner>/<repo>` slug in the
  env var fires the local deploy.
- **The optional `.gluecron/workflows/deploy.yml`** runs `self-deploy.sh
  --inline` on the in-process workflow runner if you want belt-and-
  braces. The post-receive hook is the primary path.
