/**
 * Claude-deploy wizard — paste a Claude tool-use loop, get a hosted endpoint.
 *
 * Routes
 *   GET   /connect/claude/deploy             wizard + list of user's loops
 *   GET   /connect/claude/deploy/:id         loop detail (history, edit, danger)
 *   POST  /api/v2/claude-loops               create
 *   POST  /api/v2/claude-loops/:id/invoke    owner-side synchronous invoke
 *   POST  /api/v2/claude-loops/:id/pause     pause
 *   POST  /api/v2/claude-loops/:id/resume    resume
 *   DELETE /api/v2/claude-loops/:id          delete
 *   GET   /api/v2/claude-loops/:id/runs      run history
 *   POST  /loops/:slug/invoke                public sync invoke (when is_public)
 *
 * Hard rules
 *   - Do not modify shared layout/components/UI — CSS scoped to `.cldploy-*`.
 *   - Sandbox subprocess is wired in src/lib/hosted-claude-loop.ts; this file
 *     just renders the wizard and exposes the surface.
 */

import { Hono } from "hono";
import { db } from "../db";
import { hostedClaudeLoops } from "../db/schema";
import { eq } from "drizzle-orm";
import { Layout } from "../views/layout";
import { config } from "../lib/config";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  DEFAULT_LOOP_TEMPLATE,
  createLoop,
  deleteLoop,
  getLoop,
  getLoopByEndpointPath,
  invokeLoop,
  listLoopsForOwner,
  listRunsForLoop,
  pauseLoop,
  resumeLoop,
  updateLoop,
} from "../lib/hosted-claude-loop";
import { formatCents } from "../lib/ai-cost-tracker";

const claudeDeploy = new Hono<AuthEnv>();

// Wizard + detail pages require a logged-in user. Public /loops/:slug/invoke
// is intentionally NOT gated — anyone can hit it (the loop's `is_public`
// flag governs whether it actually runs).
claudeDeploy.use("/connect/claude/deploy", requireAuth);
claudeDeploy.use("/connect/claude/deploy/*", requireAuth);

// API endpoints: every /api/v2/claude-loops/* POST/DELETE goes through
// requireAuth so we get session cookies OR Bearer PATs.
claudeDeploy.use("/api/v2/claude-loops", requireAuth);
claudeDeploy.use("/api/v2/claude-loops/*", requireAuth);

// ---------------------------------------------------------------------------
// Tiny HTML escape — keeps `&` / `<` / `>` / `"` safe inside <pre> blocks.
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Budget plans surfaced in the wizard step 2.
// ---------------------------------------------------------------------------
const BUDGET_PLANS: Array<{
  cents: number;
  label: string;
  blurb: string;
}> = [
  { cents: 500, label: "$5 / month", blurb: "Trial — ~5k tokens/day" },
  { cents: 2500, label: "$25 / month", blurb: "Hobby — ~25k tokens/day" },
  { cents: 10000, label: "$100 / month", blurb: "Production — high volume" },
];

