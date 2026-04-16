# GlueCron — Project State

> Auto-updated at end of each agent session. Human-readable snapshot.

## Current Status

- **Codebase:** 196 files, ~60,000 lines TypeScript
- **Tests:** 767 passing across 51 test files
- **TypeScript errors:** 10 remaining (all Bun Uint8Array compat, non-blocking)
- **Database:** 53+ tables, 35 migrations (Drizzle + Neon PostgreSQL)
- **Branch:** `claude/resume-previous-work-KzyLw` (6 commits ahead of main)

## What's Shipped (Blocks A–J complete)

- Full GitHub-parity git hosting (Smart HTTP clone/push/fetch)
- Issue tracker, PR system with AI review + auto-merge conflict resolution
- Green gate enforcement (GateTest, secret scan, security scan, merge check, AI review)
- Auto-repair on gate failures (secrets, security issues)
- Branch protection, CODEOWNERS, rulesets
- Flywheel learning system (review outcomes, pattern extraction, context injection)
- SSE real-time streaming (gate updates, notifications)
- SBOM export (SPDX 2.3 + CycloneDX 1.5)
- License compliance scanner
- OAuth2 + PAT tokens + 2FA/TOTP + WebAuthn passkeys
- Webhooks, deploy pipelines, CI workflows
- Wiki, discussions, projects, gists, packages (npm registry)
- Marketplace, sponsors, billing, org management
- GraphQL API, admin panel, audit log

## Active Gaps

- No GateTest self-healing loop (continuous test → fix → resubmit)
- Web Push notifications (infrastructure exists, needs final wiring)
- Streaming AI responses via SSE
- Developer velocity metrics dashboard
- No client-side JavaScript interactivity (pure SSR currently)
- Mobile experience not optimized

## Deployment

- **Target:** Fly.io (London region, persistent volume for repos)
- **Dockerfile:** Multi-stage, Bun runtime, auto-migration on release
- **Not yet deployed** — awaiting DATABASE_URL and first deploy

## Key Integrations

- **GateTest:** `https://gatetest.ai/api/scan/run` (test runner)
- **Crontech:** `https://crontech.ai/api/trpc/tenant.deploy` (deploy on push to main)
- **Anthropic Claude:** AI review, merge resolution, security scan, triage, changelog, test gen
