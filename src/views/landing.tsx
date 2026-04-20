/**
 * Marketing landing page for logged-out visitors.
 *
 * Pure presentational component — no props required. Drops into an existing
 * <Layout user={null}> as a single fragment. All styles are scoped under the
 * `landing-` class prefix so they don't leak into the rest of the app.
 *
 * Tone: confident, technical, specific. No "revolutionary", no "game-changing".
 */

import type { FC } from "hono/jsx";

export interface LandingPageProps {
  stats?: {
    publicRepos?: number;
    users?: number;
  };
}

export const LandingPage: FC<LandingPageProps> = () => {
  return (
    <>
      <style>{landingCss}</style>

      {/* ---------- Hero ---------- */}
      <section class="landing-hero">
        <h1 class="landing-hero-title">
          GitHub, but the AI actually ships the code.
        </h1>
        <p class="landing-hero-sub">
          gluecron is a self-hostable code platform with AI review, dependency
          updates, semantic search, and a workflow runner built in. No plugins.
          No bolt-ons. One binary.
        </p>
        <div class="landing-hero-ctas">
          <a href="/register" class="btn btn-primary landing-cta-primary">
            Start free
          </a>
          <a href="/explore" class="btn landing-cta-secondary">
            Explore public repos
          </a>
        </div>
        <p class="landing-trust">
          Self-hostable &middot; AI built in &middot; Open source mindset
        </p>
      </section>

      {/* ---------- Features grid ---------- */}
      <section class="landing-section">
        <h2 class="landing-section-title">Everything in one binary</h2>
        <p class="landing-section-sub">
          The features GitHub sells as separate products (Dependabot, Copilot,
          Actions, Advanced Security) ship with gluecron by default.
        </p>
        <div class="landing-grid">
          <FeatureCard
            icon="\u2728"
            title="AI code review"
            desc="Claude Sonnet reviews every PR with inline comments. Can block merges when configured in branch protection."
          />
          <FeatureCard
            icon="\u21BB"
            title="AI dependency updates"
            desc="Scans package.json, opens PRs with bump tables, writes the branch via git plumbing. Dependabot without the setup."
          />
          <FeatureCard
            icon="\u2315"
            title="Semantic code search"
            desc="voyage-code-3 embeddings over every chunk, with lexical fallback. Finds code by intent, not just text."
          />
          <FeatureCard
            icon="\u{1F4D6}"
            title="Explain this codebase"
            desc="One click gets you a per-commit cached Markdown tour of the repo. Onboarding that writes itself."
          />
          <FeatureCard
            icon="\u2713"
            title="Signed commit verification"
            desc="GPG and SSH signatures, Issuer Fingerprint extraction, a green Verified badge on the commit list."
          />
          <FeatureCard
            icon="\u21C4"
            title="Merge queues + required checks"
            desc="Serialised merges with re-test against the latest base. Per-branch required check matrix, enforced at merge."
          />
          <FeatureCard
            icon="\u2699"
            title="Self-hosted workflow runner"
            desc="Actions-equivalent runner reads .gluecron/workflows/*.yml. Bun subprocesses, size-capped logs, per-step timeouts."
          />
          <FeatureCard
            icon="\u{1F4E6}"
            title="npm-protocol package registry"
            desc="Publish, install, yank over the real npm protocol. PAT-auth via .npmrc. No separate service to run."
          />
          <FeatureCard
            icon="\u{1F510}"
            title="Enterprise SSO (OIDC)"
            desc="Okta, Azure AD, Auth0, Google Workspace. Auth-code flow, state+nonce, optional email-domain allow-list."
          />
        </div>
      </section>

      {/* ---------- vs GitHub ---------- */}
      <section class="landing-section landing-compare">
        <h2 class="landing-section-title">gluecron vs GitHub</h2>
        <p class="landing-section-sub">
          Honest comparison. GitHub is excellent at what it does. gluecron is
          built for teams that want AI and CI in one place, on infrastructure
          they control.
        </p>
        <div class="landing-compare-grid">
          <div class="landing-compare-col landing-compare-us">
            <h3>gluecron</h3>
            <ul>
              <li><span class="landing-check">{"\u2713"}</span> Self-host on your own box</li>
              <li><span class="landing-check">{"\u2713"}</span> AI review and completion included</li>
              <li><span class="landing-check">{"\u2713"}</span> Dependency updater included</li>
              <li><span class="landing-check">{"\u2713"}</span> Workflow runner included</li>
              <li><span class="landing-check">{"\u2713"}</span> Semantic search included</li>
              <li><span class="landing-check">{"\u2713"}</span> Green-by-default (gates, protection, codeowners)</li>
              <li><span class="landing-check">{"\u2713"}</span> One binary. One database. One deploy.</li>
            </ul>
          </div>
          <div class="landing-compare-col landing-compare-them">
            <h3>GitHub</h3>
            <ul>
              <li><span class="landing-dash">{"\u2013"}</span> SaaS-first (Enterprise Server is separate)</li>
              <li><span class="landing-dash">{"\u2013"}</span> Copilot billed per seat</li>
              <li><span class="landing-dash">{"\u2013"}</span> Dependabot configured per repo</li>
              <li><span class="landing-dash">{"\u2013"}</span> Actions minutes metered</li>
              <li><span class="landing-dash">{"\u2013"}</span> Code search is lexical by default</li>
              <li><span class="landing-dash">{"\u2013"}</span> Advanced Security is an add-on</li>
              <li><span class="landing-dash">{"\u2013"}</span> Many moving pieces to wire together</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- How it works ---------- */}
      <section class="landing-section">
        <h2 class="landing-section-title">How it works</h2>
        <div class="landing-steps">
          <div class="landing-step">
            <div class="landing-step-num">1</div>
            <h3>Push code</h3>
            <p>
              <code>git push</code> to gluecron. Standard Smart HTTP. No agent
              to install.
            </p>
          </div>
          <div class="landing-step">
            <div class="landing-step-num">2</div>
            <h3>Gates + AI review run</h3>
            <p>
              Secret scanner, security gate, AI reviewer, and your workflows
              fire automatically. Rulesets enforce push policy.
            </p>
          </div>
          <div class="landing-step">
            <div class="landing-step-num">3</div>
            <h3>Green pushes auto-deploy</h3>
            <p>
              Default-branch commits that pass all gates deploy through
              Crontech. Failed deploys open an AI-authored incident issue.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- Final CTA band ---------- */}
      <section class="landing-cta-band">
        <h2>Ready to push?</h2>
        <p>
          Create an account, push a repo, watch the gates run. No credit card,
          no trial clock.
        </p>
        <div class="landing-hero-ctas">
          <a href="/register" class="btn btn-primary landing-cta-primary">
            Start free
          </a>
          <a href="/explore" class="btn landing-cta-secondary">
            Browse public repos
          </a>
        </div>
      </section>

      {/* ---------- Footer row ---------- */}
      <section class="landing-foot">
        <a href="/explore">Explore</a>
        <span class="landing-foot-sep">&middot;</span>
        <a href="/marketplace">Marketplace</a>
        <span class="landing-foot-sep">&middot;</span>
        <a href="/api/graphql">GraphQL API</a>
        <span class="landing-foot-sep">&middot;</span>
        <a href="/shortcuts">Keyboard shortcuts</a>
        <span class="landing-foot-sep">&middot;</span>
        <a href="/terms">Terms</a>
      </section>
    </>
  );
};

