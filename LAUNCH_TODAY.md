# Pre-launch checklist

The platform is effectively feature-complete — BUILD_BIBLE §2 is almost entirely ✅, and blocks A–J have all shipped bar the one row called out below. This doc tracks the remaining go-live work.

Legend: ✅ done · 🟡 in-flight · ❌ not started

---

## Shipped this sprint

Big batches landed on `claude/build-status-update-3MXsf` (see `CHANGELOG.md` for the user-visible breakdown):

- ✅ **Bulk import** — `/import/bulk` paste-a-token flow, multi-repo org migration.
- ✅ **Migrations dashboard** — `/migrations` per-user history + verify button, backed by `src/lib/import-verify.ts`.
- ✅ **Spec-to-PR v2 (real AI)** — `/:owner/:repo/spec` + `src/lib/spec-to-pr.ts` now runs the real Anthropic pipeline (graceful fallback if `ANTHROPIC_API_KEY` is unset).
- ✅ **Repo collaborators + team permissions** — full collaborator model wired through permission middleware.
- ✅ **Permission middleware** — centralised check applied to all write routes.
- ✅ **Real-time SSE foundation** — event stream plumbed for live UI updates.
- ✅ **Preflight CLI** — `bun run preflight` verifies env, DB, git, and required binaries before deploy.
- ✅ **Error tracking** — `src/lib/observability.ts` wired into `app.onError` (supports `ERROR_WEBHOOK_URL` / `SENTRY_DSN`).
- ✅ **Launch comms** — `docs/LAUNCH_ANNOUNCEMENT.md` (Show HN + tweet thread + LinkedIn + demo shot list + press kit).
- ✅ **Demo seed** — `src/lib/demo-seed.ts` + `DEMO_SEED_ON_BOOT=1` flag in `src/index.ts`.
- ✅ **Public status page** — `/status` HTML + `/status.svg` shields badge.

---

## Infrastructure

- ✅ Primary deployment target is Fly.io — `fly.toml` is in-repo (see `DEPLOY.md`). A `Dockerfile` is shipped for any other container host. Neon is the database.
- ✅ Migrations run via `bun run db:migrate`; release-phase wiring documented.
- ✅ `/healthz`, `/readyz`, `/metrics` endpoints shipped (BUILD_BIBLE §2.6).
- ✅ Request-ID tracing on every response (`src/middleware/request-context.ts`).
- ✅ Rate limiting on `/api/*`, `/login`, `/register` (`src/middleware/rate-limit.ts`).
- ✅ Persistent-volume story for `/data/repos` captured in `DEPLOY.md`.
- ✅ Bare-repo backups — filesystem snapshot responsibility documented; Neon PITR for the DB.
- 🟡 `/metrics` shipping to Grafana / Datadog / Prometheus — endpoint exists, pipe not wired.
- ✅ Error-tracking wiring — `src/lib/observability.ts` (supports `ERROR_WEBHOOK_URL` + `SENTRY_DSN`, hooked into `app.onError`). Secrets still need real values in Fly.

## Content

- ✅ Landing page — `src/views/landing.tsx` (`LandingPage`), mounted for logged-out `/` via `src/routes/web.tsx` (BUILD_BIBLE §7, shipped this session).
- ✅ Legal pages — `legal/TERMS.md`, `legal/PRIVACY.md`, `legal/AUP.md`, `legal/SETUP-GUIDE.md`.
- ✅ Demo org / sample repos — shipped via `src/lib/demo-seed.ts` + `DEMO_SEED_ON_BOOT=1` flag wired in `src/index.ts`. Opt-in on boot.
- ✅ README reflects shipped feature surface (`README.md`).
- ✅ Deployment doc reflects Fly.io-first reality (`DEPLOY.md`).
- ✅ GATETEST_HOOK.md documents inbound callback contract.

## Operational

- ✅ Autopilot ticker (`src/lib/autopilot.ts`) shipped this session. Runs mirror sync, merge-queue peek, weekly digests, advisory rescans every 5 minutes. Opt out via `AUTOPILOT_DISABLED=1`. Test coverage in `src/__tests__/autopilot.test.ts`.
- ✅ Site admin panel (`/admin`) + bootstrap rule — oldest user becomes admin when `site_admins` is empty (BUILD_BIBLE Block F3).
- ✅ Billing plans seeded (free/pro/team/enterprise) + quota enforcement (Block F4).
- ✅ Audit log surfaced per-user (`/settings/audit`) and per-repo (`/:owner/:repo/settings/audit`) (Block A2).
- ✅ Email notifications + opt-in weekly digest (Blocks A8, I7).
- ✅ Post-receive pipeline — GateTest, secret scanner, AI security review, CODEOWNERS sync, webhook fan-out (Blocks A1, D, repo defaults).
- ✅ Auto-repair engine runs when `ANTHROPIC_API_KEY` is set.
- 🟡 Monitoring / on-call rotation — `/metrics` + `/healthz` are live; alerting rules are not.
- 🟡 Backup restore drill — never rehearsed end-to-end.

## Communications

- ✅ Launch announcement draft — `docs/LAUNCH_ANNOUNCEMENT.md` (Show HN + tweet thread + LinkedIn + demo shot list + press kit).
- ✅ Status page surfaced publicly — `/status` HTML page + `/status.svg` shields badge are live. Note: the dedicated external status page (status.gluecron.com or similar) is separate downstream work; the in-app `/status` satisfies the launch bar.
- ✅ Changelog cadence committed — `CHANGELOG.md` seeded (Keep-a-Changelog / SemVer). Cadence: update on every user-visible release.

## Legal

- ✅ Terms of Service — `legal/TERMS.md`.
- ✅ Privacy policy — `legal/PRIVACY.md`.
- ✅ Acceptable-use policy — `legal/AUP.md`.
- ✅ License file — `LICENSE` in root.
- 🟡 Legal audit — `docs/legal-audit.md` tracks outstanding items; review before launch.
- ❌ DPA template for enterprise SSO customers (Block I10 shipped, customer paperwork did not).

---

## Go/no-go gates (the short list)

**Top blocker: run `flyctl deploy`.** Code is ready; infra just hasn't been provisioned yet. See `DEPLOY_CHECKLIST.md` for the full runbook.

1. **Run `flyctl deploy`** — everything below is gated on this. Release command will run `bun run db:migrate` automatically.
2. Set `ERROR_WEBHOOK_URL` or `SENTRY_DSN` as a Fly secret (observability wiring is in place, just needs a real sink).
3. Smoke `/healthz`, `/readyz`, `/status` in production → all green.
4. Register → create repo → clone over HTTPS → push → GateTest posts back → webhook fires. End-to-end in prod.
5. Confirm first-admin bootstrap: oldest user in `users` becomes site admin automatically — register the intended admin first.
6. `AUTOPILOT_DISABLED` decision made explicitly (default: enabled).
7. `DEMO_SEED_ON_BOOT` decision made explicitly (default: off; flip to `1` if you want sample repos).

Anything below these bars is non-blocking polish.
