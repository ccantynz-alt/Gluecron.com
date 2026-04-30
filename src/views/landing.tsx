/**
 * Marketing landing page for logged-out visitors.
 *
 * Hero-first redesign — Linear/Cursor tier launch page.
 * Pure presentational component. Drops into <Layout user={null}>.
 * All styles scoped under `.landing-` class prefix so they don't leak.
 *
 * Tone: confident, technical, specific. No marketing buzzwords.
 *
 * Falls back gracefully when newer design tokens (--bg-surface, --accent-2,
 * --accent-gradient, --t-*, --s-*, --r-*, --ease, etc.) aren't yet defined,
 * by using `var(--token, fallback)` everywhere.
 */

import type { FC } from "hono/jsx";

export interface LandingPageProps {
  stats?: {
    publicRepos?: number;
    users?: number;
  };
}

// Public exports — both names kept for backwards compatibility with the
// web.tsx import. <LandingHero /> is a focused hero-only render; <LandingPage>
// renders the same (the hero IS the page in the new design).
export const LandingHero: FC<LandingPageProps> = ({ stats } = {}) => {
  const hasStats =
    stats &&
    ((stats.publicRepos !== undefined && stats.publicRepos > 0) ||
      (stats.users !== undefined && stats.users > 0));

  return (
    <>
      <style>{landingCss}</style>

      <div class="landing-root">
        {/* Background radial blob — purely decorative */}
        <div class="landing-blob" aria-hidden="true" />

        {/* ---------- Hero ---------- */}
        <section class="landing-hero">
          <h1 class="landing-hero-title">
            Where software{" "}
            <span class="landing-hero-grad">lives.</span>
          </h1>
          <p class="landing-hero-sub">
            AI-native code intelligence. Self-hosting, automated CI, push-time
            gate enforcement. Your software ships itself, fixes itself, gets
            better every day.
          </p>
          <div class="landing-hero-ctas">
            <a href="/register" class="btn btn-primary btn-lg landing-cta-primary">
              Get started
              <span class="landing-cta-arrow" aria-hidden="true">{"→"}</span>
            </a>
            <a href="/login" class="btn btn-ghost btn-lg landing-cta-secondary">
              Sign in
            </a>
          </div>
          <p class="landing-hero-caption">
            Already have a repo?{" "}
            <kbd class="landing-kbd">git</kbd>
            <span class="landing-kbd-sep">{" "}</span>
            <kbd class="landing-kbd">push</kbd>
            {" "}it directly.
          </p>

          {hasStats && (
            <p class="landing-stats">
              {stats!.publicRepos !== undefined && stats!.publicRepos > 0 && (
                <span>
                  <strong>{stats!.publicRepos.toLocaleString()}</strong> public
                  {stats!.publicRepos === 1 ? " repo" : " repos"}
                </span>
              )}
              {stats!.publicRepos !== undefined &&
                stats!.publicRepos > 0 &&
                stats!.users !== undefined &&
                stats!.users > 0 && <span class="landing-stats-sep"> &middot; </span>}
              {stats!.users !== undefined && stats!.users > 0 && (
                <span>
                  <strong>{stats!.users.toLocaleString()}</strong>
                  {stats!.users === 1 ? " developer" : " developers"}
                </span>
              )}
            </p>
          )}
        </section>

        {/* ---------- Feature grid ---------- */}
        <section class="landing-features">
          <div class="landing-feature">
            <div class="landing-feature-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3l1.9 4.6L18.5 9l-3.6 3 1 4.8L12 14.5 8.1 16.8l1-4.8L5.5 9l4.6-1.4z" />
              </svg>
            </div>
            <h3 class="landing-feature-title">AI as a teammate</h3>
            <p class="landing-feature-desc">
              Spec-to-PR drafts entire features from plain English. Auto-explain
              reviews every diff. The AI commits with its own account, visible
              in your history.
            </p>
          </div>

          <div class="landing-feature">
            <div class="landing-feature-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2.5l8 3.5v6c0 5-3.5 8.5-8 9.5-4.5-1-8-4.5-8-9.5v-6z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <h3 class="landing-feature-title">Quality gate that learns</h3>
            <p class="landing-feature-desc">
              GateTest scans every push. Auto-repair fixes regressions before
              you see them. Required checks block bad PRs from merging.
            </p>
          </div>

          <div class="landing-feature">
            <div class="landing-feature-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
              </svg>
            </div>
            <h3 class="landing-feature-title">Real-time everything</h3>
            <p class="landing-feature-desc">
              Live workflow logs streaming over SSE. Live PR review presence.
              Live deploys you watch happen. No polling, no refresh.
            </p>
          </div>
        </section>

        {/* ---------- Terminal block ---------- */}
        <section class="landing-terminal-wrap">
          <div class="landing-terminal" role="img" aria-label="Example git push to gluecron with passing gates">
            <div class="landing-term-line">
              <span class="landing-term-prompt">$</span>
              <span>git remote add gluecron https://gluecron.com/you/your-repo.git</span>
            </div>
            <div class="landing-term-line">
              <span class="landing-term-prompt">$</span>
              <span>git push -u gluecron main</span>
            </div>
            <div class="landing-term-line">
              <span class="landing-term-ok">{"✓"}</span>
              <span>pushed to gluecron.com/you/your-repo</span>
            </div>
            <div class="landing-term-line">
              <span class="landing-term-ok">{"✓"}</span>
              <span>GateTest passed (12 rules, 0 violations)</span>
            </div>
            <div class="landing-term-line">
              <span class="landing-term-ok">{"✓"}</span>
              <span>deployed to your-repo.gluecron.com</span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
};

// Backwards-compatible default — web.tsx imports `LandingPage`.
export const LandingPage: FC<LandingPageProps> = (props) => (
  <LandingHero {...props} />
);

export default LandingPage;

const landingCss = `
  /* ---------- Root + fade-in ---------- */
  .landing-root {
    position: relative;
    max-width: 1080px;
    margin: 0 auto;
    padding: 0 16px;
    opacity: 0;
    animation: landingFadeUp 600ms var(--ease, cubic-bezier(0.2, 0.8, 0.2, 1)) forwards;
    overflow: hidden;
  }
  @keyframes landingFadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Background radial gradient blob — sits behind everything */
  .landing-blob {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: radial-gradient(circle at 50% 30%, rgba(168, 85, 247, 0.15), transparent 50%);
  }
  .landing-root > section { position: relative; z-index: 1; }

  /* ---------- Hero ---------- */
  .landing-hero {
    padding-top: var(--s-16, 96px);
    padding-bottom: var(--s-12, 64px);
    text-align: center;
    max-width: 820px;
    margin: 0 auto;
  }
  .landing-hero-title {
    font-size: clamp(40px, 7vw, 68px);
    line-height: 1.05;
    letter-spacing: -0.02em;
    font-weight: 600;
    margin: 0 0 var(--s-4, 20px);
    color: var(--text);
  }
  .landing-hero-grad {
    background: var(--accent-gradient, linear-gradient(135deg, #a855f7 0%, #6366f1 50%, #3b82f6 100%));
    -webkit-background-clip: text;
            background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .landing-hero-sub {
    font-size: var(--t-md, 17px);
    color: var(--text-muted);
    max-width: 640px;
    margin: var(--s-4, 20px) auto 0;
    line-height: 1.55;
  }

  .landing-hero-ctas {
    display: flex;
    gap: var(--s-3, 12px);
    justify-content: center;
    flex-wrap: wrap;
    margin-top: var(--s-8, 36px);
  }
  /* btn-lg fallback in case Agent B hasn't shipped it yet */
  .btn-lg, .landing-cta-primary, .landing-cta-secondary {
    padding: 12px 22px;
    font-size: 15px;
    font-weight: 600;
    border-radius: var(--r, 8px);
  }
  /* btn-ghost fallback */
  .landing-cta-secondary.btn-ghost,
  .btn-ghost {
    background: transparent;
    border-color: var(--border);
    color: var(--text);
  }
  .btn-ghost:hover { background: var(--bg-secondary); }
  .landing-cta-primary { display: inline-flex; align-items: center; gap: 8px; }
  .landing-cta-arrow { transition: transform var(--t-fast, 120ms) var(--ease, ease); display: inline-block; }
  .landing-cta-primary:hover .landing-cta-arrow { transform: translateX(3px); }

  .landing-hero-caption {
    margin-top: var(--s-6, 24px);
    font-size: var(--t-sm, 13px);
    color: var(--text-muted);
  }
  .landing-kbd {
    display: inline-block;
    padding: 2px 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-surface, var(--bg-tertiary));
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: var(--r-sm, 4px);
    color: var(--text);
    line-height: 1;
    vertical-align: middle;
  }
  .landing-kbd-sep { display: inline-block; width: 4px; }

  .landing-stats {
    margin-top: var(--s-6, 24px);
    font-size: 14px;
    color: var(--text-muted);
  }
  .landing-stats strong { color: var(--text); font-weight: 600; }
  .landing-stats-sep { opacity: 0.5; }

  /* ---------- Feature grid ---------- */
  .landing-features {
    margin-top: var(--s-12, 64px);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--s-4, 20px);
    max-width: 980px;
    margin-left: auto;
    margin-right: auto;
  }
  .landing-feature {
    background: var(--bg-elevated, var(--bg-secondary));
    border: 1px solid var(--border);
    border-radius: var(--r-lg, 10px);
    padding: var(--s-6, 24px);
    transition: transform var(--t-base, 180ms) var(--ease, ease),
                border-color var(--t-base, 180ms) var(--ease, ease),
                box-shadow var(--t-base, 180ms) var(--ease, ease);
  }
  .landing-feature:hover {
    transform: translateY(-2px);
    border-color: var(--accent, #1f6feb);
    box-shadow: var(--elev-2, 0 6px 20px rgba(0,0,0,0.25));
  }
  .landing-feature-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border-radius: var(--r, 8px);
    background: var(--accent-gradient-soft, rgba(99, 102, 241, 0.12));
    color: var(--accent, #818cf8);
    margin-bottom: var(--s-3, 14px);
  }
  .landing-feature-title {
    font-size: var(--t-lg, 17px);
    font-weight: 500;
    margin: 0 0 var(--s-2, 8px);
    color: var(--text);
    letter-spacing: -0.005em;
  }
  .landing-feature-desc {
    font-size: var(--t-sm, 13px);
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }

  /* ---------- Terminal block ---------- */
  .landing-terminal-wrap {
    margin-top: var(--s-12, 64px);
    margin-bottom: var(--s-16, 96px);
    display: flex;
    justify-content: center;
  }
  .landing-terminal {
    width: 100%;
    max-width: 720px;
    background: var(--bg-surface, var(--bg-secondary));
    border: 1px solid var(--border);
    border-radius: var(--r-lg, 10px);
    padding: var(--s-6, 24px);
    font-family: var(--font-mono);
    font-size: var(--t-sm, 13px);
    line-height: 1.7;
    box-shadow: var(--elev-1, 0 2px 8px rgba(0,0,0,0.15));
    text-align: left;
  }
  .landing-term-line {
    display: flex;
    gap: 10px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .landing-term-prompt {
    color: var(--text-faint, var(--text-muted));
    user-select: none;
    flex-shrink: 0;
  }
  .landing-term-ok {
    color: var(--green, #3fb950);
    user-select: none;
    flex-shrink: 0;
  }

  /* ---------- Responsive ---------- */
  @media (max-width: 768px) {
    .landing-hero { padding-top: var(--s-12, 56px); padding-bottom: var(--s-8, 36px); }
    .landing-hero-title { font-size: clamp(34px, 9vw, 44px); }
    .landing-hero-sub { font-size: 15px; }
    .landing-features {
      grid-template-columns: 1fr;
      margin-top: var(--s-10, 48px);
    }
    .landing-terminal-wrap {
      margin-top: var(--s-10, 48px);
      margin-bottom: var(--s-12, 64px);
    }
    .landing-terminal {
      font-size: 12px;
      padding: 16px;
    }
    .landing-hero-ctas { gap: 10px; }
    .landing-cta-primary, .landing-cta-secondary { width: 100%; justify-content: center; }
  }
`;
