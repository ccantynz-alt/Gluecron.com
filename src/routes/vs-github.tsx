/**
 * Block L5 — Gluecron vs GitHub marketing page.
 *
 * Public, no auth. The pitch: a Claude-first developer's case for picking
 * Gluecron over GitHub for their next project. Hero + honest side-by-side
 * feature table + objections FAQ + CTA.
 *
 * Every comparison row is cross-referenced against BUILD_BIBLE §2 — we don't
 * stretch and we acknowledge where GitHub legitimately wins (ecosystem
 * maturity, Actions marketplace, third-party integrations).
 *
 * Visual family: mirrors `src/routes/sleep-mode.tsx` (L1) and re-uses
 * `landing.tsx` CSS variables (`--accent-gradient`, `--bg-elevated`, etc.).
 * Plain-HTML output — no external assets, no images.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const vsGithub = new Hono<AuthEnv>();
vsGithub.use("*", softAuth);

// ---------------------------------------------------------------------------
// Comparison data — one row per feature, grouped by category.
// gh/gc verdict strings appear verbatim in the rendered table.
// ---------------------------------------------------------------------------

type Verdict = "yes" | "partial" | "no";

interface Row {
  feature: string;
  gh: { verdict: Verdict; note: string };
  gc: { verdict: Verdict; note: string };
}

interface Category {
  title: string;
  rows: Row[];
}

const CATEGORIES: Category[] = [
  {
    title: "AI-native workflow",
    rows: [
      {
        feature: "AI code review on every PR",
        gh: { verdict: "partial", note: "Add-on (Copilot)" },
        gc: { verdict: "yes", note: "Built-in (Sonnet 4)" },
      },
      {
        feature: "AI auto-merge when checks pass",
        gh: { verdict: "no", note: "Manual (third-party action)" },
        gc: { verdict: "yes", note: "Built-in (K2, opt-in per branch)" },
      },
      {
        feature: "Spec → PR pipeline",
        gh: { verdict: "partial", note: "Copilot Workspace (beta)" },
        gc: { verdict: "yes", note: "Generally available" },
      },
      {
        feature: "Label-an-issue → AI builds it",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "ai:build label (autopilot)" },
      },
      {
        feature: "AI explain-this-codebase",
        gh: { verdict: "partial", note: "Copilot Chat" },
        gc: { verdict: "yes", note: "Cached per commit" },
      },
      {
        feature: "AI changelog per commit range",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Built-in (D7)" },
      },
      {
        feature: "AI incident responder",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Auto-issue on deploy fail" },
      },
      {
        feature: "AI dependency updater",
        gh: { verdict: "partial", note: "Dependabot (no AI reasoning)" },
        gc: { verdict: "yes", note: "Claude-driven bump table" },
      },
      {
        feature: "AI security scan on every push",
        gh: { verdict: "partial", note: "CodeQL" },
        gc: { verdict: "yes", note: "15-pattern secret + Sonnet 4 review" },
      },
      {
        feature: "AI Sleep Mode (overnight digest)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "L1 — toggle and walk away" },
      },
    ],
  },
  {
    title: "Developer integration",
    rows: [
      {
        feature: "MCP server with write tools",
        gh: { verdict: "partial", note: "External (mcp__github__*)" },
        gc: { verdict: "yes", note: "Native (/mcp)" },
      },
      {
        feature: "One-command install for Claude Desktop",
        gh: { verdict: "no", note: "Manual config" },
        gc: { verdict: "yes", note: "curl gluecron.com/install" },
      },
      {
        feature: "Bundled Claude Code skills",
        gh: { verdict: "no", note: "None" },
        gc: { verdict: "yes", note: "Three skills shipped (L7)" },
      },
      {
        feature: "VS Code extension",
        gh: { verdict: "yes", note: "Yes" },
        gc: { verdict: "yes", note: "Yes" },
      },
      {
        feature: "Official CLI",
        gh: { verdict: "yes", note: "gh" },
        gc: { verdict: "yes", note: "gluecron" },
      },
      {
        feature: "GraphQL API",
        gh: { verdict: "yes", note: "Yes" },
        gc: { verdict: "yes", note: "Yes (queries)" },
      },
      {
        feature: "REST API",
        gh: { verdict: "yes", note: "Yes" },
        gc: { verdict: "yes", note: "Yes (v1 + v2)" },
      },
    ],
  },
  {
    title: "Hosting + workflow",
    rows: [
      {
        feature: "Workflow runner (Actions equivalent)",
        gh: { verdict: "yes", note: "Actions (paid minutes)" },
        gc: { verdict: "yes", note: ".gluecron/workflows/*.yml (free, your server)" },
      },
      {
        feature: "Package registry",
        gh: { verdict: "yes", note: "Multiple ecosystems" },
        gc: { verdict: "partial", note: "npm protocol only" },
      },
      {
        feature: "Pages / static hosting",
        gh: { verdict: "yes", note: "Pages" },
        gc: { verdict: "yes", note: "gh-pages branch" },
      },
      {
        feature: "Self-hostable",
        gh: { verdict: "partial", note: "Enterprise only" },
        gc: { verdict: "yes", note: "Single binary" },
      },
      {
        feature: "Single-tenant (your code stays yours)",
        gh: { verdict: "no", note: "Shared multi-tenant" },
        gc: { verdict: "yes", note: "Your DB, your disk" },
      },
    ],
  },
  {
    title: "Pricing",
    rows: [
      {
        feature: "Free for public repos",
        gh: { verdict: "yes", note: "Yes" },
        gc: { verdict: "yes", note: "Yes" },
      },
      {
        feature: "Free private repos",
        gh: { verdict: "partial", note: "Limited" },
        gc: { verdict: "yes", note: "Your host, your rules" },
      },
      {
        feature: "Paid Actions minutes",
        gh: { verdict: "yes", note: "Yes (a cost)" },
        gc: { verdict: "no", note: "Your server" },
      },
      {
        feature: "Per-seat fees",
        gh: { verdict: "yes", note: "$4–$21/user" },
        gc: { verdict: "no", note: "Your server" },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// FAQ — honest answers to common objections.
// ---------------------------------------------------------------------------

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: "What about GitHub's huge action ecosystem?",
    a: "Fair point — GitHub's Actions marketplace is years ahead. Gluecron's workflow runner uses the same yaml shape and runs on your server, so most workflows port directly. For the long tail of third-party actions, you're on your own for now; that's the honest trade.",
  },
  {
    q: "What if Claude is wrong about a review?",
    a: "Claude's PR review posts inline comments — you're free to ignore them. Auto-merge is opt-in per branch protection rule and re-uses every gate your manual merge already enforces. If Claude blocks a good PR, override is one click; if Claude approves a bad one, your required checks still have to pass.",
  },
  {
    q: "Can I migrate without downtime?",
    a: "Yes. `/import` clones a single repo via PAT; `/import-bulk` mirrors an entire org in one pass. You can keep pushing to GitHub during the cutover and flip the default remote when you're ready. A migration verifier checks object counts and branch parity post-clone.",
  },
  {
    q: "What about ecosystem (search, code intel, etc.)?",
    a: "Per-repo ILIKE search, semantic embedding search, regex-based symbol nav, blame, and a dependency graph are all built in. They're not GitHub's curated index of every public repo — but for your code, they're tuned for the same Claude that's reviewing your PRs.",
  },
];

// ---------------------------------------------------------------------------
// Verdict glyph + label
// ---------------------------------------------------------------------------

function verdictIcon(v: Verdict): string {
  if (v === "yes") return "✅"; // ✅
  if (v === "partial") return "🟡"; // 🟡
  return "❌"; // ❌
}

function verdictClass(v: Verdict): string {
  if (v === "yes") return "vsg-cell-yes";
  if (v === "partial") return "vsg-cell-partial";
  return "vsg-cell-no";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

vsGithub.get("/vs-github", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Gluecron vs GitHub" user={user}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div class="vsg-root">
        {/* ---------- Hero ---------- */}
        <header class="vsg-hero">
          <div class="eyebrow">Side by side</div>
          <h1 class="display vsg-hero-title">
            Gluecron <span class="vsg-vs">vs</span>{" "}
            <span class="vsg-gh-word">GitHub</span>
          </h1>
          <p class="vsg-hero-sub">
            The git host built around Claude.
          </p>
          <div class="vsg-logos">
            <div class="vsg-logo-card vsg-logo-them">
              <span class="vsg-logo-text">GitHub</span>
              <span class="vsg-logo-sub">the incumbent</span>
            </div>
            <div class="vsg-logo-vs" aria-hidden="true">vs</div>
            <div class="vsg-logo-card vsg-logo-us">
              <span class="vsg-logo-text gradient-text">gluecron</span>
              <span class="vsg-logo-sub">the Claude-native one</span>
            </div>
          </div>
          <div class="vsg-hero-cta">
            <a href="/import" class="btn btn-primary btn-lg">
              Migrate from GitHub in 60 seconds &rarr;
            </a>
            <a href="/demo" class="btn btn-ghost btn-lg">
              Try the demo
            </a>
          </div>
        </header>

        {/* ---------- Feature comparison table ---------- */}
        <section class="vsg-section">
          <div class="section-header">
            <div class="eyebrow">Feature comparison</div>
            <h2>What you actually get.</h2>
            <p>
              Every row cross-referenced against the public parity scorecard.
              When GitHub legitimately wins on a row, we say so &mdash;
              honesty makes the wins land harder.
            </p>
          </div>

          <div class="vsg-table" role="table" aria-label="Gluecron vs GitHub feature comparison">
            <div class="vsg-thead" role="row">
              <div class="vsg-th vsg-th-feature" role="columnheader">Feature</div>
              <div class="vsg-th vsg-th-them" role="columnheader">GitHub</div>
              <div class="vsg-th vsg-th-us" role="columnheader">Gluecron</div>
            </div>

            {CATEGORIES.map((cat) => (
              <>
                <div class="vsg-cat-row" role="row">
                  <div class="vsg-cat-title" role="cell">
                    {cat.title}
                  </div>
                </div>
                {cat.rows.map((row) => (
                  <div class="vsg-row" role="row">
                    <div class="vsg-cell vsg-cell-feature" role="cell">
                      {row.feature}
                    </div>
                    <div
                      class={`vsg-cell vsg-cell-them ${verdictClass(row.gh.verdict)}`}
                      role="cell"
                    >
                      <span class="vsg-icon" aria-hidden="true">
                        {verdictIcon(row.gh.verdict)}
                      </span>
                      <span class="vsg-note">{row.gh.note}</span>
                    </div>
                    <div
                      class={`vsg-cell vsg-cell-us ${verdictClass(row.gc.verdict)}`}
                      role="cell"
                    >
                      <span class="vsg-icon" aria-hidden="true">
                        {verdictIcon(row.gc.verdict)}
                      </span>
                      <span class="vsg-note">{row.gc.note}</span>
                    </div>
                  </div>
                ))}
              </>
            ))}
          </div>
        </section>

        {/* ---------- The killer move ---------- */}
        <section class="vsg-section vsg-killer">
          <div class="vsg-killer-card">
            <div class="eyebrow">The killer move</div>
            <h2 class="vsg-killer-headline">
              Toggle Sleep Mode, walk away,{" "}
              <span class="gradient-text">wake up to a digest.</span>
            </h2>
            <p class="vsg-killer-sub">
              GitHub: not possible. Gluecron: ships in L1. While you sleep,
              Claude auto-merges green PRs, builds features from{" "}
              <code>ai:build</code> issues, and patches the gates that fail.
            </p>
            <a href="/sleep-mode" class="btn btn-secondary btn-lg">
              See how Sleep Mode works &rarr;
            </a>
          </div>
        </section>

        {/* ---------- Objections FAQ ---------- */}
        <section class="vsg-section">
          <div class="section-header">
            <div class="eyebrow">But what about…</div>
            <h2>The honest objections.</h2>
          </div>
          <div class="vsg-faq-grid">
            {FAQS.map((f) => (
              <div class="vsg-faq">
                <h3 class="vsg-faq-q">{f.q}</h3>
                <p class="vsg-faq-a">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- CTA ---------- */}
        <section class="vsg-section vsg-cta-section">
          <h2 class="vsg-cta-title">
            Stop renting your repos.{" "}
            <span class="gradient-text">Start owning your stack.</span>
          </h2>
          <p class="vsg-cta-sub">
            One command imports a GitHub repo. One toggle hands the night
            shift to Claude. One binary self-hosts the whole thing.
          </p>
          <div class="vsg-cta-buttons">
            <a href="/import" class="btn btn-primary btn-lg">
              Migrate from GitHub in 60 seconds &rarr;
            </a>
            <a href="/demo" class="btn btn-ghost btn-lg">
              Try the demo
            </a>
          </div>
        </section>
      </div>
    </Layout>
  );
});

