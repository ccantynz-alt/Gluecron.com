/**
 * /docs — expanded documentation site.
 *
 * Routes:
 *   GET /docs                   — landing page with links to all sections
 *   GET /docs/getting-started   — push your first repo in 60 seconds
 *   GET /docs/workflow-yaml     — workflow YAML syntax reference
 *   GET /docs/mcp-server        — MCP server setup + tool catalogue
 *   GET /docs/api               — REST API reference
 *   GET /docs/agents            — agent publishing guide
 *
 * Uses softAuth so the nav bar renders with the signed-in user's session
 * cookie when present; the pages are reachable without auth.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const docs = new Hono<AuthEnv>();
docs.use("*", softAuth);

// ─── SHARED STYLES ──────────────────────────────────────────────────────────
const docsStyles = `
  /* ─── Layout ─── */
  .docs-wrap {
    max-width: 1320px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: var(--space-6);
    align-items: start;
  }
  @media (max-width: 800px) {
    .docs-wrap { grid-template-columns: 1fr; }
    .docs-sidebar { display: none; }
  }

  /* ─── Sidebar ─── */
  .docs-sidebar {
    position: sticky;
    top: calc(var(--header-h, 56px) + var(--space-4));
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4);
  }
  .docs-sidebar-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: var(--space-3);
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .docs-sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .docs-sidebar-nav a {
    display: block;
    padding: 7px 10px;
    font-size: 13.5px;
    color: var(--text);
    text-decoration: none;
    border-radius: 8px;
    transition: background 120ms ease, color 120ms ease;
  }
  .docs-sidebar-nav a:hover {
    background: rgba(140,109,255,0.08);
    color: var(--text-strong);
  }
  .docs-sidebar-nav a.docs-nav-active {
    background: rgba(140,109,255,0.14);
    color: #c4b6ff;
    font-weight: 600;
  }

  /* ─── Hero (landing page only) ─── */
  .docs-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .docs-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
  }
  .docs-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
  }
  .docs-hero-inner { position: relative; z-index: 1; max-width: 640px; }
  .docs-hero-eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: var(--space-2);
  }
  .docs-hero-title {
    font-size: clamp(26px, 3.5vw, 38px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.025em;
    margin: 0 0 var(--space-3);
    color: var(--text-strong);
  }
  .docs-hero-title .docs-gradient {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .docs-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Card grid (landing) ─── */
  .docs-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .docs-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    text-decoration: none;
    transition: border-color 150ms ease, box-shadow 150ms ease;
    display: block;
  }
  .docs-card:hover {
    border-color: rgba(140,109,255,0.45);
    box-shadow: 0 4px 24px -8px rgba(140,109,255,0.25);
  }
  .docs-card-icon {
    font-size: 24px;
    margin-bottom: var(--space-2);
  }
  .docs-card-title {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
  }
  .docs-card-desc {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  /* ─── Main content area ─── */
  .docs-content h1 {
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
    margin: 0 0 var(--space-2);
  }
  .docs-content .docs-page-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0 0 var(--space-5);
    line-height: 1.55;
  }
  .docs-content h2 {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-strong);
    margin: var(--space-6) 0 var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
    scroll-margin-top: calc(var(--header-h, 56px) + var(--space-3));
  }
  .docs-content h2:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
  .docs-content h3 {
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    margin: var(--space-4) 0 var(--space-2);
  }
  .docs-content p {
    font-size: 14px;
    line-height: 1.65;
    color: var(--text);
    margin: 0 0 var(--space-3);
  }
  .docs-content ul, .docs-content ol {
    font-size: 14px;
    line-height: 1.65;
    color: var(--text);
    margin: 0 0 var(--space-3);
    padding-left: var(--space-4);
  }
  .docs-content li { margin-bottom: 6px; }
  .docs-content code {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(140,109,255,0.10);
    color: #c4b6ff;
  }
  .docs-content pre {
    margin: 0 0 var(--space-3);
    padding: 16px 18px;
    background: #0a0c14;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 13px;
    line-height: 1.6;
    color: #d6d8e3;
    overflow-x: auto;
  }
  .docs-content pre code {
    background: none;
    padding: 0;
    color: inherit;
    font-size: inherit;
  }
  .docs-content a { color: var(--accent); }
  .docs-content table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
    margin: 0 0 var(--space-4);
  }
  .docs-content th {
    text-align: left;
    padding: 8px 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    font-weight: 600;
    color: var(--text-strong);
  }
  .docs-content td {
    padding: 8px 12px;
    border: 1px solid var(--border);
    color: var(--text);
    vertical-align: top;
  }
  .docs-content td code { font-size: 12px; }

  /* ─── Page nav (prev/next) ─── */
  .docs-page-nav {
    display: flex;
    justify-content: space-between;
    gap: var(--space-4);
    margin-top: var(--space-6);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  .docs-page-nav-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-decoration: none;
    padding: 12px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 10px;
    transition: border-color 150ms ease;
    max-width: 220px;
    flex: 1;
  }
  .docs-page-nav-item:hover { border-color: rgba(140,109,255,0.45); }
  .docs-page-nav-item--next { text-align: right; margin-left: auto; }
  .docs-page-nav-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .docs-page-nav-title {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-strong);
  }

  /* ─── Edit link ─── */
  .docs-edit-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    margin-top: var(--space-5);
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .docs-edit-link:hover {
    color: var(--text);
    border-color: rgba(140,109,255,0.35);
  }
