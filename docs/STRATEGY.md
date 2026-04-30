# Gluecron Strategy — GitHub parity + 10 next moves + 5-10 year horizon

**Owner:** Cantynz · **Status:** Living document — update on every meaningful product move.

**Read first:** `BUILD_BIBLE.md` (canonical implementation truth). This doc is the *direction*; the bible is the *position*.

---

## 1. What GitHub does well (the pros we must match)

| # | Pro | Gluecron status |
|---|---|---|
| 1 | Network effect — largest dev community | ❌ no shortcut. Earned via product wins, not features. |
| 2 | Decade-tuned UI polish, keyboard-first chords | ✅ dark/light, Cmd+K palette, `?` shortcuts, /shortcuts page |
| 3 | Actions marketplace (huge action ecosystem) | 🟡 v2 engine + 5 builtins (cache/checkout/upload-artifact/download-artifact/gatetest); marketplace catalog ✅ |
| 4 | Copilot completion latency + IDE integration | ✅ POST /api/copilot/completions + VS Code extension |
| 5 | Code search at scale | ✅ ILIKE per-repo + global · ✅ semantic (Voyage `voyage-code-3`) · 🟡 vector index size at GitHub scale |
| 6 | Codespaces (cloud dev environments) | ❌ — see move #6 below |
| 7 | Pages (free static hosting) | ✅ `gh-pages` branch, custom domain |
| 8 | REST + GraphQL APIs widely integrated | ✅ REST v1 + v2, GraphQL (queries) · 🟡 GraphQL mutations |
| 9 | Security: Dependabot, code scanning, secret scanning | ✅ AI dep updater (J), advisories (J2), secret scanner, code-scanning UI |
| 10 | Brand trust + docs | 🟡 still building. /help is ✅, comprehensive docs are 🟡 |
| 11 | Forks, stars, follows, issues, PRs, reviews | ✅ all shipped |
| 12 | Enterprise SSO + audit log | ✅ OIDC SSO + per-user + per-repo audit UI |

## 2. What GitHub falls short on (the cons we are fixing)

