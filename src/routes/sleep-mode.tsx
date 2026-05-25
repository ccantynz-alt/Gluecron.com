/**
 * Block L1 — Sleep Mode marketing page.
 *
 * Public, no auth. Pitch: "Toggle Sleep Mode. Walk away. Wake up to a
 * digest of what Claude shipped overnight." Status card surfaces the
 * viewer's own toggle (Active / Inactive) when signed in, a config card
 * mirrors the upcoming threshold form fields, an excluded-repos section
 * card stubs the per-repo opt-out list, and a sample digest renders from
 * a synthetic `SleepModeReport`.
 *
 * The form/card UIs are read-only previews — the real mutation lives in
 * `/settings`. We render them here so the marketing page mirrors the
 * shape an operator will see once they enable the feature. CSS scoped
 * under `.sleep-` so it can't bleed into other surfaces.
 */

import { Hono } from "hono";
import { raw } from "hono/html";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  renderSleepModeDigest,
  type SleepModeReport,
} from "../lib/sleep-mode";

const sleepMode = new Hono<AuthEnv>();
sleepMode.use("*", softAuth);

/** A synthetic, on-brand report used to render the sample digest screenshot. */
const SAMPLE_REPORT: SleepModeReport = {
  windowHours: 24,
  prsAutoMerged: [
    { number: 412, title: "Bump axios to 1.7.4", repo: "api-gateway" },
    { number: 88, title: "Fix flaky retry test", repo: "billing" },
    { number: 134, title: "Cache stage results", repo: "workflow-runner" },
  ],
  issuesBuiltByAi: [
    {
      number: 207,
      title: "Add /metrics endpoint with Prometheus format",
      repo: "api-gateway",
      prNumber: 413,
    },
    {
      number: 56,
      title: "Dark-mode toggle in admin nav",
      repo: "dashboard",
      prNumber: 89,
    },
  ],
  aiReviewsPosted: 14,
  securityIssuesAutoFixed: 2,
  gateFailuresAutoRepaired: 5,
  hoursSaved: 7.4,
};