`;

// ─── SIDEBAR NAV (shared) ─────────────────────────────────────────────────
type DocSection = { href: string; label: string };

const NAV_SECTIONS: DocSection[] = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/getting-started", label: "Getting started" },
  { href: "/docs/workflow-yaml", label: "Workflow YAML" },
  { href: "/docs/mcp-server", label: "MCP server" },
  { href: "/docs/api", label: "API reference" },
  { href: "/docs/agents", label: "Agent publishing" },
];

function Sidebar({ current }: { current: string }) {
  return (
    <aside class="docs-sidebar">
      <div class="docs-sidebar-label">Documentation</div>
      <nav class="docs-sidebar-nav" aria-label="Docs sections">
        {NAV_SECTIONS.map((s) => (
          <a
            href={s.href}
            class={s.href === current ? "docs-nav-active" : ""}
            aria-current={s.href === current ? "page" : undefined}
          >
            {s.label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

function PageNav({
  prev,
  next,
}: {
  prev?: DocSection;
  next?: DocSection;
}) {
  return (
    <div class="docs-page-nav">
      {prev ? (
        <a href={prev.href} class="docs-page-nav-item">
          <span class="docs-page-nav-label">&#8592; Previous</span>
          <span class="docs-page-nav-title">{prev.label}</span>
        </a>
      ) : (
        <span />
      )}
      {next ? (
        <a href={next.href} class="docs-page-nav-item docs-page-nav-item--next">
          <span class="docs-page-nav-label">Next &#8594;</span>
          <span class="docs-page-nav-title">{next.label}</span>
        </a>
      ) : null}
    </div>
  );
}

function EditLink({ path }: { path: string }) {
  return (
    <a
      href={`/ccantynz/Gluecron.com/blob/main/${path}`}
      class="docs-edit-link"
      title="Edit this page in the source repo"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </svg>
      Edit this page
    </a>
  );
}

// ─── LANDING (/docs) ──────────────────────────────────────────────────────

docs.get("/docs", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Docs — gluecron" user={user} description="Gluecron documentation — getting started, workflow YAML, MCP server, REST API, and agent publishing.">
      <style dangerouslySetInnerHTML={{ __html: docsStyles }} />
      <div class="docs-wrap">
        <Sidebar current="/docs" />
        <div class="docs-content">
          {/* Hero */}
          <div class="docs-hero">
            <div class="docs-hero-orb" aria-hidden="true" />
            <div class="docs-hero-inner">
              <div class="docs-hero-eyebrow">Documentation</div>
              <h1 class="docs-hero-title">
                Build on <span class="docs-gradient">gluecron</span>
              </h1>
              <p class="docs-hero-sub">
                Everything you need to host code, automate CI, talk to your
                repos from Claude, and publish agents to the marketplace.
              </p>
            </div>
          </div>

          {/* Card grid */}
          <div class="docs-card-grid">
            <a href="/docs/getting-started" class="docs-card">
              <div class="docs-card-icon">&#9654;</div>
              <div class="docs-card-title">Getting started</div>
              <p class="docs-card-desc">
                Create an account, create a repo, and push your first commit —
                in under 60 seconds.
              </p>
            </a>
            <a href="/docs/workflow-yaml" class="docs-card">
              <div class="docs-card-icon">&#9881;</div>
              <div class="docs-card-title">Workflow YAML</div>
              <p class="docs-card-desc">
                Triggers, steps, env vars, secrets, matrix builds, and the
                cache action — full syntax reference.
              </p>
            </a>
            <a href="/docs/mcp-server" class="docs-card">
              <div class="docs-card-icon">&#128279;</div>
              <div class="docs-card-title">MCP server</div>
              <p class="docs-card-desc">
                Add the Gluecron MCP config to Claude Code and get 15+ tools
                for driving repos from AI sessions.
              </p>
            </a>
            <a href="/docs/api" class="docs-card">
              <div class="docs-card-icon">&#128196;</div>
              <div class="docs-card-title">API reference</div>
              <p class="docs-card-desc">
                Bearer-token auth, repos, issues, PRs, webhooks, and rate
                limits. Core endpoints with request/response shapes.
              </p>
            </a>
            <a href="/docs/agents" class="docs-card">
              <div class="docs-card-icon">&#129302;</div>
              <div class="docs-card-title">Agent publishing</div>
              <p class="docs-card-desc">
                Write an agent, test it locally, publish to the marketplace,
                and earn 70% of every sale.
              </p>
            </a>
          </div>

          <EditLink path="src/routes/docs.tsx" />
        </div>
      </div>
    </Layout>
  );
});

// ─── GETTING STARTED (/docs/getting-started) ─────────────────────────────

docs.get("/docs/getting-started", (c) => {
  const user = c.get("user");
  const idx = NAV_SECTIONS.findIndex((s) => s.href === "/docs/getting-started");
  const prev = NAV_SECTIONS[idx - 1];
  const next = NAV_SECTIONS[idx + 1];

  return c.html(
    <Layout title="Getting started — Docs — gluecron" user={user} description="Push your first repo to Gluecron in under 60 seconds.">
      <style dangerouslySetInnerHTML={{ __html: docsStyles }} />
      <div class="docs-wrap">
        <Sidebar current="/docs/getting-started" />
        <div class="docs-content">
          <h1>Getting started</h1>
          <p class="docs-page-sub">
            Push your first repo to Gluecron in under 60 seconds. No special
            tooling required — just git.
          </p>

          <h2 id="create-account">1. Create an account</h2>
          <p>
            Head to <a href="/register">/register</a>, pick a username and
            password. Your username becomes part of every repo URL:
            <code>gluecron.com/&lt;username&gt;/&lt;repo&gt;</code>.
          </p>
          <p>
            Verify your email when the one-time link arrives. Verified
            addresses receive issue, PR, and gate-run notifications.
          </p>

          <h2 id="create-repo">2. Create your first repo</h2>
          <p>
            From the dashboard hit <strong>+ New</strong>, or visit{" "}
            <a href="/new">/new</a>. Choose:
          </p>
          <ul>
            <li>
              <strong>Name</strong> — lowercase, hyphens OK, no spaces.
            </li>
            <li>
              <strong>Visibility</strong> — public (anyone can clone) or
              private (only you and collaborators).
            </li>
            <li>
              <strong>Initialize with README</strong> — tick this so you get
              a default branch immediately.
            </li>
          </ul>

          <h2 id="push-existing">3. Push an existing local repo</h2>
          <p>
            Add gluecron as a remote and push your default branch. Replace
            <code>you</code> and <code>my-project</code> with your actual
            username and repo name.
          </p>
          <pre><code>{`# Add the remote
