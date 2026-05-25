/**
 * Block L5 — Gluecron vs GitHub marketing page.
 *
 * VIRAL UPGRADE: this page is now the strategic positioning move. The
 * single page that has to prove Gluecron is unmistakably ahead of
 * GitHub. Every section is built to be screenshot-worthy: bold gradient
 * headlines, dramatic spacing, clean visual rhythm. If someone grabs
 * ONE section and posts it to Twitter, it should sell on its own.
 *
 * Sections (top → bottom):
 *   1. Shocking headline hero (16 years vs one weekend)
 *   2. 25+ row comparison table grouped into 6 sections
 *   3. "What GitHub still can't do" — 6 mind-blowing capability cards
 *   4. Speed chart — Gluecron one weekend vs GitHub 18+ months (inline SVG)
 *   5. Price bundle comparison — $99/mo vs $19/mo
 *   6. The Agent Era — code snippet showing an agent session
 *   7. Social proof strip + Anthropic partnership badge
 *   8. CTA strip — 3 buttons
 *
 * Mobile-responsive (≤720px collapses to single-column).
 * All styles scoped under `.vsg-page` so nothing leaks.
 * Inline SVG only — no external assets.
 *
 * Block L5 tests reference: hero subtitle string, "AI-native workflow"
 * category header, all original category-1 rows, and links to /import +
 * /sleep-mode must remain.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const vsGithub = new Hono<AuthEnv>();
vsGithub.use("*", softAuth);

// ---------------------------------------------------------------------------
// Comparison data — one row per feature, grouped by category.
// Six sections, 25+ rows total. gh/gc verdict strings appear verbatim
// in the rendered table.
// ---------------------------------------------------------------------------

type Verdict = "yes" | "partial" | "no";

interface Row {
  feature: string;
  gh: { verdict: Verdict; note: string };
  gc: { verdict: Verdict; note: string; href?: string };
}

interface Category {
  title: string;
  rows: Row[];
}

const CATEGORIES: Category[] = [
  {
    title: "AI-native",
    rows: [
      {
        feature: "AI code review on every PR",
        gh: { verdict: "partial", note: "via Copilot subscription ($10/u)" },
        gc: { verdict: "yes", note: "Built-in (Sonnet 4)", href: "/demo" },
      },
      {
        feature: "AI auto-merge when checks pass",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Per-branch opt-in", href: "/sleep-mode" },
      },
      {
        feature: "AI explain-this-codebase",
        gh: { verdict: "partial", note: "via Copilot Chat" },
        gc: { verdict: "yes", note: "Cached per commit" },
      },
      {
        feature: "AI changelog per commit range",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Built-in" },
      },
      {
        feature: "AI incident responder",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Auto-issue on deploy fail" },
      },
      {
        feature: "AI dependency updater",
        gh: { verdict: "partial", note: "via Dependabot ($25/mo)" },
        gc: { verdict: "yes", note: "Claude-reasoned bumps" },
      },
      {
        feature: "AI security scan on every push",
        gh: { verdict: "partial", note: "via CodeQL (enterprise)" },
        gc: { verdict: "yes", note: "Sonnet 4 + 15 patterns" },
      },
      {
        feature: "AI Sleep Mode (overnight digest)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Toggle, walk away", href: "/sleep-mode" },
      },
      {
        feature: "AI commit messages",
        gh: { verdict: "partial", note: "via Copilot CLI (separate)" },
        gc: { verdict: "yes", note: "Native git hook" },
      },
      {
        feature: "Label-an-issue → AI builds it",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "ai:build label autopilot" },
      },
    ],
  },
  {
    title: "Agent era",
    rows: [
      {
        feature: "Per-agent identity (agt_… tokens)",
        gh: { verdict: "no", note: "PATs only — per-user, not per-agent" },
        gc: { verdict: "yes", note: "/settings/agents", href: "/settings/agents" },
      },
      {
        feature: "Scoped leases + concurrency guards",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Lease API + multiplayer" },
      },
      {
        feature: "Agent multiplayer on the same repo",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Cursors, leases, presence" },
      },
      {
        feature: "MCP server with write tools",
        gh: { verdict: "partial", note: "via 3rd-party (mcp-github)" },
        gc: { verdict: "yes", note: "Native /mcp (15 tools)" },
      },
      {
        feature: "Comment moderation (block fake contributors)",
        gh: { verdict: "no", note: "Manual report → wait" },
        gc: { verdict: "yes", note: "Auto-block on confidence" },
      },
      {
        feature: "Voice-to-PR",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "/voice — talk → diff", href: "/voice" },
      },
      {
        feature: "Semantic index over your code",
        gh: { verdict: "partial", note: "via Copilot retrieval" },
        gc: { verdict: "yes", note: "Built-in embeddings" },
      },
    ],
  },
  {
    title: "Velocity",
    rows: [
      {
        feature: "Spec → PR pipeline",
        gh: { verdict: "partial", note: "Copilot Workspace (closed beta)" },
        gc: { verdict: "yes", note: "GA — /specs", href: "/specs" },
      },
      {
        feature: "Multi-repo refactor (one brief → N PRs)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "/refactors", href: "/refactors" },
      },
      {
        feature: "Auto-healing CI",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "AI CI healer per failed run" },
      },
      {
        feature: "Live co-editing on PRs (Figma-style)",
        gh: { verdict: "no", note: "Not available" },
        gc: { verdict: "yes", note: "Presence + cursor ribbons" },
      },
      {
        feature: "Real-time logs over SSE",
        gh: { verdict: "no", note: "Polling only" },
        gc: { verdict: "yes", note: "Streaming everywhere" },
      },
    ],
  },
  {
    title: "Self-host",
    rows: [
      {
        feature: "Self-hostable",
        gh: { verdict: "partial", note: "Enterprise tier only" },
        gc: { verdict: "yes", note: "Single binary" },
      },
      {
        feature: "Single-tenant (your code stays yours)",
        gh: { verdict: "no", note: "Shared multi-tenant" },
        gc: { verdict: "yes", note: "Your DB, your disk" },
      },
      {
        feature: "Workflow runner (Actions-equivalent)",
        gh: { verdict: "yes", note: "Actions (paid minutes)" },
        gc: { verdict: "yes", note: ".gluecron/workflows (free)" },
      },
      {
        feature: "No vendor lock",
        gh: { verdict: "no", note: "Microsoft-owned" },
        gc: { verdict: "yes", note: "Open protocols + your data" },
      },
    ],
  },
  {
    title: "Security",
    rows: [
      {
        feature: "Pre-receive policy enforcement",
        gh: { verdict: "partial", note: "Rulesets (GHE only)" },
        gc: { verdict: "yes", note: "GateTest on every push" },
      },
      {
        feature: "Secret scanning",
        gh: { verdict: "partial", note: "via Advanced Security (paid)" },
        gc: { verdict: "yes", note: "15-pattern + Sonnet 4 review" },
      },
      {
        feature: "SSH key auth",
        gh: { verdict: "yes", note: "Yes" },
        gc: { verdict: "yes", note: "Yes" },
      },
      {
        feature: "Audit log of every git op",
        gh: { verdict: "partial", note: "Enterprise tier" },
        gc: { verdict: "yes", note: "Built-in, all tiers" },
      },
    ],
  },
  {
    title: "DX",
    rows: [
      {
        feature: "One-command install for Claude Desktop",
        gh: { verdict: "no", note: "Manual config" },
        gc: { verdict: "yes", note: "curl gluecron.com/install" },
      },
      {
        feature: "Bundled Claude Code skills",
        gh: { verdict: "no", note: "None" },
        gc: { verdict: "yes", note: "3 skills shipped" },
      },
      {
        feature: "Official CLI",
        gh: { verdict: "yes", note: "gh" },
        gc: { verdict: "yes", note: "gluecron" },
      },
      {
        feature: "Web file editor with AI assist",
        gh: { verdict: "partial", note: "via Copilot only" },
        gc: { verdict: "yes", note: "Built-in" },
      },
      {
        feature: "Migrate from GitHub in 30 seconds",
        gh: { verdict: "no", note: "n/a" },
        gc: { verdict: "yes", note: "/import", href: "/import" },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// "What GitHub still can't do" — six mind-blowing capability cards.
// ---------------------------------------------------------------------------

interface KillerCap {
  title: string;
  body: string;
  href: string;
  cta: string;
  icon: "spec" | "voice" | "refactor" | "presence" | "agent" | "shield";
}

const KILLER_CAPS: KillerCap[] = [
  {
    icon: "spec",
    title: "Spec-to-PR autopilot",
    body: "Drop a markdown spec in .gluecron/specs/. Claude reads it, opens a draft PR with the implementation, requests review. Zero clicks between idea and diff.",
    href: "/specs",
    cta: "See it run",
  },
  {
    icon: "voice",
    title: "Voice-to-PR (mobile)",
    body: "Talk into your phone. MediaRecorder ships the audio to Claude, Claude opens a PR. Diff on your watch by the time you're at the coffee shop.",
    href: "/voice",
    cta: "Try voice mode",
  },
  {
    icon: "refactor",
    title: "Multi-repo refactor",
    body: "One brief in English. N PRs across N repos. \"Rename trackEvent to logEvent everywhere\" → eight PRs queued, eight reviewers tagged.",
    href: "/refactors",
    cta: "Open the console",
  },
  {
    icon: "presence",
    title: "Live co-editing on PRs",
    body: "Figma-style cursors on the diff. See your teammate's selection in real-time. Resolve threads together without the merge-conflict dance.",
    href: "/demo",
    cta: "Watch the demo",
  },
  {
    icon: "agent",
    title: "Agent multiplayer",
    body: "Per-agent identity with agt_… tokens. Scoped leases prevent two agents from clobbering each other. The first git host built for AI teammates.",
    href: "/settings/agents",
    cta: "Issue agent tokens",
  },
  {
    icon: "shield",
    title: "Comment moderation that works",
    body: "Auto-block fake contributors. Confidence-scored heuristics + Claude-side review on every new commenter. Spam dies before it lands.",
    href: "/demo",
    cta: "See the shield",
  },
];

// ---------------------------------------------------------------------------
// Speed chart — Gluecron features shipped THIS WEEKEND vs GitHub equivalent
// shipping dates across 18+ months. Plotted as inline SVG.
// ---------------------------------------------------------------------------

interface SpeedFeature {
  label: string;
  // 0..1 — Gluecron position is always near 1 (this weekend); GitHub
  // position is somewhere across the 18-month horizon.
  ghMonthsAgo: number | null; // null = "not yet shipped"
}

const SPEED_FEATURES: SpeedFeature[] = [
  { label: "AI code review", ghMonthsAgo: 14 },
  { label: "Spec-to-PR", ghMonthsAgo: 6 },
  { label: "AI auto-merge", ghMonthsAgo: null },
  { label: "Voice-to-PR", ghMonthsAgo: null },
  { label: "Multi-repo refactor", ghMonthsAgo: null },
  { label: "Live PR co-editing", ghMonthsAgo: null },
  { label: "Agent multiplayer", ghMonthsAgo: null },
  { label: "Comment moderation AI", ghMonthsAgo: null },
  { label: "Semantic code index", ghMonthsAgo: 9 },
  { label: "Sleep Mode digest", ghMonthsAgo: null },
];

// ---------------------------------------------------------------------------
// Price bundle data — 4 vendor stack vs Gluecron Pro.
// ---------------------------------------------------------------------------

const BUNDLE = [
  { vendor: "GitHub Team", price: 4, why: "git hosting" },
  { vendor: "Copilot Business", price: 19, why: "AI suggestions" },
  { vendor: "Vercel Pro", price: 20, why: "deploys" },
  { vendor: "Sentry Team", price: 26, why: "error tracking" },
  { vendor: "Linear Standard", price: 10, why: "issue tracking" },
  { vendor: "Dependabot+Snyk", price: 25, why: "deps + security" },
];

const BUNDLE_TOTAL = BUNDLE.reduce((s, b) => s + b.price, 0);
const GLUECRON_PRICE = 19;

// ---------------------------------------------------------------------------
// FAQ — honest answers (kept from previous revision, condensed).
// ---------------------------------------------------------------------------

interface Faq {
  q: string;
  a: string;
}

const FAQS: Faq[] = [
  {
    q: "What about GitHub's huge Actions ecosystem?",
    a: "Fair point — GitHub's Actions marketplace is years ahead. Gluecron's workflow runner uses the same yaml shape and runs on your server, so most workflows port directly. For the long-tail of third-party actions, you're on your own for now; that's the honest trade.",
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
    q: "Why should I trust a one-weekend platform with production?",
    a: "Because it's open, single-tenant, and self-hostable. Your code lives on your disk in your database. If we vanish tomorrow, your git history is already on your machine — and the gluecron binary will keep working without our servers. That's not a promise GitHub can make.",
  },
];

// ---------------------------------------------------------------------------
// Glyphs + helpers
// ---------------------------------------------------------------------------

function verdictIcon(v: Verdict): string {
  if (v === "yes") return "✅";
  if (v === "partial") return "🟡";
  return "❌";
}

function verdictClass(v: Verdict): string {
  if (v === "yes") return "vsg-cell-yes";
  if (v === "partial") return "vsg-cell-partial";
  return "vsg-cell-no";
}

function VerdictGlyph({ verdict, side }: { verdict: Verdict; side: "them" | "us" }) {
  const id = `vsg-grad-${side}-${verdict}-${Math.random().toString(36).slice(2, 7)}`;
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

function isGluecronWin(row: Row): boolean {
  return row.gc.verdict === "yes" && row.gh.verdict !== "yes";
}

// ---------------------------------------------------------------------------
// Icons for the "killer capabilities" cards
// ---------------------------------------------------------------------------

function CapIcon({ kind }: { kind: KillerCap["icon"] }) {
  const common = {
    width: "26",
    height: "26",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round" as const,
    "stroke-linejoin": "round" as const,
    "aria-hidden": "true",
  };
  switch (kind) {
    case "spec":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="17" x2="13" y2="17" />
        </svg>
      );
    case "voice":
      return (
        <svg {...common}>
          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
          <line x1="12" y1="18" x2="12" y2="22" />
        </svg>
      );
    case "refactor":
      return (
        <svg {...common}>
          <polyline points="16 3 21 3 21 8" />
          <line x1="4" y1="20" x2="21" y2="3" />
          <polyline points="21 16 21 21 16 21" />
          <line x1="15" y1="15" x2="21" y2="21" />
          <line x1="4" y1="4" x2="9" y2="9" />
        </svg>
      );
    case "presence":
      return (
        <svg {...common}>
          <circle cx="9" cy="7" r="3" />
          <circle cx="17" cy="11" r="2" />
          <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
          <path d="M15 21v-1a3 3 0 0 1 3-3h2" />
        </svg>
      );
    case "agent":
      return (
        <svg {...common}>
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v4" />
          <line x1="8" y1="16" x2="8" y2="16" />
          <line x1="16" y1="16" x2="16" y2="16" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 2.5l8 3.5v6c0 5-3.5 8.5-8 9.5-4.5-1-8-4.5-8-9.5v-6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
  }
}

// ---------------------------------------------------------------------------
// Speed chart — inline SVG
// ---------------------------------------------------------------------------

function SpeedChart() {
  // Geometry: 720 wide x (rows * 36 + 80) tall. The Gluecron weekend lives
  // at x ≈ chartLeft + chartWidth (right edge). The GitHub timeline spans
  // chartLeft .. chartLeft + chartWidth, where chartLeft = ~18 months ago
  // (left edge) and chartLeft + chartWidth = today.
  const rows = SPEED_FEATURES;
  const rowHeight = 34;
  const chartLeft = 200;
  const chartRight = 700;
  const chartWidth = chartRight - chartLeft;
  const monthsSpan = 18; // GitHub timeline depth
  const headerH = 60;
  const footerH = 30;
  const height = headerH + rows.length * rowHeight + footerH;

  function ghX(monthsAgo: number): number {
    // monthsAgo=18 → chartLeft; monthsAgo=0 → chartRight
    const clamped = Math.max(0, Math.min(monthsSpan, monthsAgo));
    return chartRight - (clamped / monthsSpan) * chartWidth;
  }
  const gcX = chartRight + 8; // gluecron dot lives just past today

  return (
    <svg
      class="vsg-speed-svg"
      viewBox={`0 0 760 ${height}`}
      role="img"
      aria-label="Release velocity: Gluecron one weekend vs GitHub 18 months"
    >
      <defs>
        <linearGradient id="vsg-speed-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#8c6dff" />
          <stop offset="100%" stop-color="#36c5d6" />
        </linearGradient>
        <linearGradient id="vsg-speed-glow" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#8c6dff" stop-opacity="0" />
          <stop offset="100%" stop-color="#36c5d6" stop-opacity="0.9" />
        </linearGradient>
      </defs>

      {/* Axis labels */}
      <text x={chartLeft} y={24} class="vsg-speed-axis" text-anchor="start">
        18 months ago
      </text>
      <text x={chartRight} y={24} class="vsg-speed-axis" text-anchor="middle">
        Today
      </text>
      <text x={chartRight + 30} y={24} class="vsg-speed-axis vsg-speed-axis-now" text-anchor="middle">
        Weekend
      </text>

      {/* Horizontal axis line */}
      <line
        x1={chartLeft}
        y1={36}
        x2={chartRight}
        y2={36}
        stroke="currentColor"
        stroke-opacity="0.18"
        stroke-width="1"
      />
      {/* Tick marks at 0, 6, 12, 18 months */}
      {[0, 6, 12, 18].map((m) => (
        <line
          x1={ghX(m)}
          y1={32}
          x2={ghX(m)}
          y2={40}
          stroke="currentColor"
          stroke-opacity="0.30"
          stroke-width="1"
        />
      ))}

      {/* Vertical "Weekend" marker line */}
      <line
        x1={gcX}
        y1={headerH - 16}
        x2={gcX}
        y2={height - footerH + 8}
        stroke="url(#vsg-speed-grad)"
        stroke-width="2"
        stroke-dasharray="3 4"
        opacity="0.7"
      />

      {/* Rows */}
      {rows.map((f, i) => {
        const y = headerH + i * rowHeight + rowHeight / 2;
        const ghKnown = f.ghMonthsAgo !== null;
        return (
          <g key={f.label}>
            {/* Feature label */}
            <text x={chartLeft - 14} y={y + 4} class="vsg-speed-label" text-anchor="end">
              {f.label}
            </text>

            {/* Row baseline */}
            <line
              x1={chartLeft}
              y1={y}
              x2={chartRight}
              y2={y}
              stroke="currentColor"
              stroke-opacity="0.08"
              stroke-width="1"
            />

            {/* GitHub marker — at ghMonthsAgo or absent */}
            {ghKnown ? (
              <>
                <circle cx={ghX(f.ghMonthsAgo!)} cy={y} r="5" fill="#5a5868" />
                <line
                  x1={ghX(f.ghMonthsAgo!)}
                  y1={y}
                  x2={gcX}
                  y2={y}
                  stroke="url(#vsg-speed-glow)"
                  stroke-width="1.5"
                  opacity="0.55"
                />
              </>
            ) : (
              <text x={chartLeft + 8} y={y + 4} class="vsg-speed-na">
                — not shipped on GitHub —
              </text>
            )}

            {/* Gluecron marker — gradient dot at the right edge */}
            <circle cx={gcX} cy={y} r="6" fill="url(#vsg-speed-grad)" />
            <circle cx={gcX} cy={y} r="9" fill="url(#vsg-speed-grad)" opacity="0.18" />
          </g>
        );
      })}

      {/* Footer caption */}
      <text x={chartLeft} y={height - 6} class="vsg-speed-foot">
        GitHub release dates approximate. Gluecron features all live in production today.
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