sleepMode.get("/sleep-mode", (c) => {
  const user = c.get("user");
  const sample = renderSleepModeDigest(SAMPLE_REPORT, {
    username: user?.username || "you",
  });

  // Viewer is treated as "Inactive" by default — the real status lives on
  // the per-user row in /settings. The card is a marketing preview only;
  // signed-in visitors see a personalised "Inactive — turn it on" CTA.
  const isActive = false;

  return c.html(
    <Layout title="Sleep Mode — gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div class="sleep-wrap">
        <section class="sleep-hero">
          <div class="sleep-hero-orb" aria-hidden="true" />
          <div class="sleep-hero-inner">
            <div class="sleep-eyebrow">
              <span class="sleep-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              </span>
              Sleep Mode · overnight autopilot
            </div>
            <h1 class="sleep-title">
              Toggle Sleep Mode. Walk away.{" "}
              <span class="sleep-title-grad">Wake up to a digest.</span>
            </h1>
            <p class="sleep-sub">
              Claude keeps your repos shipping while you sleep — auto-merging
              green PRs, building features from <code>ai:build</code> issues,
              reviewing code, and quietly fixing the gates that fail. One
              email lands at the UTC hour you pick.
            </p>
            <div class="sleep-hero-cta">
              <a href="/settings" class="sleep-btn sleep-btn-primary">
                Enable Sleep Mode in Settings <span aria-hidden="true">→</span>
              </a>
              <a
                href="/settings/sleep-mode/preview"
                class="sleep-btn"
              >
                Preview your digest
              </a>
            </div>
          </div>
        </section>

        {/* ─── Status card — Active / Inactive ─── */}
        <section
          class={"sleep-status-card " + (isActive ? "is-active" : "is-inactive")}
          aria-labelledby="sleep-status-title"
        >
          <div class="sleep-status-left">
            <span class="sleep-status-dot" aria-hidden="true" />
            <div>
              <p class="sleep-status-title" id="sleep-status-title">
                Sleep Mode is{" "}
                <strong>{isActive ? "Active" : "Inactive"}</strong>
                {user ? <> for {user.username}</> : null}
              </p>
              <p class="sleep-status-sub">
                {isActive
                  ? "The autopilot will email your digest at the next configured hour."
                  : user
                    ? "Turn it on in Settings and pick a UTC hour. Defaults are safe."
                    : "Sign in to flip the toggle for your account."}
              </p>
            </div>
          </div>
          <div class="sleep-status-actions">
            {user ? (
              <a href="/settings#sleep-mode" class="sleep-btn sleep-btn-primary">
                {isActive ? "Manage" : "Turn on"}
              </a>
            ) : (
              <a href="/login?next=/settings" class="sleep-btn sleep-btn-primary">
                Sign in
              </a>
            )}
          </div>
        </section>

        {/* ─── How it works — three steps ─── */}
        <section class="sleep-section" aria-labelledby="sleep-steps-h">
          <header class="sleep-section-head">
            <div>
              <p class="sleep-section-eyebrow">How it works</p>
              <h2 class="sleep-section-title" id="sleep-steps-h">
                Three steps. Then forget about it.
              </h2>
            </div>
          </header>
          <div class="sleep-section-body">
            <div class="sleep-steps">
              <article class="sleep-step">
                <div class="sleep-step-num">1</div>
                <h3 class="sleep-step-title">Flip the toggle</h3>
                <p class="sleep-step-body">
                  A single checkbox in <a href="/settings">/settings</a>.
                  Pick the UTC hour you want the digest to land — default
                  is 9 AM.
                </p>
              </article>
              <article class="sleep-step">
                <div class="sleep-step-num">2</div>
                <h3 class="sleep-step-title">Claude works the night shift</h3>
                <p class="sleep-step-body">
                  The autopilot sweeps every 5 minutes. Green PRs get
                  auto-merged. <code>ai:build</code> issues become PRs.
                  Gate failures get auto-repaired. Security findings get
                  patched.
                </p>
              </article>
              <article class="sleep-step">
                <div class="sleep-step-num">3</div>
                <h3 class="sleep-step-title">Wake up to a digest</h3>
                <p class="sleep-step-body">
                  One email. Subject line tells you everything: "while you
                  slept, Claude shipped <em>N</em> things". Headlines,
                  links, and an estimate of hours saved.
                </p>
              </article>
            </div>
          </div>
        </section>

        {/* ─── Threshold form (preview) ─── */}
        <section class="sleep-section" aria-labelledby="sleep-thresholds-h">
          <header class="sleep-section-head">
            <div>
              <p class="sleep-section-eyebrow">Thresholds</p>
              <h2 class="sleep-section-title" id="sleep-thresholds-h">
                Conservative defaults you can tighten.
              </h2>
              <p class="sleep-section-sub">
                Preview of the form rendered in <code>/settings</code>. Mutations
                live there — this card is read-only.
              </p>
            </div>
          </header>
          <div class="sleep-section-body">
            <div class="sleep-form" aria-disabled="true">
              <div class="sleep-field">
                <label class="sleep-field-label" for="sleep-hour">
                  Digest delivery hour <span class="sleep-field-hint">UTC, 0–23</span>
                </label>
                <input
                  id="sleep-hour"
                  class="sleep-input"
                  type="number"
                  min={0}
                  max={23}
                  value={9}
                  disabled
                />
              </div>
              <div class="sleep-field">
                <label class="sleep-field-label" for="sleep-max-merges">
                  Max auto-merges per night <span class="sleep-field-hint">soft cap</span>
                </label>
                <input
                  id="sleep-max-merges"
                  class="sleep-input"
                  type="number"
                  min={1}
                  max={500}
                  value={25}
                  disabled
                />
              </div>
              <div class="sleep-field">
                <label class="sleep-field-label" for="sleep-max-builds">
                  Max AI builds per night <span class="sleep-field-hint">issue → PR</span>
                </label>
                <input
                  id="sleep-max-builds"
                  class="sleep-input"
                  type="number"
                  min={0}
                  max={100}
                  value={10}
                  disabled
                />
              </div>
              <div class="sleep-field sleep-field-wide">
                <label class="sleep-field-label" for="sleep-min-checks">
                  Required green checks before auto-merge
                </label>
                <input
                  id="sleep-min-checks"
                  class="sleep-input"
                  type="text"
                  value="ci,gate,build"
                  disabled
                />
                <p class="sleep-field-help">
                  Comma-separated check names. PRs are only merged once
                  every listed check is green.
                </p>
              </div>
            </div>
          </div>
          <footer class="sleep-section-foot">
            <span class="sleep-foot-hint">
              Edit on <a href="/settings#sleep-mode">/settings</a>.
            </span>
          </footer>
        </section>

        {/* ─── Excluded repos ─── */}
        <section class="sleep-section" aria-labelledby="sleep-excluded-h">
          <header class="sleep-section-head">
            <div>
              <p class="sleep-section-eyebrow">Excluded repos</p>
              <h2 class="sleep-section-title" id="sleep-excluded-h">
                Skip the riskiest projects.
              </h2>
              <p class="sleep-section-sub">
                Sleep Mode will never touch a repo on this list. Add the
                ones with manual-only release workflows.
              </p>
            </div>
          </header>
          <div class="sleep-section-body">
            <div class="sleep-empty">
              <div class="sleep-empty-orb" aria-hidden="true" />
              <div class="sleep-empty-inner">
                <p class="sleep-empty-title">No excluded repos yet.</p>
                <p class="sleep-empty-sub">
                  When Sleep Mode is on, every repo you own is eligible.
                  Add one here to opt it out. Manage the list from{" "}
                  <a href="/settings#sleep-mode-excluded">Settings</a>.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Sample digest ─── */}
        <section class="sleep-section" aria-labelledby="sleep-sample-h">
          <header class="sleep-section-head">
            <div>
              <p class="sleep-section-eyebrow">Sample digest</p>
              <h2 class="sleep-section-title" id="sleep-sample-h">
                Here's what lands in your inbox.
              </h2>
              <p class="sleep-section-sub">
                A real Sleep Mode digest, rendered from a synthetic report
                so you can see the shape before you turn it on.
              </p>
            </div>
          </header>
          <div class="sleep-section-body">
            <div class="sleep-sample">
              <div class="sleep-sample-frame">
                <div class="sleep-sample-meta">
                  <span class="sleep-sample-from">no-reply@gluecron.app</span>
                  <span class="sleep-sample-subject">{sample.subject}</span>
                </div>
                <div class="sleep-sample-body">{raw(sample.html)}</div>
              </div>
            </div>
          </div>
        </section>

        <section class="sleep-cta">
          <h2 class="sleep-cta-title">Ready to walk away?</h2>
          <p class="sleep-cta-sub">
            Sleep Mode is on-by-default safe — it can't merge anything
            that wouldn't pass your branch protection rules. Turn it on,
            sleep well.
          </p>
          <a href="/settings" class="sleep-btn sleep-btn-primary sleep-btn-lg">
            Enable Sleep Mode <span aria-hidden="true">→</span>
          </a>
        </section>
      </div>
    </Layout>
  );
});

