/**
 * Developer Program page — /developer-program
 *
 * "Build on Gluecron. Earn revenue."
 * Three sections: Publish an agent · Revenue share · Partner badge.
 * CTA: partner application form (logs for now; no DB write required).
 *
 * Pure server-rendered. Dark theme. No new dependencies.
 * All CSS scoped under .devprog-* to avoid leaking into app views.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const developerProgram = new Hono<AuthEnv>();

developerProgram.use("*", softAuth);

// ─── Page-scoped styles ───────────────────────────────────────────────────────
const devprogCss = `
  .devprog-wrap { max-width: 1060px; margin: 0 auto; padding: 0 24px 80px; }

  /* ─── Hero ─── */
  .devprog-hero {
    position: relative;
    margin: 4px 0 48px;
    padding: 64px 48px 56px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    text-align: center;
  }
  .devprog-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.85;
    pointer-events: none;
  }
  .devprog-hero-bg {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 500px; height: 500px;
    pointer-events: none;
    z-index: 0;
  }
  .devprog-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.24), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(90px);
    opacity: 0.7;
    animation: devprogOrbDrift 14s ease-in-out infinite;
  }
  .devprog-hero-orb-2 {
    position: absolute;
    inset: auto auto -20% -12%;
    width: 340px; height: 340px;
    background: radial-gradient(circle, rgba(54,197,214,0.18), rgba(140,109,255,0.06) 50%, transparent 75%);
    filter: blur(70px);
    opacity: 0.5;
    pointer-events: none;
    z-index: 0;
    animation: devprogOrbDrift2 18s ease-in-out infinite;
  }
  @keyframes devprogOrbDrift {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.10) translate(-12px, 10px); opacity: 0.88; }
  }
  @keyframes devprogOrbDrift2 {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.40; }
    50%      { transform: scale(1.08) translate(14px, -8px); opacity: 0.65; }
  }
  @media (prefers-reduced-motion: reduce) {
    .devprog-hero-orb, .devprog-hero-orb-2 { animation: none; }
  }
  .devprog-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
  }
  .devprog-hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .devprog-hero-eyebrow-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px rgba(140,109,255,0.7);
  }
  .devprog-hero-title {
    font-family: var(--font-display);
    font-size: clamp(36px, 5.5vw, 68px);
    font-weight: 800;
    letter-spacing: -0.036em;
    line-height: 0.96;
    color: var(--text-strong);
    max-width: 780px;
    margin: 0;
  }
  .devprog-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .devprog-hero-sub {
    font-size: 17px;
    color: var(--text-muted);
    line-height: 1.6;
    max-width: 560px;
    margin: 0;
  }
  .devprog-hero-ctas {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 8px;
  }

  /* ─── Section cards (the three value props) ─── */
  .devprog-sections {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 20px;
    margin-bottom: 48px;
  }
  .devprog-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px 28px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: hidden;
    transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
  }
  .devprog-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0;
    transition: opacity 180ms ease;
    pointer-events: none;
  }
  .devprog-card:hover {
    border-color: rgba(140,109,255,0.40);
    box-shadow: 0 14px 32px -16px rgba(0,0,0,0.55), 0 0 24px -8px rgba(140,109,255,0.18);
    transform: translateY(-2px);
  }
  .devprog-card:hover::before { opacity: 0.85; }
  .devprog-card-icon {
    width: 44px; height: 44px;
    border-radius: 12px;
    background: var(--accent-gradient-soft, rgba(140,109,255,0.12));
    border: 1px solid rgba(140,109,255,0.22);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    flex-shrink: 0;
  }
  .devprog-card-eyebrow {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .devprog-card-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0;
    line-height: 1.2;
  }
  .devprog-card-body {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
    flex: 1;
  }
  .devprog-card-link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-link);
    text-decoration: none;
    transition: color 120ms ease, gap 120ms ease;
    margin-top: 4px;
  }
  .devprog-card-link:hover {
    color: var(--accent-hover);
    gap: 8px;
    text-decoration: none;
  }

  /* ─── Revenue highlight strip ─── */
  .devprog-revenue-strip {
    display: flex;
    gap: 0;
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: 48px;
    background: var(--bg-elevated);
  }
  .devprog-revenue-pct {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 28px 36px;
    flex: 0 0 auto;
    border-right: 1px solid var(--border);
  }
  .devprog-revenue-num {
    font-family: var(--font-display);
    font-size: 52px;
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
    background-image: linear-gradient(135deg, #a48bff 0%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .devprog-revenue-label {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
    text-align: center;
  }
  .devprog-revenue-body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 28px 32px;
    gap: 8px;
  }
  .devprog-revenue-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0;
  }
  .devprog-revenue-desc {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
    max-width: 520px;
  }

  /* ─── Application form card ─── */
  .devprog-apply {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 44px 48px;
    position: relative;
    overflow: hidden;
  }
  .devprog-apply::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .devprog-apply-inner { max-width: 640px; }
  .devprog-apply-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 12px;
  }
  .devprog-apply-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.5vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    color: var(--text-strong);
    margin: 0 0 10px;
  }
  .devprog-apply-sub {
    font-size: 15px;
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0 0 28px;
  }
  .devprog-form { display: flex; flex-direction: column; gap: 16px; }
  .devprog-field { display: flex; flex-direction: column; gap: 6px; }
  .devprog-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.008em;
  }
  .devprog-input,
  .devprog-textarea {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: 9px 12px;
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--text);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    width: 100%;
  }
  .devprog-input::placeholder,
  .devprog-textarea::placeholder { color: var(--text-faint); }
  .devprog-input:focus,
  .devprog-textarea:focus {
    outline: none;
    border-color: var(--border-focus);
    box-shadow: var(--ring);
  }
  .devprog-textarea { resize: vertical; min-height: 90px; }
  .devprog-form-actions {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .devprog-form-note {
    font-size: 12.5px;
    color: var(--text-faint);
    line-height: 1.5;
  }
  .devprog-success {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    background: rgba(52,211,153,0.06);
    border: 1px solid rgba(52,211,153,0.28);
    border-radius: 12px;
    padding: 18px 20px;
    font-size: 14.5px;
    color: var(--text-strong);
    line-height: 1.55;
  }
  .devprog-success-icon {
    width: 24px; height: 24px;
    border-radius: 50%;
    background: rgba(52,211,153,0.15);
    border: 1px solid rgba(52,211,153,0.35);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    flex-shrink: 0;
    color: #34d399;
  }

  /* ─── Docs link strip ─── */
  .devprog-docs-strip {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    margin-top: 28px;
    font-size: 14px;
  }
  .devprog-docs-strip-icon { color: var(--accent); flex-shrink: 0; }
  .devprog-docs-strip-text { flex: 1; color: var(--text-muted); }
  .devprog-docs-strip-link {
    font-weight: 600;
    color: var(--text-link);
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .devprog-hero { padding: 40px 24px 36px; }
    .devprog-apply { padding: 32px 24px; }
    .devprog-revenue-strip { flex-direction: column; }
    .devprog-revenue-pct { border-right: none; border-bottom: 1px solid var(--border); }
  }
`;

// ─── Route: GET /developer-program ───────────────────────────────────────────
developerProgram.get("/developer-program", (c) => {
  const user = c.get("user");
  const applied = c.req.query("applied") === "1";

  return c.html(
    <Layout
      title="Developer Program"
      user={user}
      description="Build AI agents on Gluecron, list them in the marketplace, and keep 70% of every sale. Apply for the partner program today."
    >
      <style dangerouslySetInnerHTML={{ __html: devprogCss }} />
      <div class="devprog-wrap">

        {/* ── Hero ── */}
        <section class="devprog-hero" aria-labelledby="devprog-hero-h">
          <div class="devprog-hero-bg" aria-hidden="true">
            <div class="devprog-hero-orb" />
            <div class="devprog-hero-orb-2" />
          </div>
          <div class="devprog-hero-inner">
            <div class="devprog-hero-eyebrow">
              <span class="devprog-hero-eyebrow-dot" aria-hidden="true" />
              Gluecron Developer Program
            </div>
            <h1 id="devprog-hero-h" class="devprog-hero-title">
              Build on Gluecron.{" "}
              <span class="gradient-text">Earn revenue.</span>
            </h1>
            <p class="devprog-hero-sub">
              List your AI agent in the Gluecron marketplace. Set your price. Ship
              to thousands of developer teams already using Gluecron for their daily
              workflow.
            </p>
            <div class="devprog-hero-ctas">
              <a href="#apply" class="btn btn-primary btn-xl">
                Apply for partner status
                <span aria-hidden="true">{" →"}</span>
              </a>
              <a href="/help#agents" class="btn btn-secondary btn-xl">
                Read the docs
              </a>
            </div>
          </div>
        </section>

        {/* ── Three sections ── */}
        <div class="devprog-sections">
          {/* 1 — Publish an agent */}
          <div class="devprog-card">
            <div class="devprog-card-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2l2.39 5.95L20 9l-4.5 3.9L17 19l-5-3.2L7 19l1.5-6.1L4 9l5.61-1.05L12 2z" />
              </svg>
            </div>
            <div class="devprog-card-eyebrow">Step 1</div>
            <h2 class="devprog-card-title">Publish an agent</h2>
            <p class="devprog-card-body">
              List your AI agent in the Gluecron marketplace. Set your price.
              Gluecron takes 30% — you keep 70%. Your agent is discoverable
              by every developer on the platform the moment it's approved.
            </p>
            <a href="/marketplace/agents/new" class="devprog-card-link">
              Publish your first agent
              <span aria-hidden="true">→</span>
            </a>
          </div>

          {/* 2 — Revenue share */}
          <div class="devprog-card">
            <div class="devprog-card-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </div>
            <div class="devprog-card-eyebrow">How you earn</div>
            <h2 class="devprog-card-title">Revenue share</h2>
            <p class="devprog-card-body">
              The 30% platform cut is already in the schema. When your agent is
              installed by a team, you earn automatically — no invoicing, no
              chasing payments. Payouts go out monthly to your connected account.
            </p>
            <a href="/help#agents" class="devprog-card-link">
              See payout docs
              <span aria-hidden="true">→</span>
            </a>
          </div>

          {/* 3 — Partner badge */}
          <div class="devprog-card">
            <div class="devprog-card-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2.5l8 3.5v6c0 5-3.5 8.5-8 9.5-4.5-1-8-4.5-8-9.5v-6z" />
                <path d="M9 12l2 2 4-4" />
              </svg>
            </div>
            <div class="devprog-card-eyebrow">Verified status</div>
            <h2 class="devprog-card-title">gluecron-partner badge</h2>
            <p class="devprog-card-body">
              Verified partners get a badge on their profile and priority
              placement in the marketplace. The badge signals to buyers that
              your agent has been reviewed by the Gluecron team and meets our
              quality and security bar.
            </p>
            <a href="#apply" class="devprog-card-link">
              Apply now
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>

        {/* ── Revenue highlight strip ── */}
        <div class="devprog-revenue-strip" aria-label="Revenue split: you keep 70%">
          <div class="devprog-revenue-pct">
            <div class="devprog-revenue-num">70%</div>
            <div class="devprog-revenue-label">you keep</div>
          </div>
          <div class="devprog-revenue-body">
            <h2 class="devprog-revenue-title">The math is simple.</h2>
            <p class="devprog-revenue-desc">
              Gluecron takes 30% to cover infrastructure, payments, and
              marketplace distribution. You keep 70% of every subscription or
              one-time purchase — no hidden fees, no surprise deductions. The
              split is encoded in the platform schema and applied automatically
              at payout time.
            </p>
          </div>
        </div>

        {/* ── Application form ── */}
        <section id="apply" class="devprog-apply" aria-labelledby="devprog-apply-h">
          <div class="devprog-apply-inner">
            <div class="devprog-apply-eyebrow">Partner application</div>
            <h2 id="devprog-apply-h" class="devprog-apply-title">
              Apply for partner status
            </h2>
            <p class="devprog-apply-sub">
              Tell us about the agent you're building. We review every
              application within 5 business days and reply to the email on your
              Gluecron account.
            </p>

            {applied ? (
              <div class="devprog-success" role="alert">
                <div class="devprog-success-icon" aria-hidden="true">✓</div>
                <div>
                  <strong>Application received.</strong> We'll review your
                  submission and reply within 5 business days. Keep building!
                </div>
              </div>
            ) : (
              <form
                method="post"
                action="/developer-program"
                class="devprog-form"
              >
                <div class="devprog-field">
                  <label class="devprog-label" for="dp-agent-name">
                    Agent name
                  </label>
                  <input
                    id="dp-agent-name"
                    name="agent_name"
                    type="text"
                    class="devprog-input"
                    placeholder="e.g. PR Summarizer Pro"
                    required
                    maxlength={120}
                  />
                </div>
                <div class="devprog-field">
                  <label class="devprog-label" for="dp-agent-desc">
                    What does it do?
                  </label>
                  <textarea
                    id="dp-agent-desc"
                    name="agent_description"
                    class="devprog-textarea"
                    placeholder="Describe your agent in 2–4 sentences. What problem does it solve? Who is it for?"
                    required
                    maxlength={800}
                  />
                </div>
                <div class="devprog-field">
                  <label class="devprog-label" for="dp-pricing">
                    Pricing model
                  </label>
                  <input
                    id="dp-pricing"
                    name="pricing_model"
                    type="text"
                    class="devprog-input"
                    placeholder='e.g. "$9/mo per seat" or "one-time $49"'
                    maxlength={120}
                  />
                </div>
                <div class="devprog-field">
                  <label class="devprog-label" for="dp-repo">
                    Gluecron repo or demo URL
                  </label>
                  <input
                    id="dp-repo"
                    name="repo_url"
                    type="url"
                    class="devprog-input"
                    placeholder="https://gluecron.com/you/your-agent"
                  />
                </div>
                <div class="devprog-form-actions">
                  <button type="submit" class="btn btn-primary">
                    Submit application
                  </button>
                  <p class="devprog-form-note">
                    We'll reply to the email on your Gluecron account.
                    Applications are reviewed manually — no bots.
                  </p>
                </div>
              </form>
            )}

            {/* Docs link */}
            <div class="devprog-docs-strip" role="complementary">
              <svg class="devprog-docs-strip-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <span class="devprog-docs-strip-text">
                Want to start building before applying?
              </span>
              <a href="/help#agents" class="devprog-docs-strip-link">
                Read the agent publishing docs →
              </a>
            </div>
          </div>
        </section>

      </div>
    </Layout>
  );
});

// ─── Route: POST /developer-program ──────────────────────────────────────────
// Logs the application for now. Future: insert into partner_applications table.
developerProgram.post("/developer-program", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();

  // Log the application so it's visible in server output / observability
  console.log("[developer-program] partner application received", {
    userId: user?.id ?? null,
    username: user?.username ?? null,
    agentName: body["agent_name"],
    pricingModel: body["pricing_model"],
    repoUrl: body["repo_url"],
    // description intentionally omitted from log to keep it brief
    at: new Date().toISOString(),
  });

  return c.redirect("/developer-program?applied=1");
});

export default developerProgram;