git remote add origin https://gluecron.com/you/my-project.git

# Push (first time — track the upstream branch)
git push -u origin main`}</code></pre>
          <p>
            Git will prompt for your username and password. Use your
            Gluecron password, or better yet a{" "}
            <a href="/settings/tokens">personal access token</a> (tokens
            start with <code>glc_</code> and never expire until revoked).
          </p>

          <h2 id="clone">4. Clone an existing repo</h2>
          <pre><code>{`git clone https://gluecron.com/you/my-project.git
cd my-project`}</code></pre>

          <h2 id="ssh">5. Switch to SSH (recommended)</h2>
          <p>
            HTTPS is fine for one-off clones. For daily use, SSH is smoother —
            no password prompts.
          </p>
          <ol>
            <li>
              Copy your public key:{" "}
              <code>cat ~/.ssh/id_ed25519.pub</code>
            </li>
            <li>
              Paste it at{" "}
              <a href="/settings/keys">/settings/keys</a> and save.
            </li>
            <li>
              Re-clone with the SSH URL:
              <pre><code>{`git clone git@gluecron.com:you/my-project.git`}</code></pre>
            </li>
          </ol>

          <h2 id="import">6. Import from GitHub</h2>
          <p>
            Already have repos on GitHub? Visit{" "}
            <a href="/import">/import</a>, paste the GitHub URL (public or
            private), and Gluecron mirrors the full history, branches, and tags
            in one shot. Subsequent pushes go to Gluecron directly.
          </p>

          <h2 id="next">What happens after push?</h2>
          <p>
            Every push to the default branch triggers the{" "}
            <code>post-receive</code> hook:
          </p>
          <ul>
            <li>
              <strong>GateTest scan</strong> — checks the diff for leaked
              secrets, dependency advisories, and policy violations. Results
              appear on the commit page within seconds.
            </li>
            <li>
              <strong>AI review</strong> — if the push targets an open PR,
              the AI reviewer comments on changed files automatically.
            </li>
            <li>
              <strong>Workflow runs</strong> — any{" "}
              <code>.gluecron/workflows/*.yml</code> files with a{" "}
              <code>push</code> trigger fire immediately.
            </li>
            <li>
              <strong>Webhooks</strong> — registered webhook URLs receive a{" "}
              <code>push</code> event payload within ~1 second.
            </li>
          </ul>

          <PageNav prev={prev} next={next} />
          <EditLink path="src/routes/docs.tsx" />
        </div>
      </div>
    </Layout>
  );
});

// ─── WORKFLOW YAML (/docs/workflow-yaml) ──────────────────────────────────

docs.get("/docs/workflow-yaml", (c) => {
  const user = c.get("user");
  const idx = NAV_SECTIONS.findIndex((s) => s.href === "/docs/workflow-yaml");
  const prev = NAV_SECTIONS[idx - 1];
  const next = NAV_SECTIONS[idx + 1];

  return c.html(
    <Layout title="Workflow YAML — Docs — gluecron" user={user} description="Gluecron workflow YAML syntax reference — triggers, steps, env vars, secrets, matrix builds.">
      <style dangerouslySetInnerHTML={{ __html: docsStyles }} />
      <div class="docs-wrap">
        <Sidebar current="/docs/workflow-yaml" />
        <div class="docs-content">
          <h1>Workflow YAML syntax</h1>
          <p class="docs-page-sub">
            Workflows live in <code>.gluecron/workflows/*.yml</code> at the
            repo root. Gluecron runs them on the same node that handles your
            pushes — no external scheduler required.
          </p>

          <h2 id="minimal">Minimal example</h2>
          <pre><code>{`name: CI

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bun install --frozen-lockfile
      - run: bun test`}</code></pre>

          <h2 id="triggers">Triggers</h2>
          <p>
            The <code>on:</code> key controls when a workflow fires. Multiple
            triggers can be combined in a single file.
          </p>

          <h3 id="push-trigger">push</h3>
          <pre><code>{`on:
  push:
    branches: [main, "release/**"]
    # Optional — only run when these paths change:
    paths:
      - "src/**"
      - "package.json"`}</code></pre>

          <h3 id="pr-trigger">pull_request</h3>
          <pre><code>{`on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]`}</code></pre>

          <h3 id="schedule-trigger">schedule (cron)</h3>
          <p>
            Drop a cron expression in the <code>schedule</code> array. The
            Gluecron autopilot ticker fires it from the same node — no
            external scheduler needed.
          </p>
          <pre><code>{`on:
  schedule:
    # Every day at 06:00 UTC
    - cron: "0 6 * * *"
    # Every Monday at 09:00 UTC
    - cron: "0 9 * * 1"`}</code></pre>

          <h3 id="manual-trigger">workflow_dispatch (manual)</h3>
          <pre><code>{`on:
  workflow_dispatch:
    inputs:
      environment:
        description: "Target environment"
        required: true
        default: staging
        type: choice
        options: [staging, production]`}</code></pre>

          <h2 id="jobs">Jobs</h2>
          <p>
            Each job runs in a fresh container. Jobs within the same workflow
            run in parallel by default; use <code>needs:</code> to sequence
            them.
          </p>
          <pre><code>{`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bun run build

  deploy:
    runs-on: ubuntu-latest
    needs: build           # waits for build to succeed
    if: github.ref == 'refs/heads/main'
    steps:
      - run: echo "Deploying…"`}</code></pre>

          <h2 id="steps">Steps</h2>

          <h3>run — shell commands</h3>
          <pre><code>{`steps:
  - name: Install deps
    run: bun install --frozen-lockfile

  - name: Multi-line script
    run: |
      bun run lint
      bun run typecheck
      bun test --reporter=verbose`}</code></pre>

          <h3>uses — reusable actions</h3>
          <pre><code>{`steps:
  - uses: actions/checkout@v4          # check out the repo

  - uses: oven-sh/setup-bun@v2         # install Bun
    with:
      bun-version: latest

  - uses: actions/cache@v4             # cache restore/save
    with:
      path: ~/.bun/install/cache
      key: \${{ runner.os }}-bun-\${{ hashFiles('**/bun.lockb') }}`}</code></pre>

          <h2 id="env">Environment variables</h2>
          <p>
            Set env vars at the workflow, job, or step level. Step-level
            values override job-level which override workflow-level.
          </p>
          <pre><code>{`env:
  NODE_ENV: test
  LOG_LEVEL: debug

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgresql://localhost/testdb
    steps:
      - run: bun test
        env:
          VERBOSE: "1"            # step-level override`}</code></pre>

          <h2 id="secrets">Secrets</h2>
          <p>
            Secrets are stored encrypted at the repo or org level and injected
            at runtime. They never appear in logs — values are masked
            automatically.
          </p>
          <pre><code>{`steps:
  - name: Deploy
    run: curl -X POST \$DEPLOY_WEBHOOK
    env:
      DEPLOY_WEBHOOK: \${{ secrets.DEPLOY_WEBHOOK_URL }}`}</code></pre>
          <p>
            Manage repo secrets at{" "}
            <code>/:owner/:repo/settings/secrets</code>. Org-level secrets
            live at <code>/orgs/:slug/settings/secrets</code> and are shared
            across all repos in the org.
          </p>

          <h2 id="matrix">Matrix builds</h2>
          <p>
            Run the same job across multiple configurations in parallel.
          </p>
          <pre><code>{`jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [ubuntu-latest, macos-latest]
      fail-fast: false    # don't cancel others on first failure
    steps:
      - uses: actions/checkout@v4
      - run: node --version   # uses matrix.node implicitly via setup-node
      - run: bun test`}</code></pre>

          <h2 id="cache">Cache action</h2>
          <pre><code>{`# Bun package cache — speeds up installs by ~80% on warm hits
- uses: actions/cache@v4
  id: bun-cache
  with:
    path: ~/.bun/install/cache
    key: \${{ runner.os }}-bun-\${{ hashFiles('**/bun.lockb') }}
    restore-keys: |
      \${{ runner.os }}-bun-

- run: bun install --frozen-lockfile`}</code></pre>

          <h2 id="expressions">Expressions</h2>
          <pre><code>{`# Context access
\${{ github.actor }}          # username that triggered the run
\${{ github.ref }}            # refs/heads/main
\${{ github.sha }}            # full commit SHA
\${{ runner.os }}             # Linux | macOS | Windows
\${{ job.status }}            # success | failure | cancelled

# Functions
\${{ hashFiles('**/bun.lockb') }}
\${{ contains(github.ref, 'release') }}
\${{ startsWith(github.ref, 'refs/tags/') }}`}</code></pre>

          <h2 id="complete-example">Complete CI + deploy example</h2>
          <pre><code>{`# .gluecron/workflows/ci.yml
name: CI / Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: \${{ runner.os }}-bun-\${{ hashFiles('**/bun.lockb') }}

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test

  deploy:
    runs-on: ubuntu-latest
    needs: ci
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - run: bun run build
      - name: Deploy to Fly.io
        run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: \${{ secrets.FLY_API_TOKEN }}`}</code></pre>

          <PageNav prev={prev} next={next} />
          <EditLink path="src/routes/docs.tsx" />
        </div>
      </div>
    </Layout>
  );
});

