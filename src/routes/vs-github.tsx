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
    title: "Closed-loop AI (no GitHub equivalent)",
    rows: [
      {
        feature: "Spec-to-PR (spec file → draft PR)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: ".gluecron/specs → /specs" },
      },
      {
        feature: "Voice-to-PR (talk → diff)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "/voice — MediaRecorder + Claude" },
      },
      {
        feature: "Multi-repo refactor agent",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "/refactors — one brief, N PRs" },
      },
      {
        feature: "Auto-healing CI",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "AI CI healer on every failed run" },
      },
      {
        feature: "Per-PR live co-editing",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Presence pill + cursor ribbons" },
      },
      {
        feature: "Agent multiplayer (scoped tokens + leases)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "/settings/agents + lease API" },
      },
      {
        feature: "AI commit messages",
        gh: { verdict: "partial", note: "Copilot CLI (separate product)" },
        gc: { verdict: "yes", note: "Native — gluecron commit / git hook" },
      },
    ],
  },
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

/**
 * SVG glyphs for the comparison cells — replace the emoji in the visual
 * cells (emoji are kept for accessibility/no-CSS fallback inside .vsg-icon).
 * Gluecron-side cells get a polished gradient checkmark; GitHub-side cells
 * get a plain glyph so the eye lands on the wins.
 */
function VerdictGlyph({ verdict, side }: { verdict: Verdict; side: "them" | "us" }) {
  const id = `vsg-grad-${side}-${verdict}`;
  if (verdict === "yes") {
    if (side === "us") {
      return (
        <svg class="vsg-glyph vsg-glyph-yes-us" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#a48bff" />
              <stop offset="100%" stop-color="#36c5d6" />
            </linearGradient>
          </defs>
          <circle cx="12" cy="12" r="10" fill={`url(#${id})`} opacity="0.20" />
          <path d="M7.5 12.5l3 3 6-6.5" stroke={`url(#${id})`} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      );
    }
    return (
      <svg class="vsg-glyph vsg-glyph-yes-them" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.4" opacity="0.40" />
        <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    );
  }
  if (verdict === "partial") {
    return (
      <svg class="vsg-glyph vsg-glyph-partial" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.4" opacity="0.55" />
        <path d="M12 2a10 10 0 0 1 0 20z" fill="currentColor" opacity="0.55" />
      </svg>
    );
  }
  return (
    <svg class="vsg-glyph vsg-glyph-no" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.2" opacity="0.35" />
      <path d="M8 8l8 8M16 8l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
  );
}

/**
 * A row is a "Gluecron win" when Gluecron is yes and GitHub is no/partial.
 * Those rows get a soft gradient wash so the visual scan tells the story.
 */
