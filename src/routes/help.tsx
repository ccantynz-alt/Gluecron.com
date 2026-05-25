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
            <a href="#chat-bots">Slack &amp; Discord bots</a>
            <a href="#tokens">Personal access tokens</a>
            <a href="#gates">Gates & AI review</a>
            <a href="#ai-native">AI-native flow</a>
            <a href="#ai-surfaces">New AI surfaces</a>
            <a href="#repo-chat">Chat with a repo</a>
            <a href="#previews">Branch previews</a>
            <a href="#migrations">Migration assistant</a>
            <a href="#slash-commands">PR slash commands</a>
            <a href="#release-notes">AI release notes</a>
            <a href="#ai-commits">AI commit messages</a>
            <a href="#agents">Agent multiplayer</a>
            <a href="#semantic">Semantic search API</a>
            <a href="#shortcuts">Keyboard shortcuts</a>
            <a href="#api">API</a>
            <a href="#build-agents">Build-agent integration</a>
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

        {/* ─── Slack + Discord bots ─── */}
        <section id="chat-bots" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Integrations</div>
            <h2 class="help-section-title">Slack &amp; Discord</h2>
            <p class="help-section-desc">
              Install the Gluecron bot from{" "}
              <a href="/settings/integrations">/settings/integrations</a>{" "}
              to drive your repos from chat. PR opens, merges, and AI
              review summaries also push back into the channel.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Slash commands.</strong>
              <pre class="help-code">
{`/gluecron pr list owner/repo
/gluecron pr open owner/repo "Add dark mode"
/gluecron issue list owner/repo
/gluecron issue create owner/repo "Bug in foo()"
/gluecron spec ship "rewrite the cron scheduler"
/gluecron chat "How do I run the tests?"
/gluecron help`}
              </pre>
            </div>
            <div class="help-item">
              <strong>Signature verification.</strong> Slack requests are
              checked against your signing secret (HMAC-SHA256 over{" "}
              <code>v0:&lt;timestamp&gt;:&lt;body&gt;</code>). Discord
              interactions are verified against your Application Public
              Key with Ed25519. Bad signatures get a 401.
            </div>
            <div class="help-item">
              <strong>Outbound notifications.</strong> Once installed, PR
              opens / merges, issue creates, and AI review summaries
              auto-post to your channel. Disable on a per-workspace basis
              from <a href="/settings/integrations">/settings/integrations</a>.
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

        {/* ─── New AI surfaces (global) ─── */}
        <section id="ai-surfaces" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Discover</div>
            <h2 class="help-section-title">New AI surfaces</h2>
            <p class="help-section-desc">
              Seven cross-repo dashboards that ship with Gluecron — find
              them under the <strong>AI</strong> dropdown in the top nav,
              plus the always-on <em>Pulls</em>, <em>Issues</em>,{" "}
              <em>Activity</em>, and <em>Inbox</em> tabs.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong><a href="/pulls">/pulls</a> — global pull-request
              dashboard.</strong> Every open PR across every repo you own
              or follow, grouped by review state. Filter by author, label,
              or repo. Replaces tab-flicking between repos when you just
              want to know "what needs me right now."
            </div>
            <div class="help-item">
              <strong><a href="/issues">/issues</a> — global issue
              dashboard.</strong> Same shape as <code>/pulls</code> for
              issues. Combine the <code>ai:build</code> filter with{" "}
              <em>assigned to me</em> to scan everything Claude is queued
              to build for you.
            </div>
            <div class="help-item">
              <strong><a href="/inbox">/inbox</a> — unified inbox.</strong>{" "}
              Mentions, review requests, CI failures, and AI-generated
              actions in one stream. Filters at the top:{" "}
              <code>filter=mentions</code>, <code>filter=review</code>,{" "}
              <code>filter=ci</code>, <code>filter=ai</code>. The badge
              count next to <em>Inbox</em> in the nav is unread items.
            </div>
            <div class="help-item">
              <strong><a href="/activity">/activity</a> — your
              timeline.</strong> A chronological feed of every push,
              merge, comment, and AI action across your repos. Useful for
              writing your own weekly recap and for spotting when an
              autopilot task fired without you noticing.
            </div>
            <div class="help-item">
              <strong><a href="/standups">/standups</a> — daily AI
              brief.</strong> Claude writes a short standup at your
              configured time (defaults to 09:00 UTC) summarising
              yesterday's pushes, today's open PRs, and anything blocking.
              Toggle the cadence in <a href="/settings">Settings →
              Standups</a>. Hit <em>Refresh</em> on the page to regenerate
              for the current window.
            </div>
            <div class="help-item">
              <strong><a href="/voice">/voice</a> — voice-to-PR.</strong>{" "}
              Hit record, speak a feature spec, stop — Claude transcribes,
              picks the target repo, drafts the diff, and opens a draft
              PR. The whole loop fits in a single browser tab; no native
              app, no Whisper setup. Uses the browser's MediaRecorder API
              under the hood — Chrome, Safari 17+, Firefox.
            </div>
            <div class="help-item">
              <strong><a href="/refactors">/refactors</a> — multi-repo
              refactor agent.</strong> Paste a brief like "rename the{" "}
              <code>cents</code> field to <code>amountMinor</code> across
              every API repo." Claude walks each repo, generates a patch,
              and opens a draft PR per repo. Tracking dashboard shows
              per-repo status (drafted / pushed / merged / failed).
            </div>
            <div class="help-item">
              <strong><a href="/specs">/specs</a> — spec-to-PR loop.</strong>
              Every <code>.gluecron/specs/*.md</code> file across your
              repos shows up here. Add a spec, push it, then either run
              the spec-to-PR generator from the page or label the file
              and let autopilot do it overnight.
            </div>
          </div>
        </section>

        {/* ─── Chat with a repo ─── */}
        <section id="repo-chat" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Per-repo</div>
            <h2 class="help-section-title">Chat with a repo</h2>
            <p class="help-section-desc">
              Rubber-duck a question against any single repo. Powered by
              the semantic code index — Claude pulls the relevant files
              on every turn so answers stay grounded in your actual code.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              Visit <code>/:owner/:repo/chat</code> on any repo you can
              read (the dashboard <em>Quick actions</em> panel has a
              one-click link). Ask "where does auth happen?", "what does
              this Drizzle migration do?", "draft a test for {`<file>`}".
              The chat scrolls forever and the context is freshly retrieved
              on every message — so file moves and recent pushes are
              immediately visible to Claude.
            </div>
            <div class="help-item">
              <strong>Foundation: semantic search.</strong>{" "}
              <code>/:owner/:repo/semantic-search?q=…</code> is the
              underlying retrieval. Chunks are embedded with{" "}
              <code>voyage-code-3</code> when <code>VOYAGE_API_KEY</code>{" "}
              is set; otherwise a lexical fallback (still useful — same
              chunking and ranking, just no embeddings).
            </div>
          </div>
        </section>

        {/* ─── Branch previews ─── */}
        <section id="previews" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Per-repo</div>
            <h2 class="help-section-title">Branch previews</h2>
            <p class="help-section-desc">
              Every non-default branch with a Dockerfile or a{" "}
              <code>.gluecron/preview.yml</code> gets an ephemeral preview
              URL. Spin up, share, tear down — automatically on push.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              Open <code>/:owner/:repo/previews</code> to see the list of
              live previews for the repo. Each row shows the branch, the
              last commit, the preview URL, and the most recent build log.
              Previews self-destruct when the branch is deleted or merged.
            </div>
            <div class="help-item">
              <strong>Linked from PRs.</strong> Whenever a PR is opened
              against the default branch, the PR header surfaces the
              preview URL so reviewers click straight through to a running
              instance instead of pulling locally.
            </div>
          </div>
        </section>

        {/* ─── PR sandboxes (migration 0067) ─── */}
        <section id="pr-sandboxes" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Per-PR</div>
            <h2 class="help-section-title">Runnable PR sandboxes</h2>
            <p class="help-section-desc">
              Every PR can spin up a live, executable sandbox at{" "}
              <code>pr-N-owner-repo.sandbox.gluecron.com</code>.
              Reviewers click "Try this PR live" and poke the change in
              a real browser before merging. Auto-destroys after 4h.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Opt-in defaults.</strong> Per-PR sandboxes are
              triggered manually from the PR detail page; flip{" "}
              <code>auto_pr_sandbox</code> on in repo settings to make
              every newly opened PR provision one automatically.
            </div>
            <div class="help-item">
              <strong>Customise via <code>.gluecron/playground.yml</code>.</strong>{" "}
              Commit this file at the repo root to control what the
              sandbox runs. If it's missing, Claude drafts one from your
              repo on first provision.
              <pre class="help-code">
{`# .gluecron/playground.yml
runtime: docker
image: node:20-alpine
ports: [3000]
seed:
  - "npm install"
  - "node scripts/seed-demo.js"
command: "npm start"
env:
  NODE_ENV: development`}
              </pre>
            </div>
            <div class="help-item">
              <strong>API.</strong> Poll{" "}
              <code>GET /:owner/:repo/pulls/:n/sandbox</code> for the
              status JSON. <code>POST .../sandbox/provision</code> and{" "}
              <code>POST .../sandbox/destroy</code> drive the lifecycle.
              Sandboxes are deterministic by PR number, so the URL is
              stable across re-provisions.
            </div>
          </div>
        </section>

        {/* ─── Migration assistant ─── */}
        <section id="migrations" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Per-repo</div>
            <h2 class="help-section-title">Migration assistant</h2>
            <p class="help-section-desc">
              When you touch a Drizzle schema, Claude proposes the
              corresponding migration SQL and a one-line rollback plan.
              No more "did I forget the migration?" PRs.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              Visit <code>/:owner/:repo/migrations/propose</code> and
              point the assistant at a recent schema change. It returns
              the SQL diff, an up/down script, and a checklist of edge
              cases (NULL→NOT NULL, type widening, default backfill). Save
              the suggestion straight into <code>drizzle/NNNN_*.sql</code>{" "}
              when you're happy with it.
            </div>
            <div class="help-item">
              <strong>Discoverability.</strong> Surfaced from{" "}
              <code>Settings → Integrations</code> on the repo, and
              auto-pinged when a push modifies <code>src/db/schema.ts</code>{" "}
              without a sibling migration file.
            </div>
          </div>
        </section>

        {/* ─── PR slash commands ─── */}
        <section id="slash-commands" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">PR power</div>
            <h2 class="help-section-title">PR slash commands</h2>
            <p class="help-section-desc">
              Type <code>/</code> at the start of a PR comment to invoke
              Claude inline. The composer hint shows the list as you type.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Available commands.</strong>
              <pre class="help-code">
{`/review              Re-run the AI reviewer on the latest diff
/summarise           Drop a fresh PR summary into the description
/test-plan           Generate a test plan from the diff
/explain-this        Plain-English summary of one file or hunk
/risk                Score the diff for breaking-change risk
/migrate             Propose a Drizzle migration for schema changes
/release-notes       Draft release notes covering this PR only
/help                List every command`}
              </pre>
            </div>
            <div class="help-item">
              Commands are deterministic when <code>ANTHROPIC_API_KEY</code>{" "}
              is missing (fallbacks summarise file lists; no model output).
              They also work from the CLI: <code>gluecron pr cmd /review</code>.
            </div>
          </div>
        </section>

        {/* ─── AI release notes ─── */}
        <section id="release-notes" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Releases</div>
            <h2 class="help-section-title">AI release notes</h2>
            <p class="help-section-desc">
              The release form has a <em>Generate notes</em> button that
              drafts a polished changelog from every PR merged since the
              previous tag.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              From <code>/:owner/:repo/releases/new</code>, type a new tag
              name and click <em>Generate notes</em>. Claude calls{" "}
              <code>POST /api/v2/repos/:owner/:repo/releases/notes</code>{" "}
              with the from/to tags and returns markdown grouped by{" "}
              <em>Features</em>, <em>Fixes</em>, <em>Internal</em>. Edit
              before publishing or accept as-is.
            </div>
          </div>
        </section>

        {/* ─── Agent multiplayer ─── */}
        <section id="agents" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">Multi-agent</div>
            <h2 class="help-section-title">Agent multiplayer</h2>
            <p class="help-section-desc">
              Mint scoped tokens for AI agents, give each its own branch
              namespace + daily budget, and let them coordinate through
              the lease API so two Claudes never touch the same file.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>Manage agents</strong> at{" "}
              <a href="/settings/agents">/settings/agents</a>. Each agent
              gets a name, a branch namespace
              (<code>refs/heads/&lt;namespace&gt;*</code>), and a daily
              spend cap. Tokens are shown once on creation — copy them
              immediately. The same page lists the most recent leases
              (work-in-progress markers) per agent.
            </div>
            <div class="help-item">
              <strong>Lease API.</strong>{" "}
              <code>POST /api/v2/agents/leases</code> acquires a lease on
              an issue, PR, or file path. Agents see currently-held
              leases via <code>GET /api/v2/agents/leases</code> and back
              off when a conflict is hit. Full protocol is in{" "}
              <code>docs/multiplayer.md</code> on the gluecron source repo.
            </div>
          </div>
        </section>

        {/* ─── Semantic search API ─── */}
        <section id="semantic" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">API</div>
            <h2 class="help-section-title">Semantic search API</h2>
            <p class="help-section-desc">
              The same index that powers <em>Chat with a repo</em> is
              available as a JSON endpoint.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <pre class="help-code">
{`curl -H "Authorization: Bearer glc_…" \\
  "https://<your-host>/api/v2/repos/<owner>/<repo>/semantic-search?q=password+hashing&limit=10"`}
              </pre>
              Returns a JSON array of <code>{`{ path, startLine, endLine, snippet, score }`}</code>{" "}
              objects sorted by relevance. When <code>VOYAGE_API_KEY</code>{" "}
              is unset on the server the endpoint falls back to lexical
              ranking — useful for offline / air-gapped installs.
            </div>
          </div>
        </section>

        {/* ─── Setup AI commits ─── */}
        <section id="ai-commits" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">CLI</div>
            <h2 class="help-section-title">Setup AI commits</h2>
            <p class="help-section-desc">
              Let Claude write your commit messages. Two ways in: an
              explicit <code>gluecron commit</code> wrapper, or a git
              hook that fires whenever <code>git commit</code> runs
              without <code>-m</code>.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              <strong>1. Install the CLI.</strong> Grab a personal
              access token from{" "}
              <a href="/settings/tokens">/settings/tokens</a>, then:
              <pre class="help-code">
{`bun build --compile --outfile gluecron cli/gluecron.ts
sudo mv gluecron /usr/local/bin/
gluecron login   # paste the token`}
              </pre>
            </div>
            <div class="help-item">
              <strong>2. Use <code>gluecron commit</code>.</strong>{" "}
              Stage your changes the usual way, then:
              <pre class="help-code">
{`gluecron commit          # AI drafts → [y]es / [e]dit / [n]o
gluecron commit -a       # same, but stages tracked changes first
gluecron commit -m "..." # plain pass-through, no AI`}
              </pre>
              The draft is a Conventional Commit by default
              (<code>feat(scope): subject</code> + body explaining why).
              Pass <code>--plain</code> for a plain-English subject.
            </div>
            <div class="help-item">
              <strong>3. Or: install the git hook.</strong> One-time
              setup; every plain <code>git commit</code> (no <code>-m</code>)
              gets a draft pre-filled into the editor.
              <pre class="help-code">
{`cd /path/to/your/repo
gluecron hook install commit-msg
# undo:
gluecron hook uninstall commit-msg`}
              </pre>
              The hook only fires when the message is empty — explicit
              <code> -m</code>, <code>--amend</code>, and merge commits
              are left untouched.
            </div>
            <div class="help-item">
              All AI calls hit <code>POST /api/v2/ai/commit-message</code>,
              rate-limited to <strong>60 requests/minute per token</strong>.
              If <code>ANTHROPIC_API_KEY</code> is unset on the server,
              the endpoint falls back to a deterministic heuristic so
              the CLI keeps working.
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

        {/* ─── Build-agent integration spec ─── */}
        <section id="build-agents" class="help-section">
          <div class="help-section-head">
            <div class="help-section-eyebrow">For AI vendors</div>
            <h2 class="help-section-title">Build-agent integration</h2>
            <p class="help-section-desc">
              Public spec for AI build-agent vendors (Holden Mercer,
              Cursor, Claude Code, etc.) who want to read issues, open
              PRs, and post review comments via the Gluecron API.
            </p>
          </div>
          <div class="help-section-body">
            <div class="help-item">
              The full integration contract lives at{" "}
              <a href="/docs/build-agent-integration">/docs/build-agent-integration</a>{" "}
              — endpoint list, auth scopes, webhook payloads, and the
              <code>ai:build</code> label convention.
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
