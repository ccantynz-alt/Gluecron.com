/**
 * Connect Page — /connect/claude onboarding for Claude Code sessions.
 *
 * Routes
 *   GET /connect/claude   — Beautiful onboarding page. If the user is logged
 *                           in, their username is pre-filled in code snippets.
 *
 * NOTE: The existing /connect/claude route in connect-claude.tsx is
 * auth-gated (requireAuth). This file intentionally lives at the same path
 * but is mounted AFTER connect-claude.tsx in app.tsx — it will never win the
 * route match while connect-claude.tsx is registered first. That's by design:
 * logged-in users hit the rich interactive page; unauthenticated visitors
 * should instead be redirected to login by connect-claude.tsx's requireAuth.
 *
 * This file provides a standalone public-friendly version of the onboarding
 * guide at a slightly different path to avoid any conflict:
 *   GET /connect/claude-guide  — public, no auth required
 *
 * Both views reference the same instructions; the guide version simply shows
 * USERNAME as a placeholder when no session is present.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { config } from "../lib/config";

const connectRoutes = new Hono<AuthEnv>();

// Apply softAuth so we can read the user (if any) for pre-filling snippets.
connectRoutes.use("/connect/claude-guide", softAuth);

// ─── Scoped CSS ─────────────────────────────────────────────────────────────
const styles = `
  /* All classes prefixed with .cg- (claude-guide) to avoid bleed */
  .cg-wrap {
    max-width: 860px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4) var(--space-6);
  }

  /* ─── Hero ─── */
  .cg-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
  }
  .cg-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    pointer-events: none;
  }
  .cg-hero-orb {
    position: absolute;
    inset: -20% -5% auto auto;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.6;
    pointer-events: none;
    animation: cgOrbPulse 18s ease-in-out infinite;
  }
  @keyframes cgOrbPulse {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.5; }
    50%       { transform: scale(1.1) translate(-10px, 6px); opacity: 0.8; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cg-hero-orb { animation: none; }
  }
  .cg-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .cg-hero-tag {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    border: 1px solid rgba(140,109,255,0.35);
    background: rgba(140,109,255,0.10);
    color: #c5b3ff;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: var(--space-3);
  }
  .cg-hero-title {
    font-size: clamp(28px, 4.5vw, 44px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.06;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .cg-hero-title .gradient {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .cg-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0 0 var(--space-4);
    line-height: 1.55;
  }
  .cg-hero-cta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 11px 20px;
    border-radius: 10px;
    border: 1px solid rgba(140,109,255,0.45);
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.12));
    color: var(--text-strong);
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    transition: border-color 150ms ease, background 150ms ease, transform 150ms ease;
  }
  .cg-hero-cta:hover {
    border-color: rgba(140,109,255,0.65);
    transform: translateY(-1px);
    text-decoration: none;
  }

  /* ─── Steps ─── */
  .cg-steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
  }
  .cg-step {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .cg-step-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-subtle);
  }
  .cg-step-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 30px; height: 30px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    border: 1px solid rgba(140,109,255,0.40);
    color: #c5b3ff;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
  }
  .cg-step-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text-strong);
    margin: 0;
  }
  .cg-step-body {
    padding: var(--space-4) var(--space-5);
  }
  .cg-step-desc {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 0 var(--space-3);
    line-height: 1.55;
  }

  /* ─── Code blocks ─── */
  .cg-code-wrap {
    position: relative;
    margin-bottom: var(--space-3);
  }
  .cg-code {
    display: block;
    background: var(--bg-tertiary, #0d1018);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 14px 16px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-strong);
    overflow-x: auto;
    white-space: pre;
    line-height: 1.6;
    margin: 0;
  }
  .cg-copy-btn {
    appearance: none;
    position: absolute;
    top: 8px; right: 8px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
    color: var(--text-muted);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 11.5px;
    font-family: inherit;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .cg-copy-btn:hover {
    color: var(--text-strong);
    border-color: var(--border-strong);
  }
  .cg-link {
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
  }
  .cg-link:hover { text-decoration: underline; }

  /* ─── Why Gluecron section ─── */
  .cg-why {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5);
    margin-bottom: var(--space-4);
  }
  .cg-why-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin: 0 0 var(--space-4);
  }
  .cg-why-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3);
  }
  .cg-why-card {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cg-why-card-icon {
    font-size: 20px;
    line-height: 1;
  }
  .cg-why-card-title {
    font-weight: 700;
    font-size: 13.5px;
    color: var(--text-strong);
    margin: 0;
  }
  .cg-why-card-desc {
    font-size: 12.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }

  @media (max-width: 600px) {
    .cg-hero { padding: var(--space-4); }
    .cg-step-body, .cg-step-head { padding: var(--space-3) var(--space-4); }
    .cg-why-grid { grid-template-columns: 1fr; }
  }
`;

// ─── Client-side copy + snippet fill ──────────────────────────────────────
function clientScript(username: string) {
  return `
(function() {
  // Copy-to-clipboard
  document.querySelectorAll('[data-cg-copy]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var targetId = btn.getAttribute('data-cg-copy');
      var el = document.getElementById(targetId);
      if (!el) return;
      var text = el.textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function() {
          var prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function() { btn.textContent = prev; }, 1500);
        }).catch(function() {});
      }
    });
  });
})();
`;
}

// ─── GET /connect/claude-guide ─────────────────────────────────────────────

connectRoutes.get("/connect/claude-guide", async (c) => {
  const user = c.get("user") ?? null;
  const username = user?.username ?? "USERNAME";
  const host = config.appBaseUrl || "https://gluecron.com";

  const remoteSnippet = `git remote add gluecron ${host}/${username}/REPO.git`;
  const mcpJsonSnippet = JSON.stringify(
    {
      mcpServers: {
        gluecron: {
          transport: "http",
          url: `${host}/mcp`,
          headers: {
            Authorization: "Bearer YOUR_TOKEN_HERE",
          },
        },
      },
    },
    null,
    2
  );

  return c.html(
    <Layout
      title="Connect Claude Code to Gluecron"
      user={user}
      description="Push from any Claude Code session in 60 seconds. Zero config."
    >
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <div class="cg-wrap">

        {/* ─── Hero ─── */}
        <section class="cg-hero">
          <div class="cg-hero-orb" aria-hidden="true" />
          <div class="cg-hero-inner">
            <span class="cg-hero-tag">Claude Code Integration</span>
            <h1 class="cg-hero-title">
              Connect <span class="gradient">Claude Code</span> to Gluecron
            </h1>
            <p class="cg-hero-sub">
              Push from any Claude session in 60 seconds. Your repos get
              lightning-fast CI, AI review on every PR, and full MCP tool
              access — no extra configuration needed.
            </p>
            <a href="/settings/tokens" class="cg-hero-cta">
              Create an access token →
            </a>
          </div>
        </section>

        {/* ─── Steps ─── */}
        <div class="cg-steps">

          {/* Step 1 */}
          <section class="cg-step">
            <div class="cg-step-head">
              <span class="cg-step-num">1</span>
              <h2 class="cg-step-title">Create an access token</h2>
            </div>
            <div class="cg-step-body">
              <p class="cg-step-desc">
                Head to{" "}
                <a href="/settings/tokens" class="cg-link">
                  /settings/tokens
                </a>{" "}
                and generate a new personal access token with{" "}
                <code>repo</code> scope (or <code>admin,repo,user</code> for
                full MCP write access). Copy the token — it's shown once.
              </p>
            </div>
          </section>

          {/* Step 2 */}
          <section class="cg-step">
            <div class="cg-step-head">
              <span class="cg-step-num">2</span>
              <h2 class="cg-step-title">Add the remote</h2>
            </div>
            <div class="cg-step-body">
              <p class="cg-step-desc">
                In your project directory, add Gluecron as a git remote.
                Replace <code>REPO</code> with your repository name — it will
                be created automatically on the first push.
              </p>
              <div class="cg-code-wrap">
                <pre id="cg-remote" class="cg-code">{remoteSnippet}</pre>
                <button type="button" class="cg-copy-btn" data-cg-copy="cg-remote">
                  Copy
                </button>
              </div>
            </div>
          </section>

          {/* Step 3 */}
          <section class="cg-step">
            <div class="cg-step-head">
              <span class="cg-step-num">3</span>
              <h2 class="cg-step-title">Configure MCP in .claude/settings.json</h2>
            </div>
            <div class="cg-step-body">
              <p class="cg-step-desc">
                Add the Gluecron MCP server so Claude Code can open issues, file
                PRs, and query your repos directly. Paste the snippet below into{" "}
                <code>.claude/settings.json</code> (or{" "}
                <code>~/.claude/settings.json</code> for global config), replacing{" "}
                <code>YOUR_TOKEN_HERE</code> with the token from Step 1.
              </p>
              <div class="cg-code-wrap">
                <pre id="cg-mcp-json" class="cg-code">{mcpJsonSnippet}</pre>
                <button type="button" class="cg-copy-btn" data-cg-copy="cg-mcp-json">
                  Copy
                </button>
              </div>
            </div>
          </section>

          {/* Step 4 */}
          <section class="cg-step">
            <div class="cg-step-head">
              <span class="cg-step-num">4</span>
              <h2 class="cg-step-title">Push</h2>
            </div>
            <div class="cg-step-body">
              <p class="cg-step-desc">
                Push your code. The repository is created automatically if it
                doesn't exist yet, and CI gates fire immediately.
              </p>
              <div class="cg-code-wrap">
                <pre id="cg-push" class="cg-code">git push gluecron main</pre>
                <button type="button" class="cg-copy-btn" data-cg-copy="cg-push">
                  Copy
                </button>
              </div>
              <p class="cg-step-desc" style="margin-top: var(--space-3); margin-bottom: 0;">
                That's it. Your push triggers the full gate suite and Claude
                AI review lands on any PR within seconds.
              </p>
            </div>
          </section>
        </div>

        {/* ─── Why Gluecron ─── */}
        <section class="cg-why">
          <h2 class="cg-why-title">Why Gluecron?</h2>
          <div class="cg-why-grid">
            <div class="cg-why-card">
              <span class="cg-why-card-icon" aria-hidden="true">⚡</span>
              <h3 class="cg-why-card-title">Lightning-fast CI</h3>
              <p class="cg-why-card-desc">
                Gate runs fire in parallel the moment code lands. Type-check,
                lint, secret-scan, and test in under 30 seconds on most repos.
              </p>
            </div>
            <div class="cg-why-card">
              <span class="cg-why-card-icon" aria-hidden="true">🤖</span>
              <h3 class="cg-why-card-title">AI review on every PR</h3>
              <p class="cg-why-card-desc">
                Claude reads the diff, flags bugs, suggests improvements, and
                auto-approves or blocks merge — before a human even looks.
              </p>
            </div>
            <div class="cg-why-card">
              <span class="cg-why-card-icon" aria-hidden="true">🔧</span>
              <h3 class="cg-why-card-title">15 MCP tools built-in</h3>
              <p class="cg-why-card-desc">
                Claude Code gets native read/write tools: search code, open
                issues, create PRs, merge branches — all from the chat window.
              </p>
            </div>
            <div class="cg-why-card">
              <span class="cg-why-card-icon" aria-hidden="true">🔒</span>
              <h3 class="cg-why-card-title">Secret scanning</h3>
              <p class="cg-why-card-desc">
                Every push is scanned for leaked credentials. A flagged push is
                blocked at the gate — not just flagged after the fact.
              </p>
            </div>
            <div class="cg-why-card">
              <span class="cg-why-card-icon" aria-hidden="true">🌐</span>
              <h3 class="cg-why-card-title">Self-hostable</h3>
              <p class="cg-why-card-desc">
                Run Gluecron on your own infra with a single Docker image. All
                AI features work with your own Anthropic key.
              </p>
            </div>
          </div>
        </section>

        {/* ─── CTA footer ─── */}
        {!user && (
          <p style="text-align: center; color: var(--text-muted); font-size: 14px; margin-top: var(--space-4);">
            <a href="/register" class="cg-link">Create a free account</a> to get
            started, or{" "}
            <a href="/login" class="cg-link">sign in</a> if you already have one.
          </p>
        )}
      </div>
      <script dangerouslySetInnerHTML={{ __html: clientScript(username) }} />
    </Layout>
  );
});

export default connectRoutes;
