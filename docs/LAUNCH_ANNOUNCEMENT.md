# Gluecron Launch Announcement Package

Prepared for the public launch on 2026-04-21. Placeholder URL throughout: `https://gluecron.fly.dev` (owner to replace once the final Fly app name is chosen).

---

## 1. Show HN post

**Title:** Show HN: Gluecron – a GitHub alternative with AI review on by default

**Body:**

Gluecron is a self-hostable code platform that tries to keep every push production-ready. It started as a weekend experiment in gluing an AI reviewer to a git server and grew into something closer to a full GitHub replacement.

What it does today: git Smart HTTP hosting (clone, push, fetch), pull requests with inline review, issues, discussions, wikis, gists, projects, releases, tags, a package registry speaking the npm protocol, and static page hosting from a `gh-pages` branch. Orgs, teams, CODEOWNERS with team-based resolution, 2FA/TOTP, WebAuthn passkeys, and OIDC SSO (Okta, Azure AD, Auth0, Google Workspace) are all in the box.

What makes it different:

- AI code review runs on every PR and can block merges when `requireAiApproval` is set on a branch protection rule. AI security review plus a 15-pattern secret scanner run on every push.
- Repository rulesets enforce commit, branch, tag, blocked-path, file-size, and force-push policies at push time.
- An autopilot background ticker handles mirror sync, merge-queue processing, weekly email digests, and advisory rescans. Opt out with `AUTOPILOT_DISABLED=1`.
- A workflow runner discovers `.gluecron/workflows/*.yml` on push and executes each step as a Bun subprocess with per-step timeouts and size-capped logs.
- Outbound HMAC-signed webhooks on push/issue/PR/star, an inbound GateTest callback, and a commit status API for external CI.
- Everything AI-flavoured gracefully degrades without `ANTHROPIC_API_KEY`, so it is genuinely usable without paid keys.

Runs anywhere Bun runs. `fly.toml` and `Dockerfile` both ship in the repo. Backed by Neon Postgres.

Stack: Bun, Hono (with server-rendered JSX), Drizzle ORM, Neon PostgreSQL, git CLI subprocesses for the Smart HTTP protocol.

Live site: https://gluecron.fly.dev
Source: https://gluecron.fly.dev/gluecron/gluecron

Happy to answer questions about the gate engine, the autopilot loop, or how the AI reviewer is wired into branch protection.

---

## 2. Tweet thread

