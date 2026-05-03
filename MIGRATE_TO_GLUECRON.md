# Migrating gluecron off GitHub onto itself

This is the dogfooding play. The pitch is "GitHub replacement for AI-native software" — and right now gluecron's own source code lives on GitHub. This doc is the path to fix that.

## Prerequisites

- `gluecron.com` is live and responding 200 on `/healthz`
- You have an admin account registered on gluecron.com (the first user with username matching `SITE_ADMIN_USERNAME` env auto-becomes site admin; default is `ccantynz-alt`)

If gluecron.com is still 502, see the platform-status section in `LAUNCH_TODAY.md` first.

## Phase B — gluecron-on-gluecron (ship today)

This phase mirrors the repo onto gluecron.com without abandoning GitHub. Both stay in sync until you're confident enough to cut the cord.

### One command

```powershell
.\scripts\migrate-to-gluecron.ps1
```

It will:

1. Verify `gluecron.com` is live
2. Prompt for your PAT (generate at `/settings/tokens`)
3. Trigger a `/import/github/repo` mirror of `ccantynz-alt/Gluecron.com` onto gluecron
4. Print the `git remote add gluecron` command for your local clone
5. Print the Claude Desktop / Cursor MCP config snippet so Claude switches from GitHub MCP to gluecron's MCP

After this:

- The repo is browsable at `https://gluecron.com/ccantynz-alt/Gluecron.com`
- You can `git push gluecron main` — both remotes stay in sync
- Claude Code can `read_file`, `list_issues`, `search_repo`, etc. against gluecron instead of GitHub once you swap the MCP config

### Workflow runner takes over deploys (incremental)

The repo now ships `.gluecron/workflows/deploy.yml` — the gluecron-native equivalent of `.github/workflows/vultr-deploy.yml`. When gluecron's workflow runner picks it up on a push to main, it runs the same deploy steps locally on the box (no SSH-from-runner gymnastics — gluecron and the deploy target are on the same machine, so the workflow runner runs `bash scripts/deploy-crontech.sh` directly).

For now both `.github/workflows/vultr-deploy.yml` (GitHub) and `.gluecron/workflows/deploy.yml` (gluecron) coexist. After a week of clean deploys via gluecron's runner, delete the GitHub Action.

## Phase C — cut the GitHub cord (after a week of stable Phase B)

When you trust the gluecron-side enough:

1. Migrate any active GitHub issues to gluecron (the import flow handles past issues automatically; only WIP discussions need manual moves)
2. Migrate active PRs (rebase onto a gluecron-side branch, push there)
3. Delete `.github/workflows/vultr-deploy.yml` and `.github/workflows/fly-deploy.yml`
4. Set the GitHub repo to read-only / archive
5. Update `package.json` `repository.url`, `README.md` install instructions, and any other GitHub references to point at `gluecron.com/ccantynz-alt/Gluecron.com`
6. Done. Gluecron now hosts gluecron.

## Rollback at any time

The migration is non-destructive. The GitHub repo stays untouched. If gluecron-on-gluecron has a problem:

- `git push origin main` (GitHub) still works
- `.github/workflows/vultr-deploy.yml` still deploys
- The gluecron-side mirror just falls behind until you re-sync

You can also delete the gluecron-side repo entirely from `/settings` and start over.

## Why this matters

Every day gluecron's code lives on GitHub is a day the product can't truly say "GitHub replacement." This phase is mostly about credibility and trust — but it's also a forcing function. Bugs in gluecron's hosting / PR flow / workflow runner that you'd never hit as a casual self-hoster will surface immediately when *you* are the user.