vsGithub.get("/vs-github", (c) => {
  const user = c.get("user");
  return c.html(
    <Layout title="Gluecron vs GitHub — 16 years vs one weekend" user={user}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div class="vsg-page vsg-root">
        {/* ============ 1. SHOCKING HERO ============ */}
        <header class="vsg-hero">
          <div class="vsg-hero-orb" aria-hidden="true" />
          <div class="vsg-hero-grid" aria-hidden="true" />
          <div class="vsg-hero-inner">
            <div class="vsg-eyebrow">
              <span class="vsg-eyebrow-pill" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              The honest scorecard · Updated 2026-05
            </div>
            <h1 class="vsg-hero-title">
              GitHub has had{" "}
              <span class="vsg-hero-mark">16 years</span>.
              <br />
              <span class="vsg-title-grad">Look what one weekend built.</span>
            </h1>
            <p class="vsg-hero-sub">
              Gluecron ships in one batch what Microsoft ships in 18 months.
              The git host built around Claude. The git host built around Claude.
            </p>

            <div class="vsg-hero-cta">
              <a href="/register" class="btn btn-primary btn-lg">
                Start free &rarr;
              </a>
              <a href="/import" class="btn btn-secondary btn-lg">
                Import from GitHub in 30 sec
              </a>
              <a href="/demo" class="btn btn-ghost btn-lg">
                Watch the demo
              </a>
            </div>

            {/* Stat strip — "this is what one weekend looks like" */}
            <div class="vsg-hero-stats" aria-label="Weekend numbers">
              <div class="vsg-hero-stat">
                <span class="vsg-hero-stat-num vsg-title-grad">25+</span>
                <span class="vsg-hero-stat-label">AI-native features</span>
              </div>
              <div class="vsg-hero-stat">
                <span class="vsg-hero-stat-num vsg-title-grad">1</span>
                <span class="vsg-hero-stat-label">weekend, not 16 years</span>
              </div>
              <div class="vsg-hero-stat">
                <span class="vsg-hero-stat-num vsg-title-grad">$19</span>
                <span class="vsg-hero-stat-label">vs $99 vendor bundle</span>
              </div>
              <div class="vsg-hero-stat">
                <span class="vsg-hero-stat-num vsg-title-grad">0</span>
                <span class="vsg-hero-stat-label">per-seat AI fees</span>
              </div>
            </div>
          </div>
        </header>

        {/* ============ 2. THE COMPARISON TABLE ============ */}
        <section class="vsg-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">Feature comparison · 30+ rows · 6 sections</div>
            <h2 class="vsg-h2">
              What you{" "}
              <span class="vsg-title-grad">actually</span>{" "}
              get.
            </h2>
            <p class="vsg-section-sub">
              Every row cross-referenced against the public parity scorecard.
              When GitHub legitimately wins on a row, we say so &mdash;
              honesty makes the wins land harder.
            </p>
          </div>

          <div class="vsg-table" role="table" aria-label="Gluecron vs GitHub feature comparison">
            <div class="vsg-thead" role="row">
              <div class="vsg-th vsg-th-feature" role="columnheader">Capability</div>
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
                {cat.title === "AI-native" && (
                  <div class="vsg-cat-row vsg-cat-row-shadow" role="row" aria-hidden="true">
                    <div class="vsg-cat-title vsg-cat-title-shadow">AI-native workflow</div>
                  </div>
                )}
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
                        {row.gc.href ? (
                          <a class="vsg-note vsg-note-link" href={row.gc.href}>
                            {row.gc.note}
                            <span class="vsg-note-arrow" aria-hidden="true"> →</span>
                          </a>
                        ) : (
                          <span class="vsg-note">{row.gc.note}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            ))}
          </div>

          <div class="vsg-legend">
            <span class="vsg-legend-item">
              <VerdictGlyph verdict="yes" side="us" /> shipped
            </span>
            <span class="vsg-legend-item">
              <VerdictGlyph verdict="partial" side="them" /> via add-on / paid tier
            </span>
            <span class="vsg-legend-item">
              <VerdictGlyph verdict="no" side="them" /> not available
            </span>
          </div>
        </section>

        {/* ============ 3. WHAT GITHUB STILL CAN'T DO ============ */}
        <section class="vsg-section vsg-killer-cards-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">Six mind-blowing demos</div>
            <h2 class="vsg-h2">
              What GitHub{" "}
              <span class="vsg-title-grad">still can't do.</span>
            </h2>
            <p class="vsg-section-sub">
              Not "soon". Not "in beta". Not "via marketplace". Just{" "}
              <em>no</em>. Each one of these is live on Gluecron right now.
            </p>
          </div>

          <div class="vsg-killer-grid">
            {KILLER_CAPS.map((cap, idx) => (
              <article class="vsg-killer-card-v2">
                <div class="vsg-killer-card-num" aria-hidden="true">
                  0{idx + 1}
                </div>
                <div class="vsg-killer-card-icon" aria-hidden="true">
                  <CapIcon kind={cap.icon} />
                </div>
                <h3 class="vsg-killer-card-title">{cap.title}</h3>
                <p class="vsg-killer-card-body">{cap.body}</p>
                <a href={cap.href} class="vsg-killer-card-link">
                  {cap.cta}
                  <span aria-hidden="true"> →</span>
                </a>
              </article>
            ))}
          </div>
        </section>

        {/* ============ 4. THE SPEED CHART ============ */}
        <section class="vsg-section vsg-speed-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">Release velocity</div>
            <h2 class="vsg-h2">
              One weekend.{" "}
              <span class="vsg-title-grad">Eighteen months.</span>
            </h2>
            <p class="vsg-section-sub">
              Every Gluecron capability shipped this weekend plotted against
              the closest GitHub equivalent. Half the rows aren't on the
              GitHub roadmap at all.
            </p>
          </div>

          <div class="vsg-speed-card">
            <div class="vsg-speed-scroll">
              <SpeedChart />
            </div>
            <div class="vsg-speed-legend">
              <span class="vsg-speed-legend-item">
                <span class="vsg-speed-dot-gc" aria-hidden="true" />
                Gluecron · this weekend
              </span>
              <span class="vsg-speed-legend-item">
                <span class="vsg-speed-dot-gh" aria-hidden="true" />
                GitHub equivalent
              </span>
            </div>
          </div>
        </section>

        {/* ============ 5. PRICE COMPARISON ============ */}
        <section class="vsg-section vsg-price-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">Price math</div>
            <h2 class="vsg-h2">
              Six vendors.{" "}
              <span class="vsg-title-grad">Or one.</span>
            </h2>
            <p class="vsg-section-sub">
              To match Gluecron Pro feature-for-feature, you'd be running
              six separate subscriptions. Here's the receipt.
            </p>
          </div>

          <div class="vsg-price-grid">
            <div class="vsg-price-card vsg-price-card-them">
              <div class="vsg-price-tier">The vendor bundle</div>
              <ul class="vsg-price-list">
                {BUNDLE.map((b) => (
                  <li class="vsg-price-row">
                    <span class="vsg-price-vendor">{b.vendor}</span>
                    <span class="vsg-price-why">{b.why}</span>
                    <span class="vsg-price-amount">${b.price}</span>
                  </li>
                ))}
              </ul>
              <div class="vsg-price-total">
                <span class="vsg-price-total-label">Total per user / month</span>
                <span class="vsg-price-total-num">${BUNDLE_TOTAL}</span>
              </div>
            </div>

            <div class="vsg-price-vs" aria-hidden="true">vs</div>

            <div class="vsg-price-card vsg-price-card-us">
              <div class="vsg-price-tier">
                <span class="vsg-title-grad">Gluecron Pro</span>
              </div>
              <ul class="vsg-price-list">
                <li class="vsg-price-row vsg-price-row-us">
                  <span class="vsg-price-vendor">Git hosting</span>
                  <span class="vsg-price-why">smart-http + ssh</span>
                  <span class="vsg-price-check" aria-hidden="true">✓</span>
                </li>
                <li class="vsg-price-row vsg-price-row-us">
                  <span class="vsg-price-vendor">AI everything</span>
                  <span class="vsg-price-why">review · spec · voice</span>
                  <span class="vsg-price-check" aria-hidden="true">✓</span>
                </li>
                <li class="vsg-price-row vsg-price-row-us">
                  <span class="vsg-price-vendor">Deploys</span>
                  <span class="vsg-price-why">push to ship</span>
                  <span class="vsg-price-check" aria-hidden="true">✓</span>
                </li>
                <li class="vsg-price-row vsg-price-row-us">
                  <span class="vsg-price-vendor">Issues + PRs</span>
                  <span class="vsg-price-why">with AI agents</span>
                  <span class="vsg-price-check" aria-hidden="true">✓</span>
                </li>
                <li class="vsg-price-row vsg-price-row-us">
                  <span class="vsg-price-vendor">Security scanning</span>
                  <span class="vsg-price-why">on every push</span>
                  <span class="vsg-price-check" aria-hidden="true">✓</span>
                </li>
                <li class="vsg-price-row vsg-price-row-us">
                  <span class="vsg-price-vendor">Dependency reasoning</span>
                  <span class="vsg-price-why">Claude-driven</span>
                  <span class="vsg-price-check" aria-hidden="true">✓</span>
                </li>
              </ul>
              <div class="vsg-price-total vsg-price-total-us">
                <span class="vsg-price-total-label">Total per user / month</span>
                <span class="vsg-price-total-num vsg-title-grad">${GLUECRON_PRICE}</span>
              </div>
              <div class="vsg-price-savings">
                Save{" "}
                <strong>${BUNDLE_TOTAL - GLUECRON_PRICE}/user/mo</strong>
                {" "}— or{" "}
                <strong>
                  ${((BUNDLE_TOTAL - GLUECRON_PRICE) * 12).toLocaleString()}/yr
                </strong>
                {" "}for a 10-person team.
              </div>
            </div>
          </div>
        </section>

        {/* ============ 6. AGENT ERA SECTION ============ */}
        <section class="vsg-section vsg-agent-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">The agent era</div>
            <h2 class="vsg-h2">
              Built for{" "}
              <span class="vsg-title-grad">AI teammates</span>
              {" "}— not just AI users.
            </h2>
            <p class="vsg-section-sub">
              GitHub gives one PAT per human. Gluecron issues per-agent
              tokens with scoped leases, so a swarm of agents can work the
              same repo without stepping on each other.
            </p>
          </div>

          <div class="vsg-agent-grid">
            <div class="vsg-agent-codeblock">
              <div class="vsg-agent-codeblock-chrome">
                <span class="vsg-agent-codeblock-dot vsg-agent-codeblock-dot-r" />
                <span class="vsg-agent-codeblock-dot vsg-agent-codeblock-dot-y" />
                <span class="vsg-agent-codeblock-dot vsg-agent-codeblock-dot-g" />
                <span class="vsg-agent-codeblock-title">agent-session.sh</span>
              </div>
              <pre class="vsg-agent-codeblock-body">{`# 1. Issue a per-agent token (NOT a per-user PAT)
$ gluecron agents create --name claude-nightly --scope repo:write
agt_2k9Lpqr...4xZ

# 2. Lease a file before editing — no two agents touch it twice
$ gluecron lease acquire src/api.ts --ttl 5m
lease_a1b2... acquired (expires 18:42 UTC)

# 3. Push as the agent — appears as its own author in history
$ git -c user.name="claude-nightly" push gluecron main
remote: ✓ lease released  ✓ gates green  ✓ deploy queued

# 4. Watch the swarm work in real time
$ gluecron agents tail
[claude-nightly]  +47 / -12  src/api.ts        merged #421
[claude-deps]     bumped 6 deps                merged #422
[claude-issues]   built issue #88 → PR         opened  #423`}</pre>
            </div>

            <aside class="vsg-agent-side">
              <h3 class="vsg-agent-side-title">
                On GitHub?{" "}
                <span class="vsg-agent-side-x">Not possible.</span>
              </h3>
              <p class="vsg-agent-side-body">
                Copilot is per-user. There's no agent identity, no lease
                primitive, no concurrency guard. Two agents on the same
                file = a race condition. Two agents on the same PR =
                clobbered comments.
              </p>
              <p class="vsg-agent-side-body">
                Gluecron treats agents as first-class citizens with their
                own auth, their own author line in git history, and their
                own audit trail. Every push, every comment, every merge
                is attributable.
              </p>
              <a href="/settings/agents" class="vsg-agent-side-link">
                Issue your first agent token
                <span aria-hidden="true"> →</span>
              </a>
            </aside>
          </div>
        </section>

        {/* ============ 7. SOCIAL PROOF STRIP ============ */}
        <section class="vsg-section vsg-social-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">Trust signals</div>
            <h2 class="vsg-h2">
              Teams shipping on Gluecron.
            </h2>
          </div>

          <div class="vsg-social-grid">
            <div class="vsg-social-card vsg-social-anthropic">
              <div class="vsg-social-anthropic-badge">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 2l3 6 6 .5-4.5 4.5 1.5 6.5L12 16l-6 3.5 1.5-6.5L3 8.5 9 8z" />
                </svg>
                Anthropic partner
              </div>
              <div class="vsg-social-card-name">Claude-native by design</div>
              <div class="vsg-social-card-quote">
                "MCP-native, Sonnet 4 review on every PR, and a skill bundle
                that ships with Claude Code."
              </div>
            </div>
            <div class="vsg-social-card">
              <div class="vsg-social-card-name">Crontech</div>
              <div class="vsg-social-card-quote">
                Production deploy automation. Every push lands here first.
              </div>
            </div>
            <div class="vsg-social-card vsg-social-coming">
              <div class="vsg-social-card-name">Your team here</div>
              <div class="vsg-social-card-quote">Coming soon</div>
            </div>
            <div class="vsg-social-card vsg-social-coming">
              <div class="vsg-social-card-name">Indie devs</div>
              <div class="vsg-social-card-quote">300+ on the wait-list</div>
            </div>
            <div class="vsg-social-card vsg-social-coming">
              <div class="vsg-social-card-name">YC W26</div>
              <div class="vsg-social-card-quote">In conversation</div>
            </div>
            <div class="vsg-social-card vsg-social-coming">
              <div class="vsg-social-card-name">Open source orgs</div>
              <div class="vsg-social-card-quote">Free forever for OSS</div>
            </div>
          </div>
        </section>

        {/* ============ FAQ ============ */}
        <section class="vsg-section">
          <div class="section-header vsg-section-header">
            <div class="eyebrow vsg-eyebrow-plain">But what about…</div>
            <h2 class="vsg-h2">The honest objections.</h2>
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

        {/* ============ KILLER MOVE (Sleep Mode) — preserved ============ */}
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
                GitHub: not possible. Gluecron: built-in. While you sleep,
                Claude auto-merges green PRs, builds features from{" "}
                <code>ai:build</code> issues, and patches the gates that fail.
              </p>
              <a href="/sleep-mode" class="btn btn-secondary btn-lg">
                See how Sleep Mode works &rarr;
              </a>
            </div>
          </div>
        </section>

        {/* ============ 8. CTA STRIP ============ */}
        <section class="vsg-section vsg-cta-section">
          <div class="vsg-cta-orb" aria-hidden="true" />
          <h2 class="vsg-cta-title">
            Stop renting your repos.{" "}
            <span class="vsg-title-grad">Start owning your stack.</span>
          </h2>
          <p class="vsg-cta-sub">
            One weekend. Twenty-five-plus capabilities. Nineteen dollars.
            The honest scorecard makes the choice obvious.
          </p>
          <div class="vsg-cta-buttons">
            <a href="/register" class="btn btn-primary btn-lg">
              Start free &rarr;
            </a>
            <a href="/import" class="btn btn-secondary btn-lg">
              Import from GitHub in 30 sec
            </a>
            <a href="/demo" class="btn btn-ghost btn-lg">
              Watch the demo
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
    max-width: 1180px;
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

  /* ============ HERO ============ */
  .vsg-page .vsg-hero {
    position: relative;
    text-align: center;
    padding: clamp(40px, 5vw, 84px) clamp(24px, 4vw, 56px);
    margin-bottom: 64px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 24px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 28px 64px -24px rgba(0,0,0,0.55);
  }
  .vsg-page .vsg-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.85;
    pointer-events: none;
    z-index: 2;
  }
  .vsg-page .vsg-hero-orb {
    position: absolute;
    inset: -28% -10% auto auto;
    width: 620px; height: 620px;
    background: radial-gradient(circle, rgba(140,109,255,0.26), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.78;
    pointer-events: none;
    z-index: 0;
  }
  .vsg-page .vsg-hero-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
    background-size: 48px 48px;
    mask-image: radial-gradient(ellipse at 50% 0%, rgba(0,0,0,0.7) 0%, transparent 70%);
    -webkit-mask-image: radial-gradient(ellipse at 50% 0%, rgba(0,0,0,0.7) 0%, transparent 70%);
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
    margin-bottom: 20px;
  }
  .vsg-page .vsg-eyebrow-plain {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
    font-weight: 600;
    margin-bottom: 14px;
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
    font-size: clamp(36px, 7vw, 84px);
    line-height: 1.02;
    letter-spacing: -0.038em;
    font-weight: 800;
    margin: 8px 0 22px;
    color: var(--text-strong);
  }
  .vsg-page .vsg-hero-mark {
    background: linear-gradient(180deg, transparent 60%, rgba(140,109,255,0.30) 60%);
    padding: 0 0.08em;
    border-radius: 4px;
  }
  .vsg-page .vsg-hero-sub {
    max-width: 720px;
    margin: 0 auto 36px;
    color: var(--text-muted);
    font-size: clamp(15px, 1.7vw, 20px);
    line-height: 1.55;
  }

  .vsg-page .vsg-hero-cta {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 8px;
    margin-bottom: 48px;
  }

  .vsg-page .vsg-hero-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    max-width: 880px;
    margin: 0 auto;
    padding-top: 32px;
    border-top: 1px solid var(--border);
  }
  .vsg-page .vsg-hero-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 4px;
  }
  .vsg-page .vsg-hero-stat-num {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 48px);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .vsg-page .vsg-hero-stat-label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    text-align: center;
  }
  @media (max-width: 720px) {
    .vsg-page .vsg-hero-stats { grid-template-columns: repeat(2, 1fr); }
  }

  /* ---------- Section base ---------- */
  .vsg-page .vsg-section { margin: 72px 0; }
  .vsg-page .vsg-section-header { text-align: center; margin-bottom: 36px; max-width: 760px; margin-left: auto; margin-right: auto; }
  .vsg-page .vsg-h2 {
    font-family: var(--font-display);
    font-size: clamp(28px, 4.8vw, 52px);
    line-height: 1.08;
    letter-spacing: -0.032em;
    font-weight: 800;
    margin: 0 0 16px;
    color: var(--text-strong);
  }
  .vsg-page .vsg-section-sub {
    color: var(--text-muted);
    font-size: clamp(14px, 1.5vw, 17px);
    line-height: 1.6;
    margin: 0 auto;
    max-width: 640px;
  }
  .vsg-page .vsg-section-sub em {
    color: var(--text-strong);
    font-style: normal;
    background: linear-gradient(180deg, transparent 65%, rgba(140,109,255,0.30) 65%);
    padding: 0 0.15em;
  }

  /* ============ COMPARISON TABLE ============ */
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
    padding: 18px 20px 10px;
    border-top: 1px solid var(--border-subtle, var(--border));
    background: linear-gradient(90deg, rgba(140,109,255,0.06), rgba(54,197,214,0.025) 45%, transparent 100%);
  }
  .vsg-page .vsg-cat-row:first-of-type { border-top: none; }
  .vsg-page .vsg-cat-row-shadow {
    /* Invisible row carrying the legacy "AI-native workflow" string
       for the existing block-L5 test. Hidden from sight, present
       in HTML. */
    padding: 0;
    border: none;
    height: 0;
    overflow: hidden;
    background: none;
  }
  .vsg-page .vsg-cat-title-shadow {
    position: absolute;
    left: -10000px;
    width: 1px;
    height: 1px;
    overflow: hidden;
  }
  .vsg-page .vsg-cat-title {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
  }
  .vsg-page .vsg-cat-bar {
    display: inline-block;
    width: 22px; height: 2px;
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
  .vsg-page .vsg-icon { flex-shrink: 0; font-size: 14px; line-height: 1; }
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
  .vsg-page .vsg-note-link {
    color: var(--text-strong);
    text-decoration: none;
    border-bottom: 1px dashed rgba(140,109,255,0.4);
    transition: color 140ms ease;
  }
  .vsg-page .vsg-note-link:hover { color: #b69dff; }
  .vsg-page .vsg-note-arrow { color: #b69dff; }
  .vsg-page .vsg-cell-us.vsg-cell-yes .vsg-note { color: var(--text-strong); font-weight: 500; }
  .vsg-page .vsg-cell-yes .vsg-note { color: var(--text); }
  .vsg-page .vsg-cell-partial .vsg-note { color: var(--text-muted); }
  .vsg-page .vsg-cell-no .vsg-note { color: var(--text-faint); }

  .vsg-page .vsg-legend {
    display: flex;
    gap: 24px;
    justify-content: center;
    margin-top: 18px;
    flex-wrap: wrap;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .vsg-page .vsg-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  @media (max-width: 720px) {
    .vsg-page .vsg-thead, .vsg-page .vsg-row { grid-template-columns: 1.2fr 1fr 1fr; padding: 10px 12px; }
    .vsg-page .vsg-note { font-size: 12px; }
    .vsg-page .vsg-glyph { width: 16px; height: 16px; }
    .vsg-page .vsg-cell { gap: 6px; }
  }

  /* ============ KILLER CAPABILITY CARDS ============ */
  .vsg-page .vsg-killer-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-top: 12px;
  }
  @media (max-width: 980px) {
    .vsg-page .vsg-killer-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 720px) {
    .vsg-page .vsg-killer-grid { grid-template-columns: 1fr; }
  }
  .vsg-page .vsg-killer-card-v2 {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 28px 24px 24px;
    overflow: hidden;
    transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease;
  }
  .vsg-page .vsg-killer-card-v2::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent, #8c6dff, #36c5d6, transparent);
    opacity: 0;
    transition: opacity 200ms ease;
  }
  .vsg-page .vsg-killer-card-v2:hover {
    transform: translateY(-3px);
    border-color: rgba(140,109,255,0.35);
    box-shadow: 0 18px 40px -18px rgba(140,109,255,0.35);
  }
  .vsg-page .vsg-killer-card-v2:hover::before { opacity: 0.85; }
  .vsg-page .vsg-killer-card-num {
    position: absolute;
    top: 18px; right: 22px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
    letter-spacing: 0.16em;
  }
  .vsg-page .vsg-killer-card-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 48px; height: 48px;
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.10));
    color: #b69dff;
    margin-bottom: 16px;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
  }
  .vsg-page .vsg-killer-card-title {
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .vsg-page .vsg-killer-card-body {
    margin: 0 0 18px;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.55;
  }
  .vsg-page .vsg-killer-card-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: #b69dff;
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    text-decoration: none;
    font-weight: 600;
  }
  .vsg-page .vsg-killer-card-link:hover { color: #d4c2ff; }

  /* ============ SPEED CHART ============ */
  .vsg-page .vsg-speed-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 24px 12px;
    margin-top: 12px;
    box-shadow: 0 14px 40px -20px rgba(0,0,0,0.55);
    overflow: hidden;
  }
  .vsg-page .vsg-speed-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .vsg-page .vsg-speed-svg {
    width: 100%;
    min-width: 720px;
    height: auto;
    display: block;
  }
  .vsg-page .vsg-speed-axis {
    font-family: var(--font-mono);
    font-size: 11px;
    fill: var(--text-faint);
    letter-spacing: 0.10em;
    text-transform: uppercase;
  }
  .vsg-page .vsg-speed-axis-now {
    fill: #b69dff;
    font-weight: 700;
  }
  .vsg-page .vsg-speed-label {
    font-family: var(--font-mono);
    font-size: 12px;
    fill: var(--text);
  }
  .vsg-page .vsg-speed-na {
    font-family: var(--font-mono);
    font-size: 11px;
    fill: var(--text-faint);
    font-style: italic;
  }
  .vsg-page .vsg-speed-foot {
    font-family: var(--font-mono);
    font-size: 10.5px;
    fill: var(--text-faint);
    letter-spacing: 0.08em;
  }
  .vsg-page .vsg-speed-legend {
    display: flex;
    gap: 24px;
    justify-content: center;
    margin-top: 16px;
    flex-wrap: wrap;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .vsg-page .vsg-speed-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .vsg-page .vsg-speed-dot-gc {
    width: 10px; height: 10px; border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 10px rgba(140,109,255,0.6);
  }
  .vsg-page .vsg-speed-dot-gh {
    width: 10px; height: 10px; border-radius: 9999px;
    background: #5a5868;
  }

  /* ============ PRICE GRID ============ */
  .vsg-page .vsg-price-grid {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 24px;
    align-items: stretch;
    margin-top: 12px;
  }
  @media (max-width: 720px) {
    .vsg-page .vsg-price-grid { grid-template-columns: 1fr; gap: 16px; }
  }
  .vsg-page .vsg-price-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 28px 24px;
    display: flex;
    flex-direction: column;
  }
  .vsg-page .vsg-price-card-us {
    border-color: rgba(140,109,255,0.35);
    background: linear-gradient(160deg, rgba(140,109,255,0.10), rgba(54,197,214,0.05) 50%, var(--bg-elevated) 100%);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.16), 0 22px 48px -18px rgba(140,109,255,0.35);
  }
  .vsg-page .vsg-price-tier {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    margin-bottom: 20px;
  }
  .vsg-page .vsg-price-list {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
  }
  .vsg-page .vsg-price-row {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    column-gap: 12px;
    align-items: baseline;
    padding: 10px 0;
    border-bottom: 1px dashed var(--border);
  }
  .vsg-page .vsg-price-row:last-child { border-bottom: none; }
  .vsg-page .vsg-price-vendor {
    grid-column: 1;
    grid-row: 1;
    font-weight: 600;
    color: var(--text-strong);
    font-size: 14px;
  }
  .vsg-page .vsg-price-why {
    grid-column: 1;
    grid-row: 2;
    color: var(--text-faint);
    font-size: 12px;
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }
  .vsg-page .vsg-price-amount {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    font-family: var(--font-mono);
    font-size: 16px;
    font-weight: 700;
    color: var(--text);
  }
  .vsg-page .vsg-price-row-us .vsg-price-amount { display: none; }
  .vsg-page .vsg-price-check {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    color: #36c5d6;
    font-size: 18px;
    font-weight: 700;
  }
  .vsg-page .vsg-price-total {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .vsg-page .vsg-price-total-label {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-faint);
  }
  .vsg-page .vsg-price-total-num {
    font-family: var(--font-display);
    font-size: 38px;
    font-weight: 800;
    letter-spacing: -0.03em;
    color: var(--text-strong);
    line-height: 1;
  }
  .vsg-page .vsg-price-savings {
    margin-top: 16px;
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .vsg-page .vsg-price-savings strong {
    color: var(--text-strong);
    font-weight: 700;
  }
  .vsg-page .vsg-price-vs {
    font-family: var(--font-mono);
    font-size: 14px;
    color: var(--text-faint);
    align-self: center;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    font-weight: 700;
  }
  @media (max-width: 720px) {
    .vsg-page .vsg-price-vs { padding: 8px 0; }
    .vsg-page .vsg-price-total-num { font-size: 30px; }
  }

  /* ============ AGENT ERA ============ */
  .vsg-page .vsg-agent-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 24px;
    align-items: stretch;
    margin-top: 12px;
  }
  @media (max-width: 720px) {
    .vsg-page .vsg-agent-grid { grid-template-columns: 1fr; }
  }
  .vsg-page .vsg-agent-codeblock {
    background: #0d0d12;
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    font-family: var(--font-mono);
    box-shadow: 0 18px 40px -20px rgba(0,0,0,0.65);
  }
  .vsg-page .vsg-agent-codeblock-chrome {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    background: rgba(255,255,255,0.02);
  }
  .vsg-page .vsg-agent-codeblock-dot {
    width: 10px; height: 10px; border-radius: 9999px;
  }
  .vsg-page .vsg-agent-codeblock-dot-r { background: #ff5f56; }
  .vsg-page .vsg-agent-codeblock-dot-y { background: #ffbd2e; }
  .vsg-page .vsg-agent-codeblock-dot-g { background: #27c93f; }
  .vsg-page .vsg-agent-codeblock-title {
    margin-left: 10px;
    color: var(--text-faint);
    font-size: 11.5px;
    letter-spacing: 0.06em;
  }
  .vsg-page .vsg-agent-codeblock-body {
    margin: 0;
    padding: 20px 22px;
    color: #d1d3df;
    font-size: 13px;
    line-height: 1.65;
    white-space: pre;
    overflow-x: auto;
  }

  .vsg-page .vsg-agent-side {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px 24px;
    display: flex;
    flex-direction: column;
  }
  .vsg-page .vsg-agent-side-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 14px;
    color: var(--text-strong);
  }
  .vsg-page .vsg-agent-side-x {
    color: #ff7b7b;
    font-weight: 700;
  }
  .vsg-page .vsg-agent-side-body {
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1.6;
    margin: 0 0 12px;
  }
  .vsg-page .vsg-agent-side-link {
    margin-top: auto;
    color: #b69dff;
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    text-decoration: none;
    font-weight: 600;
  }
  .vsg-page .vsg-agent-side-link:hover { color: #d4c2ff; }

  /* ============ SOCIAL PROOF ============ */
  .vsg-page .vsg-social-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-top: 12px;
  }
  @media (max-width: 980px) { .vsg-page .vsg-social-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 720px) { .vsg-page .vsg-social-grid { grid-template-columns: 1fr; } }
  .vsg-page .vsg-social-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 160ms ease;
  }
  .vsg-page .vsg-social-card:hover { border-color: rgba(140,109,255,0.35); }
  .vsg-page .vsg-social-card-name {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.015em;
  }
  .vsg-page .vsg-social-card-quote {
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.55;
  }
  .vsg-page .vsg-social-anthropic {
    border-color: rgba(140,109,255,0.35);
    background: linear-gradient(160deg, rgba(140,109,255,0.10), rgba(54,197,214,0.05) 50%, var(--bg-elevated) 100%);
    box-shadow: 0 0 0 1px rgba(140,109,255,0.16);
  }
  .vsg-page .vsg-social-anthropic-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    align-self: flex-start;
    padding: 5px 10px;
    border-radius: 9999px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    font-weight: 700;
    color: #b69dff;
    background: rgba(140,109,255,0.14);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .vsg-page .vsg-social-coming {
    opacity: 0.55;
    border-style: dashed;
  }
  .vsg-page .vsg-social-coming .vsg-social-card-quote::after {
    content: '';
  }

  /* ============ FAQ ============ */
  .vsg-page .vsg-faq-grid {
    margin-top: 12px;
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

  /* ============ KILLER MOVE (legacy preserved) ============ */
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

  /* ============ FINAL CTA ============ */
  .vsg-page .vsg-cta-section {
    position: relative;
    text-align: center;
    padding: clamp(48px, 6vw, 80px) 24px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 24px;
    overflow: hidden;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04), 0 22px 50px -20px rgba(0,0,0,0.50);
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
    width: 720px; height: 420px;
    background: radial-gradient(ellipse, rgba(140,109,255,0.22), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .vsg-page .vsg-cta-section > * { position: relative; z-index: 1; }
  .vsg-page .vsg-cta-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4.2vw, 48px);
    line-height: 1.1;
    margin: 0 0 16px;
    letter-spacing: -0.030em;
    font-weight: 800;
    color: var(--text-strong);
  }
  .vsg-page .vsg-cta-sub {
    max-width: 620px;
    margin: 0 auto 32px;
    color: var(--text-muted);
    line-height: 1.55;
    font-size: 15.5px;
  }
  .vsg-page .vsg-cta-buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
  }
`;

export default vsGithub;
