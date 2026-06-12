/**
 * Marketing landing page for logged-out visitors.
 *
 * Editorial-Technical redesign — 2026.05.
 * Hero · trust strip · feature grid · workflow walkthrough ·
 * comparison · terminal · pricing teaser · closing CTA.
 *
 * Block L10 — hero rewrite. The hero now lands the Block L positioning
 * ("the git host built around Claude"): gradient headline, one-line
 * install snippet w/ copy button, three CTAs (Sign up / Demo / vs-GitHub),
 * and a four-line activity rail driven off the L4 publicStats
 * payload. The L4 counters tile section and L5 vs-GitHub CTA are both
 * preserved — additive only.
 *
 * Also adds two new editorial sections below the L4 counters:
 *   - "Three reasons to switch" (Instant Shipping / Migrate / Demo)
 *   - "How is this different from GitHub?" pull-quote → /vs-github
 *
 * Pure presentational. Drops into <Layout user={null}>.
 * All styles scoped under `.landing-` so they don't bleed into app views.
 */

import type { FC } from "hono/jsx";
import type { PublicStats } from "../lib/public-stats";
import { DEMO_USERNAME } from "../lib/demo-seed";

export interface LandingLiveFeedQueued {
  repo: string;
  number: number;
  title: string;
  createdAt: string | Date;
}

export interface LandingLiveFeedMerge {
  repo: string;
  number: number;
  title: string;
  mergedAt: string | Date;
}

export interface LandingLiveFeedReview {
  repo: string;
  prNumber: number;
  commentSnippet: string;
  createdAt: string | Date;
}

export interface LandingLiveFeedEntry {
  kind: "auto_merge.merged" | "ai_build.dispatched" | "ai_review.posted";
  repo: string;
  ref: { type: "issue" | "pr"; number: number };
  at: string | Date;
}

/**
 * Block M1 — server-rendered snapshot of the live-now feed. The same
 * fields are also fetched client-side every 30s from
 * `/api/v2/demo/{queued,merges,reviews,activity}`. Optional so existing
 * call-sites (and tests that don't care about the live block) keep
 * compiling.
 */
export interface LandingLiveFeed {
  queued: LandingLiveFeedQueued[];
  merges: LandingLiveFeedMerge[];
  reviews: LandingLiveFeedReview[];
  reviewCount: number;
  feed: LandingLiveFeedEntry[];
}

export interface LandingPageProps {
  stats?: {
    publicRepos?: number;
    users?: number;
  };
  /**
   * Block L4 — full public-stats payload (lifetime + trailing-7-day
   * AI-highlight counters). When present, the hero renders an animated
   * six-tile social-proof row beneath the eyebrow.
   */
  publicStats?: PublicStats | null;
  /**
   * Block M1 — initial SSR snapshot for the live-now feed block.
   * The same endpoints poll client-side every 30s. When undefined the
   * section still renders, but with empty-state copy until the first
   * client poll lands.
   */
  liveFeed?: LandingLiveFeed | null;
}

export const LandingHero: FC<LandingPageProps> = ({
  stats,
  publicStats,
  liveFeed,
} = {}) => {
  const hasStats =
    stats &&
    ((stats.publicRepos !== undefined && stats.publicRepos > 0) ||
      (stats.users !== undefined && stats.users > 0));

  // Block L4 — six-tile social proof row. Rendered only when the
  // cached public-stats payload is available; absent → fall back to
  // the small text-only `landing-stats` row.
  const tiles = publicStats
    ? buildSocialProofTiles(publicStats)
    : null;

  // Block M1 — SSR-friendly fallbacks so the no-JS path still renders
  // a populated block. The client-side poller will overwrite these
  // every 30s anyway.
  const liveQueued = liveFeed?.queued ?? [];
  const liveMerges = liveFeed?.merges ?? [];
  const liveReviews = liveFeed?.reviews ?? [];
  const liveReviewCount = liveFeed?.reviewCount ?? 0;
  const liveEntries = liveFeed?.feed ?? [];

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: landingCss }} />

      <div class="landing-root">
        {/* ---------- Hero ----------
            Block U1 — Senior polish pass. Rebuilt for tighter rhythm:
              · 2 primary CTAs (sign up + Claude Desktop)
              · "Try the live demo" / "Compare to GitHub" demoted to
                a tertiary text-link row
              · Install snippet moved BELOW the CTAs as a "power users"
                panel — used to sit above and crowded the buttons
              · 4-stat rail kept but rendered as a tighter horizontal
                strip with the gradient accent rule
              · One new muted gradient orb absolutely positioned behind
                everything so the section reads as a product page, not
                a tutorial
              · vertical rhythm = var(--space-6) between every block
        */}
        <section class="landing-hero">
          <div class="landing-hero-bg" aria-hidden="true">
            <div class="landing-hero-blob landing-hero-blob-1" />
            <div class="landing-hero-blob landing-hero-blob-2" />
            <div class="landing-hero-blob landing-hero-orb" />
            <div class="landing-hero-grid" />
          </div>

          <div class="landing-hero-inner stagger">
            <div class="eyebrow landing-hero-eyebrow">
              <span class="landing-hero-pulse" />
              v1 · pre-launch · {new Date().getFullYear()}
            </div>

            <h1 class="landing-hero-title display">
              <span class="gradient-text">Write the spec. Gluecron ships it.</span>
            </h1>

            <p class="landing-hero-sub">
              Spec to PR in 90 seconds. Push to live in 25. AI review, auto-merge, deploy — automatic.
            </p>

            {/* U1 — primary CTA row. "Migrate from GitHub" added as a
                secondary CTA alongside sign-up to capture visitors who
                already have GitHub repos and want a one-click move. */}
            <div class="landing-hero-ctas" data-testid="hero-primary-ctas">
              <a href="/register" class="btn btn-primary btn-xl landing-cta-primary">
                Sign up free
                <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
              </a>
              {/* Migrate from GitHub — prominent secondary CTA */}
              <a
                href="/import"
                class="btn btn-xl landing-cta-migrate"
                data-testid="cta-migrate"
              >
                Migrate from GitHub
                <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
              </a>
              {/* BLOCK Q1 — one-click Claude Desktop install. */}
              <a
                href="/gluecron.dxt"
                class="btn btn-xl landing-cta-dxt"
                download
                data-testid="cta-dxt"
              >
                Add to Claude Desktop
                <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
              </a>
            </div>

            {/* U1 — tertiary text-link row.
                Visually subordinate to the buttons above. Keeps the
                "Try the live demo" + "Compare to GitHub" affordances
                from L10 + the Q3 "try without signing up" /play link
                without crowding the primary CTA row. */}
            <div class="landing-hero-tertiary" data-testid="hero-tertiary-row">
              <a href="/demo" class="landing-hero-tertiary-link" data-testid="cta-tertiary-demo">
                Try the live demo
                <span aria-hidden="true">{" →"}</span>
              </a>
              <span class="landing-hero-tertiary-sep" aria-hidden="true">·</span>
              <a href="/vs-github" class="landing-hero-tertiary-link" data-testid="cta-tertiary-vs">
                Compare to GitHub
                <span aria-hidden="true">{" →"}</span>
              </a>
              <span class="landing-hero-tertiary-sep" aria-hidden="true">·</span>
              <a href="/play" class="landing-hero-tertiary-link" data-testid="cta-play">
                Try it without signing up
                <span aria-hidden="true">{" →"}</span>
              </a>
            </div>

            {/* U1 — power-users install snippet panel.
                Moved BELOW the CTAs so it doesn't compete for the eye
                with the primary "Sign up free" button. */}
            <div class="landing-hero-install-wrap" aria-label="Power users install panel">
              <div class="landing-hero-install-label">For power users</div>
              <div class="landing-hero-install" aria-label="One-line install">
                <code class="landing-hero-install-code">
                  <span class="landing-hero-install-prompt" aria-hidden="true">$</span>
                  <span id="landing-install-text">curl -sSL gluecron.com/install | bash</span>
                </code>
                <button
                  type="button"
                  class="landing-hero-install-copy"
                  data-copy-target="landing-install-text"
                  aria-label="Copy install command"
                >
                  Copy
                </button>
              </div>
            </div>

            {/* U1 — tightened activity rail.
                Same data as before, rendered as a single horizontal
                rule with the gradient accent line on top. Numbers
                smaller, copy still scannable. */}
            {publicStats && (
              <ul class="landing-hero-rail" aria-label="Gluecron live this week">
                <li>
                  <strong>{publicStats.weeklyPrsAutoMerged.toLocaleString()}</strong>
                  <span class="landing-hero-rail-label">PRs auto-merged</span>
                </li>
                <li>
                  <strong>{publicStats.weeklyIssuesBuiltByAi.toLocaleString()}</strong>
                  <span class="landing-hero-rail-label">issues built by AI</span>
                </li>
                <li>
                  <strong>{publicStats.weeklyDeploysShipped.toLocaleString()}</strong>
                  <span class="landing-hero-rail-label">deploys shipped</span>
                </li>
                <li>
                  <strong>{`~${Math.round(publicStats.weeklyHoursSaved).toLocaleString()}`}</strong>
                  <span class="landing-hero-rail-label">hours saved by AI</span>
                </li>
              </ul>
            )}

            {/* L8 — free-tier reassurance link. Keeps anxiety low for the AI-curious. */}
            <p class="landing-hero-freenote">
              Free forever for the AI-curious.{" "}
              <a href="/pricing" class="landing-hero-freenote-link">
                See pricing &rarr;
              </a>
            </p>

            <p class="landing-hero-caption">
              Already have a repo?
              <span class="landing-hero-cmd">
                <span class="kbd">git</span>
                <span class="kbd">remote</span>
                <span class="kbd">add</span>
                <span class="kbd">gluecron</span>
                <span class="landing-hero-arrow">{"→"}</span>
                <span class="kbd">git push</span>
              </span>
            </p>

            {hasStats && (
              <p class="landing-stats">
                {stats!.publicRepos !== undefined && stats!.publicRepos > 0 && (
                  <span>
                    <strong>{stats!.publicRepos.toLocaleString()}</strong>
                    {stats!.publicRepos === 1 ? " repo" : " repos"}
                  </span>
                )}
                {stats!.publicRepos !== undefined &&
                  stats!.publicRepos > 0 &&
                  stats!.users !== undefined &&
                  stats!.users > 0 && <span class="landing-stats-sep">·</span>}
                {stats!.users !== undefined && stats!.users > 0 && (
                  <span>
                    <strong>{stats!.users.toLocaleString()}</strong>
                    {stats!.users === 1 ? " developer" : " developers"}
                  </span>
                )}
                <span class="landing-stats-sep">·</span>
                <span>
                  <strong>100%</strong> AI-native
                </span>
              </p>
            )}
          </div>
        </section>

        {/* ---------- Block M1 — Live-now demo feed ---------- */}
        <LiveNowSection
          queued={liveQueued}
          merges={liveMerges}
          reviews={liveReviews}
          reviewCount={liveReviewCount}
          feed={liveEntries}
        />

        {/* ---------- L4 social-proof counters (animated count-up) ---------- */}
        {tiles && (
          <section class="landing-counters" aria-label="Gluecron live counters">
            <div class="landing-counters-grid">
              {tiles.map((t) => (
                <div class="landing-counter">
                  <div
                    class="landing-counter-num"
                    data-counter-target={String(t.value)}
                    data-counter-suffix={t.suffix ?? ""}
                    data-counter-prefix={t.prefix ?? ""}
                  >
                    {t.prefix ?? ""}
                    {t.value.toLocaleString()}
                    {t.suffix ?? ""}
                  </div>
                  <div class="landing-counter-label">{t.label}</div>
                </div>
              ))}
            </div>
            <script dangerouslySetInnerHTML={{ __html: landingCountersJs }} />
          </section>
        )}

        {/* ---------- L10 — Three reasons to switch ---------- */}
        <section class="landing-section landing-reasons" aria-label="Three reasons to switch">
          <div class="section-header">
            <div class="eyebrow">Three reasons to switch</div>
            <h2>Built so Claude can do the work.</h2>
          </div>
          <div class="landing-reasons-grid">
            <ReasonCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                </svg>
              }
              title="Ships in seconds, not tabs"
              body="Spec to draft PR in 90 seconds. AI review posted in under 10. Push to live in 25. Every step streams in real time — no polling, no waiting on a CI tab. Or let Sleep Mode batch it for when you're away."
              link={{ href: "/sleep-mode", label: "See Sleep Mode" }}
            />
            <ReasonCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              }
              title="One command to migrate"
              body="Drop a single curl into your shell. Gluecron rehosts your repo, your issues, your branches — no SaaS rip-and-replace project required."
              extra={
                <code class="landing-reasons-code">curl -sSL gluecron.com/install | bash</code>
              }
              link={{ href: "/import", label: "Or import from GitHub" }}
            />
            <ReasonCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              }
              title="Open the demo, watch it work"
              body="The demo repo is real. Label an issue, watch Claude open the PR in seconds. Inspect the diff. Approve the merge. Zero setup, zero credit card."
              link={{ href: "/demo", label: "Open the live demo" }}
            />
          </div>
        </section>

        {/* ---------- Capability strip — uppercase tracked grid (vapron-style) ---------- */}
        <section class="landing-caps">
          <div class="landing-caps-grid">
            <span class="landing-cap">Claude-powered AI</span>
            <span class="landing-cap">Spec-to-PR</span>
            <span class="landing-cap">Auto-repair</span>
            <span class="landing-cap">Real-time gates</span>
            <span class="landing-cap">MCP-native</span>
            <span class="landing-cap">Workflow runner</span>
            <span class="landing-cap">Self-hostable</span>
            <span class="landing-cap">Branch protection</span>
            <span class="landing-cap">Bun + Hono</span>
            <span class="landing-cap">Drizzle + Postgres</span>
            <span class="landing-cap">JSX server-rendered</span>
            <span class="landing-cap">Type-safe end to end</span>
          </div>
        </section>

        {/* ---------- Big stat row (vapron-style hero closer) ---------- */}
        <section class="landing-bigstats">
          <div class="landing-bigstats-grid">
            <div class="landing-bigstat">
              <div class="landing-bigstat-num">Claude-powered</div>
              <div class="landing-bigstat-label">The best AI, native</div>
            </div>
            <div class="landing-bigstat">
              <div class="landing-bigstat-num">Self-hosted</div>
              <div class="landing-bigstat-label">On your hardware</div>
            </div>
            <div class="landing-bigstat">
              <div class="landing-bigstat-num">MCP-native</div>
              <div class="landing-bigstat-label">Claude · Cursor · Code</div>
            </div>
            <div class="landing-bigstat">
              <div class="landing-bigstat-num">Real-time</div>
              <div class="landing-bigstat-label">SSE everywhere</div>
            </div>
          </div>
        </section>

        {/* ---------- Feature grid ---------- */}
        <section class="landing-section">
          <div class="section-header">
            <div class="eyebrow">The platform</div>
            <h2>An IDE for your repo, not just a host.</h2>
            <p>
              Gluecron ships the surfaces GitHub charges extra for, and the
              ones it never built. AI is a teammate with its own commits, not
              a sidebar.
            </p>
          </div>

          <div class="landing-features stagger">
            <FeatureCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3l1.9 4.6L18.5 9l-3.6 3 1 4.8L12 14.5 8.1 16.8l1-4.8L5.5 9l4.6-1.4z" />
                </svg>
              }
              title="AI as a teammate"
              desc="Spec-to-PR drafts entire features from plain English. Auto-explain reviews every diff. The AI commits with its own bot account, visible in your history."
            />
            <FeatureCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2.5l8 3.5v6c0 5-3.5 8.5-8 9.5-4.5-1-8-4.5-8-9.5v-6z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              }
              title="Quality gate that learns"
              desc="GateTest scans every push. Auto-repair fixes regressions before you see them. Required checks block bad PRs from merging. Your software self-corrects."
            />
            <FeatureCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
                </svg>
              }
              title="Real-time everything"
              desc="Live workflow logs over SSE. Live PR review presence. Live deploys you watch happen. No polling, no refresh, no waiting on a CI tab."
            />
            <FeatureCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <path d="M3 9h18M9 21V9" />
                </svg>
              }
              title="Workflow runner"
              desc="Drop a yaml in `.gluecron/workflows/` and it runs on every push. Cron triggers, secret substitution, matrix runs, artifacts. No SaaS provider in the loop."
            />
            <FeatureCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18" />
                </svg>
              }
              title="MCP-native"
              desc="Claude, Cursor, Code — they speak Model Context Protocol. Gluecron exposes search, file read, issues, codebase explain as MCP tools by default."
            />
            <FeatureCard
              icon={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path d="M12 7v5l3 2" />
                </svg>
              }
              title="Yours, on your hardware"
              desc="Single-binary Bun runtime. Postgres + bare git repos on a volume. Deploy to Fly, Railway, your own VPS. No vendor lock, no surprise bills."
            />
          </div>
        </section>

        {/* ---------- Workflow walkthrough ---------- */}
        <section class="landing-section landing-walk">
          <div class="section-header">
            <div class="eyebrow">How it works</div>
            <h2>Push code. Watch it ship.</h2>
            <p>
              Every push triggers the same pipeline whether the commit came
              from you, from CI, or from an AI agent.
            </p>
          </div>

          <div class="landing-walk-grid">
            <WalkStep n="01" title="Push" desc="git push to gluecron — Smart-HTTP, SSH, or via the web editor." />
            <WalkStep n="02" title="Gate" desc="GateTest runs. Secret scanner runs. AI security review posts inline comments." />
            <WalkStep n="03" title="Repair" desc="If a gate fails, auto-repair tries to fix it. New commit gets re-gated." />
            <WalkStep n="04" title="Ship" desc="Green push to default branch fires deploy webhook. Vapron, Fly, your prod." />
          </div>
        </section>

        {/* ---------- Terminal block ---------- */}
        <section class="landing-section landing-terminal-section">
          <div class="landing-terminal-wrap">
            <div class="landing-terminal" role="img" aria-label="Example git push to gluecron with passing gates">
              <div class="landing-terminal-chrome">
                <span class="landing-terminal-dot landing-terminal-dot-r" />
                <span class="landing-terminal-dot landing-terminal-dot-y" />
                <span class="landing-terminal-dot landing-terminal-dot-g" />
                <span class="landing-terminal-title">~/your-repo &mdash; zsh</span>
              </div>
              <div class="landing-terminal-body">
                <div class="landing-term-line">
                  <span class="landing-term-prompt">$</span>
                  <span>git remote add gluecron https://gluecron.com/you/your-repo.git</span>
                </div>
                <div class="landing-term-line">
                  <span class="landing-term-prompt">$</span>
                  <span>git push -u gluecron main</span>
                </div>
                <div class="landing-term-line landing-term-out">
                  <span class="landing-term-meta">remote:</span>
                  <span>Resolving deltas… 100% (24/24)</span>
                </div>
                <div class="landing-term-line landing-term-out landing-term-ok-line">
                  <span class="landing-term-ok">{"✓"}</span>
                  <span>pushed to gluecron.com/you/your-repo</span>
                </div>
                <div class="landing-term-line landing-term-out landing-term-ok-line">
                  <span class="landing-term-ok">{"✓"}</span>
                  <span>GateTest passed (12 rules, 0 violations)</span>
                </div>
                <div class="landing-term-line landing-term-out landing-term-ok-line">
                  <span class="landing-term-ok">{"✓"}</span>
                  <span>AI review posted (2 suggestions, 0 blockers)</span>
                </div>
                <div class="landing-term-line landing-term-out landing-term-ok-line">
                  <span class="landing-term-ok">{"✓"}</span>
                  <span>deployed to your-repo.gluecron.com <span class="landing-term-meta">(4.1s)</span></span>
                </div>
                <div class="landing-term-line landing-term-cursor">
                  <span class="landing-term-prompt">$</span>
                  <span class="landing-term-blink">▍</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Comparison ---------- */}
        <section class="landing-section">
          <div class="section-header">
            <div class="eyebrow">vs the incumbent</div>
            <h2>Everything GitHub charges for. And the parts they didn't build.</h2>
          </div>

          <div class="landing-compare">
            <CompareRow feature="Git hosting + Smart-HTTP push" them="✓" us="✓" />
            <CompareRow feature="Issues, PRs, code review" them="✓" us="✓" />
            <CompareRow feature="Workflow runner (Actions-equivalent)" them="paid minutes" us="self-hosted, unmetered" highlight />
            <CompareRow feature="AI code review on every PR" them="Copilot subscription" us="built in" highlight />
            <CompareRow feature="Spec-to-PR (NL feature → draft PR)" them="—" us="✓" highlight />
            <CompareRow feature="Auto-repair on failed gates" them="—" us="✓" highlight />
            <CompareRow feature="Real-time SSE for logs + PRs" them="polling" us="streaming" highlight />
            <CompareRow feature="MCP server (Claude / Cursor)" them="—" us="✓" highlight />
            <CompareRow feature="Self-host on your own infra" them="enterprise tier" us="single binary" highlight />
            <CompareRow feature="Pre-receive policy enforcement" them="rulesets (GHE)" us="✓" />
          </div>
        </section>

        {/* ---------- Pricing teaser ---------- */}
        <section class="landing-section">
          <div class="section-header">
            <div class="eyebrow">Pricing</div>
            <h2>Free to start. Honest at scale.</h2>
            <p>
              Self-hosting is free forever. Hosted plans price the AI calls,
              not the seats.
            </p>
          </div>

          <div class="landing-pricing">
            <PricingCard
              tier="Free"
              price="$0"
              cadence="forever"
              desc="For personal projects + open source. Public + private repos, full AI suite, fair quotas."
              features={["Unlimited public repos", "3 private repos", "5K AI calls / mo", "Community support"]}
              cta="Start free"
              href="/register"
            />
            <PricingCard
              tier="Pro"
              price="$12"
              cadence="per user / mo"
              desc="For working developers. Lifts every quota, adds priority routing, no Gluecron branding on deploys."
              features={["Unlimited private repos", "100K AI calls / mo", "Priority queue", "Custom domains"]}
              cta="Go Pro"
              href="/settings/billing"
              highlight
            />
            <PricingCard
              tier="Team"
              price="Talk to us"
              cadence="custom"
              desc="For orgs running production on Gluecron. SSO, audit retention, enterprise SLA, on-prem."
              features={["SSO + SCIM", "On-prem deploy", "Dedicated capacity", "24/7 incident response"]}
              cta="Contact"
              href="mailto:hello@gluecron.com"
            />
          </div>
        </section>

        {/* ---------- L10 — "How is this different?" pull-quote ---------- */}
        <section class="landing-pullquote-section" aria-label="How is this different from GitHub?">
          <figure class="landing-pullquote">
            <div class="landing-pullquote-eyebrow">How is this different from GitHub?</div>
            <blockquote class="landing-pullquote-text">
              Every other host bolts AI on as a sidecar. Gluecron is the first
              git host where Claude is a first-class developer. Built to be
              operated by AI agents, not just augmented by them.
            </blockquote>
            <a href="/vs-github" class="landing-pullquote-link">
              See the full comparison
              <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
            </a>
          </figure>
        </section>

        {/* ---------- Closing CTA ---------- */}
        <section class="landing-cta-section">
          <div class="landing-cta-card">
            <div class="landing-cta-bg" aria-hidden="true" />
            <div class="eyebrow">Ready when you are</div>
            <h2 class="landing-cta-title">
              Stop maintaining the platform.<br />
              <span class="gradient-text">Start shipping the product.</span>
            </h2>
            <p class="landing-cta-sub">
              Free to start, self-hosted-friendly, MCP-native. Migrate from
              GitHub in one click.
            </p>
            <div class="landing-cta-buttons">
              <a href="/register" class="btn btn-primary btn-xl">
                Create your account
                <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
              </a>
              <a href="/import" class="btn btn-ghost btn-xl">
                Migrate a repo
              </a>
            </div>
            <div style="margin-top:var(--space-3);font-size:13.5px;color:var(--text-muted)">
              Migrating from GitHub?{" "}
              <a href="/migrate" style="color:var(--accent)">
                Import your entire org in one click &rarr;
              </a>
            </div>
          </div>
        </section>

        {/* L10 — clipboard copy script for the hero install snippet. */}
        <script dangerouslySetInnerHTML={{ __html: landingCopyJs }} />
      </div>
    </>
  );
};