const pageCss = `
  .sleep-wrap { max-width: 1080px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .sleep-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-6) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .sleep-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .sleep-hero-orb {
    position: absolute;
    inset: -25% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .sleep-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .sleep-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .sleep-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .sleep-title {
    font-size: clamp(32px, 5vw, 52px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .sleep-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .sleep-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.55;
    max-width: 640px;
  }
  .sleep-sub code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .sleep-hero-cta { display: flex; gap: 10px; flex-wrap: wrap; }

  /* ─── Buttons ─── */
  .sleep-btn {
    appearance: none;
    border: 1px solid var(--border-strong);
    background: var(--bg-secondary);
    color: var(--text);
    padding: 10px 16px;
    border-radius: 10px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .sleep-btn:hover {
    border-color: var(--border-focus);
    background: rgba(255,255,255,0.03);
    transform: translateY(-1px);
    text-decoration: none;
  }
  .sleep-btn-primary {
    border-color: rgba(140,109,255,0.45);
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: var(--text-strong);
  }
  .sleep-btn-primary:hover {
    border-color: rgba(140,109,255,0.65);
    background: linear-gradient(135deg, rgba(140,109,255,0.28), rgba(54,197,214,0.20));
  }
  .sleep-btn-lg { padding: 12px 20px; font-size: 15px; }

  /* ─── Status card ─── */
  .sleep-status-card {
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .sleep-status-left {
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 1;
    min-width: 240px;
  }
  .sleep-status-dot {
    width: 12px; height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-faint);
  }
  .sleep-status-card.is-active .sleep-status-dot {
    background: #3fb950;
    box-shadow: 0 0 0 4px rgba(63,185,80,0.18);
  }
  .sleep-status-card.is-inactive .sleep-status-dot {
    background: #6e7681;
    box-shadow: 0 0 0 4px rgba(110,118,129,0.14);
  }
  .sleep-status-title {
    margin: 0;
    font-size: 14.5px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .sleep-status-title strong {
    color: var(--text-strong);
    font-weight: 700;
  }
  .sleep-status-card.is-active .sleep-status-title strong { color: #6ee7b7; }
  .sleep-status-card.is-inactive .sleep-status-title strong { color: var(--text-muted); }
  .sleep-status-sub {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .sleep-status-actions { flex-shrink: 0; }

  /* ─── Section cards ─── */
  .sleep-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .sleep-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .sleep-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 0 0 6px;
  }
  .sleep-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .sleep-section-sub {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .sleep-section-sub code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .sleep-section-body { padding: var(--space-5); }
  .sleep-section-foot {
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--border);
    background: rgba(255,255,255,0.012);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .sleep-foot-hint a { color: var(--accent); text-decoration: none; }
  .sleep-foot-hint a:hover { text-decoration: underline; }

  /* ─── Steps ─── */
  .sleep-steps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-3);
  }
  .sleep-step {
    position: relative;
    padding: var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 150ms ease, transform 150ms ease;
  }
  .sleep-step:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }
  .sleep-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px; height: 30px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
  }
  .sleep-step-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .sleep-step-body {
    margin: 0;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .sleep-step-body code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .sleep-step-body a { color: var(--accent); text-decoration: none; }
  .sleep-step-body a:hover { text-decoration: underline; }

  /* ─── Form (preview) ─── */
  .sleep-form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-4);
  }
  .sleep-field { display: flex; flex-direction: column; gap: 6px; }
  .sleep-field-wide { grid-column: 1 / -1; }
  .sleep-field-label {
    font-family: var(--font-mono);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.005em;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .sleep-field-hint {
    font-family: var(--font-sans, inherit);
    font-size: 11px;
    color: var(--text-faint);
    text-transform: none;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .sleep-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
  }
  .sleep-input:disabled {
    opacity: 0.75;
    cursor: not-allowed;
  }
  .sleep-field-help {
    margin: 0;
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }

  /* ─── Empty state ─── */
  .sleep-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 14px;
    background: rgba(255,255,255,0.02);
    text-align: center;
    overflow: hidden;
  }
  .sleep-empty-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.55;
    pointer-events: none;
    z-index: 0;
  }
  .sleep-empty-inner { position: relative; z-index: 1; }
  .sleep-empty-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .sleep-empty-sub {
    margin: 0 auto;
    max-width: 460px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .sleep-empty-sub a { color: var(--accent); text-decoration: none; }
  .sleep-empty-sub a:hover { text-decoration: underline; }

  /* ─── Sample digest ─── */
  .sleep-sample { display: flex; justify-content: center; }
  .sleep-sample-frame {
    background: #fff;
    color: #111;
    border-radius: 12px;
    width: 100%;
    max-width: 720px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.25);
    overflow: hidden;
    border: 1px solid var(--border);
  }
  .sleep-sample-meta {
    background: #f6f7fb;
    padding: 12px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-bottom: 1px solid #e6e7ed;
    font-size: 13px;
    color: #4a4d59;
  }
  .sleep-sample-from { font-size: 12px; color: #8a8e9c; }
  .sleep-sample-subject { font-weight: 600; color: #0f1019; }
  .sleep-sample-body { background: #fff; }

  /* ─── CTA card ─── */
  .sleep-cta {
    margin-top: var(--space-6);
    padding: var(--space-6) var(--space-5);
    background: linear-gradient(135deg, rgba(140,109,255,0.14), rgba(54,197,214,0.08));
    border: 1px solid rgba(140,109,255,0.30);
    border-radius: 16px;
    text-align: center;
  }
  .sleep-cta-title {
    margin: 0 0 8px;
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 800;
    color: var(--text-strong);
    letter-spacing: -0.022em;
  }
  .sleep-cta-sub {
    max-width: 540px;
    margin: 0 auto var(--space-4);
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.55;
  }

  @media (max-width: 640px) {
    .sleep-status-card { flex-direction: column; align-items: flex-start; }
    .sleep-status-actions { width: 100%; }
    .sleep-status-actions .sleep-btn { width: 100%; justify-content: center; }
  }
`;

export default sleepMode;