// ---------------------------------------------------------------------------
// CSS — scoped under .cldploy- prefix.
// ---------------------------------------------------------------------------
const styles = `
  .cldploy-container { max-width: 1320px; margin: 0 auto; padding: 0 0 var(--space-6); }

  /* ─── Hero ─── */
  .cldploy-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .cldploy-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #f78c4d 30%, #8c6dff 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .cldploy-hero-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(247,140,77,0.20), rgba(140,109,255,0.12) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.65;
    pointer-events: none;
    animation: cldployOrb 16s ease-in-out infinite;
  }
  @keyframes cldployOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-12px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cldploy-hero-orb { animation: none; }
  }
  .cldploy-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .cldploy-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
  }
  .cldploy-eyebrow strong { color: #f78c4d; font-weight: 700; }
  .cldploy-title {
    font-size: clamp(28px, 4.8vw, 44px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.04;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .cldploy-title .gradient {
    background-image: linear-gradient(135deg, #f78c4d 0%, #8c6dff 60%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .cldploy-sub {
    font-size: 16px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Section card ─── */
  .cldploy-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .cldploy-section-head {
    padding: var(--space-4) var(--space-5) var(--space-2);
  }
  .cldploy-step-row {
    display: flex; align-items: center; gap: 12px; margin-bottom: 6px;
  }
  .cldploy-step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(247,140,77,0.22), rgba(140,109,255,0.14));
    color: #ffc09f;
    border: 1px solid rgba(247,140,77,0.45);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
  }
  .cldploy-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    margin: 0;
  }
  .cldploy-section-desc {
    margin: 0;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.5;
  }
  .cldploy-section-body { padding: var(--space-2) var(--space-5) var(--space-5); }

  /* ─── Code editor (Step 1) ─── */
  .cldploy-editor-wrap {
    position: relative;
    margin-top: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    overflow: hidden;
    background: var(--bg-tertiary, #0b0e16);
  }
  .cldploy-editor-toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px;
    background: rgba(255,255,255,0.02);
    border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .cldploy-editor-toolbar .dot { width:10px; height:10px; border-radius:50%; background:#f78c4d; box-shadow:0 0 6px rgba(247,140,77,0.6); display:inline-block; margin-right:6px; }
  .cldploy-editor-body {
    display: grid;
    grid-template-columns: 56px 1fr;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.55;
  }
  .cldploy-editor-gutter {
    user-select: none;
    padding: 12px 8px 12px 12px;
    text-align: right;
    color: var(--text-faint);
    background: rgba(255,255,255,0.015);
    border-right: 1px solid var(--border-subtle);
    white-space: pre;
    overflow: hidden;
  }
  .cldploy-editor-textarea {
    width: 100%;
    min-height: 360px;
    padding: 12px 14px;
    color: var(--text-strong);
    background: transparent;
    border: 0;
    outline: 0;
    resize: vertical;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    tab-size: 2;
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
  }

  /* ─── Form bits ─── */
  .cldploy-field { margin-top: var(--space-3); }
  .cldploy-label {
    display: block;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 6px;
    font-weight: 500;
  }
  .cldploy-input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-strong);
    border-radius: 10px;
    font-family: inherit;
    font-size: 14px;
  }
  .cldploy-input:focus { border-color: var(--border-focus); outline: none; }

  .cldploy-plans {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-top: 10px;
  }
  .cldploy-plan {
    position: relative;
    padding: 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    cursor: pointer;
    transition: border-color 150ms ease, transform 150ms ease;
  }
  .cldploy-plan:hover { border-color: var(--border-strong); transform: translateY(-1px); }
  .cldploy-plan input { position: absolute; opacity: 0; pointer-events: none; }
  .cldploy-plan-label {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 16px;
    color: var(--text-strong);
  }
  .cldploy-plan-blurb {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .cldploy-plan input:checked ~ .cldploy-plan-label,
  .cldploy-plan:has(input:checked) {
    border-color: #f78c4d;
    background: linear-gradient(180deg, rgba(247,140,77,0.10), var(--bg-secondary) 70%);
  }

  /* ─── Buttons ─── */
  .cldploy-btn {
    appearance: none;
    border: 1px solid var(--border-strong);
    background: var(--bg-secondary);
    color: var(--text);
    padding: 10px 18px;
    border-radius: 10px;
    font-family: inherit;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
    text-decoration: none;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .cldploy-btn:hover { border-color: var(--border-focus); transform: translateY(-1px); }
  .cldploy-btn-primary {
    border-color: rgba(247,140,77,0.55);
    background: linear-gradient(135deg, rgba(247,140,77,0.22), rgba(140,109,255,0.14));
    color: var(--text-strong);
    font-weight: 600;
  }
  .cldploy-btn-primary:hover { border-color: rgba(247,140,77,0.75); }
  .cldploy-btn-danger {
    border-color: rgba(248,81,73,0.45);
    color: #f8c5c5;
  }
  .cldploy-btn-danger:hover { border-color: #f85149; color: #fff; background: rgba(248,81,73,0.12); }

  /* ─── Result panel (Step 3 / after create) ─── */
  .cldploy-result {
    margin-top: var(--space-3);
    padding: 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    display: none;
  }
  .cldploy-result.is-shown { display: block; }
  .cldploy-result-row { margin-bottom: 10px; }
  .cldploy-result-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-bottom: 4px;
  }
  .cldploy-code {
    background: var(--bg-tertiary, #0b0e16);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Loops list ─── */
  .cldploy-list { display: flex; flex-direction: column; gap: 10px; }
  .cldploy-row {
    display: grid;
    grid-template-columns: 1.4fr 0.7fr 0.7fr 0.7fr auto;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    transition: border-color 150ms ease;
  }
  .cldploy-row:hover { border-color: var(--border-strong); }
  .cldploy-row-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 15px;
    color: var(--text-strong);
    text-decoration: none;
  }
  .cldploy-row-name:hover { color: #f78c4d; }
  .cldploy-row-path {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .cldploy-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    border: 1px solid transparent;
  }
  .cldploy-pill.is-running { background: rgba(63,185,80,0.10); color: #4cce6a; border-color: rgba(63,185,80,0.30); }
  .cldploy-pill.is-paused  { background: rgba(140,109,255,0.10); color: #b5a4ff; border-color: rgba(140,109,255,0.30); }
  .cldploy-pill.is-errored { background: rgba(248,81,73,0.10); color: #ff7e76; border-color: rgba(248,81,73,0.30); }
  .cldploy-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

  .cldploy-empty {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 14px;
    background: var(--bg-secondary);
    border: 1px dashed var(--border-subtle);
    border-radius: 10px;
  }

  /* ─── Detail page ─── */
  .cldploy-meta {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-top: var(--space-3);
  }
  .cldploy-meta-cell {
    padding: 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }
  .cldploy-meta-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-faint); margin-bottom: 4px;
  }
  .cldploy-meta-value {
    font-family: var(--font-display); font-size: 18px; font-weight: 700;
    color: var(--text-strong);
  }

  .cldploy-run-list { display: flex; flex-direction: column; gap: 8px; margin-top: var(--space-3); }
  .cldploy-run {
    display: grid;
    grid-template-columns: 160px 120px 120px 1fr;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    font-size: 13px;
  }
  .cldploy-run-status { font-weight: 600; }
  .cldploy-run-status.ok { color: #4cce6a; }
  .cldploy-run-status.error { color: #ff7e76; }
  .cldploy-run-status.budget_exceeded { color: #ffc09f; }
  .cldploy-run-status.timeout { color: #f8c5c5; }
  .cldploy-run-time { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }

  @media (max-width: 720px) {
    .cldploy-row { grid-template-columns: 1fr; }
    .cldploy-run { grid-template-columns: 1fr; }
  }
`;