const pageCss = `
  .vsg-root {
    max-width: 1120px;
    margin: 0 auto;
    padding: 48px 24px 80px;
  }

  /* ---------- Hero ---------- */
  .vsg-hero { text-align: center; padding: 32px 0 48px; }
  .vsg-hero-title {
    font-size: clamp(40px, 7vw, 80px);
    line-height: 1.05;
    letter-spacing: -0.03em;
    margin: 16px 0 16px;
    color: var(--text-strong);
  }
  .vsg-vs {
    font-family: var(--font-mono);
    font-size: 0.55em;
    color: var(--text-faint);
    text-transform: lowercase;
    letter-spacing: 0.06em;
    vertical-align: 0.18em;
    padding: 0 0.2em;
  }
  .vsg-gh-word { color: var(--text-muted); }
  .vsg-hero-sub {
    max-width: 640px;
    margin: 0 auto 32px;
    color: var(--text-muted);
    font-size: clamp(15px, 1.6vw, 19px);
    line-height: 1.55;
  }

  .vsg-logos {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    margin: 32px auto 28px;
    flex-wrap: wrap;
  }
  .vsg-logo-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px 32px;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .vsg-logo-us {
    border-color: rgba(140,109,255,0.35);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.18), 0 12px 32px -10px rgba(140,109,255,0.30);
  }
  .vsg-logo-text {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1;
  }
  .vsg-logo-them .vsg-logo-text { color: var(--text); }
  .vsg-logo-sub {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .vsg-logo-vs {
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .vsg-hero-cta {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 28px;
  }

  /* ---------- Section base ---------- */
  .vsg-section { margin: 64px 0; }

  /* ---------- Comparison table ---------- */
  .vsg-table {
    margin: 32px auto 0;
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .vsg-thead {
    display: grid;
    grid-template-columns: 1.7fr 1fr 1fr;
    align-items: center;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-hover, rgba(255,255,255,0.02));
  }
  .vsg-th {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    font-weight: 600;
  }
  .vsg-th-them, .vsg-th-us { text-align: left; }
  .vsg-th-us { color: var(--accent); }

  .vsg-cat-row {
    padding: 14px 20px 6px;
    border-top: 1px solid var(--border-subtle, var(--border));
    background: var(--accent-gradient-faint, rgba(140,109,255,0.04));
  }
  .vsg-cat-row:first-of-type { border-top: none; }
  .vsg-cat-title {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
  }

  .vsg-row {
    display: grid;
    grid-template-columns: 1.7fr 1fr 1fr;
    align-items: stretch;
    padding: 12px 20px;
    border-top: 1px solid var(--border-subtle, var(--border));
    font-size: 14px;
    transition: background var(--t-fast, 0.15s) ease;
  }
  .vsg-row:hover { background: var(--bg-hover, rgba(255,255,255,0.02)); }
  .vsg-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 12px;
  }
  .vsg-cell-feature {
    color: var(--text-strong);
    font-weight: 500;
  }
  .vsg-icon {
    flex-shrink: 0;
    font-size: 14px;
    line-height: 1;
  }
  .vsg-note {
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.4;
  }
  .vsg-cell-yes .vsg-note { color: var(--text); }
  .vsg-cell-partial .vsg-note { color: var(--text-muted); }
  .vsg-cell-no .vsg-note { color: var(--text-faint); }

  @media (max-width: 720px) {
    .vsg-thead, .vsg-row { grid-template-columns: 1.4fr 1fr 1fr; padding: 10px 12px; }
    .vsg-note { font-size: 12px; }
  }

  /* ---------- Killer move ---------- */
  .vsg-killer-card {
    padding: 40px 32px;
    border: 1px solid rgba(140,109,255,0.35);
    border-radius: 18px;
    background:
      linear-gradient(135deg, rgba(140,109,255,0.10), rgba(54,197,214,0.06)),
      var(--bg-elevated);
    text-align: center;
  }
  .vsg-killer-headline {
    font-size: clamp(24px, 3.8vw, 40px);
    line-height: 1.15;
    margin: 12px 0 16px;
    letter-spacing: -0.025em;
  }
  .vsg-killer-sub {
    max-width: 620px;
    margin: 0 auto 24px;
    color: var(--text-muted);
    line-height: 1.55;
    font-size: 15px;
  }
  .vsg-killer-sub code {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12.5px;
    color: var(--accent);
  }

  /* ---------- FAQ ---------- */
  .vsg-faq-grid {
    margin-top: 32px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 18px;
  }
  .vsg-faq {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 22px;
  }
  .vsg-faq-q {
    margin: 0 0 10px;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.015em;
  }
  .vsg-faq-a {
    margin: 0;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.6;
  }
  @media (max-width: 720px) {
    .vsg-faq-grid { grid-template-columns: 1fr; }
  }

  /* ---------- CTA ---------- */
  .vsg-cta-section {
    text-align: center;
    padding: 56px 24px;
    background: var(--accent-gradient-soft, rgba(140,109,255,0.06));
    border: 1px solid var(--border);
    border-radius: 18px;
  }
  .vsg-cta-title {
    font-size: clamp(26px, 4vw, 44px);
    line-height: 1.1;
    margin: 0 0 14px;
    letter-spacing: -0.025em;
    color: var(--text-strong);
  }
  .vsg-cta-sub {
    max-width: 560px;
    margin: 0 auto 28px;
    color: var(--text-muted);
    line-height: 1.55;
    font-size: 15px;
  }
  .vsg-cta-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }
`;

export default vsGithub;
