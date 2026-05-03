/**
 * Marketing landing page for logged-out visitors.
 *
 * Editorial-Technical redesign — 2026.05.
 * Hero · trust strip · feature grid · workflow walkthrough ·
 * comparison · terminal · pricing teaser · closing CTA.
 *
 * Pure presentational. Drops into <Layout user={null}>.
 * All styles scoped under `.landing-` so they don't bleed into app views.
 */

import type { FC } from "hono/jsx";

export interface LandingPageProps {
  stats?: {
    publicRepos?: number;
    users?: number;
  };
}

export const LandingHero: FC<LandingPageProps> = ({ stats } = {}) => {
  const hasStats =
    stats &&
    ((stats.publicRepos !== undefined && stats.publicRepos > 0) ||
      (stats.users !== undefined && stats.users > 0));

  return (
    <>
      <style>{landingCss}</style>

      <div class="landing-root">
        {/* ---------- Hero ---------- */}
        <section class="landing-hero">
          <div class="landing-hero-bg" aria-hidden="true">
            <div class="landing-hero-blob landing-hero-blob-1" />
            <div class="landing-hero-blob landing-hero-blob-2" />
            <div class="landing-hero-grid" />
          </div>

          <div class="landing-hero-inner stagger">
            <div class="eyebrow landing-hero-eyebrow">
              <span class="landing-hero-pulse" />
              v1 · pre-launch · {new Date().getFullYear()}
            </div>

            <h1 class="landing-hero-title display">
              Where software{" "}
              <span class="gradient-text">writes itself.</span>
            </h1>

            <p class="landing-hero-sub">
              Gluecron is the operator-tier replacement for GitHub. Push code,
              and the platform reviews it, fixes it, ships it. Spec-to-PR. Auto-repair.
              Real-time gates. Built for the era when most code is written by AI
              and most reviews are too.
            </p>

            <div class="landing-hero-ctas">
              <a href="/register" class="btn btn-primary btn-xl landing-cta-primary">
                Start shipping
                <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
              </a>
              <a href="/explore" class="btn btn-secondary btn-xl">
                Explore repos
              </a>
            </div>

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

        {/* ---------- Trust strip ---------- */}
        <section class="landing-trust">
          <p class="landing-trust-label">Built for the new shape of software</p>
          <div class="landing-trust-row">
            <span class="landing-trust-item">Spec-to-PR</span>
            <span class="landing-trust-dot" aria-hidden="true" />
            <span class="landing-trust-item">Auto-repair</span>
            <span class="landing-trust-dot" aria-hidden="true" />
            <span class="landing-trust-item">Live gates</span>
            <span class="landing-trust-dot" aria-hidden="true" />
            <span class="landing-trust-item">MCP-native</span>
            <span class="landing-trust-dot" aria-hidden="true" />
            <span class="landing-trust-item">Workflow runner</span>
            <span class="landing-trust-dot" aria-hidden="true" />
            <span class="landing-trust-item">Self-hosted</span>
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
            <WalkStep n="04" title="Ship" desc="Green push to default branch fires deploy webhook. Crontech, Fly, your prod." />
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
          </div>
        </section>
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

// Backwards-compatible default — web.tsx imports `LandingPage`.
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
    padding: var(--s-20) 0 var(--s-16);
    text-align: center;
    overflow: hidden;
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
  }
  .landing-hero-blob-1 {
    top: -10%;
    left: 30%;
    width: 480px;
    height: 480px;
    background: radial-gradient(circle, rgba(140,109,255,0.55), transparent 65%);
  }
  .landing-hero-blob-2 {
    top: 10%;
    left: 50%;
    width: 380px;
    height: 380px;
    background: radial-gradient(circle, rgba(54,197,214,0.40), transparent 65%);
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
  .landing-hero-eyebrow {
    margin: 0 auto var(--s-6);
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
    font-size: clamp(44px, 8vw, 92px);
    line-height: 0.98;
    letter-spacing: -0.04em;
    font-weight: 600;
    margin: 0 0 var(--s-6);
    color: var(--text-strong);
  }

  .landing-hero-sub {
    font-size: clamp(15px, 1.6vw, 19px);
    color: var(--text-muted);
    max-width: 680px;
    margin: 0 auto;
    line-height: 1.55;
    letter-spacing: -0.005em;
  }

  .landing-hero-ctas {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: var(--s-10);
  }
  .landing-cta-arrow {
    transition: transform var(--t-base) var(--ease-spring);
    display: inline-block;
  }
  .btn:hover .landing-cta-arrow,
  .landing-cta-primary:hover .landing-cta-arrow {
    transform: translateX(4px);
  }

  .landing-hero-caption {
    margin-top: var(--s-8);
    font-size: var(--t-sm);
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 12px;
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
    margin-top: var(--s-7);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    flex-wrap: wrap;
    letter-spacing: 0.02em;
  }
  .landing-stats strong {
    color: var(--text-strong);
    font-weight: 600;
    font-feature-settings: 'tnum';
  }
  .landing-stats-sep { opacity: 0.4; }

  /* ---------- Trust strip ---------- */
  .landing-trust {
    margin: var(--s-8) auto var(--s-16);
    padding: var(--s-7) 0;
    border-top: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
    text-align: center;
  }
  .landing-trust-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--text-faint);
    margin-bottom: var(--s-4);
  }
  .landing-trust-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .landing-trust-item {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 500;
    letter-spacing: -0.015em;
    color: var(--text-muted);
    transition: color var(--t-fast) var(--ease);
  }
  .landing-trust-item:hover { color: var(--text-strong); }
  .landing-trust-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--text-faint);
    opacity: 0.5;
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
`;