| # | Con | Gluecron's answer |
|---|---|---|
| 1 | AI is bolted on, not native | ✅ End-to-end: AI review on every PR, AI triage on every PR + issue, AI commit messages on the editor, AI PR descriptions on the new-PR form, AI explain on every commit, AI tests, semantic search, spec-to-PR, AI changelog, AI incident responder. Every surface degrades gracefully without ANTHROPIC_API_KEY. |
| 2 | Owned by Microsoft → data + training concerns | ✅ Self-hostable single Bun binary; AGPL/MIT-friendly. Bring-your-own model. |
| 3 | Push policy enforcement is via Actions (post-hoc) | ✅ Pre-receive: protected tags + ruleset name patterns block at the HTTP layer. Pack-content rules in flight (move #3). |
| 4 | Copilot Workspace is paywalled, narrow scope | ✅ Spec-to-PR is built-in: paste an issue body → AI opens a draft PR. "Build with AI" button on every issue. |
| 5 | Slow merge of feedback (PR review iteration takes days) | ✅ Re-run AI review + Re-run AI triage buttons (idempotency-bypass), live SSE comment banner, auto-merge on green gate. |
| 6 | Workflow secrets advertised but Actions-only | ✅ AES-256-GCM-stored, substituted into v1 runner step.run via `${{ secrets.NAME }}` |
| 7 | Wait timers, protected tags, environment approvals shown but not all enforced | ✅ Wait timer flips status="waiting_timer" + autopilot sweeper releases on tick. Protected tags 403 at receive. |
| 8 | No first-class scheduled workflows beyond external cron | ✅ `on: schedule: [{cron: ...}]` driven by autopilot tick (50/tick safety cap) |
| 9 | Limited live UX — refresh-driven | ✅ SSE foundation, live comment banner on issue + PR detail; live log tail on workflow runs |
| 10 | Vendor lock-in (.github/workflows) | ✅ `.gluecron/workflows/*.yml` is a parallel namespace; importer respects `.github/workflows/*` for inbound migration |
| 11 | Org-level gating is policy-only, no enforcement | ✅ Branch protection + required-checks matrix enforced at merge handler |
| 12 | DMCA / privacy / sovereign deploys are hard | ✅ Single-tenant deploys are first-class (fly.toml, Dockerfile in repo) |

## 3. Next 10 biggest moves (the strategic build queue)

Numbers are priority, not size. Each maps to a concrete code surface; bible §3 is the canonical block list.

1. **Container registry (OCI / Docker)** — schema is ready (workflow_run_cache backs blobs). Closes the only major package-ecosystem gap. Estimated: 1 week.
2. **Cross-node SSE fanout (Redis pub/sub or NATS)** — `src/lib/sse.ts` TODO(scale). Required for >1 Bun instance behind a load balancer. Estimated: 2-3 days once Redis is on the deploy.
3. **Pack-content rule enforcement** — extend `src/lib/push-policy.ts` to read the new pack via `git index-pack --stdin`, scan commit messages + tree blobs for: `commit_message_pattern`, `blocked_file_paths`, `max_file_size`. Bible §2.5 J6 partial. Estimated: 1 week.
4. **App-bot push auth (`ghi_` install tokens)** — `src/db/schema.ts` `app_bots` lacks a `users.id` link. Add a synthetic-user shim so installation tokens identify a bot account that can own pushes / comments. Unblocks third-party integrations. Estimated: 3-4 days.
5. **Native mobile apps (iOS + Android)** — only ❌ in the parity scorecard. Wrap the PWA first (Capacitor), full native after. Estimated: 2 weeks for PWA wrap, 6+ weeks for native.
6. **Codespaces equivalent** — Bun-powered ephemeral container per branch + browser IDE. Backed by the existing workflow runner pool. Estimated: 4-6 weeks.
7. **AI agent-mode (multi-turn PR authoring)** — promote spec-to-PR to a *conversation*: the agent proposes, the human comments, the agent iterates. Builds on existing chat memory + PR comments. Estimated: 2-3 weeks.
8. **Proactive AI security advisories** — extend `src/lib/advisories.ts` to *propose patches*, not just flag. PR opened automatically against a `security/auto-patch-*` branch. Estimated: 1-2 weeks.
9. **MCP server endpoints** — Gluecron speaks the Model Context Protocol so any MCP-compatible client (Claude Desktop, Claude Code, Cursor) can read repos, post issues, run workflows. Estimated: 1 week.
10. **AI repo-health coach** — daily/weekly digest surfaced on the dashboard: "your `auth.ts` has 3 TODOs older than 90 days; here's a draft PR fixing 2 of them." Builds on the existing health-score + autopilot. Estimated: 1-2 weeks.

## 4. The 5-10 year horizon (the bets)

Predictions, not promises. We optimise the architecture so each is a small step, not a rewrite.

1. **Code is a runtime artifact, intent is the source.** Humans describe; AI maintains 70%+ of generated code under continuous review. *Gluecron bet:* spec-to-PR + AI review + auto-merge are the load-bearing primitives. Every commit signed by an identifiable agent.
2. **Repos become living agents.** A `.gluecron/agent.yml` declares "what this repo does"; the agent self-heals dependencies, self-runs migrations, self-files incidents. *Gluecron bet:* autopilot framework + auto-repair + scheduled workflows are the seed. Add per-repo agent declarations next.
3. **Reviewers become evaluators.** "Did the agent meet the spec?" replaces line-by-line review. *Gluecron bet:* AI review already does this for every PR. Spec-to-PR closes the loop end-to-end.
4. **Continuous compliance.** Every push proves itself against policy (regulatory, security, custom). *Gluecron bet:* rulesets + protected tags + gate runs + audit log already do this; add SOC2 / HIPAA preset rulesets.
5. **Memory-augmented developers.** Each engineer carries a personal context that follows them across orgs and AI assistants. *Gluecron bet:* AI chat persistence per repo is in. User-level cross-repo memory is move #11 (off-list).
6. **Multimodal authoring.** Issues + PRs authored partly from speech, screenshots, video. *Gluecron bet:* the AI helpers all accept text only today; extending to multimodal is one prompt-shape change (Claude already supports vision).
7. **Edge inference + git.** Repo data + AI compute close to each user (CDN + on-device or regional inference). *Gluecron bet:* Bun + Fly.io regional placement makes this trivial; add per-region runner pools.
8. **Open weights, BYO model.** Users bring their own model (small fine-tuned or local). *Gluecron bet:* `src/lib/ai-client.ts` already isolates the Anthropic call; swap with an OpenAI-compatible adapter is hours.
9. **Sovereign deployments are normal.** Enterprises and states run their own Gluecron, mirroring upstream selectively. *Gluecron bet:* repo mirroring + SSO + admin panel + audit log + single-binary deploy → already shipped. Add a "Gluecron Federation" peer protocol.
10. **The dashboard is the IDE.** Users live on a Gluecron tab the way they live on Slack. *Gluecron bet:* live comment banners, SSE foundation, command palette (Cmd+K), AI chat, dashboard health → the substrate is in. Codespaces (move #6) is the missing leg.

## 5. What this means for the build queue

- Every move in §3 maps to a bounded code change with a defined entry point.
- Every prediction in §4 is a *vector*, not a *destination* — we widen options today (locked invariants, additive schemas, pluggable AI client) so any of these can land without a rewrite.
- The bible is updated in lockstep. New work shows up in §2 (scorecard), §4 (locked files), §7 (in-flight). Strategy → reality flow stays one-way.

## 6. Anti-goals (things we will NOT do)

1. Re-implement the GitHub UI pixel-for-pixel. Different platform, different UI choices.
2. Train our own foundation model. We integrate the best (Claude today, swappable tomorrow).
3. Lock users into Gluecron-specific YAML. Workflow files are portable; importer respects `.github/workflows/*`.
4. Tier essential AI features into paid plans. AI is the platform, not an add-on.
5. Track or sell user code. Privacy + sovereignty are first-class.

---

*Last updated 2026-04-30 alongside the AI-native flow batch (Build with AI, pre-receive enforcement, scheduled workflows, secret substitution, re-review/re-triage buttons, live comment banners). Next review: after move #1 ships.*
