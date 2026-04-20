# Pre-launch checklist

The platform is effectively feature-complete — BUILD_BIBLE §2 is almost entirely ✅, and blocks A–J have all shipped bar the one row called out below. This doc tracks the remaining go-live work.

Legend: ✅ done · 🟡 in-flight · ❌ not started

---

## Infrastructure

- ✅ Deployment target is Crontech (see `DEPLOY.md`). Neon is the database. No Vercel, no Hetzner.
- ✅ Migrations run via `bun run db:migrate`; release-phase wiring documented.
- ✅ `/healthz`, `/readyz`, `/metrics` endpoints shipped (BUILD_BIBLE §2.6).
- ✅ Request-ID tracing on every response (`src/middleware/request-context.ts`).
- ✅ Rate limiting on `/api/*`, `/login`, `/register` (`src/middleware/rate-limit.ts`).
- ✅ Persistent-volume story for `/data/repos` captured in `DEPLOY.md`.
- ✅ Bare-repo backups — filesystem snapshot responsibility documented; Neon PITR for the DB.
- 🟡 `/metrics` shipping to Grafana / Datadog / Prometheus — endpoint exists, pipe not wired.
- ❌ Error-tracking (Sentry) wiring. Block F follow-up.

## Content

- ✅ Landing page — `src/views/landing.tsx` (`LandingPage`), mounted for logged-out `/` via `src/routes/web.tsx` (BUILD_BIBLE §7, shipped this session).
- ✅ Legal pages — `legal/TERMS.md`, `legal/PRIVACY.md`, `legal/AUP.md`, `legal/SETUP-GUIDE.md`.
- 🟡 Demo org / sample repos — `src/lib/demo-seed.ts` and the `DEMO_SEED_ON_BOOT=1` boot flag are the deferred item from BUILD_BIBLE §7. Design sketch exists; no code yet.
- ✅ README reflects shipped feature surface (`README.md`).
- ✅ Deployment doc reflects Crontech-first reality (`DEPLOY.md`).
- ✅ GATETEST_HOOK.md documents inbound callback contract.

## Operational

- ✅ Autopilot ticker (`src/lib/autopilot.ts`) shipped this session. Runs mirror sync, merge-queue peek, weekly digests, advisory rescans every 5 minutes. Opt out via `AUTOPILOT_DISABLED=1`. Test coverage in `src/__tests__/autopilot.test.ts`.
- ✅ Site admin panel (`/admin`) + bootstrap rule — oldest user becomes admin when `site_admins` is empty (BUILD_BIBLE Block F3).
- ✅ Billing plans seeded (free/pro/team/enterprise) + quota enforcement (Block F4).
- ✅ Audit log surfaced per-user (`/settings/audit`) and per-repo (`/:owner/:repo/settings/audit`) (Block A2).
- ✅ Email notifications + opt-in weekly digest (Blocks A8, I7).
- ✅ Post-receive pipeline — GateTest, secret scanner, AI security review, CODEOWNERS sync, webhook fan-out (Blocks A1, D, green-ecosystem defaults).
- ✅ Auto-repair engine runs when `ANTHROPIC_API_KEY` is set.
- 🟡 Monitoring / on-call rotation — `/metrics` + `/healthz` are live; alerting rules are not.
- 🟡 Backup restore drill — never rehearsed end-to-end.

## Communications

- ❌ Launch announcement draft (blog post, social).
- ❌ Status page / platform-status endpoints surfaced publicly. `CRONTECH_STATUS_URL` / `GLUECRON_STATUS_URL` / `GATETEST_STATUS_URL` env vars + `/admin/platform` widget are shipped; external status page is not.
- ❌ Changelog or release-notes cadence committed.

## Legal

- ✅ Terms of Service — `legal/TERMS.md`.
- ✅ Privacy policy — `legal/PRIVACY.md`.
- ✅ Acceptable-use policy — `legal/AUP.md`.
- ✅ License file — `LICENSE` in root.
- 🟡 Legal audit — `docs/legal-audit.md` tracks outstanding items; review before launch.
- ❌ DPA template for enterprise SSO customers (Block I10 shipped, customer paperwork did not).

---

## Go/no-go gates (the short list)

1. Smoke `/healthz` + `/readyz` in production → both green.
2. Crontech release pipeline runs `db:migrate` successfully on deploy.
3. Register → create repo → clone over HTTPS → push → GateTest posts back → webhook fires. End-to-end in prod.
4. `AUTOPILOT_DISABLED` decision made explicitly (default: enabled).
5. Demo content story resolved — either ship `DEMO_SEED_ON_BOOT=1` wiring or accept an empty home.
6. Launch comms drafted and scheduled.

Anything below these bars is non-blocking polish.