**1/** Gluecron is live. It is a GitHub alternative with AI review, a secret scanner, and push-time policy gates on by default. Self-hostable, one Bun process, Neon Postgres behind it. https://gluecron.fly.dev

**2/** Every push runs an AI security review plus a 15-pattern secret scanner. Every PR runs an AI code reviewer that can block merges when `requireAiApproval` is set on a branch protection rule. Opt out per feature, never by default.

**3/** Repository rulesets cover commit/branch/tag patterns, blocked paths, file-size caps, and force-push forbiddance. Workflows live at `.gluecron/workflows/*.yml` and run as Bun subprocesses with per-step timeouts and size-capped logs.

**4/** Also shipped: orgs and teams, CODEOWNERS with team resolution, 2FA, passkeys, OIDC SSO, merge queues, required checks, discussions, wikis, projects, releases, an npm-protocol package registry, and `gh-pages` static hosting.

**5/** Built on Bun, Hono with server-rendered JSX, Drizzle ORM, and Neon Postgres. Deploy target is Fly.io (`fly.toml` in repo) or any Docker host. Try it, break it, file an issue: https://gluecron.fly.dev

---

## 3. LinkedIn post

Gluecron is now publicly available at https://gluecron.fly.dev.

Gluecron is a self-hostable code platform that aims to keep every push production-ready. It provides git Smart HTTP hosting, pull requests with inline review, issues, discussions, wikis, projects, releases, an npm-protocol package registry, and static page hosting, alongside the governance layer teams usually have to assemble themselves.

The differentiator is that AI review, a push-time secret scanner, and repository rulesets are enabled by default rather than bolted on. An AI code reviewer runs on every pull request and can block merges when a branch protection rule requires approval. A 15-pattern secret scanner and an AI security review run on every push. Repository rulesets enforce commit, branch, tag, blocked-path, file-size, and force-push policies.

Platform features include organizations and teams, CODEOWNERS with team-based resolution, two-factor authentication, WebAuthn passkeys, OIDC single sign-on for Okta, Azure AD, Auth0, and Google Workspace, merge queues, required-check matrices, and a workflow runner for `.gluecron/workflows/*.yml` files.

Gluecron is built on Bun, Hono with server-rendered JSX, Drizzle ORM, and Neon PostgreSQL. It ships with a `fly.toml` for Fly.io and a `Dockerfile` for any container host. Features that depend on `ANTHROPIC_API_KEY` degrade gracefully when the key is absent.

Feedback, bug reports, and pull requests are welcome.

---

## 4. Demo video shot list (60 seconds)

- **0:00 – 0:07 Register.** Landing page, click Register, fill in username and password, submit. Arrive on the personal dashboard.
- **0:08 – 0:14 Create repo.** Click New Repository. Name it `demo`, set visibility to public, click Create. Empty repo page renders with clone instructions.
- **0:15 – 0:24 Push a buggy commit.** Terminal window overlay. `git clone`, edit a file to introduce a hardcoded API key plus a simple bug, `git commit`, `git push`. The push output streams in real time.
- **0:25 – 0:34 Gates run.** Cut to the PR or commit page. The 15-pattern secret scanner flags the API key. The AI security review posts a finding. Rulesets show a pass/fail summary. Required checks list updates.
- **0:35 – 0:44 AI review comments.** Open the pull request. AI reviewer has left inline comments on the bug. Show a comment thread. Highlight the `requireAiApproval` badge on the branch protection rule.
- **0:45 – 0:54 Merge and deploy webhook.** Developer fixes the key and the bug, force-pushes the branch, AI review re-runs and approves. Click Merge. Cut to terminal tailing the deploy webhook receiver; a POST arrives with the HMAC signature.
- **0:55 – 1:00 Status page goes green.** Cut to `/status`. All checks green. Fade to the Gluecron wordmark and the URL `https://gluecron.fly.dev`.

---

## 5. Press kit

**What is Gluecron (5-bullet cheatsheet):**

- Gluecron is a self-hostable GitHub alternative built on Bun, Hono, Drizzle ORM, and Neon PostgreSQL, with git Smart HTTP served from the same process.
- AI code review, AI security review, and a 15-pattern secret scanner are enabled by default; AI review can block merges through branch protection.
- Repository rulesets enforce commit, branch, tag, blocked-path, file-size, and force-push policies at push time, independent of AI features.
- Ships with organizations and teams, CODEOWNERS with team resolution, 2FA/TOTP, WebAuthn passkeys, OIDC SSO, merge queues, required checks, an npm-protocol package registry, and `gh-pages` static hosting.
- Deploys via the included `fly.toml` on Fly.io or the included `Dockerfile` on any container host; AI features degrade gracefully when `ANTHROPIC_API_KEY` is absent.

**Screenshot targets:**

- Landing page (`/`) — logged-out hero view.
- Repository file tree — a representative repo with directories, a README rendered below, branch switcher visible.
- Pull request with an inline AI review comment thread visible on a diff hunk.
- `/status` page showing all system checks green.
- `/admin/autopilot` tick table showing the most recent autopilot ticks with mirror sync, merge-queue, digest, and advisory-rescan rows.

---

## 6. Changelog seed

### 2026-04-21 — Public launch

- Git Smart HTTP hosting with clone, push, and fetch over subprocess-backed git, plus SSH keys, personal access tokens, and an OAuth 2.0 provider.
- Pull requests with inline review, draft PRs, merge queues, required-check matrices, and AI code review that can block merges via `requireAiApproval` branch protection.
- Push-time policy enforcement: repository rulesets for commit, branch, tag, blocked-path, file-size, and force-push rules, plus a 15-pattern secret scanner and AI security review on every push.
- Workflow runner that auto-discovers `.gluecron/workflows/*.yml` on push and executes steps as Bun subprocesses with per-step timeouts and size-capped logs; commit status API for external CI.
- Collaboration surface: issues with labels and milestones, discussions, wikis with revision history, projects/kanban, gists, reactions, mentions, notifications, and closing-keyword auto-close on PR merge.
- Platform layer: organizations and teams with team-based CODEOWNERS resolution, 2FA/TOTP with recovery codes, WebAuthn passkeys, OIDC SSO (Okta, Azure AD, Auth0, Google Workspace), an app marketplace with scoped install tokens, an npm-protocol package registry, `gh-pages` static hosting, and protected environments.
- Autopilot background ticker covering mirror sync, merge-queue processing, weekly email digests, and advisory rescans; outbound HMAC-signed webhooks on push/issue/PR/star and an inbound GateTest callback.
- Observability and admin: `/healthz`, `/readyz`, `/metrics`, request-ID tracing, rate limiting, per-repo and personal audit logs, traffic analytics, org-wide insights, and a site admin panel with registration lock, site banner, and read-only mode flags.