// ─── MCP SERVER (/docs/mcp-server) ───────────────────────────────────────

docs.get("/docs/mcp-server", (c) => {
  const user = c.get("user");
  const idx = NAV_SECTIONS.findIndex((s) => s.href === "/docs/mcp-server");
  const prev = NAV_SECTIONS[idx - 1];
  const next = NAV_SECTIONS[idx + 1];

  return c.html(
    <Layout title="MCP server — Docs — gluecron" user={user} description="Set up the Gluecron MCP server in Claude Code and drive your repos from AI sessions.">
      <style dangerouslySetInnerHTML={{ __html: docsStyles }} />
      <div class="docs-wrap">
        <Sidebar current="/docs/mcp-server" />
        <div class="docs-content">
          <h1>MCP server</h1>
          <p class="docs-page-sub">
            Gluecron ships a Model Context Protocol (MCP) server at{" "}
            <code>POST /mcp</code>. Add it to Claude Code and you can create
            issues, open PRs, merge pull requests, and more — all from an AI
            session, with full gate enforcement on every write.
          </p>

          <h2 id="install">1. Install Claude Code</h2>
          <p>
            If you don't have Claude Code yet, install it from{" "}
            <a href="https://claude.ai/code" target="_blank" rel="noopener">claude.ai/code</a>{" "}
            or via npm:
          </p>
          <pre><code>{`npm install -g @anthropic-ai/claude-code`}</code></pre>

          <h2 id="generate-token">2. Generate a personal access token</h2>
          <p>
            MCP write tools require authentication. Create a token at{" "}
            <a href="/settings/tokens">/settings/tokens</a> — choose the{" "}
            <strong>admin</strong> scope so merge and close operations are
            allowed. The token is shown once; copy it immediately. Tokens
            start with <code>glc_</code>.
          </p>

          <h2 id="add-config">3. Add the MCP config</h2>
          <p>
            Add the Gluecron server to your Claude Code{" "}
            <code>.claude/settings.json</code> (or the global
            <code>~/.claude/settings.json</code>):
          </p>
          <pre><code>{`{
  "mcpServers": {
    "gluecron": {
      "type": "http",
      "url": "https://gluecron.com/mcp",
      "headers": {
        "Authorization": "Bearer glc_your_token_here"
      }
    }
  }
}`}</code></pre>
          <p>
            If you self-host Gluecron, replace <code>gluecron.com</code> with
            your instance URL.
          </p>
          <p>
            Alternatively, one-click setup is available at{" "}
            <a href="/connect/claude">/connect/claude</a> — it generates the
            JSON snippet with your token pre-filled.
          </p>

          <h2 id="verify">4. Verify the connection</h2>
          <p>Start Claude Code in your project directory:</p>
          <pre><code>{`claude

# In the session, ask:
# "List open PRs on my-org/my-repo"
# Claude will call gluecron_list_prs and return the results.`}</code></pre>

          <h2 id="tools">Available tools</h2>
          <p>
            The MCP server exposes the following tools. Read-only tools work
            without authentication; write tools require a token with the
            appropriate scope.
          </p>

          <h3>Read-only tools</h3>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>gluecron_repo_search</code></td>
                <td>Search public repos by keyword. Returns up to 20 results.</td>
              </tr>
              <tr>
                <td><code>gluecron_repo_read_file</code></td>
                <td>Read a single file from a public repo at a given ref (branch / tag / commit).</td>
              </tr>
              <tr>
                <td><code>gluecron_repo_list_issues</code></td>
                <td>List open issues for a public repo. Returns up to 50 ordered by most-recent.</td>
              </tr>
              <tr>
                <td><code>gluecron_repo_explain_codebase</code></td>
                <td>Return the cached AI "explain this codebase" Markdown for a public repo.</td>
              </tr>
              <tr>
                <td><code>gluecron_repo_health</code></td>
                <td>Compute the health report for a public repo: overall score (0-100), letter grade, per-category breakdown, and actionable insights.</td>
              </tr>
            </tbody>
          </table>

          <h3>Write tools (require auth)</h3>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>gluecron_create_issue</code></td>
                <td>Create a new issue. Returns <code>{"{number, url}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_comment_issue</code></td>
                <td>Add a comment to an existing issue. Returns <code>{"{commentId}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_close_issue</code></td>
                <td>Close an open issue (idempotent). Returns <code>{"{state}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_reopen_issue</code></td>
                <td>Reopen a closed issue (idempotent). Returns <code>{"{state}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_create_pr</code></td>
                <td>Open a new pull request. Returns <code>{"{number, url}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_get_pr</code></td>
                <td>Fetch full PR detail (title, body, state, branches, draft, author).</td>
              </tr>
              <tr>
                <td><code>gluecron_list_prs</code></td>
                <td>List PRs filtered by state (open|closed|merged|all). Returns up to 50 rows.</td>
              </tr>
              <tr>
                <td><code>gluecron_comment_pr</code></td>
                <td>Add a comment to a pull request. Returns <code>{"{commentId}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_merge_pr</code></td>
                <td>Merge an open PR. Enforces gate checks, branch-protection rules, and the pre-merge risk score. Returns <code>{"{merged, sha?, reason?, riskScore?}"}</code>.</td>
              </tr>
              <tr>
                <td><code>gluecron_close_pr</code></td>
                <td>Close a PR without merging (idempotent). Returns <code>{"{state}"}</code>.</td>
              </tr>
            </tbody>
          </table>

          <h2 id="example-session">Example Claude session</h2>
          <pre><code>{`# Open an issue
User: "Open an issue on my-org/api titled 'Rate limiter not resetting'"
Claude: [calls gluecron_create_issue]
        Created issue #42: /my-org/api/issues/42

# Create a PR from a feature branch
User: "Open a PR from feat/rate-limit-fix into main"
Claude: [calls gluecron_create_pr with head_branch=feat/rate-limit-fix]
        Opened PR #17: /my-org/api/pulls/17

# Merge after review
User: "Merge PR #17 — I've reviewed it"
Claude: [calls gluecron_merge_pr with number=17]
        Merged PR #17. SHA: a3f9c2d`}</code></pre>

          <h2 id="gate-enforcement">Gate enforcement on merge</h2>
          <p>
            <code>gluecron_merge_pr</code> enforces the same checks as the
            web UI merge button:
          </p>
          <ul>
            <li>PR must not be a draft.</li>
            <li>Head branch ref must resolve.</li>
            <li>
              GateTest hard gates must pass (secrets scan, dependency
              advisories, policy violations).
            </li>
            <li>Branch-protection rules must be satisfied.</li>
            <li>
              If the pre-merge risk score is <em>critical</em>, the tool
              returns <code>merged: false</code> with a prompt to re-call
              with <code>confirm_high_risk: true</code>.
            </li>
          </ul>

          <h2 id="dxt">One-click Claude Desktop extension</h2>
          <p>
            Download the <code>.dxt</code> extension at{" "}
            <a href="/gluecron.dxt">/gluecron.dxt</a>. Open it in Claude
            Desktop — it installs the MCP config automatically. No JSON
            editing needed.
          </p>

          <PageNav prev={prev} next={next} />
          <EditLink path="src/routes/docs.tsx" />
        </div>
      </div>
    </Layout>
  );
});

// ─── API REFERENCE (/docs/api) ────────────────────────────────────────────

docs.get("/docs/api", (c) => {
  const user = c.get("user");
  const idx = NAV_SECTIONS.findIndex((s) => s.href === "/docs/api");
  const prev = NAV_SECTIONS[idx - 1];
  const next = NAV_SECTIONS[idx + 1];

  return c.html(
    <Layout title="API reference — Docs — gluecron" user={user} description="Gluecron REST API reference — authentication, repos, issues, PRs, webhooks, rate limits.">
      <style dangerouslySetInnerHTML={{ __html: docsStyles }} />
      <div class="docs-wrap">
        <Sidebar current="/docs/api" />
        <div class="docs-content">
          <h1>API reference</h1>
          <p class="docs-page-sub">
            Gluecron exposes a REST API at <code>/api/v2/</code>. All
            endpoints return JSON. Authenticated endpoints require a{" "}
            <code>Bearer</code> token in the <code>Authorization</code> header.
          </p>

          <h2 id="auth">Authentication</h2>
          <p>
            Generate a personal access token at{" "}
            <a href="/settings/tokens">/settings/tokens</a>. Tokens start
            with <code>glc_</code> and are hashed (SHA-256) before storage —
            the plaintext is shown exactly once.
          </p>
          <pre><code>{`curl -H "Authorization: Bearer glc_your_token_here" \\
  https://gluecron.com/api/v2/repos`}</code></pre>
          <p>
            Tokens can also authenticate <code>git</code> over HTTPS —
            use the token as the password with any username.
          </p>

          <h2 id="rate-limits">Rate limits</h2>
          <table>
            <thead>
              <tr>
                <th>Surface</th>
                <th>Limit</th>
                <th>Window</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>API (anonymous)</td>
                <td>1 000 requests</td>
                <td>60 seconds</td>
              </tr>
              <tr>
                <td>API (authenticated)</td>
                <td>4 000 requests</td>
                <td>60 seconds</td>
              </tr>
              <tr>
                <td>AI commit message</td>
                <td>60 requests</td>
                <td>60 seconds per token</td>
              </tr>
              <tr>
                <td>Login / register</td>
                <td>10–20 requests</td>
                <td>60 seconds per IP</td>
              </tr>
            </tbody>
          </table>
          <p>
            When a limit is exceeded the server returns{" "}
            <code>429 Too Many Requests</code> with a{" "}
            <code>Retry-After</code> header.
          </p>

          <h2 id="repos">Repositories</h2>

          <h3>List your repos</h3>
          <pre><code>{`GET /api/v2/repos

Response 200:
[
  {
    "id": "...",
    "name": "my-project",
    "fullName": "you/my-project",
    "description": "...",
    "isPrivate": false,
    "defaultBranch": "main",
    "starCount": 12,
    "forkCount": 3,
    "issueCount": 5,
    "createdAt": "2025-01-15T10:00:00Z",
    "updatedAt": "2025-06-01T14:30:00Z"
  }
]`}</code></pre>

          <h3>Create a repo</h3>
          <pre><code>{`POST /api/v2/repos
Content-Type: application/json

{
  "name": "my-project",
  "description": "Optional description",
  "isPrivate": false,
  "initReadme": true,
  "defaultBranch": "main"
}

Response 201:
{ "id": "...", "name": "my-project", "fullName": "you/my-project" }`}</code></pre>

          <h3>Get a repo</h3>
          <pre><code>{`GET /api/v2/repos/:owner/:repo

Response 200:
{ /* same shape as list item */ }`}</code></pre>

          <h3>Delete a repo</h3>
          <pre><code>{`DELETE /api/v2/repos/:owner/:repo

Response 204 No Content`}</code></pre>

          <h2 id="issues">Issues</h2>

          <h3>List issues</h3>
          <pre><code>{`GET /api/v2/repos/:owner/:repo/issues?state=open&limit=25

Response 200:
[
  {
    "number": 42,
    "title": "Bug in auth flow",
    "body": "...",
    "state": "open",
    "author": "kit",
    "createdAt": "2025-05-20T08:00:00Z"
  }
]`}</code></pre>

          <h3>Create an issue</h3>
          <pre><code>{`POST /api/v2/repos/:owner/:repo/issues
Content-Type: application/json

{
  "title": "Bug in auth flow",
  "body": "Steps to reproduce: ..."
}

Response 201:
{ "number": 42, "url": "/you/my-project/issues/42" }`}</code></pre>

          <h3>Close / reopen an issue</h3>
          <pre><code>{`PATCH /api/v2/repos/:owner/:repo/issues/:number
Content-Type: application/json

{ "state": "closed" }   // or "open"

Response 200:
{ "state": "closed" }`}</code></pre>

          <h2 id="pull-requests">Pull requests</h2>

          <h3>List PRs</h3>
          <pre><code>{`GET /api/v2/repos/:owner/:repo/pulls?state=open

Response 200:
[
  {
    "number": 17,
    "title": "Add rate limiter",
    "state": "open",
    "baseBranch": "main",
    "headBranch": "feat/rate-limit",
    "isDraft": false,
    "author": "kit",
    "createdAt": "2025-06-01T09:00:00Z"
  }
]`}</code></pre>

          <h3>Create a PR</h3>
          <pre><code>{`POST /api/v2/repos/:owner/:repo/pulls
Content-Type: application/json

{
  "title": "Add rate limiter",
  "body": "## Summary\n- Implements token-bucket rate limiter\n\n## Test plan\n- [ ] Run bun test",
  "headBranch": "feat/rate-limit",
  "baseBranch": "main"
}

Response 201:
{ "number": 17, "url": "/you/my-project/pulls/17" }`}</code></pre>

          <h3>Merge a PR</h3>
          <pre><code>{`POST /api/v2/repos/:owner/:repo/pulls/:number/merge

Response 200:
{ "merged": true, "sha": "a3f9c2d..." }

// If gate checks fail:
Response 422:
{ "merged": false, "reason": "GateTest: leaked secret in src/config.ts" }`}</code></pre>

          <h2 id="webhooks">Webhooks</h2>

          <h3>Register a webhook</h3>
          <pre><code>{`POST /api/v2/repos/:owner/:repo/webhooks
Content-Type: application/json

{
  "url": "https://example.com/hooks/gluecron",
  "secret": "mysecret",
  "events": ["push", "pull_request", "issues", "star"]
}

Response 201:
{ "id": "...", "url": "https://example.com/hooks/gluecron" }`}</code></pre>

          <h3>Webhook payload shape</h3>
          <pre><code>{`// push event
{
  "event": "push",
  "repo": { "owner": "you", "name": "my-project" },
  "ref": "refs/heads/main",
  "before": "<sha>",
  "after": "<sha>",
  "commits": [
    {
      "id": "<sha>",
      "message": "feat: add rate limiter",
      "author": { "name": "Kit", "email": "kit@example.com" }
    }
  ],
  "sender": { "username": "kit" }
}

// Signature header (verify with HMAC-SHA256 over raw body):
X-Gluecron-Signature: sha256=<hex>`}</code></pre>

          <h2 id="ai-endpoints">AI endpoints</h2>

          <h3>Generate a commit message</h3>
          <pre><code>{`POST /api/v2/ai/commit-message
Content-Type: application/json

{ "diff": "<git diff output>" }

Response 200:
{
  "message": "feat(auth): add token-bucket rate limiter\\n\\nPrevents brute-force login attempts..."
}`}</code></pre>

          <h3>Semantic code search</h3>
          <pre><code>{`GET /api/v2/repos/:owner/:repo/semantic-search?q=password+hashing&limit=10

Response 200:
[
  {
    "path": "src/lib/auth.ts",
    "startLine": 12,
    "endLine": 28,
    "snippet": "...",
    "score": 0.94
  }
]`}</code></pre>

          <PageNav prev={prev} next={next} />
          <EditLink path="src/routes/docs.tsx" />
        </div>
      </div>
    </Layout>
  );
});

// ─── AGENT PUBLISHING (/docs/agents) ─────────────────────────────────────

docs.get("/docs/agents", (c) => {
  const user = c.get("user");
  const idx = NAV_SECTIONS.findIndex((s) => s.href === "/docs/agents");
  const prev = NAV_SECTIONS[idx - 1];
  const next = NAV_SECTIONS[idx + 1];

  return c.html(
    <Layout title="Agent publishing — Docs — gluecron" user={user} description="Write, test, and publish an AI agent to the Gluecron marketplace. Earn 70% of every sale.">
      <style dangerouslySetInnerHTML={{ __html: docsStyles }} />
      <div class="docs-wrap">
        <Sidebar current="/docs/agents" />
        <div class="docs-content">
          <h1>Agent publishing guide</h1>
          <p class="docs-page-sub">
            Build an AI agent that drives Gluecron repos, publish it to the
            marketplace, and earn <strong>70% revenue share</strong> on every
            sale. Gluecron keeps 30% to cover infrastructure and fraud
            prevention.
          </p>

          <h2 id="overview">What is an agent?</h2>
          <p>
            A Gluecron agent is a JSON manifest that describes an AI tool-use
            loop. It declares:
          </p>
          <ul>
            <li>A name, description, and icon.</li>
            <li>
              Which MCP tools the agent is allowed to call (scoped to the
              token provided by the buyer).
            </li>
            <li>
              A system prompt that instructs Claude how to use those tools to
              accomplish a goal.
            </li>
            <li>
              Optional input fields the user fills in before the agent runs.
            </li>
          </ul>
          <p>
            Example agents: "Daily standup writer", "Auto-triage new issues",
            "Dependency upgrade PR opener", "Release notes drafter".
          </p>

          <h2 id="write">1. Write your agent</h2>
          <p>
            Create an <code>agent.json</code> in any repo:
          </p>
          <pre><code>{`{
  "name": "standup-writer",
  "displayName": "Daily Standup Writer",
  "description": "Reads yesterday's pushes and open PRs, then writes a concise standup summary.",
  "icon": "https://example.com/standup-icon.png",
  "version": "1.0.0",
  "tools": [
    "gluecron_repo_list_issues",
    "gluecron_list_prs",
    "gluecron_repo_read_file"
  ],
  "inputs": [
    {
      "key": "owner",
      "label": "GitHub/Gluecron owner",
      "type": "string",
      "required": true
    },
    {
      "key": "repo",
      "label": "Repository",
      "type": "string",
      "required": true
    }
  ],
  "systemPrompt": "You are a standup writer. Given the open PRs and recent issues on the target repo, write a concise standup update in bullet-point form: what was done yesterday, what is planned today, and any blockers.",
  "pricing": {
    "model": "per_run",
    "price_usd": 0.10
  }
}`}</code></pre>

          <h2 id="test">2. Test locally</h2>
          <p>
            Use the Gluecron CLI to run your agent against a repo before
            publishing:
          </p>
          <pre><code>{`# Install the CLI
bun add -g @gluecron/cli

# Run the agent locally (no marketplace, no billing)
gluecron agent run ./agent.json \\
  --input owner=my-org \\
  --input repo=api \\
  --token glc_your_dev_token`}</code></pre>
          <p>
            The CLI streams each tool call and its result to stdout so you
            can see exactly what Claude is doing. Errors in the system prompt
            or missing tool permissions surface here before any buyer sees
            them.
          </p>

          <h3>Testing checklist</h3>
          <ul>
            <li>
              Run against a repo with open PRs and issues to verify the
              agent handles non-empty state.
            </li>
            <li>Run against a brand-new empty repo (edge case).</li>
            <li>
              Confirm the agent only calls the tools it declared in{" "}
              <code>"tools"</code> — the runtime rejects undeclared tool
              calls.
            </li>
            <li>
              Test with a read-only token to verify the agent degrades
              gracefully when write tools are unavailable.
            </li>
          </ul>

          <h2 id="publish">3. Publish to the marketplace</h2>
          <p>
            Once you are happy with your agent, push <code>agent.json</code>{" "}
            to a public repo and submit via the marketplace form:
          </p>
          <ol>
            <li>
              Visit{" "}
              <a href="/marketplace/agents/new">/marketplace/agents/new</a>.
            </li>
            <li>
              Paste the URL of your public repo (e.g.{" "}
              <code>https://gluecron.com/you/standup-writer</code>).
            </li>
            <li>
              Set a price — per-run, monthly subscription, or free.
              Minimum per-run price is <strong>$0.01</strong>.
            </li>
            <li>
              Submit for review. The Gluecron team checks that the agent
              manifest is valid, the system prompt doesn't exfiltrate data,
              and the declared tool scope is appropriate. Reviews typically
              complete within <strong>48 hours</strong>.
            </li>
          </ol>

          <h2 id="revenue">Revenue share</h2>
          <table>
            <thead>
              <tr>
                <th>Party</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Agent author (you)</td>
                <td><strong>70%</strong></td>
              </tr>
              <tr>
                <td>Gluecron</td>
                <td>30% (infrastructure + payment processing + fraud prevention)</td>
              </tr>
            </tbody>
          </table>
          <p>
            Payouts are processed monthly via Stripe to the bank account or
            PayPal address on file in your{" "}
            <a href="/settings">account settings</a>. Minimum payout
            threshold is <strong>$10</strong>.
          </p>

          <h2 id="versioning">Versioning and updates</h2>
          <p>
            Bump <code>"version"</code> in <code>agent.json</code>, push,
            and submit an update from the marketplace dashboard. Buyers on
            a subscription get the new version automatically on their next
            run. Per-run buyers always get the latest approved version.
          </p>
          <p>
            Breaking changes (removing tools, changing input keys) require a
            major version bump and a migration note in the changelog field.
          </p>

          <h2 id="guidelines">Marketplace guidelines</h2>
          <ul>
            <li>
              Agents must not exfiltrate repo content to external URLs not
              disclosed in the description.
            </li>
            <li>
              Agents must not call write tools without clear disclosure in
              the description (e.g. "This agent opens PRs automatically").
            </li>
            <li>
              System prompts are public — do not embed secrets or proprietary
              data in them.
            </li>
            <li>
              Agents that repeatedly fail (error rate &gt; 20% over 7 days)
              are automatically delisted pending author review.
            </li>
          </ul>

          <h2 id="example-agent">Full example: dependency upgrade agent</h2>
          <pre><code>{`{
  "name": "dep-upgrader",
  "displayName": "Dependency Upgrade PR",
  "description": "Checks for outdated npm/bun dependencies and opens a PR with the bumped package.json.",
  "version": "1.0.0",
  "tools": [
    "gluecron_repo_read_file",
    "gluecron_create_pr",
    "gluecron_comment_pr"
  ],
  "inputs": [
    { "key": "owner", "label": "Owner", "type": "string", "required": true },
    { "key": "repo",  "label": "Repo",  "type": "string", "required": true }
  ],
  "systemPrompt": "You are a dependency upgrade bot. 1) Read package.json from the repo. 2) Identify any dependencies pinned to a major version older than the current latest on npm. 3) Produce an updated package.json with the bumped versions. 4) Open a PR titled 'chore(deps): bump outdated dependencies' with the updated file as the diff. 5) Comment on the PR with a table of what changed.",
  "pricing": {
    "model": "per_run",
    "price_usd": 0.25
  }
}`}</code></pre>

          <PageNav prev={prev} next={next} />
          <EditLink path="src/routes/docs.tsx" />
        </div>
      </div>
    </Layout>
  );
});

export default docs;