const FeatureCard: FC<{ icon: any; title: string; desc: string }> = ({
  icon,
  title,
  desc,
}) => (
  <div class="landing-feature">
    <div class="landing-feature-icon" aria-hidden="true">
      {icon}
    </div>
    <h3 class="landing-feature-title">{title}</h3>
    <p class="landing-feature-desc">{desc}</p>
  </div>
);

// Block L10 — "Three reasons to switch" column.
const ReasonCard: FC<{
  icon: any;
  title: string;
  body: string;
  link: { href: string; label: string };
  extra?: any;
}> = ({ icon, title, body, link, extra }) => (
  <div class="landing-reason">
    <div class="landing-reason-icon" aria-hidden="true">
      {icon}
    </div>
    <h3 class="landing-reason-title">{title}</h3>
    <p class="landing-reason-body">{body}</p>
    {extra}
    <a href={link.href} class="landing-reason-link">
      {link.label}
      <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
    </a>
  </div>
);

const WalkStep: FC<{ n: string; title: string; desc: string }> = ({
  n,
  title,
  desc,
}) => (
  <div class="landing-walk-step">
    <div class="landing-walk-num">{n}</div>
    <h3 class="landing-walk-title">{title}</h3>
    <p class="landing-walk-desc">{desc}</p>
  </div>
);

const CompareRow: FC<{
  feature: string;
  them: string;
  us: string;
  highlight?: boolean;
}> = ({ feature, them, us, highlight }) => (
  <div class={`landing-compare-row${highlight ? " landing-compare-hl" : ""}`}>
    <div class="landing-compare-feature">{feature}</div>
    <div class="landing-compare-them">{them}</div>
    <div class="landing-compare-us">{us === "✓" ? "✓" : us}</div>
  </div>
);

const PricingCard: FC<{
  tier: string;
  price: string;
  cadence: string;
  desc: string;
  features: string[];
  cta: string;
  href: string;
  highlight?: boolean;
}> = ({ tier, price, cadence, desc, features, cta, href, highlight }) => (
  <div class={`landing-price-card${highlight ? " landing-price-hl" : ""}`}>
    {highlight && <div class="landing-price-badge">Most popular</div>}
    <div class="landing-price-tier">{tier}</div>
    <div class="landing-price-amount">
      <span class="landing-price-num">{price}</span>
      <span class="landing-price-cad">{cadence}</span>
    </div>
    <p class="landing-price-desc">{desc}</p>
    <ul class="landing-price-features">
      {features.map((f) => (
        <li>
          <span class="landing-price-check" aria-hidden="true">{"✓"}</span>
          {f}
        </li>
      ))}
    </ul>
    <a
      href={href}
      class={`btn ${highlight ? "btn-primary" : "btn-secondary"} btn-block landing-price-cta`}
    >
      {cta}
    </a>
  </div>
);

// ─────────────────────────────────────────────────────────────────
// Block L4 — social-proof tile builder.
//
// Pure: takes the cached PublicStats payload and emits the six
// landing-page tiles in render order. Exported so tests / future
// surfaces (dashboard, /about, …) can share the exact same copy.
// ─────────────────────────────────────────────────────────────────

export interface SocialProofTile {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
}