// ---------------------------------------------------------------------------
// Build a curl example showing how to invoke the loop.
// ---------------------------------------------------------------------------
function curlExample(host: string, endpointPath: string): string {
  return [
    `curl -X POST ${host}${endpointPath} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"repo":"ccantynz-alt/Gluecron.com"}'`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// GET /connect/claude/deploy — wizard + list
// ---------------------------------------------------------------------------
claudeDeploy.get("/connect/claude/deploy", async (c) => {
  const user = c.get("user")!;
  const loops = await listLoopsForOwner(user.id);
  const host = config.appBaseUrl || "https://gluecron.com";

  const templateLines = DEFAULT_LOOP_TEMPLATE.split("\n");
  const gutter = templateLines.map((_, i) => i + 1).join("\n");

  return c.html(
    <Layout title="Deploy Claude loop" user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="cldploy-container">
        {/* ─── Hero ─── */}
        <section class="cldploy-hero">
          <div class="cldploy-hero-orb" aria-hidden="true" />
          <div class="cldploy-hero-inner">
            <div class="cldploy-eyebrow">
              <strong>Claude · Hosted loops</strong> · @{user.username}
            </div>
            <h1 class="cldploy-title">
              Ship your Claude loop in <span class="gradient">30 seconds</span>.
            </h1>
            <p class="cldploy-sub">
              Paste a tool-use loop. We host the endpoint, run it on demand,
              meter your Claude spend against a monthly budget cap, and stream
              every invocation to a permanent run log. No infra to wire up.
            </p>
          </div>
        </section>

        {/* ─── Wizard form ─── */}
        <form id="cldploy-create" autocomplete="off">
          {/* Step 1 */}
          <section class="cldploy-section">
            <div class="cldploy-section-head">
              <div class="cldploy-step-row">
                <span class="cldploy-step-num">1</span>
                <h2 class="cldploy-section-title">Paste your code</h2>
              </div>
              <p class="cldploy-section-desc">
                A complete JavaScript / TypeScript snippet. The platform's{" "}
                <code>ANTHROPIC_API_KEY</code> is injected at runtime. Read the
                input payload from <code>process.env.INPUT</code>; print JSON
                to stdout — we record it as the run output.
              </p>
            </div>
            <div class="cldploy-section-body">
              <div class="cldploy-editor-wrap">
                <div class="cldploy-editor-toolbar">
                  <span><span class="dot" aria-hidden="true" />loop.mjs</span>
                  <span>Bun · 30s timeout · isolated subprocess</span>
                </div>
                <div class="cldploy-editor-body">
                  <pre
                    id="cldploy-gutter"
                    class="cldploy-editor-gutter"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: escapeHtml(gutter) }}
                  />
                  <textarea
                    id="cldploy-source"
                    name="sourceCode"
                    class="cldploy-editor-textarea"
                    spellcheck={false}
                    wrap="off"
                  >
                    {DEFAULT_LOOP_TEMPLATE}
                  </textarea>
                </div>
              </div>
            </div>
          </section>

          {/* Step 2 */}
          <section class="cldploy-section">
            <div class="cldploy-section-head">
              <div class="cldploy-step-row">
                <span class="cldploy-step-num">2</span>
                <h2 class="cldploy-section-title">Name it &amp; pick a budget</h2>
              </div>
              <p class="cldploy-section-desc">
                The name becomes part of the public URL. The budget caps your
                cumulative Claude spend — over-cap invocations return 402.
              </p>
            </div>
            <div class="cldploy-section-body">
              <div class="cldploy-field">
                <label class="cldploy-label" for="cldploy-name">Name</label>
                <input
                  id="cldploy-name"
                  class="cldploy-input"
                  type="text"
                  name="name"
                  placeholder="repo-summariser"
                  required
                  maxlength={80}
                />
              </div>
              <div class="cldploy-field">
                <label class="cldploy-label">Monthly budget cap</label>
                <div class="cldploy-plans">
                  {BUDGET_PLANS.map((p, i) => (
                    <label class="cldploy-plan">
                      <input
                        type="radio"
                        name="monthlyBudgetCents"
                        value={String(p.cents)}
                        checked={i === 0}
                      />
                      <div class="cldploy-plan-label">{p.label}</div>
                      <div class="cldploy-plan-blurb">{p.blurb}</div>
                    </label>
                  ))}
                </div>
              </div>
              <div class="cldploy-field">
                <label
                  style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text-muted)"
                >
                  <input type="checkbox" name="isPublic" value="1" />
                  Make endpoint public (anyone with the URL can invoke)
                </label>
              </div>
            </div>
          </section>

          {/* Step 3 */}
          <section class="cldploy-section">
            <div class="cldploy-section-head">
              <div class="cldploy-step-row">
                <span class="cldploy-step-num">3</span>
                <h2 class="cldploy-section-title">Deploy &amp; get your endpoint</h2>
              </div>
              <p class="cldploy-section-desc">
                One click. We mint an agent token, persist the snippet, and
                give you back a hosted URL plus a copy-pasteable curl.
              </p>
            </div>
            <div class="cldploy-section-body">
              <button
                id="cldploy-submit"
                type="submit"
                class="cldploy-btn cldploy-btn-primary"
              >
                Deploy loop
              </button>
              <div id="cldploy-result" class="cldploy-result">
                <div class="cldploy-result-row">
                  <div class="cldploy-result-label">Endpoint</div>
                  <pre class="cldploy-code" id="cldploy-endpoint" />
                </div>
                <div class="cldploy-result-row">
                  <div class="cldploy-result-label">curl example</div>
                  <pre class="cldploy-code" id="cldploy-curl" />
                </div>
                <div class="cldploy-result-row">
                  <div class="cldploy-result-label">Agent token (shown once)</div>
                  <pre class="cldploy-code" id="cldploy-token" />
                </div>
                <a
                  id="cldploy-detail-link"
                  href="#"
                  class="cldploy-btn cldploy-btn-primary"
                  style="margin-top:8px"
                >
                  Open loop dashboard →
                </a>
              </div>
            </div>
          </section>
        </form>

        {/* ─── Existing loops ─── */}
        <section class="cldploy-section">
          <div class="cldploy-section-head">
            <h2 class="cldploy-section-title">Your loops</h2>
            <p class="cldploy-section-desc">
              {loops.length === 0
                ? "Nothing deployed yet — ship your first loop above."
                : `${loops.length} loop${loops.length === 1 ? "" : "s"} hosted.`}
            </p>
          </div>
          <div class="cldploy-section-body">
            {loops.length === 0 ? (
              <div class="cldploy-empty">
                Your loops will appear here once you deploy.
              </div>
            ) : (
              <div class="cldploy-list">
                {loops.map((loop) => (
                  <div class="cldploy-row">
                    <div>
                      <a
                        href={`/connect/claude/deploy/${loop.id}`}
                        class="cldploy-row-name"
                      >
                        {loop.name}
                      </a>
                      <div class="cldploy-row-path">{loop.endpointPath}</div>
                    </div>
                    <div>
                      <span
                        class={`cldploy-pill is-${loop.status}`}
                      >
                        <span class="cldploy-pill-dot" />
                        {loop.status}
                      </span>
                    </div>
                    <div style="font-size:12.5px;color:var(--text-muted)">
                      {loop.lastRunAt
                        ? new Date(loop.lastRunAt).toLocaleString()
                        : "never"}
                    </div>
                    <div style="font-family:var(--font-mono);font-size:12.5px;color:var(--text-strong)">
                      {formatCents(loop.totalCentsSpent)} ·{" "}
                      <span style="color:var(--text-muted)">
                        / {formatCents(loop.monthlyBudgetCents)}
                      </span>
                    </div>
                    <div style="display:flex;gap:6px">
                      <button
                        type="button"
                        class="cldploy-btn"
                        data-cldploy-invoke={loop.id}
                      >
                        Invoke
                      </button>
                      <a
                        href={`/connect/claude/deploy/${loop.id}`}
                        class="cldploy-btn"
                      >
                        Open
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: wizardScript(host),
        }}
      />
    </Layout>
  );
});

function wizardScript(host: string): string {
  return `
    (function(){
      const form = document.getElementById('cldploy-create');
      const result = document.getElementById('cldploy-result');
      const elEndpoint = document.getElementById('cldploy-endpoint');
      const elCurl = document.getElementById('cldploy-curl');
      const elToken = document.getElementById('cldploy-token');
      const elDetail = document.getElementById('cldploy-detail-link');
      const elGutter = document.getElementById('cldploy-gutter');
      const elSource = document.getElementById('cldploy-source');
      const HOST = ${JSON.stringify(host)};

      // Sync line-number gutter with textarea content & scroll.
      function syncGutter() {
        if (!elSource || !elGutter) return;
        const lines = (elSource.value || '').split('\\n').length;
        let out = '';
        for (let i = 1; i <= lines; i++) out += (i === 1 ? '' : '\\n') + i;
        elGutter.textContent = out;
      }
      function syncScroll() {
        if (elSource && elGutter) elGutter.scrollTop = elSource.scrollTop;
      }
      if (elSource) {
        elSource.addEventListener('input', syncGutter);
        elSource.addEventListener('scroll', syncScroll);
        syncGutter();
      }

      if (form) {
        form.addEventListener('submit', async function(ev) {
          ev.preventDefault();
          const fd = new FormData(form);
          const body = {
            name: String(fd.get('name') || ''),
            sourceCode: String(fd.get('sourceCode') || ''),
            monthlyBudgetCents: Number(fd.get('monthlyBudgetCents') || 500),
            isPublic: fd.get('isPublic') === '1',
          };
          const btn = document.getElementById('cldploy-submit');
          if (btn) { btn.setAttribute('disabled', '1'); btn.textContent = 'Deploying…'; }
          try {
            const res = await fetch('/api/v2/claude-loops', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || 'create failed');
            if (result) result.classList.add('is-shown');
            if (elEndpoint) elEndpoint.textContent = HOST + j.endpointPath;
            if (elCurl) {
              elCurl.textContent = 'curl -X POST ' + HOST + j.endpointPath + ' \\\\\\n' +
                '  -H "Content-Type: application/json" \\\\\\n' +
                '  -d \\'{"repo":"ccantynz-alt/Gluecron.com"}\\'';
            }
            if (elToken) elToken.textContent = j.agentToken || '(no token — agent session create failed)';
            if (elDetail) elDetail.setAttribute('href', '/connect/claude/deploy/' + j.id);
            if (btn) btn.textContent = 'Deployed ✓';
          } catch (e) {
            if (btn) { btn.removeAttribute('disabled'); btn.textContent = 'Try again'; }
            console.error('[cldploy]', e);
          }
        });
      }

      // Invoke-from-list buttons.
      document.querySelectorAll('[data-cldploy-invoke]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          const id = btn.getAttribute('data-cldploy-invoke');
          if (!id) return;
          const prev = btn.textContent;
          btn.textContent = 'Invoking…';
          btn.setAttribute('disabled', '1');
          try {
            const res = await fetch('/api/v2/claude-loops/' + id + '/invoke', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            });
            const j = await res.json();
            btn.textContent = j.status === 'ok' ? 'Invoked ✓' : (j.status || 'error');
            setTimeout(function() {
              btn.textContent = prev;
              btn.removeAttribute('disabled');
            }, 1600);
          } catch (e) {
            btn.textContent = 'error';
            setTimeout(function() {
              btn.textContent = prev;
              btn.removeAttribute('disabled');
            }, 1600);
          }
        });
      });
    })();
  `;
}

// ---------------------------------------------------------------------------
// GET /connect/claude/deploy/:id — loop detail
// ---------------------------------------------------------------------------
claudeDeploy.get("/connect/claude/deploy/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const loop = await getLoop(id);
  if (!loop || loop.ownerUserId !== user.id) {
    return c.html(
      <Layout title="Loop not found" user={user}>
        <div style="max-width:720px;margin:60px auto;padding:0 20px;text-align:center">
          <h1>Loop not found</h1>
          <p style="color:var(--text-muted)">
            Either it doesn't exist or you don't have access.
          </p>
          <a href="/connect/claude/deploy" class="cldploy-btn">
            Back to wizard
          </a>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </Layout>,
      404
    );
  }
  const runs = await listRunsForLoop(loop.id, 50);
  const host = config.appBaseUrl || "https://gluecron.com";
  const curl = curlExample(host, loop.endpointPath);

  const templateLines = loop.sourceCode.split("\n");
  const gutter = templateLines.map((_, i) => i + 1).join("\n");

  return c.html(
    <Layout title={`Loop · ${loop.name}`} user={user}>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="cldploy-container">
        <section class="cldploy-hero">
          <div class="cldploy-hero-orb" aria-hidden="true" />
          <div class="cldploy-hero-inner">
            <div class="cldploy-eyebrow">
              <strong>Loop</strong> · @{user.username} ·{" "}
              <span class={`cldploy-pill is-${loop.status}`}>
                <span class="cldploy-pill-dot" />
                {loop.status}
              </span>
            </div>
            <h1 class="cldploy-title">{loop.name}</h1>
            <p class="cldploy-sub">
              Endpoint:{" "}
              <code style="font-size:13px">{host}{loop.endpointPath}</code>
            </p>
          </div>
        </section>

        <section class="cldploy-section">
          <div class="cldploy-section-head">
            <h2 class="cldploy-section-title">Meter</h2>
            <p class="cldploy-section-desc">
              Lifetime spend vs monthly cap. Over-cap invocations return 402.
            </p>
          </div>
          <div class="cldploy-section-body">
            <div class="cldploy-meta">
              <div class="cldploy-meta-cell">
                <div class="cldploy-meta-label">Spent</div>
                <div class="cldploy-meta-value">
                  {formatCents(loop.totalCentsSpent)}
                </div>
              </div>
              <div class="cldploy-meta-cell">
                <div class="cldploy-meta-label">Cap</div>
                <div class="cldploy-meta-value">
                  {formatCents(loop.monthlyBudgetCents)}
                </div>
              </div>
              <div class="cldploy-meta-cell">
                <div class="cldploy-meta-label">Invocations</div>
                <div class="cldploy-meta-value">{loop.totalInvocations}</div>
              </div>
              <div class="cldploy-meta-cell">
                <div class="cldploy-meta-label">Last run</div>
                <div class="cldploy-meta-value" style="font-size:13px">
                  {loop.lastRunAt
                    ? new Date(loop.lastRunAt).toLocaleString()
                    : "never"}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="cldploy-section">
          <div class="cldploy-section-head">
            <h2 class="cldploy-section-title">Invoke</h2>
            <p class="cldploy-section-desc">
              POST any JSON to the endpoint. The body becomes the snippet's{" "}
              <code>process.env.INPUT</code>.
            </p>
          </div>
          <div class="cldploy-section-body">
            <pre class="cldploy-code">{curl}</pre>
            <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
              <button
                type="button"
                class="cldploy-btn cldploy-btn-primary"
                data-cldploy-invoke={loop.id}
              >
                Invoke now
              </button>
              {loop.status === "paused" ? (
                <button
                  type="button"
                  class="cldploy-btn"
                  data-cldploy-resume={loop.id}
                >
                  Resume
                </button>
              ) : (
                <button
                  type="button"
                  class="cldploy-btn"
                  data-cldploy-pause={loop.id}
                >
                  Pause
                </button>
              )}
              <button
                type="button"
                class="cldploy-btn cldploy-btn-danger"
                data-cldploy-delete={loop.id}
              >
                Delete
              </button>
            </div>
          </div>
        </section>

        <section class="cldploy-section">
          <div class="cldploy-section-head">
            <h2 class="cldploy-section-title">Source</h2>
            <p class="cldploy-section-desc">
              Edit + save to roll out a new version. Existing runs are
              preserved.
            </p>
          </div>
          <div class="cldploy-section-body">
            <form id="cldploy-edit" data-loop-id={loop.id}>
              <div class="cldploy-editor-wrap">
                <div class="cldploy-editor-toolbar">
                  <span><span class="dot" aria-hidden="true" />loop.mjs</span>
                  <span>{loop.sourceCode.length} bytes</span>
                </div>
                <div class="cldploy-editor-body">
                  <pre
                    id="cldploy-edit-gutter"
                    class="cldploy-editor-gutter"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: escapeHtml(gutter) }}
                  />
                  <textarea
                    id="cldploy-edit-source"
                    name="sourceCode"
                    class="cldploy-editor-textarea"
                    spellcheck={false}
                    wrap="off"
                  >
                    {loop.sourceCode}
                  </textarea>
                </div>
              </div>
              <div style="margin-top:12px">
                <button
                  type="submit"
                  class="cldploy-btn cldploy-btn-primary"
                >
                  Save source
                </button>
              </div>
            </form>
          </div>
        </section>

        <section class="cldploy-section">
          <div class="cldploy-section-head">
            <h2 class="cldploy-section-title">
              Run history · {runs.length}
            </h2>
          </div>
          <div class="cldploy-section-body">
            {runs.length === 0 ? (
              <div class="cldploy-empty">
                No runs yet — invoke to see history populate here.
              </div>
            ) : (
              <div class="cldploy-run-list">
                {runs.map((r) => (
                  <div class="cldploy-run">
                    <div class="cldploy-run-time">
                      {new Date(r.startedAt).toLocaleString()}
                    </div>
                    <div class={`cldploy-run-status ${r.status}`}>
                      {r.status}
                    </div>
                    <div style="font-family:var(--font-mono);font-size:12.5px">
                      {formatCents(r.centsEstimate)} ·{" "}
                      {r.claudeInputTokens + r.claudeOutputTokens} toks
                    </div>
                    <div
                      style="font-size:12.5px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                      title={r.errorMessage || ""}
                    >
                      {r.errorMessage || (r.stdout || "").slice(0, 200)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      <script
        dangerouslySetInnerHTML={{ __html: detailScript(loop.id) }}
      />
    </Layout>
  );
});

function detailScript(loopId: string): string {
  return `
    (function(){
      const ID = ${JSON.stringify(loopId)};
      const elSource = document.getElementById('cldploy-edit-source');
      const elGutter = document.getElementById('cldploy-edit-gutter');
      function syncGutter() {
        if (!elSource || !elGutter) return;
        const lines = (elSource.value || '').split('\\n').length;
        let out = '';
        for (let i = 1; i <= lines; i++) out += (i === 1 ? '' : '\\n') + i;
        elGutter.textContent = out;
      }
      if (elSource) {
        elSource.addEventListener('input', syncGutter);
        syncGutter();
      }
      const form = document.getElementById('cldploy-edit');
      if (form) {
        form.addEventListener('submit', async function(ev) {
          ev.preventDefault();
          const body = { sourceCode: (elSource && elSource.value) || '' };
          const res = await fetch('/api/v2/claude-loops/' + ID, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            const btn = form.querySelector('button[type=submit]');
            if (btn) {
              const prev = btn.textContent;
              btn.textContent = 'Saved ✓';
              setTimeout(function(){ btn.textContent = prev; }, 1400);
            }
          }
        });
      }
      function buttonAction(attr, method, urlSuffix) {
        document.querySelectorAll('[data-cldploy-' + attr + ']').forEach(function(btn) {
          btn.addEventListener('click', async function() {
            const id = btn.getAttribute('data-cldploy-' + attr);
            if (!id) return;
            if (attr === 'delete' && !confirm('Delete this loop? This cannot be undone.')) return;
            btn.setAttribute('disabled', '1');
            const url = '/api/v2/claude-loops/' + id + (urlSuffix || '');
            try {
              const res = await fetch(url, { method, credentials: 'same-origin' });
              if (attr === 'delete' && res.ok) {
                window.location.href = '/connect/claude/deploy';
                return;
              }
              window.location.reload();
            } catch {
              btn.removeAttribute('disabled');
            }
          });
        });
      }
      buttonAction('invoke', 'POST', '/invoke');
      buttonAction('pause', 'POST', '/pause');
      buttonAction('resume', 'POST', '/resume');
      buttonAction('delete', 'DELETE', '');
    })();
  `;
}

// ---------------------------------------------------------------------------
// POST /api/v2/claude-loops — create
// ---------------------------------------------------------------------------
claudeDeploy.post("/api/v2/claude-loops", async (c) => {
  const user = c.get("user")!;
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const name = typeof body.name === "string" ? body.name : "";
  const sourceCode = typeof body.sourceCode === "string" ? body.sourceCode : "";
  const monthlyBudgetCents =
    typeof body.monthlyBudgetCents === "number" ? body.monthlyBudgetCents : 500;
  const isPublic = Boolean(body.isPublic);
  if (!name.trim() || !sourceCode.trim()) {
    return c.json({ error: "name and sourceCode are required" }, 400);
  }
  const result = await createLoop({
    ownerUserId: user.id,
    name,
    sourceCode,
    monthlyBudgetCents,
    isPublic,
  });
  if (!result) {
    return c.json({ error: "could not create loop" }, 500);
  }
  return c.json(
    {
      id: result.loop.id,
      name: result.loop.name,
      endpointPath: result.loop.endpointPath,
      status: result.loop.status,
      monthlyBudgetCents: result.loop.monthlyBudgetCents,
      isPublic: result.loop.isPublic,
      agentToken: result.agentToken,
    },
    201
  );
});

// ---------------------------------------------------------------------------
// POST /api/v2/claude-loops/:id/invoke — owner-side sync invoke
// ---------------------------------------------------------------------------
claudeDeploy.post("/api/v2/claude-loops/:id/invoke", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const loop = await getLoop(id);
  if (!loop || loop.ownerUserId !== user.id) {
    return c.json({ error: "not found" }, 404);
  }
  let inputPayload: unknown = {};
  try {
    inputPayload = await c.req.json();
  } catch {
    inputPayload = {};
  }
  const result = await invokeLoop({
    loopId: loop.id,
    inputPayload,
    isPublicInvocation: false,
  });
  if (result.status === "budget_exceeded") {
    return c.json(
      {
        status: "budget_exceeded",
        error: "monthly budget cap reached",
        centsSpent: loop.totalCentsSpent,
        centsCap: loop.monthlyBudgetCents,
      },
      402
    );
  }
  return c.json(
    {
      status: result.status,
      output: result.output,
      stdout: result.stdout.slice(0, 16_000),
      stderr: result.stderr.slice(0, 16_000),
      centsCharged: result.centsCharged,
      runId: result.run?.id ?? null,
    },
    result.status === "ok" ? 200 : 502
  );
});

// ---------------------------------------------------------------------------
// PATCH /api/v2/claude-loops/:id — update name/source/budget/visibility
// ---------------------------------------------------------------------------
claudeDeploy.patch("/api/v2/claude-loops/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const patch: {
    name?: string;
    sourceCode?: string;
    monthlyBudgetCents?: number;
    isPublic?: boolean;
  } = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.sourceCode === "string") patch.sourceCode = body.sourceCode;
  if (typeof body.monthlyBudgetCents === "number") {
    patch.monthlyBudgetCents = body.monthlyBudgetCents;
  }
  if (typeof body.isPublic === "boolean") patch.isPublic = body.isPublic;
  const row = await updateLoop(id, user.id, patch);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ id: row.id, name: row.name });
});