const FeatureCard: FC<{ icon: string; title: string; desc: string }> = ({
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

const landingCss = `
  /* ---------- Hero ---------- */
  .landing-hero {
    padding: 72px 16px 56px;
    text-align: center;
    max-width: 860px;
    margin: 0 auto;
    border-bottom: 1px solid var(--border);
  }
  .landing-hero-title {
    font-size: 44px;
    line-height: 1.1;
    letter-spacing: -0.02em;
    margin: 0 0 20px;
    color: var(--text);
    font-weight: 700;
  }
  .landing-hero-sub {
    font-size: 18px;
    color: var(--text-muted);
    margin: 0 auto 32px;
    max-width: 640px;
    line-height: 1.5;
  }
  .landing-hero-ctas {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .landing-cta-primary,
  .landing-cta-secondary {
    padding: 10px 20px;
    font-size: 15px;
    font-weight: 600;
  }
  .landing-trust {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 12px;
    letter-spacing: 0.02em;
  }

  /* ---------- Section scaffolding ---------- */
  .landing-section {
    padding: 64px 16px;
    max-width: 1080px;
    margin: 0 auto;
    border-bottom: 1px solid var(--border);
  }
  .landing-section-title {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 12px;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .landing-section-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0 0 36px;
    max-width: 680px;
    line-height: 1.6;
  }

  /* ---------- Features grid ---------- */
  .landing-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .landing-feature {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    background: var(--bg-secondary);
    transition: border-color 0.15s;
  }
  .landing-feature:hover { border-color: var(--text-muted); }
  .landing-feature-icon {
    font-size: 22px;
    margin-bottom: 10px;
    line-height: 1;
  }
  .landing-feature-title {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 6px;
    color: var(--text);
  }
  .landing-feature-desc {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  /* ---------- Compare strip ---------- */
  .landing-compare-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .landing-compare-col {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    background: var(--bg-secondary);
  }
  .landing-compare-us { border-color: var(--accent); }
  .landing-compare-col h3 {
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 16px;
    color: var(--text);
  }
  .landing-compare-col ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .landing-compare-col li {
    font-size: 14px;
    color: var(--text);
    padding: 6px 0;
    line-height: 1.5;
  }
  .landing-check { color: var(--green); font-weight: 700; margin-right: 8px; }
  .landing-dash  { color: var(--text-muted); font-weight: 700; margin-right: 8px; }
  .landing-compare-them li { color: var(--text-muted); }

  /* ---------- How it works ---------- */
  .landing-steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
  }
  .landing-step {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    background: var(--bg-secondary);
  }
  .landing-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    margin-bottom: 12px;
  }
  .landing-step h3 {
    font-size: 16px;
    font-weight: 600;
    margin: 0 0 6px;
    color: var(--text);
  }
  .landing-step p {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
  .landing-step code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 6px;
    border-radius: 3px;
    color: var(--text);
  }

  /* ---------- Final CTA band ---------- */
  .landing-cta-band {
    padding: 72px 16px;
    text-align: center;
    max-width: 860px;
    margin: 0 auto;
    border-bottom: 1px solid var(--border);
  }
  .landing-cta-band h2 {
    font-size: 32px;
    font-weight: 700;
    margin: 0 0 12px;
    color: var(--text);
  }
  .landing-cta-band p {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0 auto 28px;
    max-width: 560px;
  }

  /* ---------- Foot row ---------- */
  .landing-foot {
    padding: 32px 16px 48px;
    text-align: center;
    font-size: 13px;
    color: var(--text-muted);
  }
  .landing-foot a { color: var(--text-muted); }
  .landing-foot a:hover { color: var(--text); text-decoration: none; }
  .landing-foot-sep { margin: 0 10px; color: var(--border); }

  /* ---------- Responsive ---------- */
  @media (max-width: 820px) {
    .landing-hero { padding: 48px 16px 40px; }
    .landing-hero-title { font-size: 32px; }
    .landing-hero-sub { font-size: 16px; }
    .landing-section { padding: 48px 16px; }
    .landing-section-title { font-size: 24px; }
    .landing-grid { grid-template-columns: 1fr; }
    .landing-compare-grid { grid-template-columns: 1fr; }
    .landing-steps { grid-template-columns: 1fr; }
    .landing-cta-band { padding: 48px 16px; }
    .landing-cta-band h2 { font-size: 24px; }
  }
`;

export default LandingPage;