export function buildSocialProofTiles(s: PublicStats): SocialProofTile[] {
  return [
    { label: "Public repos", value: s.totalPublicRepos },
    { label: "Developers", value: s.totalUsers },
    {
      label: "PRs auto-merged this week",
      value: s.weeklyPrsAutoMerged,
    },
    {
      label: "Issues built by AI this week",
      value: s.weeklyIssuesBuiltByAi,
    },
    {
      label: "Deploys shipped this week",
      value: s.weeklyDeploysShipped,
    },
    {
      label: "Hours saved this week",
      // Round to whole hours for the tile — the precise 0.1 figure
      // lives on the dashboard widget; the marketing surface keeps
      // the number scannable.
      value: Math.round(s.weeklyHoursSaved),
      prefix: "~",
      suffix: "h",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────
// Block M1 — Live-now demo feed.
//
// A 4-tile row inserted between the hero and the L4 counters tile
// section, surfacing real autopilot activity from the seeded `demo`
// owner's repos:
//   1. Issues queued for AI build (ai:build label, open)
//   2. PRs auto-merged in the last 24h
//   3. AI reviews posted today (count + latest 3)
//   4. Combined activity feed (last 10)
//
// SSR-renders an initial snapshot, then re-fetches every 30s via the
// L3 JSON endpoints so the page feels alive without a websocket.
// Pure presentational; the route layer owns the DB reads.
// ─────────────────────────────────────────────────────────────────

/**
 * Render an ISO timestamp (or Date) as a coarse "about N units ago"
 * string. Tolerates strings, Dates, NaN, and future timestamps.
 *
 * Exported for unit testing.
 */
export function relativeTimeFromNow(
  value: string | Date | number | null | undefined,
  now: number = Date.now()
): string {
  if (value === null || value === undefined) return "just now";
  let t: number;
  if (value instanceof Date) {
    t = value.getTime();
  } else if (typeof value === "number") {
    t = value;
  } else {
    t = new Date(value).getTime();
  }
  if (!Number.isFinite(t)) return "just now";
  const delta = now - t;
  // Future timestamps (clock skew) — treat as "just now" rather than
  // surfacing a confusing negative.
  if (delta < 0) return "just now";
  const s = Math.floor(delta / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `about ${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `about ${d} day${d === 1 ? "" : "s"} ago`;
}

function feedEntryId(e: LandingLiveFeedEntry): string {
  const at = e.at instanceof Date ? e.at.toISOString() : String(e.at);
  return `${e.kind}|${e.repo}|${e.ref.type}|${e.ref.number}|${at}`;
}

function feedEntryLabel(kind: LandingLiveFeedEntry["kind"]): string {
  switch (kind) {
    case "auto_merge.merged":
      return "auto-merged";
    case "ai_build.dispatched":
      return "AI-build queued";
    case "ai_review.posted":
      return "AI review posted";
  }
}

interface LiveNowSectionProps {
  queued: LandingLiveFeedQueued[];
  merges: LandingLiveFeedMerge[];
  reviews: LandingLiveFeedReview[];
  reviewCount: number;
  feed: LandingLiveFeedEntry[];
}

const LiveNowSection: FC<LiveNowSectionProps> = ({
  queued,
  merges,
  reviews,
  reviewCount,
  feed,
}) => {
  return (
    <section class="landing-livenow" aria-labelledby="landing-livenow-h">
      <div class="landing-livenow-head">
        <div class="landing-livenow-eyebrow">
          <span class="landing-livenow-pulse" aria-hidden="true" />
          Live now
        </div>
        <h2 id="landing-livenow-h" class="landing-livenow-title">
          Claude is working on demo repos as you read this.
        </h2>
        <p class="landing-livenow-sub">
          Every card below is real data from the public{" "}
          <code>{DEMO_USERNAME}/*</code> repos. Refreshes every 30 seconds.
        </p>
      </div>

      <div class="landing-livenow-grid" data-livenow-grid>
        {/* Card 1 — queued issues */}
        <article class="landing-livecard" aria-labelledby="lc-queued-h">
          <header class="landing-livecard-head">
            <span class="landing-livecard-dot" aria-hidden="true" />
            <h3 id="lc-queued-h" class="landing-livecard-title">
              Issues queued for AI
            </h3>
          </header>
          <ul class="landing-livecard-list" data-livecard="queued">
            {queued.length === 0 ? (
              <li class="landing-livecard-empty">
                No queued AI builds — quiet right now.
              </li>
            ) : (
              queued.slice(0, 3).map((i) => (
                <li
                  class="landing-livecard-row"
                  data-row-id={`queued|${i.repo}|${i.number}`}
                >
                  <a
                    class="landing-livecard-link"
                    href={`/${DEMO_USERNAME}/${i.repo}/issues/${i.number}`}
                  >
                    <span class="landing-livecard-num">#{i.number}</span>{" "}
                    <span class="landing-livecard-title-text">{i.title}</span>
                  </a>
                  <div class="landing-livecard-meta">
                    <span class="landing-livecard-repo">{i.repo}</span>
                  </div>
                </li>
              ))
            )}
          </ul>
        </article>

        {/* Card 2 — recently merged */}
        <article class="landing-livecard" aria-labelledby="lc-merges-h">
          <header class="landing-livecard-head">
            <span class="landing-livecard-dot" aria-hidden="true" />
            <h3 id="lc-merges-h" class="landing-livecard-title">
              Recently merged by AI
            </h3>
          </header>
          <ul class="landing-livecard-list" data-livecard="merges">
            {merges.length === 0 ? (
              <li class="landing-livecard-empty">
                No auto-merges in the last 24h.
              </li>
            ) : (
              merges.slice(0, 3).map((m) => (
                <li
                  class="landing-livecard-row"
                  data-row-id={`merges|${m.repo}|${m.number}`}
                >
                  <a
                    class="landing-livecard-link"
                    href={`/${DEMO_USERNAME}/${m.repo}/pulls/${m.number}`}
                  >
                    <span class="landing-livecard-num">#{m.number}</span>{" "}
                    <span class="landing-livecard-title-text">{m.title}</span>
                  </a>
                  <div class="landing-livecard-meta">
                    AI merged in{" "}
                    <span class="landing-livecard-repo">{m.repo}</span>{" "}
                    <span
                      class="landing-livecard-rel"
                      data-rel={
                        m.mergedAt instanceof Date
                          ? m.mergedAt.toISOString()
                          : String(m.mergedAt)
                      }
                    >
                      {relativeTimeFromNow(m.mergedAt)}
                    </span>
                  </div>
                </li>
              ))
            )}
          </ul>
        </article>

        {/* Card 3 — AI reviews */}
        <article class="landing-livecard" aria-labelledby="lc-reviews-h">
          <header class="landing-livecard-head">
            <span class="landing-livecard-dot" aria-hidden="true" />
            <h3 id="lc-reviews-h" class="landing-livecard-title">
              AI reviews posted
            </h3>
          </header>
          <div class="landing-livecard-bignum">
            <span
              class="landing-livecard-bignum-n"
              data-livecard-count="reviews"
              data-tick-target={String(reviewCount)}
            >
              {reviewCount.toLocaleString()}
            </span>
            <span class="landing-livecard-bignum-label">reviews today</span>
          </div>
          <ul class="landing-livecard-list" data-livecard="reviews">
            {reviews.length === 0 ? (
              <li class="landing-livecard-empty">
                No AI reviews in the last 24h.
              </li>
            ) : (
              reviews.slice(0, 3).map((r) => (
                <li
                  class="landing-livecard-row"
                  data-row-id={`reviews|${r.repo}|${r.prNumber}`}
                >
                  <a
                    class="landing-livecard-link"
                    href={`/${DEMO_USERNAME}/${r.repo}/pulls/${r.prNumber}`}
                  >
                    <span class="landing-livecard-num">#{r.prNumber}</span>{" "}
                    <span class="landing-livecard-snippet">
                      {r.commentSnippet}
                    </span>
                  </a>
                  <div class="landing-livecard-meta">
                    <span class="landing-livecard-repo">{r.repo}</span>
                  </div>
                </li>
              ))
            )}
          </ul>
        </article>

        {/* Card 4 — activity feed */}
        <article class="landing-livecard" aria-labelledby="lc-feed-h">
          <header class="landing-livecard-head">
            <span class="landing-livecard-dot" aria-hidden="true" />
            <h3 id="lc-feed-h" class="landing-livecard-title">
              Activity feed
            </h3>
          </header>
          <ul class="landing-livecard-list landing-livecard-feed" data-livecard="feed">
            {feed.length === 0 ? (
              <li class="landing-livecard-empty">
                Quiet right now — check back in a minute.
              </li>
            ) : (
              feed.slice(0, 10).map((e) => {
                const path = e.ref.type === "pr" ? "pulls" : "issues";
                const id = feedEntryId(e);
                return (
                  <li class="landing-livecard-feedrow" data-row-id={id}>
                    <span
                      class={`landing-livecard-kind landing-livecard-kind-${e.kind.replace(/\./g, "-")}`}
                    >
                      {feedEntryLabel(e.kind)}
                    </span>{" "}
                    <a
                      class="landing-livecard-link"
                      href={`/${DEMO_USERNAME}/${e.repo}/${path}/${e.ref.number}`}
                    >
                      {e.repo} #{e.ref.number}
                    </a>{" "}
                    <span
                      class="landing-livecard-rel"
                      data-rel={
                        e.at instanceof Date ? e.at.toISOString() : String(e.at)
                      }
                    >
                      {relativeTimeFromNow(e.at)}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </article>
      </div>

      <div class="landing-livenow-cta">
        <span class="landing-livenow-cta-text">
          Want this for your repos?
        </span>
        <a class="landing-livenow-cta-link" href="/register">
          Sign up free
          <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
        </a>
        <span class="landing-livenow-cta-sep" aria-hidden="true">·</span>
        <a class="landing-livenow-cta-link" href="/demo">
          Try the live demo
          <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
        </a>
      </div>

      <script dangerouslySetInnerHTML={{ __html: liveNowJs }} />
    </section>
  );
};

// Inline poller. Plain JS so we don't ship a separate bundle. Hits the
// four L3 JSON endpoints every 30s, re-renders the four cards, ticks
// the big number, refreshes relative timestamps, flashes new rows.
const liveNowJs = `
(function(){
try{
  var DEMO=${JSON.stringify(DEMO_USERNAME)};
  var INTERVAL=30000;
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function rel(v){
    if(v==null) return 'just now';
    var t=(v instanceof Date)?v.getTime():(typeof v==='number'?v:new Date(v).getTime());
    if(!isFinite(t)) return 'just now';
    var d=Date.now()-t;
    if(d<0) return 'just now';
    var s=Math.floor(d/1000);
    if(s<60) return 'just now';
    var m=Math.floor(s/60);
    if(m<60) return 'about '+m+' minute'+(m===1?'':'s')+' ago';
    var h=Math.floor(m/60);
    if(h<24) return 'about '+h+' hour'+(h===1?'':'s')+' ago';
    var dd=Math.floor(h/24);
    return 'about '+dd+' day'+(dd===1?'':'s')+' ago';
  }
  function tickNumber(el,target){
    if(!el) return;
    var start=parseInt(el.getAttribute('data-tick-current')||'0',10)||0;
    if(start===target){el.textContent=target.toLocaleString();el.setAttribute('data-tick-current',String(target));return;}
    var dur=800,t0=performance.now();
    function step(now){
      var p=Math.min(1,(now-t0)/dur);
      var eased=1-Math.pow(1-p,3);
      var v=Math.round(start+(target-start)*eased);
      el.textContent=v.toLocaleString();
      if(p<1) requestAnimationFrame(step); else el.setAttribute('data-tick-current',String(target));
    }
    requestAnimationFrame(step);
  }
  function flashRow(li){
    if(!li) return;
    li.classList.add('landing-livecard-flash');
    setTimeout(function(){li.classList.remove('landing-livecard-flash');},1100);
  }
  function diffMount(ul,newHtml,newIds){
    if(!ul) return;
    var prev={};
    var nodes=ul.querySelectorAll('[data-row-id]');
    for(var i=0;i<nodes.length;i++){prev[nodes[i].getAttribute('data-row-id')]=true;}
    ul.innerHTML=newHtml;
    var fresh=ul.querySelectorAll('[data-row-id]');
    for(var j=0;j<fresh.length;j++){
      var id=fresh[j].getAttribute('data-row-id');
      if(id && !prev[id]) flashRow(fresh[j]);
    }
  }
  function pollQueued(){
    return fetch('/api/v2/demo/queued',{credentials:'omit'}).then(function(r){return r.json();}).then(function(d){
      var ul=document.querySelector('[data-livecard="queued"]');if(!ul) return;
      var items=(d&&d.items)||[];
      if(items.length===0){ul.innerHTML='<li class="landing-livecard-empty">No queued AI builds — quiet right now.</li>';return;}
      var ids=[];
      var html=items.slice(0,3).map(function(i){
        var id='queued|'+i.repo+'|'+i.number;ids.push(id);
        return '<li class="landing-livecard-row" data-row-id="'+esc(id)+'">'+
               '<a class="landing-livecard-link" href="/'+esc(DEMO)+'/'+esc(i.repo)+'/issues/'+i.number+'">'+
               '<span class="landing-livecard-num">#'+i.number+'</span> '+
               '<span class="landing-livecard-title-text">'+esc(i.title)+'</span></a>'+
               '<div class="landing-livecard-meta"><span class="landing-livecard-repo">'+esc(i.repo)+'</span></div></li>';
      }).join('');
      diffMount(ul,html,ids);
    }).catch(function(){});
  }
  function pollMerges(){
    return fetch('/api/v2/demo/merges',{credentials:'omit'}).then(function(r){return r.json();}).then(function(d){
      var ul=document.querySelector('[data-livecard="merges"]');if(!ul) return;
      var items=(d&&d.items)||[];
      if(items.length===0){ul.innerHTML='<li class="landing-livecard-empty">No auto-merges in the last 24h.</li>';return;}
      var ids=[];
      var html=items.slice(0,3).map(function(m){
        var id='merges|'+m.repo+'|'+m.number;ids.push(id);
        return '<li class="landing-livecard-row" data-row-id="'+esc(id)+'">'+
               '<a class="landing-livecard-link" href="/'+esc(DEMO)+'/'+esc(m.repo)+'/pulls/'+m.number+'">'+
               '<span class="landing-livecard-num">#'+m.number+'</span> '+
               '<span class="landing-livecard-title-text">'+esc(m.title)+'</span></a>'+
               '<div class="landing-livecard-meta">AI merged in <span class="landing-livecard-repo">'+esc(m.repo)+'</span> '+
               '<span class="landing-livecard-rel" data-rel="'+esc(m.mergedAt)+'">'+esc(rel(m.mergedAt))+'</span></div></li>';
      }).join('');
      diffMount(ul,html,ids);
    }).catch(function(){});
  }
  function pollReviews(){
    return fetch('/api/v2/demo/reviews',{credentials:'omit'}).then(function(r){return r.json();}).then(function(d){
      var ul=document.querySelector('[data-livecard="reviews"]');if(!ul) return;
      var bigEl=document.querySelector('[data-livecard-count="reviews"]');
      var n=(d&&typeof d.count==='number')?d.count:0;
      if(bigEl) tickNumber(bigEl,n);
      var items=(d&&d.items)||[];
      if(items.length===0){ul.innerHTML='<li class="landing-livecard-empty">No AI reviews in the last 24h.</li>';return;}
      var ids=[];
      var html=items.slice(0,3).map(function(r){
        var id='reviews|'+r.repo+'|'+r.prNumber;ids.push(id);
        return '<li class="landing-livecard-row" data-row-id="'+esc(id)+'">'+
               '<a class="landing-livecard-link" href="/'+esc(DEMO)+'/'+esc(r.repo)+'/pulls/'+r.prNumber+'">'+
               '<span class="landing-livecard-num">#'+r.prNumber+'</span> '+
               '<span class="landing-livecard-snippet">'+esc(r.commentSnippet)+'</span></a>'+
               '<div class="landing-livecard-meta"><span class="landing-livecard-repo">'+esc(r.repo)+'</span></div></li>';
      }).join('');
      diffMount(ul,html,ids);
    }).catch(function(){});
  }
  function pollFeed(){
    return fetch('/api/v2/demo/activity',{credentials:'omit'}).then(function(r){return r.json();}).then(function(d){
      var ul=document.querySelector('[data-livecard="feed"]');if(!ul) return;
      var entries=(d&&d.entries)||[];
      if(entries.length===0){ul.innerHTML='<li class="landing-livecard-empty">Quiet right now — check back in a minute.</li>';return;}
      var ids=[];
      var html=entries.slice(0,10).map(function(e){
        var path=(e.ref&&e.ref.type==='pr')?'pulls':'issues';
        var num=(e.ref&&e.ref.number)||0;
        var label=e.kind==='auto_merge.merged'?'auto-merged':(e.kind==='ai_build.dispatched'?'AI-build queued':'AI review posted');
        var kindCls=String(e.kind||'').replace(/\\./g,'-');
        var id=e.kind+'|'+e.repo+'|'+(e.ref&&e.ref.type)+'|'+num+'|'+e.at;ids.push(id);
        return '<li class="landing-livecard-feedrow" data-row-id="'+esc(id)+'">'+
               '<span class="landing-livecard-kind landing-livecard-kind-'+esc(kindCls)+'">'+esc(label)+'</span> '+
               '<a class="landing-livecard-link" href="/'+esc(DEMO)+'/'+esc(e.repo)+'/'+path+'/'+num+'">'+esc(e.repo)+' #'+num+'</a> '+
               '<span class="landing-livecard-rel" data-rel="'+esc(e.at)+'">'+esc(rel(e.at))+'</span></li>';
      }).join('');
      diffMount(ul,html,ids);
    }).catch(function(){});
  }
  function refreshRel(){
    var spans=document.querySelectorAll('.landing-livecard-rel[data-rel]');
    for(var i=0;i<spans.length;i++){
      spans[i].textContent=rel(spans[i].getAttribute('data-rel'));
    }
  }
  function tickAll(){pollQueued();pollMerges();pollReviews();pollFeed();}
  // Initial counter tick (count-up from 0) on first paint.
  var bigEl0=document.querySelector('[data-livecard-count="reviews"]');
  if(bigEl0){
    var target=parseInt(bigEl0.getAttribute('data-tick-target')||'0',10)||0;
    bigEl0.textContent='0';
    tickNumber(bigEl0,target);
  }
  refreshRel();
  setInterval(tickAll,INTERVAL);
  setInterval(refreshRel,INTERVAL);
  document.addEventListener('visibilitychange',function(){
    if(document.visibilityState==='visible'){tickAll();refreshRel();}
  });
}catch(_){}})();
`.trim();

// ============================================================
// Land2030 — 2030 homepage prelude (closed-loop showcase).
// ============================================================
//
// Renders BEFORE the existing LandingHero so every L10/U1/Q1/M1
// regression assertion keeps passing. CSS is scoped under
// `.land-2030-*` to avoid colliding with the older `.landing-*`
// styles. Inline SVG only — no extra deps.

const ClosedLoopDiagram: FC = () => (
  <svg
    viewBox="0 0 1100 280"
    class="land-2030-loop-svg"
    role="img"
    aria-label="Closed loop: Spec to Code to AI Review to Tests to Merge to Deploy to Monitor to Patch"
  >
    <defs>
      <linearGradient id="land2030LoopLine" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#8c6dff" stop-opacity="0.0" />
        <stop offset="20%" stop-color="#8c6dff" stop-opacity="0.6" />
        <stop offset="80%" stop-color="#36c5d6" stop-opacity="0.6" />
        <stop offset="100%" stop-color="#36c5d6" stop-opacity="0.0" />
      </linearGradient>
      <radialGradient id="land2030LoopNode" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0%" stop-color="#a48bff" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#36c5d6" stop-opacity="0.85" />
      </radialGradient>
    </defs>
    {/* connecting curve */}
    <path
      d="M 60 140 C 220 40, 880 40, 1040 140 C 880 240, 220 240, 60 140 Z"
      fill="none"
      stroke="url(#land2030LoopLine)"
      stroke-width="2"
      class="land-2030-loop-path"
    />
    {[
      { x: 70, y: 140, label: "Spec" },
      { x: 215, y: 70, label: "Code" },
      { x: 410, y: 50, label: "AI Review" },
      { x: 605, y: 50, label: "Tests" },
      { x: 800, y: 70, label: "Merge" },
      { x: 950, y: 140, label: "Deploy" },
      { x: 800, y: 210, label: "Monitor" },
      { x: 410, y: 230, label: "Patch" },
    ].map((n) => (
      <g class="land-2030-loop-node">
        <circle cx={n.x} cy={n.y} r="22" fill="url(#land2030LoopNode)" />
        <circle
          cx={n.x}
          cy={n.y}
          r="22"
          fill="none"
          stroke="rgba(255,255,255,0.18)"
          stroke-width="1"
        />
        <text
          x={n.x}
          y={n.y + (n.y > 140 ? 48 : -32)}
          text-anchor="middle"
          class="land-2030-loop-text"
          fill="currentColor"
        >
          {n.label}
        </text>
      </g>
    ))}
  </svg>
);

interface Land2030CardProps {
  icon: any;
  title: string;
  desc: string;
  href: string;
  cta?: string;
}
const Land2030Card: FC<Land2030CardProps> = ({ icon, title, desc, href, cta }) => (
  <a href={href} class="land-2030-card">
    <div class="land-2030-card-icon" aria-hidden="true">
      {icon}
    </div>
    <h3 class="land-2030-card-title">{title}</h3>
    <p class="land-2030-card-desc">{desc}</p>
    <span class="land-2030-card-cta">
      {cta ?? "Try it"}
      <span aria-hidden="true">{" →"}</span>
    </span>
  </a>
);

interface Land2030FeatureItem {
  title: string;
  desc: string;
  href: string;
  status: "live" | "beta" | "soon";
}
const LAND_2030_FEATURES: Land2030FeatureItem[] = [
  { title: "Spec-to-PR", desc: "Write English. Ship code.", href: "/specs", status: "live" },
  { title: "Voice-to-PR", desc: "Talk. Ship code.", href: "/voice-to-pr", status: "live" },
  { title: "Repo chat", desc: "Rubber-duck with a semantic index of your repo.", href: "/ask", status: "live" },
  { title: "AI CI healer", desc: "Broken CI? Claude opens a fix PR.", href: "/inbox", status: "live" },
  { title: "AI patch generator", desc: "Security finding → patch PR, signed by Claude.", href: "/code-scanning", status: "live" },
  { title: "AI proactive monitor", desc: "Claude opens issues unprompted when it spots smells.", href: "/standups", status: "live" },
  { title: "AI commit messages", desc: "`gluecron commit` writes a great message for the staged diff.", href: "/help", status: "live" },
  { title: "AI release notes", desc: "Claude reads merged PRs and writes the changelog.", href: "/ai-changelog", status: "live" },
  { title: "Multi-repo refactor", desc: "One English request → coordinated PRs across N repos.", href: "/refactors", status: "live" },
  { title: "Migration assistant", desc: "Major-version upgrades drafted PR-by-PR.", href: "/migration-assistant", status: "live" },
  { title: "AI test generator", desc: "Every PR auto-gets tests for the new diff.", href: "/ai-tests", status: "beta" },
  { title: "PR slash commands", desc: "/merge, /rebase, /explain, /test — Claude runs them.", href: "/help", status: "live" },
  { title: "Live co-editing on PRs", desc: "Figma-style cursors on PR descriptions and reviews.", href: "/pulls", status: "beta" },
  { title: "Branch preview URLs", desc: "Every push → a sharable preview URL.", href: "/previews", status: "live" },
  { title: "Agent multiplayer", desc: "Per-agent sessions, budgets, and branch namespacing.", href: "/settings/agents", status: "live" },
  { title: "Continuous semantic index", desc: "Push-time embeddings keep search and chat fresh.", href: "/semantic-search", status: "live" },
  { title: "VS Code extension", desc: "Inbox, PRs, and repo chat — in your editor.", href: "/help", status: "soon" },
  { title: "Slack / Discord bot", desc: "Mentions, reviews, deploys — in your team chat.", href: "/help", status: "soon" },
];

const Land2030: FC = () => (
  <>
    <style dangerouslySetInnerHTML={{ __html: land2030Css }} />
    <div class="land-2030-root">
      {/* ---------- 2030 HERO ---------- */}
      <section class="land-2030-hero" aria-label="Gluecron 2030">
        <div class="land-2030-hairline" aria-hidden="true" />
        <div class="land-2030-orb" aria-hidden="true" />
        <div class="land-2030-hero-inner">
          <div class="land-2030-eyebrow">
            <span class="land-2030-pulse" aria-hidden="true" />
            Gluecron — built for 2030
          </div>
          <h1 class="land-2030-display">
            <span class="land-2030-grad-1">Write</span>{" "}
            <span class="land-2030-grad-2">English.</span>{" "}
            <span class="land-2030-grad-3">Ship</span>{" "}
            <span class="land-2030-grad-4">code.</span>{" "}
            <span class="land-2030-grad-5">Gluecron.</span>
          </h1>
          <p class="land-2030-sub">
            The git platform built for the era when AI ships most of the code.
          </p>
          <div class="land-2030-cta-row">
            <a href="/register" class="btn btn-primary btn-xl land-2030-cta-primary">
              Start free
              <span aria-hidden="true">{" →"}</span>
            </a>
            <a href="#land-2030-loop" class="btn btn-xl land-2030-cta-secondary">
              Watch the loop
              <span aria-hidden="true">{" ↓"}</span>
            </a>
          </div>
        </div>
      </section>

      {/* ---------- THE CLOSED LOOP ---------- */}
      <section id="land-2030-loop" class="land-2030-section">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">The closed loop</div>
          <h2 class="land-2030-h2">One platform. No glue code.</h2>
          <p class="land-2030-lede">
            Spec → Code → AI Review → Tests → Merge → Deploy → Monitor → Patch.
            All on Gluecron. No GitHub + Copilot + Vercel + Sentry stitching
            needed.
          </p>
        </div>
        <div class="land-2030-loop-wrap">
          <ClosedLoopDiagram />
        </div>
      </section>

      {/* ---------- THE 6 THINGS NOBODY ELSE CAN DO ---------- */}
      <section class="land-2030-section">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">Unfair advantages</div>
          <h2 class="land-2030-h2">What Gluecron does that nobody else can.</h2>
        </div>
        <div class="land-2030-card-grid">
          <Land2030Card
            href="/voice-to-pr"
            title="Voice-to-PR"
            desc="Speak the change you want. Claude opens the PR. Works on your commute."
            icon={
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2" /><path d="M12 19v3" /></svg>
            }
          />
          <Land2030Card
            href="/specs"
            title="Spec-to-PR"
            desc="Write the spec in plain English. Claude implements it, opens a PR, and asks for review."
            icon={
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6M9 17h4" /></svg>
            }
          />
          <Land2030Card
            href="/workflows"
            title="AI CI self-healing"
            desc="Tests go red? Claude reads the log, finds the cause, and pushes the fix to your PR branch."
            icon={
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            }
          />
          <Land2030Card
            href="/refactors"
            title="Multi-repo refactor agent"
            desc="One English request → coordinated PRs across every repo that uses the symbol."
            icon={
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="18" r="3" /><path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" /></svg>
            }
          />
          <Land2030Card
            href="/ask"
            title="Repo chat with semantic search"
            desc="Continuous push-time embeddings. Ask the repo anything; it cites real files and commits."
            icon={
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><circle cx="9" cy="10" r="1" fill="currentColor" /><circle cx="13" cy="10" r="1" fill="currentColor" /><circle cx="17" cy="10" r="1" fill="currentColor" /></svg>
            }
          />
          <Land2030Card
            href="/pulls"
            title="Per-PR live co-editing"
            desc="Figma-style cursors and presence on PR descriptions and reviews. Goodbye stale tabs."
            icon={
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
            }
          />
        </div>
      </section>

      {/* ---------- GLOBAL DASHBOARDS ---------- */}
      <section class="land-2030-section">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">Mission control</div>
          <h2 class="land-2030-h2">Every signal, one inbox.</h2>
          <p class="land-2030-lede">
            Five global dashboards that span every repo you touch — no more
            tab-juggling across orgs.
          </p>
        </div>
        <div class="land-2030-dash-grid">
          <a href="/pulls" class="land-2030-dash">
            <span class="land-2030-dash-name">/pulls</span>
            <span class="land-2030-dash-desc">PR command center across every repo you can touch.</span>
          </a>
          <a href="/issues" class="land-2030-dash">
            <span class="land-2030-dash-name">/issues</span>
            <span class="land-2030-dash-desc">Global issue dashboard. Triage from one screen.</span>
          </a>
          <a href="/inbox" class="land-2030-dash">
            <span class="land-2030-dash-name">/inbox</span>
            <span class="land-2030-dash-desc">Unified mentions, reviews, CI, and AI events.</span>
          </a>
          <a href="/activity" class="land-2030-dash">
            <span class="land-2030-dash-name">/activity</span>
            <span class="land-2030-dash-desc">A timeline of everything that moved on your repos.</span>
          </a>
          <a href="/standups" class="land-2030-dash">
            <span class="land-2030-dash-name">/standups</span>
            <span class="land-2030-dash-desc">Daily AI-generated brief of what shipped and what's stuck.</span>
          </a>
        </div>
      </section>

      {/* ---------- FULL AI FEATURE GRID ---------- */}
      <section class="land-2030-section">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">Closed-loop AI</div>
          <h2 class="land-2030-h2">18 AI features. One platform.</h2>
          <p class="land-2030-lede">
            Most of these don't exist anywhere else. None of them require a
            second SaaS subscription.
          </p>
        </div>
        <div class="land-2030-feat-grid">
          {LAND_2030_FEATURES.map((f) => (
            <a href={f.href} class="land-2030-feat">
              <div class="land-2030-feat-head">
                <span class="land-2030-feat-title">{f.title}</span>
                <span class={`land-2030-pill land-2030-pill-${f.status}`}>
                  {f.status === "live" ? "live" : f.status === "beta" ? "beta" : "soon"}
                </span>
              </div>
              <p class="land-2030-feat-desc">{f.desc}</p>
            </a>
          ))}
        </div>
      </section>

      {/* ---------- DEVELOPER EXPERIENCE ---------- */}
      <section class="land-2030-section">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">Developer surface</div>
          <h2 class="land-2030-h2">Built where you already are.</h2>
        </div>
        <div class="land-2030-dx-grid">
          <div class="land-2030-dx">
            <h3 class="land-2030-dx-title">gluecron CLI</h3>
            <pre class="land-2030-code"><code>$ gluecron spec "add CSV export to /api/orders"
{"→ Drafting PR…"}
{"→ Opened #482 with 3 commits"}
{"→ AI review queued"}</code></pre>
          </div>
          <div class="land-2030-dx">
            <h3 class="land-2030-dx-title">PR slash commands</h3>
            <pre class="land-2030-code"><code>/merge   — squash + merge when checks pass
/rebase  — rebase onto base, push --force-with-lease
/explain — Claude explains the diff in plain English
/test    — Claude writes tests for the new code</code></pre>
          </div>
          <div class="land-2030-dx">
            <h3 class="land-2030-dx-title">Branch preview URLs</h3>
            <pre class="land-2030-code"><code>{"→ git push gluecron HEAD"}
{"→ preview: https://pr-482.preview.gluecron.com"}
{"→ commented on PR #482"}</code></pre>
          </div>
        </div>
      </section>

      {/* ---------- BUILT FOR AGENTS ---------- */}
      <section class="land-2030-section land-2030-section-dark">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">Agent era</div>
          <h2 class="land-2030-h2">Built for agents, not just humans.</h2>
          <p class="land-2030-lede">
            Per-agent tokens, per-agent budgets, per-agent branch namespaces,
            and a lease primitive so 50 agents don't trample one repo.
          </p>
        </div>
        <div class="land-2030-agent-wrap">
          <pre class="land-2030-code land-2030-code-wide"><code>{'# agent gets a scoped token + lease before writing'}
{'curl -H "Authorization: Bearer agt_3p9x…" \\\\'}
{'     -X POST https://gluecron.com/api/v2/leases \\\\'}
{'     -d \'{"repo":"acme/api","branch":"agent/jules/checkout-fix","ttl":300}\''}
{''}
{'{ "lease_id": "lse_8a2f", "expires_at": "2030-05-25T14:05:11Z" }'}</code></pre>
          <div class="land-2030-agent-stat">
            <div class="land-2030-agent-big">10,000</div>
            <div class="land-2030-agent-label">
              agents pushing to your repo per day. Welcome to 2030.
            </div>
            <a href="/docs/build-agent-integration" class="land-2030-agent-link">
              Build an agent integration{" →"}
            </a>
          </div>
        </div>
      </section>

      {/* ---------- VS GITHUB ---------- */}
      <section class="land-2030-section">
        <div class="land-2030-section-head">
          <div class="land-2030-eyebrow land-2030-eyebrow-mini">vs GitHub</div>
          <h2 class="land-2030-h2">One platform replaces five.</h2>
        </div>
        <div class="land-2030-vs">
          <div class="land-2030-vs-row land-2030-vs-head">
            <div>Today</div>
            <div>On Gluecron</div>
          </div>
          <div class="land-2030-vs-row">
            <div>GitHub + Copilot + Vercel + Sentry + Linear</div>
            <div class="land-2030-vs-us">Gluecron</div>
          </div>
          <a href="/vs-github" class="land-2030-vs-link">
            See the full comparison{" →"}
          </a>
        </div>
      </section>
    </div>
  </>
);

// Backwards-compatible default — web.tsx imports `LandingPage`.
// Single landing surface. The bolted-on <Land2030 /> prelude was rendering a
// SECOND full page above LandingHero — two stacked <h1> documents as you
// scrolled. Render exactly one page; the 2030 reboot replaces this wholesale.
export const LandingPage: FC<LandingPageProps> = (props) => (
  <LandingHero {...props} />
);

export default LandingPage;

const landingCss = `
  /* ============================================================ */
  /* Landing — Editorial-Technical 2026.05                        */
  /* ============================================================ */
  .landing-root {
    position: relative;
    max-width: 1180px;
    margin: 0 auto;
    padding: 0 16px;
  }
  .landing-root > section { position: relative; }

  /* ---------- Hero ---------- */
  .landing-hero {
    position: relative;
    padding: var(--s-16) 0 var(--s-20);
    text-align: center;
    overflow: hidden;
  }
  .landing-hero-blob-1 {
    animation: hero-blob-drift-1 18s var(--ease, ease) infinite alternate;
  }
  .landing-hero-blob-2 {
    animation: hero-blob-drift-2 22s var(--ease, ease) infinite alternate;
  }
  @keyframes hero-blob-drift-1 {
    0%   { transform: translate(0, 0) scale(1); opacity: 0.55; }
    100% { transform: translate(8%, 6%) scale(1.18); opacity: 0.75; }
  }
  @keyframes hero-blob-drift-2 {
    0%   { transform: translate(0, 0) scale(1); opacity: 0.40; }
    100% { transform: translate(-10%, -4%) scale(1.25); opacity: 0.60; }
  }

  /* ---------- Hero product visual: live AI PR review card ---------- */
  .landing-hero-visual {
    position: relative;
    max-width: 760px;
    margin: var(--s-12) auto 0;
    padding: 0 16px;
    perspective: 1400px;
    z-index: 2;
    opacity: 0;
    animation: hero-visual-in 700ms var(--ease-out-expo, cubic-bezier(0.19, 1, 0.22, 1)) 400ms forwards;
  }
  @keyframes hero-visual-in {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .hero-pr-card {
    position: relative;
    background: linear-gradient(180deg, rgba(15,17,26,0.96) 0%, rgba(8,9,15,0.96) 100%);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-xl);
    overflow: hidden;
    text-align: left;
    box-shadow:
      0 30px 80px -20px rgba(0,0,0,0.65),
      0 0 0 1px rgba(140,109,255,0.18),
      0 0 60px -10px rgba(140,109,255,0.30);
    transform: rotateX(2deg) rotateY(-2deg);
    transition: transform 600ms var(--ease, ease);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .landing-hero-visual:hover .hero-pr-card {
    transform: rotateX(0deg) rotateY(0deg);
  }
  .hero-pr-card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(140,109,255,0.10), transparent 35%, transparent 65%, rgba(54,197,214,0.08));
    pointer-events: none;
  }
  .hero-pr-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.025);
    font-size: 13px;
  }
  .hero-pr-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 10px rgba(52,211,153,0.6);
    flex-shrink: 0;
  }
  .hero-pr-title {
    color: var(--text-strong);
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hero-pr-num {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-weight: 500;
    margin-right: 8px;
  }
  .hero-pr-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--r-full);
    background: var(--accent-gradient-faint);
    border: 1px solid rgba(140,109,255,0.30);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
  .hero-pr-status-pulse {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 0 rgba(140,109,255,0.6);
    animation: hero-pulse 1.6s ease-out infinite;
  }
  @keyframes hero-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(140,109,255,0.55); }
    70%  { box-shadow: 0 0 0 8px rgba(140,109,255,0); }
    100% { box-shadow: 0 0 0 0 rgba(140,109,255,0); }
  }

  .hero-pr-body {
    padding: 0;
  }
  .hero-pr-file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 18px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.012);
  }
  .hero-pr-file-icon { color: var(--accent-2); }
  .hero-pr-file-name { color: var(--text); flex: 1; }
  .hero-pr-file-stats { display: inline-flex; gap: 8px; }
  .hero-pr-add { color: var(--green); font-weight: 600; }
  .hero-pr-del { color: var(--red); font-weight: 600; }

  .hero-pr-diff {
    padding: 12px 18px;
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat, 'calt');
    font-size: 12.5px;
    line-height: 1.7;
    color: rgba(237,237,242,0.85);
    overflow-x: auto;
  }
  .hero-pr-hunk {
    color: rgba(140,109,255,0.85);
    background: rgba(140,109,255,0.06);
    padding: 2px 8px;
    margin: 0 -8px 4px;
    border-radius: 4px;
  }
  .hero-pr-line-add {
    background: rgba(52,211,153,0.08);
    color: rgba(167,243,208,0.95);
    padding: 0 8px;
    margin: 0 -8px;
    border-left: 2px solid var(--green);
    padding-left: 8px;
  }

  .hero-pr-comment {
    margin: 14px 18px;
    padding: 14px 16px;
    background: linear-gradient(135deg, rgba(140,109,255,0.08), rgba(54,197,214,0.05));
    border: 1px solid rgba(140,109,255,0.25);
    border-radius: var(--r-md);
  }
  .hero-pr-bot-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  .hero-pr-bot-avatar {
    width: 22px; height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--accent-gradient);
    font-size: 11px;
    box-shadow: 0 0 12px rgba(140,109,255,0.40);
  }
  .hero-pr-bot-name {
    color: var(--text-strong);
    font-weight: 600;
  }
  .hero-pr-bot-meta {
    color: var(--text-faint);
    font-family: var(--font-mono);
  }
  .hero-pr-bot-text {
    color: var(--text);
    font-size: 13px;
    line-height: 1.55;
    margin: 0;
  }
  .hero-pr-bot-text code {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11.5px;
    color: var(--accent);
  }
  .hero-pr-bot-link { color: var(--accent-2); text-decoration: underline; text-decoration-style: dotted; }

  .hero-pr-gates {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 18px 16px;
    border-top: 1px solid rgba(255,255,255,0.06);
    background: rgba(255,255,255,0.012);
  }
  .hero-pr-gate {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: var(--r-full);
    font-family: var(--font-mono);
    font-size: 11px;
    border: 1px solid;
  }
  .hero-pr-gate-pass {
    color: var(--green);
    background: rgba(52,211,153,0.08);
    border-color: rgba(52,211,153,0.30);
  }
  .hero-pr-gate-running {
    color: var(--accent);
    background: var(--accent-gradient-faint);
    border-color: rgba(140,109,255,0.40);
  }
  .hero-pr-gate-spin {
    width: 9px; height: 9px;
    border: 1.5px solid rgba(140,109,255,0.30);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: hero-spin 800ms linear infinite;
  }
  @keyframes hero-spin {
    to { transform: rotate(360deg); }
  }

  /* Floating accent badges around the card */
  .hero-float {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: rgba(15,17,26,0.92);
    border: 1px solid rgba(140,109,255,0.35);
    border-radius: var(--r-full);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text);
    box-shadow: 0 12px 24px -8px rgba(0,0,0,0.5), 0 0 18px -4px rgba(140,109,255,0.30);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .hero-float-icon { color: var(--accent); }
  .hero-float-1 {
    top: -14px;
    left: -8px;
    animation: hero-float-bob-1 5s var(--ease, ease) infinite alternate;
  }
  .hero-float-2 {
    bottom: -14px;
    right: -8px;
    animation: hero-float-bob-2 6s var(--ease, ease) infinite alternate;
  }
  @keyframes hero-float-bob-1 {
    from { transform: translate(0, 0); }
    to { transform: translate(-8px, -10px); }
  }
  @keyframes hero-float-bob-2 {
    from { transform: translate(0, 0); }
    to { transform: translate(8px, 8px); }
  }

  @media (max-width: 720px) {
    .landing-hero-visual { padding: 0 8px; }
    .hero-pr-card { transform: none; }
    .hero-pr-title { font-size: 12px; }
    .hero-pr-diff { font-size: 11px; line-height: 1.6; }
    .hero-float { display: none; }
  }
  .landing-hero-bg {
    position: absolute;
    inset: -10% -20%;
    pointer-events: none;
    z-index: 0;
  }
  .landing-hero-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(80px);
    opacity: 0.55;
    will-change: transform;
  }
  .landing-hero-blob-1 {
    top: -10%;
    left: 30%;
    width: 480px;
    height: 480px;
    background: radial-gradient(circle, rgba(140,109,255,0.65), transparent 65%);
    /* 2026 polish — slow drift gives the hero "this is a live product"
       feel without being distracting. 24s loop, eased, contained motion. */
    animation: landingBlobDrift1 24s ease-in-out infinite;
  }
  .landing-hero-blob-2 {
    top: 10%;
    left: 50%;
    width: 380px;
    height: 380px;
    background: radial-gradient(circle, rgba(54,197,214,0.50), transparent 65%);
    animation: landingBlobDrift2 28s ease-in-out infinite;
  }
  /* U1 — subtle, low-opacity accent-gradient orb behind the headline.
     Sits dead-centre, very blurred, so the hero reads as a real product
     surface rather than flat-bg + text. 2026 polish — gentle breathing
     pulse to give the surface a soft heartbeat. */
  .landing-hero-orb {
    top: 18%;
    left: 50%;
    transform: translateX(-50%);
    width: 720px;
    height: 720px;
    background: radial-gradient(circle, rgba(140,109,255,0.28), rgba(54,197,214,0.16) 45%, transparent 70%);
    filter: blur(120px);
    opacity: 0.6;
    z-index: 0;
    animation: landingOrbBreath 12s ease-in-out infinite;
  }
  :root[data-theme='light'] .landing-hero-orb {
    opacity: 0.32;
  }
  @keyframes landingBlobDrift1 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    33%      { transform: translate(40px, -30px) scale(1.08); }
    66%      { transform: translate(-30px, 25px) scale(0.95); }
  }
  @keyframes landingBlobDrift2 {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50%      { transform: translate(-50px, 35px) scale(1.12); }
  }
  @keyframes landingOrbBreath {
    0%, 100% { opacity: 0.55; transform: translateX(-50%) scale(1); }
    50%      { opacity: 0.72; transform: translateX(-50%) scale(1.06); }
  }
  @media (prefers-reduced-motion: reduce) {
    .landing-hero-blob-1,
    .landing-hero-blob-2,
    .landing-hero-orb {
      animation: none;
    }
  }
  .landing-hero-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 60px 60px;
    mask-image: radial-gradient(ellipse 50% 50% at 50% 30%, #000 0%, transparent 75%);
    -webkit-mask-image: radial-gradient(ellipse 50% 50% at 50% 30%, #000 0%, transparent 75%);
  }
  :root[data-theme='light'] .landing-hero-grid {
    background-image:
      linear-gradient(to right, rgba(15,16,28,0.06) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(15,16,28,0.06) 1px, transparent 1px);
  }

  .landing-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 960px;
    margin: 0 auto;
  }
  /* U1 — every block below the headline obeys a single rhythm. */
  .landing-hero-eyebrow {
    margin: 0 auto var(--space-6);
    color: var(--accent);
  }
  .landing-hero-eyebrow::before { display: none; }
  .landing-hero-pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 0 rgba(140,109,255,0.6);
    animation: pulse 1.8s ease-out infinite;
    flex-shrink: 0;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(140,109,255,0.55); }
    70%  { box-shadow: 0 0 0 10px rgba(140,109,255,0); }
    100% { box-shadow: 0 0 0 0 rgba(140,109,255,0); }
  }

  .landing-hero-title {
    /* 2026 polish — bigger, bolder, tighter. Inter Tight at 800 weight
       with -0.03em tracking is the modern "AI-startup hero" look that
       Vercel/Linear/Cursor all use. clamp() scales gracefully on mobile. */
    font-size: clamp(40px, 7vw, 84px);
    line-height: 1.02;
    letter-spacing: -0.032em;
    font-weight: 800;
    font-family: var(--font-display);
    margin: 0 0 var(--space-6);
    color: var(--text-strong);
  }
  .landing-hero-title .gradient-text {
    /* Richer gradient with a third stop for more depth. Drop-shadow
       gives the impression of subtle glow without overpowering the type. */
    background-image: linear-gradient(135deg, #c2a8ff 0%, #8c6dff 40%, #5d3dff 70%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    filter: drop-shadow(0 4px 32px rgba(140, 109, 255, 0.18));
  }

  .landing-hero-sub {
    font-size: clamp(16px, 1.8vw, 22px);
    color: var(--text-muted);
    max-width: 680px;
    margin: 0 auto var(--space-6);
    line-height: 1.5;
    letter-spacing: -0.008em;
    font-weight: 400;
  }

  .landing-hero-ctas {
    display: flex;
    gap: var(--space-3);
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 0;
    margin-bottom: var(--space-4);
  }
  .landing-cta-arrow {
    transition: transform var(--t-base) var(--ease-spring);
    display: inline-block;
  }

  /* U1 — tertiary text-link row.
     Sits directly under the 2-button primary CTA row. Smaller, muted,
     so it reads as "by the way" rather than competing for the eye. */
  .landing-hero-tertiary {
    margin-top: 0;
    margin-bottom: var(--space-6);
    text-align: center;
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    justify-content: center;
    align-items: baseline;
    width: 100%;
    font-size: 13px;
    color: var(--text-muted);
  }
  .landing-hero-tertiary-link {
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 1px dashed transparent;
    padding-bottom: 1px;
    transition: color var(--t-fast) var(--ease),
                border-color var(--t-fast) var(--ease);
  }
  .landing-hero-tertiary-link:hover {
    color: var(--text-strong);
    border-bottom-color: var(--text-muted);
  }
  .landing-hero-tertiary-sep {
    color: var(--text-faint);
    user-select: none;
  }
  .btn:hover .landing-cta-arrow,
  .landing-cta-primary:hover .landing-cta-arrow {
    transform: translateX(4px);
  }

  /* BLOCK Q1 — flagship "Add to Claude Desktop" CTA.
     Gradient-bordered + accent text so it reads as a peer of the primary
     Sign-up CTA, not a third secondary. Theme-aware: inner fill uses
     --bg-elevated so it's white on light and dark on dark, never the
     jarring near-black on white we shipped first time. Subtle elevation
     on hover; static when the visitor opts out of motion. */
  .landing-cta-dxt {
    position: relative;
    background: var(--bg-elevated);
    color: var(--text-strong);
    border: 1px solid transparent;
    background-image:
      linear-gradient(var(--bg-elevated), var(--bg-elevated)),
      linear-gradient(90deg, #8c6dff 0%, #36c5d6 100%);
    background-origin: border-box;
    background-clip: padding-box, border-box;
    transition: transform var(--t-base, 180ms) var(--ease-spring, ease),
                box-shadow var(--t-base, 180ms) var(--ease-spring, ease);
  }
  .landing-cta-dxt:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px -8px rgba(140, 109, 255, 0.45);
  }
  @media (prefers-reduced-motion: reduce) {
    .landing-cta-dxt,
    .landing-cta-dxt:hover {
      transform: none;
      transition: none;
    }
  }

  /* "Migrate from GitHub" CTA — secondary, but strong enough to stand
     alongside the primary. Uses a subtle amber/violet mix so it reads as
     action-oriented without competing with the green primary CTA. */
  .landing-cta-migrate {
    position: relative;
    background: var(--bg-elevated);
    color: var(--text-strong);
    border: 1px solid var(--border-strong);
    transition: border-color var(--t-base, 180ms) var(--ease, ease),
                transform var(--t-base, 180ms) var(--ease-spring, ease),
                box-shadow var(--t-base, 180ms) var(--ease, ease);
  }
  .landing-cta-migrate:hover {
    border-color: rgba(140,109,255,0.55);
    transform: translateY(-2px);
    box-shadow: 0 8px 22px -8px rgba(140,109,255,0.30);
    text-decoration: none;
    color: var(--text-strong);
  }
  @media (prefers-reduced-motion: reduce) {
    .landing-cta-migrate,
    .landing-cta-migrate:hover {
      transform: none;
      transition: none;
    }
  }

  /* L8 — free-tier reassurance link beneath the CTA row.
     U1 — rhythm snapped to var(--space-6). */
  .landing-hero-freenote {
    margin: 0 auto var(--space-6);
    font-size: var(--t-sm);
    color: var(--text-muted);
    text-align: center;
  }
  .landing-hero-freenote-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    border-bottom: 1px dotted rgba(140,109,255,0.4);
    transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
  }
  .landing-hero-freenote-link:hover {
    color: var(--text-strong);
    border-bottom-color: var(--accent);
  }

  .landing-hero-caption {
    margin: 0 auto var(--space-6);
    font-size: var(--t-sm);
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
  }
  .landing-hero-cmd {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-full);
    box-shadow: var(--elev-1);
  }
  .landing-hero-cmd .kbd {
    border: 0;
    background: transparent;
    padding: 0 4px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .landing-hero-cmd .kbd:nth-last-of-type(1) { color: var(--accent); }
  .landing-hero-arrow {
    color: var(--text-faint);
    font-size: 13px;
    margin: 0 2px;
  }

  .landing-stats {
    margin: 0 auto;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    letter-spacing: 0.02em;
  }
  .landing-stats strong {
    color: var(--text-strong);
    font-weight: 600;
    font-feature-settings: 'tnum';
  }
  .landing-stats-sep { opacity: 0.4; }

  /* ---------- Capability grid (vapron-style uppercase tracked) ---------- */
  .landing-caps {
    margin: var(--s-12) auto var(--s-16);
    max-width: 1080px;
    padding: var(--s-7) var(--s-4);
    border-top: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
  }
  .landing-caps-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 24px 16px;
    text-align: center;
  }
  .landing-cap {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    transition: color var(--t-fast) var(--ease);
  }
  .landing-cap:hover { color: var(--text-strong); }
  @media (max-width: 800px) {
    .landing-caps-grid { grid-template-columns: repeat(2, 1fr); gap: 18px 12px; }
  }
  @media (max-width: 480px) {
    .landing-caps-grid { grid-template-columns: 1fr; }
  }

  /* ---------- Big stat row (vapron-style hero closer) ---------- */
  .landing-bigstats {
    margin: var(--s-10) auto var(--s-20);
    max-width: 1180px;
    padding: 0 var(--s-4);
  }
  .landing-bigstats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 32px;
    text-align: left;
  }
  .landing-bigstat {
    padding: var(--s-2) 0;
  }
  .landing-bigstat-num {
    font-family: var(--font-display);
    font-size: clamp(28px, 3.5vw, 44px);
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-weight: 700;
    color: var(--text-strong);
    margin-bottom: var(--s-2);
  }
  .landing-bigstat-label {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-faint);
  }
  @media (max-width: 800px) {
    .landing-bigstats-grid { grid-template-columns: repeat(2, 1fr); gap: 28px 16px; }
  }
  @media (max-width: 480px) {
    .landing-bigstats-grid { grid-template-columns: 1fr; gap: 24px; }
  }

  /* ---------- Section base ---------- */
  .landing-section { margin: var(--s-20) auto; }

  /* ---------- Feature grid ---------- */
  .landing-features {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .landing-feature {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-7);
    position: relative;
    overflow: hidden;
    isolation: isolate;
    transition:
      transform var(--t-base) var(--ease-out-quart),
      border-color var(--t-base) var(--ease),
      box-shadow var(--t-base) var(--ease);
  }
  .landing-feature::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(120% 100% at 0% 0%, rgba(140,109,255,0.08), transparent 55%);
    opacity: 0;
    transition: opacity var(--t-base) var(--ease);
    z-index: -1;
  }
  .landing-feature:hover {
    transform: translateY(-3px);
    border-color: var(--border-strong);
    box-shadow: var(--elev-2);
  }
  .landing-feature:hover::before { opacity: 1; }
  .landing-feature-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--r);
    background: var(--accent-gradient-soft);
    color: var(--accent);
    margin-bottom: var(--s-4);
    border: 1px solid rgba(140,109,255,0.20);
  }
  .landing-feature-title {
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.018em;
    margin: 0 0 var(--s-2);
    color: var(--text-strong);
  }
  .landing-feature-desc {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
  }

  /* ---------- Walkthrough ---------- */
  .landing-walk-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    counter-reset: walk;
  }
  .landing-walk-step {
    position: relative;
    padding: var(--s-7) var(--s-6) var(--s-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
  }
  .landing-walk-step::after {
    content: '';
    position: absolute;
    top: 50%;
    right: -12px;
    width: 12px;
    height: 1px;
    background: var(--border-strong);
  }
  .landing-walk-step:last-child::after { display: none; }
  .landing-walk-num {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    background: var(--accent-gradient-faint);
    border: 1px solid rgba(140,109,255,0.30);
    padding: 3px 8px;
    border-radius: var(--r-full);
    letter-spacing: 0.06em;
    margin-bottom: var(--s-3);
  }
  .landing-walk-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.022em;
    margin: 0 0 var(--s-2);
    color: var(--text-strong);
  }
  .landing-walk-desc {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  /* ---------- Terminal ---------- */
  .landing-terminal-section { margin-top: var(--s-16); }
  .landing-terminal-wrap {
    display: flex;
    justify-content: center;
  }
  .landing-terminal {
    width: 100%;
    max-width: 820px;
    background: linear-gradient(180deg, #0a0b12 0%, #06070c 100%);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    overflow: hidden;
    box-shadow: var(--elev-3), 0 0 60px -10px rgba(140,109,255,0.18);
    text-align: left;
  }
  :root[data-theme='light'] .landing-terminal {
    background: linear-gradient(180deg, #0f111a 0%, #06070c 100%);
  }
  .landing-terminal-chrome {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 11px 14px;
    background: rgba(255,255,255,0.025);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    position: relative;
  }
  .landing-terminal-dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .landing-terminal-dot-r { background: #ff5f57; }
  .landing-terminal-dot-y { background: #febc2e; }
  .landing-terminal-dot-g { background: #28c840; }
  .landing-terminal-title {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    font-family: var(--font-mono);
    font-size: 11px;
    color: rgba(237,237,242,0.55);
    letter-spacing: 0.01em;
  }
  .landing-terminal-body {
    padding: var(--s-6) var(--s-7);
    font-family: var(--font-mono);
    font-feature-settings: var(--mono-feat);
    font-size: 13.5px;
    line-height: 1.85;
    color: rgba(237,237,242,0.92);
  }
  .landing-term-line {
    display: flex;
    gap: 10px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .landing-term-out { color: rgba(237,237,242,0.7); }
  .landing-term-prompt { color: rgba(140,109,255,0.85); user-select: none; flex-shrink: 0; }
  .landing-term-meta { color: rgba(237,237,242,0.45); }
  .landing-term-ok { color: var(--green); user-select: none; flex-shrink: 0; }
  .landing-term-ok-line { color: rgba(237,237,242,0.92); }
  .landing-term-cursor { margin-top: 4px; }
  .landing-term-blink {
    animation: blink 1.05s steps(2) infinite;
    color: var(--accent);
  }
  @keyframes blink { 50% { opacity: 0; } }

  /* ---------- Comparison ---------- */
  .landing-compare {
    max-width: 920px;
    margin: 0 auto;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .landing-compare-row {
    display: grid;
    grid-template-columns: 1fr 180px 180px;
    align-items: center;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--t-sm);
    transition: background var(--t-fast) var(--ease);
  }
  .landing-compare-row:last-child { border-bottom: none; }
  .landing-compare-row:hover { background: var(--bg-hover); }
  .landing-compare-feature {
    color: var(--text-strong);
    font-weight: 500;
  }
  .landing-compare-them, .landing-compare-us {
    text-align: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .landing-compare-us { color: var(--green); font-weight: 500; }
  .landing-compare-hl .landing-compare-us {
    color: var(--accent);
    font-weight: 600;
  }
  .landing-compare-hl .landing-compare-feature::after {
    content: 'NEW';
    margin-left: 8px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--accent-gradient-faint);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.1em;
    font-weight: 600;
    vertical-align: 1px;
  }
  @media (max-width: 720px) {
    .landing-compare-row { grid-template-columns: 1fr 80px 80px; padding: 12px 14px; }
    .landing-compare-hl .landing-compare-feature::after { display: none; }
  }

  /* ---------- Pricing ---------- */
  .landing-pricing {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    max-width: 1080px;
    margin: 0 auto;
    align-items: stretch;
  }
  .landing-price-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-7);
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease);
  }
  .landing-price-card:hover {
    border-color: var(--border-strong);
    transform: translateY(-2px);
  }
  .landing-price-hl {
    border-color: rgba(140,109,255,0.35);
    box-shadow: var(--elev-2), 0 0 0 1px rgba(140,109,255,0.25);
    background:
      linear-gradient(180deg, rgba(140,109,255,0.05), transparent 50%),
      var(--bg-elevated);
  }
  .landing-price-hl:hover { border-color: rgba(140,109,255,0.55); }
  .landing-price-badge {
    position: absolute;
    top: -10px;
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 12px;
    background: var(--accent-gradient);
    color: #fff;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 600;
    border-radius: var(--r-full);
    box-shadow: 0 4px 12px -2px rgba(140,109,255,0.4);
  }
  .landing-price-tier {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-muted);
  }
  .landing-price-amount {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .landing-price-num {
    font-family: var(--font-display);
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -0.03em;
    color: var(--text-strong);
  }
  .landing-price-cad {
    font-size: var(--t-sm);
    color: var(--text-faint);
  }
  .landing-price-desc {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
  .landing-price-features {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: var(--t-sm);
    color: var(--text);
  }
  .landing-price-features li {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .landing-price-check {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }
  .landing-price-cta { margin-top: auto; }

  /* ---------- Closing CTA ---------- */
  .landing-cta-section { margin: var(--s-20) auto var(--s-16); }
  .landing-cta-card {
    position: relative;
    text-align: center;
    padding: var(--s-16) var(--s-7);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-2xl);
    background: var(--bg-elevated);
    overflow: hidden;
    isolation: isolate;
  }
  .landing-cta-bg {
    position: absolute;
    inset: 0;
    z-index: -1;
    background:
      radial-gradient(60% 100% at 50% 0%, rgba(140,109,255,0.16), transparent 65%),
      radial-gradient(40% 80% at 80% 100%, rgba(54,197,214,0.10), transparent 65%);
  }
  .landing-cta-card::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background-image: radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 24px 24px;
    mask-image: radial-gradient(ellipse at center, #000 0%, transparent 65%);
    -webkit-mask-image: radial-gradient(ellipse at center, #000 0%, transparent 65%);
    opacity: 0.6;
  }
  :root[data-theme='light'] .landing-cta-card::after {
    background-image: radial-gradient(rgba(15,16,28,0.07) 1px, transparent 1px);
  }
  .landing-cta-card .eyebrow { justify-content: center; }
  .landing-cta-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4.4vw, 56px);
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-weight: 600;
    margin: var(--s-3) 0 var(--s-4);
    color: var(--text-strong);
  }
  .landing-cta-sub {
    font-size: var(--t-md);
    color: var(--text-muted);
    max-width: 560px;
    margin: 0 auto var(--s-8);
    line-height: 1.55;
  }
  .landing-cta-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }

  /* ---------- Responsive ---------- */
  @media (max-width: 960px) {
    .landing-features { grid-template-columns: repeat(2, 1fr); }
    .landing-walk-grid { grid-template-columns: repeat(2, 1fr); }
    .landing-walk-step::after { display: none; }
    .landing-pricing { grid-template-columns: 1fr; max-width: 480px; }
  }
  @media (max-width: 640px) {
    .landing-hero { padding: var(--s-14) 0 var(--s-10); }
    .landing-hero-cmd { flex-wrap: wrap; justify-content: center; }
    .landing-hero-ctas { flex-direction: column; align-items: stretch; }
    .landing-hero-ctas .btn { width: 100%; justify-content: center; }
    .landing-features { grid-template-columns: 1fr; }
    .landing-walk-grid { grid-template-columns: 1fr; }
    .landing-section { margin: var(--s-12) auto; }
    .landing-cta-card { padding: var(--s-10) var(--s-5); }
    .landing-cta-buttons .btn { width: 100%; justify-content: center; }
  }

  /* ---------- L4 social-proof counters ---------- */
  .landing-counters {
    margin: var(--s-10) auto var(--s-12);
    max-width: 1180px;
    padding: 0 var(--s-4);
  }
  .landing-counters-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 20px;
    text-align: left;
  }
  .landing-counter {
    padding: var(--s-3) 0;
    border-top: 1px solid var(--border-subtle);
  }
  .landing-counter-num {
    font-family: var(--font-display);
    font-size: clamp(24px, 3vw, 38px);
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-weight: 700;
    margin-bottom: 6px;
    font-feature-settings: 'tnum';
    background-image: var(--accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .landing-counter-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-faint);
    line-height: 1.4;
  }
  @media (max-width: 960px) {
    .landing-counters-grid { grid-template-columns: repeat(3, 1fr); gap: 20px 16px; }
  }
  @media (max-width: 540px) {
    .landing-counters-grid { grid-template-columns: repeat(2, 1fr); gap: 18px 12px; }
  }

  /* ---------- L10/U1 hero install snippet ----------
     U1: wrapped in a labelled "power users" panel and re-located
     beneath the CTA + tertiary rows so it no longer competes with
     the primary calls to action. */
  .landing-hero-install-wrap {
    margin: 0 auto var(--space-6);
    text-align: center;
  }
  .landing-hero-install-label {
    display: inline-block;
    margin-bottom: var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .landing-hero-install {
    display: inline-flex;
    align-items: stretch;
    gap: 0;
    margin: 0 auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--r);
    box-shadow: var(--elev-1);
    overflow: hidden;
    max-width: 100%;
    font-family: var(--font-mono);
  }
  .landing-hero-install-code {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    font-size: 13.5px;
    color: var(--text-strong);
    background: transparent;
    border: 0;
    white-space: nowrap;
    overflow-x: auto;
  }
  .landing-hero-install-prompt {
    color: var(--accent);
    user-select: none;
  }
  .landing-hero-install-copy {
    appearance: none;
    border: 0;
    border-left: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0 16px;
    cursor: pointer;
    transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
  }
  .landing-hero-install-copy:hover {
    background: var(--accent-gradient-faint);
    color: var(--accent);
  }
  .landing-hero-install-copy[data-copied="1"] {
    color: var(--green, #34d399);
  }

  /* ---------- L10/U1 hero activity rail ----------
     U1 — tightened into a single horizontal strip. The 1px gradient
     rule on top is the same accent the headline uses, so the rail
     reads as part of the hero composition rather than a stray list. */
  .landing-hero-rail {
    list-style: none;
    padding: var(--space-4) 0 0;
    margin: 0 auto var(--space-6);
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-2) var(--space-6);
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--text-faint);
    max-width: 760px;
    position: relative;
  }
  .landing-hero-rail::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 120px;
    height: 1px;
    background: var(--accent-gradient);
    opacity: 0.45;
    border-radius: 9999px;
  }
  .landing-hero-rail li {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    line-height: 1.4;
  }
  .landing-hero-rail strong {
    color: var(--text-strong);
    font-weight: 600;
    font-feature-settings: 'tnum';
    font-size: 14px;
    letter-spacing: -0.01em;
  }
  .landing-hero-rail-label {
    color: var(--text-muted);
    letter-spacing: 0.01em;
  }
  /* Backwards-compat: nothing references this any more but if a stale
     fragment lingers it's still hidden cleanly rather than orphaned. */
  .landing-hero-rail-check { display: none; }

  /* ---------- L10 three-reasons section ---------- */
  .landing-reasons { margin-top: var(--s-12); }
  .landing-reasons-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .landing-reason {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s-7);
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease);
  }
  .landing-reason:hover {
    border-color: var(--border-strong);
    transform: translateY(-2px);
  }
  .landing-reason-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: var(--r);
    background: var(--accent-gradient-soft);
    color: var(--accent);
    border: 1px solid rgba(140,109,255,0.20);
  }
  .landing-reason-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0;
    color: var(--text-strong);
  }
  .landing-reason-body {
    font-size: var(--t-sm);
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
  .landing-reasons-code {
    display: block;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: 8px 12px;
    overflow-x: auto;
    white-space: nowrap;
  }
  .landing-reason-link {
    margin-top: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--accent);
    font-size: var(--t-sm);
    font-weight: 500;
    text-decoration: none;
  }
  .landing-reason-link:hover { text-decoration: underline; }
  @media (max-width: 960px) {
    .landing-reasons-grid { grid-template-columns: 1fr; max-width: 520px; margin: 0 auto; }
  }

  /* ---------- L10 "How is this different" pull-quote ---------- */
  .landing-pullquote-section {
    margin: var(--s-20) auto var(--s-12);
    max-width: 920px;
    padding: 0 var(--s-4);
    text-align: center;
  }
  .landing-pullquote {
    margin: 0;
    padding: var(--s-10) var(--s-7);
    background:
      radial-gradient(80% 100% at 50% 0%, rgba(140,109,255,0.10), transparent 65%),
      var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-xl);
    position: relative;
    overflow: hidden;
  }
  .landing-pullquote-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: var(--s-4);
  }
  .landing-pullquote-text {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.4vw, 28px);
    line-height: 1.4;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 auto;
    max-width: 760px;
    quotes: "\\201C" "\\201D";
  }
  .landing-pullquote-text::before { content: open-quote; color: var(--accent); margin-right: 4px; }
  .landing-pullquote-text::after { content: close-quote; color: var(--accent); margin-left: 4px; }
  .landing-pullquote-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--s-6);
    color: var(--accent);
    font-size: var(--t-sm);
    font-weight: 500;
    text-decoration: none;
  }
  .landing-pullquote-link:hover { text-decoration: underline; }

  /* ---------- L10 hero responsive overrides ---------- */
  @media (max-width: 640px) {
    .landing-hero-install { width: 100%; }
    .landing-hero-install-code { flex: 1; font-size: 12px; }
    .landing-hero-rail { flex-direction: column; align-items: flex-start; gap: 6px; padding: 0 var(--s-3); }
    .landing-hero-rail li { width: 100%; }
  }

  /* ============================================================ */
  /* Block M1 — Live-now demo feed                                */
  /* ============================================================ */
  .landing-livenow {
    margin: var(--s-8) 0 var(--s-6);
    padding: var(--s-6) 0 var(--s-4);
  }
  .landing-livenow-head {
    text-align: center;
    margin-bottom: var(--s-6);
  }
  .landing-livenow-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    border-radius: var(--r-full);
    background: rgba(52,211,153,0.08);
    border: 1px solid rgba(52,211,153,0.25);
    color: var(--green);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: var(--s-3);
  }
  .landing-livenow-pulse {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 0 0 rgba(52,211,153,0.6);
    animation: landing-livenow-pulse 1.6s ease-out infinite;
  }
  @keyframes landing-livenow-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(52,211,153,0.55); transform: scale(1); }
    70%  { box-shadow: 0 0 0 10px rgba(52,211,153,0); transform: scale(1.05); }
    100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); transform: scale(1); }
  }
  .landing-livenow-title {
    font-size: 22px;
    line-height: 1.25;
    margin: 0 auto;
    max-width: 720px;
    color: var(--text-strong);
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .landing-livenow-sub {
    margin: var(--s-2) auto 0;
    color: var(--text-muted);
    font-size: 13px;
    max-width: 560px;
  }
  .landing-livenow-sub code {
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--accent);
  }

  .landing-livenow-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-3);
  }
  @media (min-width: 980px) {
    .landing-livenow-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  .landing-livecard {
    background: linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.005));
    border: 1px solid var(--border);
    border-radius: var(--r-md, 10px);
    padding: 14px 14px 12px;
    display: flex;
    flex-direction: column;
    min-height: 180px;
    position: relative;
    overflow: hidden;
  }
  .landing-livecard::before {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--accent-gradient-faint);
    opacity: 0;
    transition: opacity 200ms var(--ease, ease);
    pointer-events: none;
  }
  .landing-livecard:hover::before { opacity: 1; }

  .landing-livecard-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .landing-livecard-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 8px rgba(52,211,153,0.55);
    animation: landing-livenow-pulse 1.8s ease-out infinite;
    flex-shrink: 0;
  }
  .landing-livecard-title {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .landing-livecard-bignum {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 4px 0 10px;
  }
  .landing-livecard-bignum-n {
    font-size: 30px;
    font-weight: 700;
    color: var(--text-strong);
    font-variant-numeric: tabular-nums;
    background: var(--accent-gradient);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .landing-livecard-bignum-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  .landing-livecard-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13px;
    line-height: 1.45;
    flex: 1;
  }
  .landing-livecard-row, .landing-livecard-feedrow {
    padding: 6px 0;
    border-bottom: 1px dashed rgba(255,255,255,0.05);
    transition: background-color 1s var(--ease, ease);
    border-radius: 4px;
    margin: 0 -4px;
    padding-left: 4px;
    padding-right: 4px;
  }
  .landing-livecard-row:last-child,
  .landing-livecard-feedrow:last-child { border-bottom: 0; }
  .landing-livecard-feedrow { padding: 4px; font-size: 12.5px; }

  .landing-livecard-flash {
    background-color: rgba(52,211,153,0.18) !important;
    animation: landing-livecard-flash-fade 1.1s ease-out forwards;
  }
  @keyframes landing-livecard-flash-fade {
    0%   { background-color: rgba(52,211,153,0.22); }
    100% { background-color: rgba(52,211,153,0); }
  }

  .landing-livecard-link {
    color: var(--text-strong);
    text-decoration: none;
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .landing-livecard-link:hover { color: var(--accent); }
  .landing-livecard-num {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--text-faint);
    font-weight: 500;
    font-size: 12px;
  }
  .landing-livecard-title-text { color: var(--text-strong); }
  .landing-livecard-snippet {
    color: var(--text-muted);
    font-style: italic;
    font-size: 12px;
  }
  .landing-livecard-meta {
    font-size: 11px;
    color: var(--text-faint);
    margin-top: 2px;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .landing-livecard-repo {
    color: var(--accent-2);
  }
  .landing-livecard-rel {
    color: var(--text-muted);
  }
  .landing-livecard-empty {
    color: var(--text-faint);
    font-size: 12px;
    font-style: italic;
    padding: 8px 0;
  }
  .landing-livecard-kind {
    display: inline-block;
    padding: 1px 7px;
    border-radius: var(--r-full);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .landing-livecard-kind-auto_merge-merged,
  .landing-livecard-kind-auto-merge-merged {
    background: rgba(52,211,153,0.12);
    color: var(--green);
    border: 1px solid rgba(52,211,153,0.25);
  }
  .landing-livecard-kind-ai_build-dispatched,
  .landing-livecard-kind-ai-build-dispatched {
    background: rgba(140,109,255,0.12);
    color: var(--accent);
    border: 1px solid rgba(140,109,255,0.30);
  }
  .landing-livecard-kind-ai_review-posted,
  .landing-livecard-kind-ai-review-posted {
    background: rgba(54,197,214,0.12);
    color: var(--accent-2);
    border: 1px solid rgba(54,197,214,0.30);
  }

  .landing-livenow-cta {
    margin-top: var(--s-5);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .landing-livenow-cta-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .landing-livenow-cta-link:hover { color: var(--accent-hover); }
  .landing-livenow-cta-sep { color: var(--text-faint); }

  @media (prefers-reduced-motion: reduce) {
    .landing-livenow-pulse,
    .landing-livecard-dot { animation: none; }
    .landing-livecard-flash { animation: none; background-color: transparent !important; }
  }
`;

/**
 * Block L4 — count-up animation.
 *
 * Reads each `[data-counter-target]` and animates the in-DOM text from
 * 0 → target over ~1.2s when the element first scrolls into view.
 *
 * Render-once semantics: each tile already contains the final value as
 * HTML, so visitors with JS disabled — or anyone before the script
 * loads — sees the correct number. The script just animates the text.
 *
 * Falls back to the static value (no animation) when IntersectionObserver
 * isn't available, or when the user prefers reduced motion.
 */
const landingCountersJs = `
(function(){
  try {
    var els = document.querySelectorAll('[data-counter-target]');
    if (!els.length) return;
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof IntersectionObserver !== 'function') return;

    function animate(el) {
      var target = parseInt(el.getAttribute('data-counter-target') || '0', 10);
      if (!isFinite(target) || target <= 0) return;
      var prefix = el.getAttribute('data-counter-prefix') || '';
      var suffix = el.getAttribute('data-counter-suffix') || '';
      var duration = 1200;
      var start = performance.now();
      function frame(now) {
        var t = Math.min(1, (now - start) / duration);
        // ease-out cubic
        var eased = 1 - Math.pow(1 - t, 3);
        var v = Math.floor(eased * target);
        el.textContent = prefix + v.toLocaleString() + suffix;
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = prefix + target.toLocaleString() + suffix;
      }
      // Reset to zero before animating in.
      el.textContent = prefix + '0' + suffix;
      requestAnimationFrame(frame);
    }

    var io = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry){
        if (entry.isIntersecting) {
          animate(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.4 });
    els.forEach(function(el){ io.observe(el); });
  } catch (_) { /* swallow — static numbers remain */ }
})();
`;

/**
 * Block L10 — clipboard copy for the hero install snippet.
 *
 * Pure progressive enhancement. Without JS the user can still
 * triple-click + Cmd/Ctrl-C the snippet — the button is the
 * speed-bump, not the only path.
 */
const landingCopyJs = `
(function(){
  try {
    var btns = document.querySelectorAll('[data-copy-target]');
    if (!btns.length) return;
    btns.forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-copy-target') || '';
        var src = document.getElementById(id);
        if (!src) return;
        var text = src.textContent || '';
        var done = function(){
          var prev = btn.textContent;
          btn.textContent = 'Copied';
          btn.setAttribute('data-copied', '1');
          setTimeout(function(){
            btn.textContent = prev || 'Copy';
            btn.removeAttribute('data-copied');
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function(){ done(); });
        } else {
          // Legacy fallback — temp textarea + execCommand.
          try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            done();
          } catch (_) {}
        }
      });
    });
  } catch (_) { /* swallow */ }
})();
`;

// ============================================================
// land2030Css — scoped CSS for the 2030 homepage prelude.
// Every selector is prefixed `.land-2030-*` so it can't bleed
// into the older `.landing-*` (L10/U1/Q1/M1) styles below.
// ============================================================
const land2030Css = `
  .land-2030-root {
    position: relative;
    max-width: 1240px;
    margin: 0 auto;
    padding: 0 16px var(--space-6, 32px);
    color: var(--text, #e6e6f0);
  }

  /* ---------- Hero ---------- */
  .land-2030-hero {
    position: relative;
    padding: clamp(48px, 8vw, 120px) 8px clamp(40px, 6vw, 80px);
    text-align: center;
    overflow: hidden;
  }
  .land-2030-hairline {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .land-2030-orb {
    position: absolute;
    top: -10%;
    left: 50%;
    width: 720px;
    height: 720px;
    transform: translateX(-50%);
    background: radial-gradient(circle, rgba(140,109,255,0.30), rgba(54,197,214,0.16) 40%, transparent 70%);
    filter: blur(90px);
    pointer-events: none;
    z-index: 0;
  }
  .land-2030-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 1080px;
    margin: 0 auto;
  }
  .land-2030-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(140,109,255,0.10);
    color: #cbb7ff;
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid rgba(140,109,255,0.30);
    margin-bottom: 24px;
  }
  .land-2030-eyebrow-mini {
    margin-bottom: 12px;
  }
  .land-2030-pulse {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #8c6dff;
    box-shadow: 0 0 12px rgba(140,109,255,0.8);
    animation: land2030-pulse 2s ease-in-out infinite;
  }
  @keyframes land2030-pulse {
    0%, 100% { opacity: 0.5; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.25); }
  }
  .land-2030-display {
    font-size: clamp(60px, 9vw, 96px);
    font-family: var(--font-display, inherit);
    font-weight: 800;
    line-height: 1.02;
    letter-spacing: -0.035em;
    margin: 0 auto 24px;
    max-width: 1040px;
  }
  .land-2030-display span { background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }
  .land-2030-grad-1 { background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 100%); }
  .land-2030-grad-2 { background-image: linear-gradient(135deg, #c4b1ff 0%, #36c5d6 100%); }
  .land-2030-grad-3 { background-image: linear-gradient(135deg, #36c5d6 0%, #5be0a9 100%); }
  .land-2030-grad-4 { background-image: linear-gradient(135deg, #5be0a9 0%, #ffd16b 100%); }
  .land-2030-grad-5 { background-image: linear-gradient(135deg, #ffd16b 0%, #ff6bd1 50%, #8c6dff 100%); }
  .land-2030-sub {
    font-size: clamp(17px, 1.6vw, 22px);
    color: var(--text-muted, #a0a0b8);
    max-width: 720px;
    margin: 0 auto 36px;
    line-height: 1.45;
  }
  .land-2030-cta-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
  }
  .land-2030-cta-primary,
  .land-2030-cta-secondary {
    min-width: 200px;
  }

  /* ---------- Section scaffold ---------- */
  .land-2030-section {
    margin: clamp(56px, 8vw, 96px) 0;
    position: relative;
  }
  .land-2030-section-dark {
    padding: 48px 32px;
    background: linear-gradient(180deg, rgba(15,17,26,0.6), rgba(8,9,15,0.6));
    border: 1px solid rgba(140,109,255,0.18);
    border-radius: 20px;
  }
  .land-2030-section-head {
    text-align: center;
    max-width: 760px;
    margin: 0 auto 40px;
  }
  .land-2030-h2 {
    font-size: clamp(28px, 4vw, 44px);
    font-family: var(--font-display, inherit);
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.1;
    margin: 0 0 12px;
  }
  .land-2030-lede {
    font-size: 16px;
    color: var(--text-muted, #a0a0b8);
    line-height: 1.55;
    margin: 0;
  }

  /* ---------- Closed loop diagram ---------- */
  .land-2030-loop-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px;
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(140,109,255,0.16);
    border-radius: 20px;
    color: var(--text-muted, #a0a0b8);
  }
  .land-2030-loop-svg {
    display: block;
    width: 100%;
    height: auto;
  }
  .land-2030-loop-path {
    stroke-dasharray: 6 4;
    animation: land2030-loop-dash 30s linear infinite;
  }
  @keyframes land2030-loop-dash {
    from { stroke-dashoffset: 0; }
    to { stroke-dashoffset: -400; }
  }
  .land-2030-loop-text {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }

  /* ---------- 6-card "unfair advantages" grid ---------- */
  .land-2030-card-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    max-width: 1180px;
    margin: 0 auto;
  }
  .land-2030-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 24px;
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    text-decoration: none;
    color: inherit;
    transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
  }
  .land-2030-card:hover {
    transform: translateY(-2px);
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 8px 30px -8px rgba(140,109,255,0.40);
  }
  .land-2030-card-icon {
    width: 44px; height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    background: rgba(140,109,255,0.12);
    color: #cbb7ff;
    border: 1px solid rgba(140,109,255,0.30);
    margin-bottom: 4px;
  }
  .land-2030-card-title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .land-2030-card-desc {
    margin: 0;
    font-size: 14.5px;
    color: var(--text-muted, #a0a0b8);
    line-height: 1.55;
  }
  .land-2030-card-cta {
    margin-top: auto;
    color: #b69dff;
    font-size: 14px;
    font-weight: 600;
  }

  /* ---------- Global dashboards grid ---------- */
  .land-2030-dash-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 12px;
    max-width: 1180px;
    margin: 0 auto;
  }
  .land-2030-dash {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 18px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 12px;
    text-decoration: none;
    color: inherit;
    transition: transform 180ms ease, border-color 180ms ease;
  }
  .land-2030-dash:hover {
    transform: translateY(-1px);
    border-color: rgba(54,197,214,0.45);
  }
  .land-2030-dash-name {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 14px;
    color: #36c5d6;
    font-weight: 600;
  }
  .land-2030-dash-desc {
    font-size: 13px;
    color: var(--text-muted, #a0a0b8);
    line-height: 1.45;
  }

  /* ---------- 18-feature grid + status pills ---------- */
  .land-2030-feat-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    max-width: 1180px;
    margin: 0 auto;
  }
  .land-2030-feat {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px;
    background: rgba(255,255,255,0.025);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 10px;
    text-decoration: none;
    color: inherit;
    transition: border-color 160ms ease, background 160ms ease;
  }
  .land-2030-feat:hover {
    border-color: rgba(140,109,255,0.35);
    background: rgba(140,109,255,0.05);
  }
  .land-2030-feat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .land-2030-feat-title {
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: -0.005em;
  }
  .land-2030-feat-desc {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted, #a0a0b8);
    line-height: 1.5;
  }
  .land-2030-pill {
    font-size: 10.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid currentColor;
    font-weight: 700;
    line-height: 1;
  }
  .land-2030-pill-live { color: #5be0a9; border-color: rgba(91,224,169,0.5); background: rgba(91,224,169,0.10); }
  .land-2030-pill-beta { color: #ffd16b; border-color: rgba(255,209,107,0.5); background: rgba(255,209,107,0.10); }
  .land-2030-pill-soon { color: #a0a0b8; border-color: rgba(160,160,184,0.4); background: rgba(160,160,184,0.08); }

  /* ---------- Developer surface ---------- */
  .land-2030-dx-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    max-width: 1180px;
    margin: 0 auto;
  }
  .land-2030-dx {
    padding: 18px;
    background: linear-gradient(180deg, rgba(15,17,26,0.7), rgba(8,9,15,0.7));
    border: 1px solid rgba(140,109,255,0.18);
    border-radius: 14px;
  }
  .land-2030-dx-title {
    margin: 0 0 10px;
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong, #fff);
  }
  .land-2030-code {
    margin: 0;
    padding: 12px 14px;
    background: rgba(0,0,0,0.30);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12.5px;
    color: #cbb7ff;
    line-height: 1.6;
    overflow-x: auto;
  }
  .land-2030-code code { color: inherit; background: transparent; padding: 0; }
  .land-2030-code-wide {
    font-size: 13px;
    color: #d6d6e4;
  }

  /* ---------- Agent multiplayer ---------- */
  .land-2030-agent-wrap {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 24px;
    max-width: 1080px;
    margin: 0 auto;
    align-items: center;
  }
  .land-2030-agent-stat { text-align: left; }
  .land-2030-agent-big {
    font-size: clamp(48px, 7vw, 80px);
    font-weight: 800;
    line-height: 1;
    background-image: linear-gradient(135deg, #a48bff 0%, #36c5d6 100%);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    letter-spacing: -0.03em;
  }
  .land-2030-agent-label {
    margin-top: 12px;
    color: var(--text-muted, #a0a0b8);
    font-size: 15px;
    line-height: 1.5;
  }
  .land-2030-agent-link {
    display: inline-block;
    margin-top: 16px;
    color: #36c5d6;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
  }
  .land-2030-agent-link:hover { text-decoration: underline; }

  /* ---------- vs GitHub strip ---------- */
  .land-2030-vs {
    max-width: 880px;
    margin: 0 auto;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    overflow: hidden;
    text-align: center;
    padding: 0 0 18px;
  }
  .land-2030-vs-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    padding: 16px 18px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    font-size: 15px;
  }
  .land-2030-vs-row:last-of-type { border-bottom: 0; }
  .land-2030-vs-head {
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted, #a0a0b8);
    background: rgba(255,255,255,0.02);
  }
  .land-2030-vs-us {
    color: #5be0a9;
    font-weight: 700;
  }
  .land-2030-vs-link {
    display: inline-block;
    margin-top: 12px;
    color: #b69dff;
    text-decoration: none;
    font-weight: 600;
    font-size: 14px;
  }
  .land-2030-vs-link:hover { text-decoration: underline; }

  /* ---------- Responsive ---------- */
  @media (max-width: 960px) {
    .land-2030-card-grid,
    .land-2030-feat-grid,
    .land-2030-dx-grid,
    .land-2030-dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .land-2030-agent-wrap { grid-template-columns: 1fr; }
  }
  @media (max-width: 640px) {
    .land-2030-card-grid,
    .land-2030-feat-grid,
    .land-2030-dx-grid,
    .land-2030-dash-grid { grid-template-columns: 1fr; }
    .land-2030-section-dark { padding: 28px 16px; }
    .land-2030-vs-row { grid-template-columns: 1fr; gap: 4px; }
  }
  @media (max-width: 375px) {
    .land-2030-display { font-size: 44px; }
    .land-2030-cta-primary,
    .land-2030-cta-secondary { width: 100%; min-width: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .land-2030-loop-path,
    .land-2030-pulse { animation: none; }
  }
`;