// ---------------------------------------------------------------------------
// POST /api/v2/claude-loops/:id/pause + /resume + DELETE
// ---------------------------------------------------------------------------
claudeDeploy.post("/api/v2/claude-loops/:id/pause", async (c) => {
  const user = c.get("user")!;
  const ok = await pauseLoop(c.req.param("id"), user.id);
  return c.json({ ok }, ok ? 200 : 404);
});

claudeDeploy.post("/api/v2/claude-loops/:id/resume", async (c) => {
  const user = c.get("user")!;
  const ok = await resumeLoop(c.req.param("id"), user.id);
  return c.json({ ok }, ok ? 200 : 404);
});

claudeDeploy.delete("/api/v2/claude-loops/:id", async (c) => {
  const user = c.get("user")!;
  const ok = await deleteLoop(c.req.param("id"), user.id);
  return c.json({ ok }, ok ? 200 : 404);
});

// ---------------------------------------------------------------------------
// GET /api/v2/claude-loops/:id/runs — paginated run history
// ---------------------------------------------------------------------------
claudeDeploy.get("/api/v2/claude-loops/:id/runs", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const loop = await getLoop(id);
  if (!loop || loop.ownerUserId !== user.id) {
    return c.json({ error: "not found" }, 404);
  }
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") || 50)));
  const runs = await listRunsForLoop(loop.id, limit);
  return c.json({
    loop: {
      id: loop.id,
      name: loop.name,
      status: loop.status,
      endpointPath: loop.endpointPath,
    },
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      centsEstimate: r.centsEstimate,
      claudeInputTokens: r.claudeInputTokens,
      claudeOutputTokens: r.claudeOutputTokens,
      exitCode: r.exitCode,
      errorMessage: r.errorMessage,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /loops/:slug/invoke — public sync invoke (slug = full slug-suffix)
// ---------------------------------------------------------------------------
claudeDeploy.post("/loops/:slug/invoke", async (c) => {
  const slug = c.req.param("slug");
  const endpointPath = `/claude-loops/${slug}`;
  const loop = await getLoopByEndpointPath(endpointPath);
  if (!loop) return c.json({ error: "loop not found" }, 404);
  if (!loop.isPublic) {
    return c.json({ error: "loop is not public" }, 403);
  }
  if (loop.status !== "running") {
    return c.json({ error: "loop is not running" }, 409);
  }
  let inputPayload: unknown = {};
  try {
    inputPayload = await c.req.json();
  } catch {
    inputPayload = {};
  }
  const result = await invokeLoop({
    loopId: loop.id,
    inputPayload,
    isPublicInvocation: true,
  });
  if (result.status === "budget_exceeded") {
    return c.json(
      {
        status: "budget_exceeded",
        error: "monthly budget cap reached",
      },
      402
    );
  }
  return c.json(
    {
      status: result.status,
      output: result.output,
      centsCharged: result.centsCharged,
    },
    result.status === "ok" ? 200 : 502
  );
});

// ---------------------------------------------------------------------------
// Suppress unused-import warning for `hostedClaudeLoops`/`eq`/`db` if the
// route never references them directly; left here for future query helpers.
// ---------------------------------------------------------------------------
void hostedClaudeLoops;
void db;
void eq;

export default claudeDeploy;
