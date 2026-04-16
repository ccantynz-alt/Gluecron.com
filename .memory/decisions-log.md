# GlueCron — Decisions Log

> Append-only. Never delete entries. Each decision records what, why, and any constraints.

## 2026-04-16

### D001: Fly.io for hosting
- **Decision:** Deploy on Fly.io instead of Hetzner/Render/Railway
- **Why:** Persistent volumes for git repos, auto-migration on release, London region, simple Dockerfile deploy. Hetzner CLI was unusable. Render doesn't support persistent volumes well. Railway lacks volume persistence.
- **Constraint:** Single server for now (shared-cpu-1x, 512MB). Scale vertically first.

### D002: Bun runtime (not Node.js)
- **Decision:** Bun for all runtime, testing, and package management
- **Why:** 2-4x faster than Node.js, native TypeScript, built-in test runner, faster installs
- **Constraint:** Some TypeScript strictness issues with Uint8Array (Bun uses ArrayBufferLike)

### D003: Server-side rendering only (no client JS framework)
- **Decision:** Hono JSX for all rendering, no React/Vue/Svelte client-side
- **Why:** Fastest possible page loads, zero JS bundle, simpler architecture
- **Constraint:** Limits interactivity. SSE provides real-time updates without full SPA.
- **Revisit when:** User demand for rich interactions exceeds what SSR+SSE can deliver

### D004: Neon PostgreSQL (serverless)
- **Decision:** Neon for database, Drizzle ORM for schema/queries
- **Why:** Serverless scaling, branching for dev, no connection pool management
- **Constraint:** Cold starts on first query per session. Mitigated by connection caching.

### D005: Flywheel over static rules
- **Decision:** AI reviews learn from historical outcomes instead of static rule files
- **Why:** Rules rot. The flywheel improves automatically as developers accept/reject suggestions.
- **Constraint:** Needs minimum ~20 review outcomes before patterns emerge. Cold start is stateless.

### D006: Free SBOM export
- **Decision:** Ship SPDX + CycloneDX for free, no paywall
- **Why:** GitHub gates this behind enterprise pricing. Free SBOM is a differentiator.
- **Constraint:** Currently only parses declared dependencies, not transitive.

### D007: GateTest as self-healing loop (planned)
- **Decision:** GateTest will continuously test, auto-fix, and resubmit
- **Why:** Zero human intervention for routine failures. The platform heals itself.
- **Constraint:** Need to define repair boundaries — what can be auto-fixed vs what needs human review.

### D008: Memory system for agent continuity
- **Decision:** Markdown state files + enhanced CLAUDE.md session protocols
- **Why:** Context loss across sessions causes repeated work. Memory files bridge the gap.
- **Constraint:** Files must be kept under 500 lines each to fit in agent context windows.