function isGluecronWin(row: Row): boolean {
  return row.gc.verdict === "yes" && row.gh.verdict !== "yes";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

vsGithub.get("/vs-github", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Gluecron vs GitHub" user={user}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div class="vsg-page vsg-root">
        {/* ---------- Hero (2026 polish: gradient hairline + orb + grad headline) ---------- */}
        <header class="vsg-hero">
          <div class="vsg-hero-orb" aria-hidden="true" />
          <div class="vsg-hero-inner">
            <div class="vsg-eyebrow">
              <span class="vsg-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              Side by side · The honest scorecard · Updated 2026-05
            </div>
            <h1 class="vsg-hero-title">
              Gluecron{" "}
              <span class="vsg-vs">vs</span>{" "}
              <span class="vsg-gh-word">GitHub</span>
            </h1>
            <p class="vsg-hero-sub">
              The git host built around Claude. One base-URL swap, three new
              superpowers, zero per-seat fees.
            </p>
            <div class="vsg-logos">
              <div class="vsg-logo-card vsg-logo-them">
                <span class="vsg-logo-text">GitHub</span>
                <span class="vsg-logo-sub">the incumbent</span>
              </div>
              <div class="vsg-logo-vs" aria-hidden="true">vs</div>
              <div class="vsg-logo-card vsg-logo-us">
                <span class="vsg-logo-text vsg-title-grad">gluecron</span>
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
              <div class="vsg-th vsg-th-them" role="columnheader">
                <span class="vsg-th-dot vsg-th-dot-them" aria-hidden="true" />
                GitHub
              </div>
              <div class="vsg-th vsg-th-us" role="columnheader">
                <span class="vsg-th-dot vsg-th-dot-us" aria-hidden="true" />
                Gluecron
              </div>
            </div>

            {CATEGORIES.map((cat) => (
              <>
                <div class="vsg-cat-row" role="row">
                  <div class="vsg-cat-title" role="cell">
                    <span class="vsg-cat-bar" aria-hidden="true" />
                    {cat.title}
                  </div>
                </div>
                {cat.rows.map((row) => {
                  const win = isGluecronWin(row);
                  return (
                    <div class={`vsg-row${win ? " vsg-row-win" : ""}`} role="row">
                      <div class="vsg-cell vsg-cell-feature" role="cell">
                        {win && <span class="vsg-win-bar" aria-hidden="true" />}
                        {row.feature}
                      </div>
                      <div
                        class={`vsg-cell vsg-cell-them ${verdictClass(row.gh.verdict)}`}
                        role="cell"
                      >
                        <VerdictGlyph verdict={row.gh.verdict} side="them" />
                        <span class="vsg-icon vsg-icon-fallback" aria-hidden="true">
                          {verdictIcon(row.gh.verdict)}
                        </span>
                        <span class="vsg-note">{row.gh.note}</span>
                      </div>
                      <div
                        class={`vsg-cell vsg-cell-us ${verdictClass(row.gc.verdict)}`}
                        role="cell"
                      >
                        <VerdictGlyph verdict={row.gc.verdict} side="us" />
                        <span class="vsg-icon vsg-icon-fallback" aria-hidden="true">
                          {verdictIcon(row.gc.verdict)}
                        </span>
                        <span class="vsg-note">{row.gc.note}</span>
                      </div>
                    </div>
                  );
                })}
              </>
            ))}
          </div>
        </section>

        {/* ---------- The killer move ---------- */}
        <section class="vsg-section vsg-killer">
          <div class="vsg-killer-card">
            <div class="vsg-killer-orb" aria-hidden="true" />
            <div class="vsg-killer-inner">
              <div class="vsg-eyebrow">
                <span class="vsg-eyebrow-pill" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                </span>
                The killer move
              </div>
              <h2 class="vsg-killer-headline">
                Toggle Sleep Mode, walk away,{" "}
                <span class="vsg-title-grad">wake up to a digest.</span>
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
          <div class="vsg-cta-orb" aria-hidden="true" />
          <h2 class="vsg-cta-title">
            Stop renting your repos.{" "}
            <span class="vsg-title-grad">Start owning your stack.</span>
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
  /* ───────── Scoped under .vsg-page so nothing leaks ───────── */
  .vsg-page.vsg-root {
    max-width: 1120px;
    margin: 0 auto;
    padding: 48px 24px 80px;
  }

  /* ---------- Gradient text utility (scoped local copy) ---------- */
  .vsg-page .vsg-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }

  /* ---------- Hero (2026 polish — hairline + orb + grad headline) ---------- */
  .vsg-page .vsg-hero {
    position: relative;
    text-align: center;
    padding: clamp(28px, 4vw, 56px) clamp(24px, 4vw, 48px);
    margin-bottom: 48px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 20px 48px -16px rgba(0,0,0,0.45);
  }
  .vsg-page .vsg-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
    z-index: 2;
  }
  .vsg-page .vsg-hero-orb {
    position: absolute;
    inset: -28% -10% auto auto;
    width: 520px; height: 520px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .vsg-page .vsg-hero-inner { position: relative; z-index: 1; }

  .vsg-page .vsg-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 18px;
  }
  .vsg-page .vsg-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }

  .vsg-page .vsg-hero-title {
    font-family: var(--font-display);
    font-size: clamp(40px, 7vw, 80px);
    line-height: 1.04;
    letter-spacing: -0.034em;
    font-weight: 800;
    margin: 6px 0 16px;
    color: var(--text-strong);
  }
  .vsg-page .vsg-vs {
    font-family: var(--font-mono);
    font-size: 0.42em;
    color: var(--text-faint);
    text-transform: lowercase;
    letter-spacing: 0.10em;
    vertical-align: 0.32em;
    padding: 0 0.25em;
    font-weight: 500;
  }
  .vsg-page .vsg-gh-word { color: var(--text-muted); }
  .vsg-page .vsg-hero-sub {
    max-width: 640px;
    margin: 0 auto 32px;
    color: var(--text-muted);
    font-size: clamp(15px, 1.6vw, 19px);
    line-height: 1.55;
  }

  .vsg-page .vsg-logos {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    margin: 28px auto 28px;
    flex-wrap: wrap;
  }
  .vsg-page .vsg-logo-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px 32px;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .vsg-page .vsg-logo-us {
    border-color: rgba(140,109,255,0.35);
    background: linear-gradient(160deg, rgba(140,109,255,0.07), rgba(54,197,214,0.04) 55%, var(--bg) 100%);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.18), 0 12px 32px -10px rgba(140,109,255,0.30);
  }
  .vsg-page .vsg-logo-text {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1;
  }
  .vsg-page .vsg-logo-them .vsg-logo-text { color: var(--text); }
  .vsg-page .vsg-logo-sub {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .vsg-page .vsg-logo-vs {
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .vsg-page .vsg-hero-cta {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 28px;
  }

  /* ---------- Section base ---------- */
  .vsg-page .vsg-section { margin: 64px 0; }
  .vsg-page .vsg-section .section-header { text-align: center; margin-bottom: 8px; }

  /* ---------- Comparison table (polished, gradient-highlight on wins) ---------- */
  .vsg-page .vsg-table {
    margin: 32px auto 0;
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    background: var(--bg-elevated);
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 14px 40px -20px rgba(0,0,0,0.55);
  }
  .vsg-page .vsg-thead {
    display: grid;
    grid-template-columns: 1.7fr 1fr 1fr;
    align-items: center;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background:
      linear-gradient(180deg, rgba(255,255,255,0.025), transparent),
      var(--bg-elevated);
    position: relative;
  }
  .vsg-page .vsg-thead::after {
    content: '';
    position: absolute;
    left: 0; right: 0; bottom: -1px;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.50) 30%, rgba(54,197,214,0.50) 70%, transparent 100%);
  }
  .vsg-page .vsg-th {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    font-weight: 600;
  }
  .vsg-page .vsg-th-them, .vsg-page .vsg-th-us { text-align: left; }
  .vsg-page .vsg-th-us { color: #b69dff; }
  .vsg-page .vsg-th-dot {
    width: 7px; height: 7px; border-radius: 9999px;
    flex-shrink: 0;
  }
  .vsg-page .vsg-th-dot-them { background: var(--text-faint); opacity: 0.6; }
  .vsg-page .vsg-th-dot-us {
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.16);
  }

  .vsg-page .vsg-cat-row {
    padding: 16px 20px 8px;
    border-top: 1px solid var(--border-subtle, var(--border));
    background: linear-gradient(90deg, rgba(140,109,255,0.06), rgba(54,197,214,0.025) 45%, transparent 100%);
  }
  .vsg-page .vsg-cat-row:first-of-type { border-top: none; }
  .vsg-page .vsg-cat-title {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
  }
  .vsg-page .vsg-cat-bar {
    display: inline-block;
    width: 18px; height: 2px;
    background: linear-gradient(90deg, #8c6dff, #36c5d6);
    border-radius: 2px;
  }

  .vsg-page .vsg-row {
    display: grid;
    grid-template-columns: 1.7fr 1fr 1fr;
    align-items: stretch;
    padding: 14px 20px;
    border-top: 1px solid var(--border-subtle, var(--border));
    font-size: 14px;
    transition: background 150ms ease;
    position: relative;
  }
  .vsg-page .vsg-row:hover { background: rgba(255,255,255,0.025); }

  /* Gluecron-win row: soft gradient wash + accent left bar */
  .vsg-page .vsg-row-win {
    background: linear-gradient(90deg, rgba(140,109,255,0.05) 0%, rgba(54,197,214,0.025) 45%, transparent 100%);
  }
  .vsg-page .vsg-row-win:hover {
    background: linear-gradient(90deg, rgba(140,109,255,0.085) 0%, rgba(54,197,214,0.04) 45%, transparent 100%);
  }
  .vsg-page .vsg-win-bar {
    position: absolute;
    left: 0;
    top: 18%;
    bottom: 18%;
    width: 2px;
    border-radius: 2px;
    background: linear-gradient(180deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 8px rgba(140,109,255,0.45);
  }

  .vsg-page .vsg-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-right: 12px;
    min-width: 0;
  }
  .vsg-page .vsg-cell-feature {
    color: var(--text-strong);
    font-weight: 500;
    position: relative;
  }
  .vsg-page .vsg-row-win .vsg-cell-feature {
    color: var(--text-strong);
    font-weight: 600;
  }
  .vsg-page .vsg-icon {
    flex-shrink: 0;
    font-size: 14px;
    line-height: 1;
  }
  /* The emoji are a fallback only — hide when SVG glyph is present. */
  .vsg-page .vsg-icon-fallback { display: none; }
  .vsg-page .vsg-glyph { flex-shrink: 0; }
  .vsg-page .vsg-glyph-yes-them { color: var(--text); }
  .vsg-page .vsg-glyph-partial { color: #f0c674; }
  .vsg-page .vsg-glyph-no { color: var(--text-faint); }
  .vsg-page .vsg-note {
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.4;
  }
  .vsg-page .vsg-cell-us.vsg-cell-yes .vsg-note { color: var(--text-strong); font-weight: 500; }
  .vsg-page .vsg-cell-yes .vsg-note { color: var(--text); }
  .vsg-page .vsg-cell-partial .vsg-note { color: var(--text-muted); }
  .vsg-page .vsg-cell-no .vsg-note { color: var(--text-faint); }

  @media (max-width: 720px) {
    .vsg-page .vsg-thead, .vsg-page .vsg-row { grid-template-columns: 1.4fr 1fr 1fr; padding: 10px 12px; }
    .vsg-page .vsg-note { font-size: 12px; }
    .vsg-page .vsg-glyph { width: 18px; height: 18px; }
  }

  /* ---------- Killer move (now also gets hairline + orb treatment) ---------- */
  .vsg-page .vsg-killer-card {
    position: relative;
    padding: clamp(32px, 4vw, 56px) clamp(24px, 4vw, 40px);
    border: 1px solid rgba(140,109,255,0.35);
    border-radius: 20px;
    background:
      linear-gradient(135deg, rgba(140,109,255,0.10), rgba(54,197,214,0.06)),
      var(--bg-elevated);
    text-align: center;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 20px 48px -18px rgba(140,109,255,0.30);
  }
  .vsg-page .vsg-killer-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.78;
    pointer-events: none;
  }
  .vsg-page .vsg-killer-orb {
    position: absolute;
    inset: auto auto -30% -10%;
    width: 420px; height: 420px;
    background: radial-gradient(circle, rgba(54,197,214,0.18), rgba(140,109,255,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .vsg-page .vsg-killer-inner { position: relative; z-index: 1; }
  .vsg-page .vsg-killer-headline {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.8vw, 40px);
    line-height: 1.15;
    margin: 10px 0 16px;
    letter-spacing: -0.025em;
    font-weight: 700;
    color: var(--text-strong);
  }
  .vsg-page .vsg-killer-sub {
    max-width: 620px;
    margin: 0 auto 24px;
    color: var(--text-muted);
    line-height: 1.55;
    font-size: 15px;
  }
  .vsg-page .vsg-killer-sub code {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.10);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12.5px;
    color: var(--accent);
  }

  /* ---------- FAQ ---------- */
  .vsg-page .vsg-faq-grid {
    margin-top: 32px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 18px;
  }
  .vsg-page .vsg-faq {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px;
    transition: border-color 160ms ease, transform 160ms ease;
  }
  .vsg-page .vsg-faq:hover {
    border-color: rgba(140,109,255,0.35);
    transform: translateY(-2px);
  }
  .vsg-page .vsg-faq-q {
    margin: 0 0 10px;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 600;
    color: var(--text-strong);
    letter-spacing: -0.015em;
  }
  .vsg-page .vsg-faq-a {
    margin: 0;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.6;
  }
  @media (max-width: 720px) {
    .vsg-page .vsg-faq-grid { grid-template-columns: 1fr; }
  }

  /* ---------- CTA ---------- */
  .vsg-page .vsg-cta-section {
    position: relative;
    text-align: center;
    padding: clamp(40px, 5vw, 64px) 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 18px 44px -18px rgba(0,0,0,0.42);
  }
  .vsg-page .vsg-cta-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
  }
  .vsg-page .vsg-cta-orb {
    position: absolute;
    inset: -25% auto auto 50%;
    transform: translateX(-50%);
    width: 620px; height: 360px;
    background: radial-gradient(ellipse, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.6;
    pointer-events: none;
    z-index: 0;
  }
  .vsg-page .vsg-cta-section > * { position: relative; z-index: 1; }
  .vsg-page .vsg-cta-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 4vw, 44px);
    line-height: 1.1;
    margin: 0 0 14px;
    letter-spacing: -0.028em;
    font-weight: 800;
    color: var(--text-strong);
  }
  .vsg-page .vsg-cta-sub {
    max-width: 560px;
    margin: 0 auto 28px;
    color: var(--text-muted);
    line-height: 1.55;
    font-size: 15px;
  }
  .vsg-page .vsg-cta-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }
`;

export default vsGithub;
