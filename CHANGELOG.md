# Changelog

All notable changes to Gluecron will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Spec-to-PR v2 (real AI pipeline).** `/:owner/:repo/spec` now drives a real Anthropic-backed generation pass through `src/lib/spec-to-pr.ts`; falls back gracefully when `ANTHROPIC_API_KEY` is unset.
- **Repository collaborators + team permissions.** Full collaborator model wired end-to-end, guarded by a centralised permission middleware applied to all write routes.
- **Bulk import.** `/import/bulk` accepts a GitHub org + token and migrates multiple repos in one pass.
- **Migrations dashboard.** `/migrations` shows per-user import history with a verify button backed by `src/lib/import-verify.ts`, which smoke-verifies imported repos are clonable.
- **Experimental spec-to-PR entry point** (first shipped in the bulk-import release, then upgraded to v2 above).
- **`/help` page + onboarding polish.** Clearer new-user path, import-flow copy tightened.
- **Error tracking.** `src/lib/observability.ts` wired into `app.onError`; supports `ERROR_WEBHOOK_URL` and `SENTRY_DSN`.
- **Launch announcement bundle.** `docs/LAUNCH_ANNOUNCEMENT.md` covers Show HN copy, tweet thread, LinkedIn post, demo shot list, and press kit.
- **Site audit.** `docs/SITE_AUDIT.md` — snapshot of readiness, drift, and launch blockers.

### Changed
- **Crontech decoupled.** Gluecron now ships as a standalone product; `CRONTECH_DEPLOY_URL` remains as an optional outbound webhook only.
- **Pre-launch docs refreshed.** `LAUNCH_TODAY.md` now reflects what's actually shipped; top blocker is now "run `flyctl deploy`".

### Fixed
- **Import-verify test hardening.** Defensive `mock.module` fallthrough so the suite passes under isolated test runs.

## [0.1.0] - 2026-04-21

- Initial public release.

[Unreleased]: https://github.com/ccantynz-alt/Gluecron.com/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ccantynz-alt/Gluecron.com/releases/tag/v0.1.0
