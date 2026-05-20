/**
 * /help — public quickstart + API cheatsheet for owners migrating their
 * products onto gluecron. Covers the first five minutes (register, clone,
 * push), integration surfaces (SSH, import, webhooks, tokens), and the
 * AI-native extras (gates + AI review). Linked from the landing page nav.
 *
 * Uses softAuth so the nav bar renders with the signed-in user's session
 * cookie when present; the page itself is reachable without auth.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const help = new Hono<AuthEnv>();
help.use("*", softAuth);

// ─── PAGE-SCOPED CSS ─────────────────────────────────────────
// All classes prefixed with `.help-` so styles cannot bleed into other
// surfaces. Mirrors the 2026 hero polish in admin, dashboard, import,
// settings, and repo-settings.
const helpStyles = `
  .help-wrap { max-width: 920px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Hero ─── */
  .help-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .help-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .help-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .help-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: helpHeroOrb 14s ease-in-out infinite;
  }
  @keyframes helpHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .help-hero-orb { animation: none; }
  }
  .help-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 680px;
  }
  .help-hero-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .help-hero-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px; height: 22px;
    border-radius: 7px;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.18));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
    color: #c4b6ff;
    font-size: 13px;
    line-height: 1;
  }
  .help-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .help-hero-title .help-gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .help-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 600px;
  }

  /* ─── On-this-page nav ─── */
  .help-toc {
    position: relative;
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
  }
  .help-toc-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 10px;
  }
  .help-toc-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .help-toc-list a {
    display: inline-flex;
    align-items: center;
    padding: 5px 10px;
    font-size: 12.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    text-decoration: none;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }
  .help-toc-list a:hover {
    border-color: rgba(140,109,255,0.45);
    background: rgba(140,109,255,0.06);
    color: var(--text-strong);
  }

  /* ─── Section cards ─── */
  .help-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
    scroll-margin-top: var(--space-6);
  }
  .help-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .help-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .help-section-title {
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .help-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .help-section-body {
    padding: var(--space-4) var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* ─── Item rows inside a section card ─── */
  .help-item {
    padding: 12px 14px;
    background: var(--bg);
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: 10px;
    font-size: 14px;
    line-height: 1.55;
    color: var(--text);
  }
  .help-item strong { color: var(--text-strong); font-weight: 600; }
  .help-item code {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(140,109,255,0.10);
    color: #c4b6ff;
  }
  .help-item a { color: var(--text-link, var(--accent)); }

  /* ─── Code blocks inside items ─── */
  .help-code {
    margin: 8px 0 0;
    padding: 12px 14px;
    background: #0a0c14;
    border: 1px solid var(--border-subtle, var(--border));
    border-radius: 8px;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12.5px;
    line-height: 1.55;
    color: #d6d8e3;
    overflow-x: auto;
  }

  /* ─── Footer hint ─── */
  .help-footnote {
    margin-top: var(--space-6);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.55;
  }
`;

help.get("/help", (c) => {
  const user = c.get("user");

  return c.html(
    <Layout title="Help — gluecron" user={user}>
      <style dangerouslySetInnerHTML={{ __html: helpStyles }} />
      <div class="help-wrap">
        {/* ─── Hero ─── */}
        <header class="help-hero">
          <div class="help-hero-bg" aria-hidden="true">
            <div class="help-hero-orb" />
          </div>
          <div class="help-hero-inner">
            <div class="help-hero-eyebrow">
              <span class="help-hero-eyebrow-pill" aria-hidden="true">?</span>
              <span>Help & quickstart</span>
            </div>
            <h1 class="help-hero-title">
              Ship onto{" "}
              <span class="help-gradient-text">gluecron</span> in five minutes.
            </h1>
            <p class="help-hero-sub">
              Everything an owner migrating a product onto gluecron needs in one
              page. If something's unclear, open an issue — link at the bottom.
            </p>
          </div>
        </header>

        {/* ─── On this page ─── */}
        <nav class="help-toc" aria-label="On this page">
          <div class="help-toc-label">On this page</div>
          <div class="help-toc-list">
            <a href="#getting-started">Getting started</a>
            <a href="#git-https">Git over HTTPS</a>
            <a href="#git-ssh">Git over SSH</a>
            <a href="#import">Importing from GitHub</a>
            <a href="#webhooks">Webhooks</a>
            <a href="#tokens">Personal access tokens</a>
            <a href="#gates">Gates & AI review</a>
            <a href="#ai-native">AI-native flow</a>
            <a href="#shortcuts">Keyboard shortcuts</a>
            <a href="#api">API</a>
          </div>
        </nav>

        {/* ─── Getting started ─── */}
        <section id="getting-started" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Step 01</div>
            <h2 class="help-section-title">Getting started</h2>
            <p class="help-section-desc">
              Register, verify, and create your first repo.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>1. Register an account.</strong>{" "}
              Head to <a href="/register">/register</a>, pick a username, and
              set a password. Usernames are your public handle and appear in
              every repo URL.
            </div>
            <div class="help-item">
              <strong>2. Verify your email.</strong>{" "}
              We send a one-time link the first time you sign in. Verified
              addresses can receive issue, PR, and gate-run notifications.
            </div>
            <div class="help-item">
              <strong>3. Create your first repo.</strong>{" "}
              From the dashboard hit <strong>New repository</strong>, or
              visit <a href="/new">/new</a>. Pick public or private, add a
              README, and you're ready to clone.
            </div>
          </div>
        </section>

        {/* ─── Git over HTTPS ─── */}
        <section id="git-https" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Protocol</div>
            <h2 class="help-section-title">Git over HTTPS</h2>
            <p class="help-section-desc">
              HTTPS works out of the box. Authenticate with your account
              password or, better, a personal access token.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Clone</strong>
              <pre class="help-code">
{`git clone https://<your-host>/<owner>/<repo>.git`}
              </pre>
            </div>
            <div class="help-item">
              <strong>Push</strong>
              <pre class="help-code">
{`git push origin main`}
              </pre>
            </div>
            <div class="help-item">
              <strong>Pull</strong>
              <pre class="help-code">
{`git pull origin main`}
              </pre>
            </div>
          </div>
        </section>

        {/* ─── Git over SSH ─── */}
        <section id="git-ssh" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Protocol</div>
            <h2 class="help-section-title">Git over SSH</h2>
            <p class="help-section-desc">
              SSH avoids typing credentials and is recommended for day-to-day
              work.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>1. Add your key.</strong>{" "}
              Copy your public key (usually{" "}
              <code>~/.ssh/id_ed25519.pub</code>) and paste it into{" "}
              <a href="/settings/keys">/settings/keys</a>. Keys take effect
              immediately.
            </div>
            <div class="help-item">
              <strong>2. Clone using the SSH URL.</strong>
              <pre class="help-code">
{`git clone git@<your-host>:<owner>/<repo>.git`}
              </pre>
            </div>
            <div class="help-item">
              <strong>3. Rotate or revoke</strong> any key from the same
              settings page — useful when a laptop walks off.
            </div>
          </div>
        </section>

        {/* ─── Import ─── */}
        <section id="import" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Migration</div>
            <h2 class="help-section-title">Importing from GitHub</h2>
            <p class="help-section-desc">
              One-time mirror with full history, branches, and tags.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              Visit <a href="/import">/import</a>, paste the source URL, and
              gluecron will mirror the repository — full history, branches,
              and tags. The mirror is a one-time copy; subsequent pushes
              land on gluecron, not the source. Private sources need a PAT
              on the source side.
            </div>
          </div>
        </section>

        {/* ─── Webhooks ─── */}
        <section id="webhooks" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Integrations</div>
            <h2 class="help-section-title">Webhooks</h2>
            <p class="help-section-desc">
              Per-repo webhooks live at{" "}
              <code>/:owner/:repo/settings/webhooks</code>. Register a URL, pick
              events (push, issue, pr, star), and set a secret.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>HMAC signature.</strong>{" "}
              Every delivery includes{" "}
              <code>X-Gluecron-Signature: sha256=&lt;hex&gt;</code>.{" "}
              Compute HMAC-SHA256 over the raw request body using your
              secret and compare in constant time.
            </div>
            <div class="help-item">
              <strong>Payload shape.</strong>
              <pre class="help-code">
{`{
  "event": "push",
  "repo": { "owner": "acme", "name": "api" },
  "ref": "refs/heads/main",
  "before": "<sha>",
  "after": "<sha>",
  "commits": [ /* ... */ ],
  "sender": { "username": "kit" }
}`}
              </pre>
            </div>
            <div class="help-item">
              Deliveries are retried with exponential backoff; inspect the
              last N attempts from the webhook's settings page.
            </div>
          </div>
        </section>

        {/* ─── Tokens ─── */}
        <section id="tokens" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Auth</div>
            <h2 class="help-section-title">Personal access tokens</h2>
            <p class="help-section-desc">
              Tokens authenticate CLI clients, CI jobs, and scripts. Create
              them at <a href="/settings/tokens">/settings/tokens</a>; the value
              is shown once, so copy it immediately. Tokens start with{" "}
              <code>glc_</code>.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Example: list your repos via the API.</strong>
              <pre class="help-code">
{`curl -H "Authorization: Bearer glc_your_token_here" \\
  https://<your-host>/api/v2/repos`}
              </pre>
            </div>
            <div class="help-item">
              Tokens can also authenticate <code>git</code> over HTTPS — use
              the token as the password in place of your account password.
            </div>
          </div>
        </section>

        {/* ─── Gates & AI review ─── */}
        <section id="gates" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Quality</div>
            <h2 class="help-section-title">Gates & AI review</h2>
            <p class="help-section-desc">
              Push-time scanning + an AI pair reviewer on every PR.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              Every push to the default branch (usually <code>main</code>)
              triggers a gate run: GateTest scans the diff for secrets,
              dependency advisories, and policy violations, while the AI
              reviewer reads the patch and comments on any PRs that touch
              the same files. Failing gates block the push by default;
              results appear on the commit page and in the repo's{" "}
              <em>Gate runs</em> tab. Configure gate policy per-repo in
              <strong> Settings → Gates</strong>.
            </div>
          </div>
        </section>

        {/* ─── AI-native flow ─── */}
        <section id="ai-native" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">AI-native</div>
            <h2 class="help-section-title">AI-native flow</h2>
            <p class="help-section-desc">
              Surfaces that ride on <code>ANTHROPIC_API_KEY</code>, with
              deterministic fallbacks when it's missing.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Issue → PR in one click.</strong> Open any issue you
              own and hit <em>Build with AI</em> in the header. The spec
              form pre-fills with the issue title + body and a{" "}
              <code>Closes #N</code> footer; Claude drafts the diff, opens
              a draft PR, and the merge auto-closes the originating issue.
            </div>
            <div class="help-item">
              <strong>AI-drafted PR descriptions.</strong> The new-PR form
              has a <em>Suggest description with AI</em> button that runs
              <code> generatePrSummary</code> against{" "}
              <code>git diff base...head</code> and fills the description
              with a structured summary (Why · Key changes · Test plan ·
              Risks).
            </div>
            <div class="help-item">
              <strong>Auto-review on PR open.</strong> Non-draft PRs get a
              summary comment plus inline file/line annotations from the
              AI reviewer. A second comment posts label + reviewer +
              priority suggestions (the <em>AI Triage</em> block). All
              suggestions; nothing applied automatically.
            </div>
            <div class="help-item">
              <strong>Repo-wide AI surfaces.</strong>{" "}
              <a href="/help#explore">Explain</a> a codebase, run{" "}
              <a href="/help#explore">semantic search</a>, ask the chat
              anything about the repo, generate failing test stubs from a
              source file (the <em>Tests</em> link in the repo nav), and
              draft full PRs from a plain-English spec via{" "}
              <em>Spec to PR</em>. All require{" "}
              <code>ANTHROPIC_API_KEY</code>; without it the surfaces
              degrade gracefully to deterministic fallbacks.
            </div>
            <div class="help-item">
              <strong>Scheduled workflows.</strong> Drop{" "}
              <code>on: schedule: [{`{cron: "0 * * * *"}`}]</code> into any
              <code> .gluecron/workflows/*.yml</code>. The autopilot
              ticker fires the cron from the same node that handles your
              pushes — no external scheduler needed.
            </div>
          </div>
        </section>

        {/* ─── Shortcuts ─── */}
        <section id="shortcuts" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Power user</div>
            <h2 class="help-section-title">Keyboard shortcuts</h2>
            <p class="help-section-desc">
              Press <code>?</code> on any page to pop the overlay.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              gluecron ships a full keyboard-first mode — see{" "}
              <a href="/shortcuts">/shortcuts</a> for the complete cheat
              sheet. Press <code>?</code> on any page to pop the overlay.
            </div>
          </div>
        </section>

        {/* ─── API ─── */}
        <section id="api" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Reference</div>
            <h2 class="help-section-title">API</h2>
            <p class="help-section-desc">
              REST + GraphQL surfaces, both documented inline.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              Full REST + GraphQL reference lives at{" "}
              <a href="/api/docs">/api/docs</a>. The GraphQL explorer is at{" "}
              <a href="/api/graphql">/api/graphql</a>.
            </div>
          </div>
        </section>

        <p class="help-footnote">
          Something missing? Open an issue on gluecron's source repo.
        </p>
      </div>
    </Layout>
  );
});

export default help;
