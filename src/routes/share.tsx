/**
 * Shareable "AI hours saved" cards — viral growth lever for Twitter / LinkedIn.
 *
 *   GET /share/hours-saved?user=:username
 *       Returns a 1200×630 SVG OG image card showing how many hours the user
 *       (or the platform globally) has saved with AI tooling.
 *
 *   GET /share/:username
 *       HTML landing page with proper OG meta tags (og:image points to the
 *       SVG endpoint above), a live stat display, and a "Share on Twitter"
 *       button with pre-filled tweet text.
 *
 * Hours-saved formula (all-time, per user):
 *   - AI-merged PRs  × 1.5 h  (source: auditLog action="auto_merge.merged",
 *                                joined to pull_requests where authorId = user)
 *   - AI reviews     × 0.5 h  (source: pr_comments where isAiReview=true and
 *                                the PR's repository is owned by the user)
 *   - CI heals       × 0.3 h  (source: gate_runs where repairSucceeded=true and
 *                                repositoryId in user's repos)
 *
 * For missing / unauthenticated users the SVG and page fall back to
 * platform-wide aggregate stats.
 *
 * No new npm dependencies — pure SVG text, no canvas / sharp / puppeteer.
 */

import { Hono } from "hono";
import { eq, and, sql, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  pullRequests,
  prComments,
  gateRuns,
  repositories,
  auditLog,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const share = new Hono<AuthEnv>();
share.use("*", softAuth);

// ─── Hours computation ────────────────────────────────────────────────────

interface HoursSaved {
  aiMergedPrs: number;
  aiReviews: number;
  ciHeals: number;
  totalHours: number;
}

/** Compute hours saved for a specific user (all-time). */
async function computeHoursForUser(userId: string): Promise<HoursSaved> {
  // Repos owned by the user — needed for CI heals and AI-review lookups.
  const userRepos = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.ownerId, userId));

  const repoIds = userRepos.map((r) => r.id);

  // 1. AI-merged PRs: audit_log rows where action='auto_merge.merged' and
  //    the associated PR was authored by the user.
  let aiMergedPrs = 0;
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "auto_merge.merged"),
          eq(auditLog.userId, userId)
        )
      );
    aiMergedPrs = Number(row?.n ?? 0);
  } catch {
    aiMergedPrs = 0;
  }

  // 2. AI reviews: pr_comments with isAiReview=true on PRs in user's repos.
  let aiReviews = 0;
  try {
    if (repoIds.length > 0) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(prComments)
        .innerJoin(
          pullRequests,
          eq(prComments.pullRequestId, pullRequests.id)
        )
        .where(
          and(
            eq(prComments.isAiReview, true),
            inArray(pullRequests.repositoryId, repoIds)
          )
        );
      aiReviews = Number(row?.n ?? 0);
    }
  } catch {
    aiReviews = 0;
  }

  // 3. CI heals: gate_runs where repairSucceeded=true on user's repos.
  let ciHeals = 0;
  try {
    if (repoIds.length > 0) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(gateRuns)
        .where(
          and(
            eq(gateRuns.repairSucceeded, true),
            inArray(gateRuns.repositoryId, repoIds)
          )
        );
      ciHeals = Number(row?.n ?? 0);
    }
  } catch {
    ciHeals = 0;
  }

  const totalHours =
    aiMergedPrs * 1.5 + aiReviews * 0.5 + ciHeals * 0.3;

  return { aiMergedPrs, aiReviews, ciHeals, totalHours };
}

/** Platform-wide aggregate hours saved (for fallback / anonymous). */
async function computeGlobalHours(): Promise<HoursSaved> {
  let aiMergedPrs = 0;
  let aiReviews = 0;
  let ciHeals = 0;

  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.action, "auto_merge.merged"));
    aiMergedPrs = Number(row?.n ?? 0);
  } catch {
    aiMergedPrs = 0;
  }

  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(prComments)
      .where(eq(prComments.isAiReview, true));
    aiReviews = Number(row?.n ?? 0);
  } catch {
    aiReviews = 0;
  }

  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gateRuns)
      .where(eq(gateRuns.repairSucceeded, true));
    ciHeals = Number(row?.n ?? 0);
  } catch {
    ciHeals = 0;
  }

  const totalHours =
    aiMergedPrs * 1.5 + aiReviews * 0.5 + ciHeals * 0.3;

  return { aiMergedPrs, aiReviews, ciHeals, totalHours };
}

/** Format a number to one decimal place, dropping ".0" when it's clean. */
function fmtHours(n: number): string {
  if (n === 0) return "0";
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

// ─── SVG OG image ────────────────────────────────────────────────────────

/**
 * GET /share/hours-saved?user=:username
 * Returns a 1200×630 SVG card suitable for use as an OG image.
 */
share.get("/share/hours-saved", async (c) => {
  const username = c.req.query("user") ?? "";
  let stats: HoursSaved;
  let displayName = username || "the community";
  let atName = username ? `@${username}` : "gluecron.com";
  let isGlobal = !username;

  if (username) {
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (found) {
      stats = await computeHoursForUser(found.id);
    } else {
      // Unknown user — fall back to global
      stats = await computeGlobalHours();
      displayName = "the community";
      atName = "gluecron.com";
      isGlobal = true;
    }
  } else {
    stats = await computeGlobalHours();
  }

  const hoursStr = fmtHours(stats.totalHours);
  const label = isGlobal
    ? "hours saved with AI — platform-wide"
    : "hours saved with AI";

  const svg = buildOgSvg({ hoursStr, label, atName, stats });

  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300, s-maxage=900");
  return c.body(svg);
});

/** Build the 1200×630 SVG string. Pure function — no I/O. */
function buildOgSvg({
  hoursStr,
  label,
  atName,
  stats,
}: {
  hoursStr: string;
  label: string;
  atName: string;
  stats: HoursSaved;
}): string {
  // Estimate text width for the giant number so we can center it.
  // Each digit ≈ 95px wide at font-size 160; decimal point ≈ 32px.
  const charWidths: Record<string, number> = {
    "0": 95, "1": 70, "2": 95, "3": 95, "4": 95,
    "5": 95, "6": 95, "7": 85, "8": 95, "9": 95,
    ".": 32,
  };
  const numWidth = [...hoursStr].reduce(
    (w, ch) => w + (charWidths[ch] ?? 90),
    0
  );
  const numX = Math.round(600 - numWidth / 2);

  const pill = (x: number, y: number, n: number, text: string) =>
    `<g transform="translate(${x},${y})">
      <rect x="0" y="0" width="240" height="46" rx="10" fill="rgba(0,255,136,0.08)" stroke="rgba(0,255,136,0.22)" stroke-width="1"/>
      <text x="20" y="30" font-family="'Courier New',monospace" font-size="14" fill="#00ff88" font-weight="700">${n.toLocaleString()}</text>
      <text x="60" y="30" font-family="'Courier New',monospace" font-size="14" fill="#8b949e">${text}</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#0a0e14"/>
    </linearGradient>
    <linearGradient id="num-grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#00ff88"/>
      <stop offset="100%" stop-color="#00e5ff"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <!-- radial glow orb behind the number -->
    <radialGradient id="orb-grad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(0,255,136,0.10)"/>
      <stop offset="100%" stop-color="rgba(0,255,136,0)"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg-grad)"/>

  <!-- Subtle grid lines -->
  <line x1="0" y1="1" x2="1200" y2="1" stroke="#30363d" stroke-width="1"/>
  <line x1="0" y1="629" x2="1200" y2="629" stroke="#30363d" stroke-width="1"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="1200" height="3" fill="url(#num-grad)" opacity="0.85"/>

  <!-- Gluecron logo / wordmark -->
  <text x="60" y="72" font-family="'Courier New',monospace" font-size="22" font-weight="700" fill="#00ff88" letter-spacing="0.18em">GLUECRON</text>
  <text x="222" y="72" font-family="'Courier New',monospace" font-size="14" fill="#444c56">· AI-native git platform</text>

  <!-- Orb glow behind number -->
  <ellipse cx="600" cy="310" rx="320" ry="180" fill="url(#orb-grad)"/>

  <!-- Giant hours number -->
  <text
    x="${numX}"
    y="340"
    font-family="'Courier New',monospace"
    font-size="160"
    font-weight="700"
    fill="url(#num-grad)"
    filter="url(#glow)"
  >${hoursStr}</text>

  <!-- Label below number -->
  <text x="600" y="400" text-anchor="middle" font-family="'Courier New',monospace" font-size="26" fill="#e6edf3" letter-spacing="0.01em">${label}</text>

  <!-- Breakdown pills -->
  ${pill(60, 450, stats.aiMergedPrs, "auto-merged PRs × 1.5h")}
  ${pill(330, 450, stats.aiReviews, "AI reviews × 0.5h")}
  ${pill(600, 450, stats.ciHeals, "CI heals × 0.3h")}

  <!-- Bottom footer -->
  <line x1="60" y1="548" x2="1140" y2="548" stroke="#21262d" stroke-width="1"/>
  <text x="60" y="580" font-family="'Courier New',monospace" font-size="18" fill="#8b949e">gluecron.com</text>
  <text x="1140" y="580" text-anchor="end" font-family="'Courier New',monospace" font-size="18" fill="#8b949e">${escSvg(atName)}</text>
</svg>`;
}

/** Escape special XML/SVG characters in text content. */
function escSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Shareable HTML page ──────────────────────────────────────────────────

const shareStyles = `
  .share-wrap { max-width: 860px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .share-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(32px,5vw,56px) clamp(24px,4vw,48px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 18px;
    overflow: hidden;
    text-align: center;
  }
  .share-hero::before {
    content: '';
    position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, transparent 0%, #00ff88 30%, #00e5ff 70%, transparent 100%);
    opacity: 0.85; pointer-events: none;
  }
  .share-orb {
    position: absolute;
    inset: -20% 10% auto 10%;
    width: 80%; height: 300px;
    background: radial-gradient(ellipse, rgba(0,255,136,0.10), rgba(0,229,255,0.06) 50%, transparent 80%);
    filter: blur(60px); opacity: 0.8;
    pointer-events: none; z-index: 0;
  }
  .share-hero-inner { position: relative; z-index: 1; }

  .share-eyebrow {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--text-muted); font-weight: 600;
    margin-bottom: var(--space-3);
  }
  .share-eyebrow-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 9999px;
    background: #00ff88; box-shadow: 0 0 0 3px rgba(0,255,136,0.18);
    margin-right: 8px; vertical-align: middle;
  }

  .share-hours-num {
    font-family: var(--font-mono);
    font-size: clamp(64px, 14vw, 120px);
    font-weight: 700;
    line-height: 1;
    background: linear-gradient(135deg, #00ff88 0%, #00e5ff 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent; color: transparent;
    letter-spacing: -0.03em;
    margin: 0 0 var(--space-2);
  }
  .share-hours-label {
    font-size: clamp(16px, 3vw, 22px);
    color: var(--text);
    font-weight: 600;
    margin: 0 0 var(--space-4);
    letter-spacing: -0.01em;
  }

  .share-pills {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: var(--space-2); margin-bottom: var(--space-4);
  }
  .share-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 14px; border-radius: 9999px;
    background: rgba(0,255,136,0.08);
    border: 1px solid rgba(0,255,136,0.22);
    font-family: var(--font-mono); font-size: 13px; color: #e6edf3;
  }
  .share-pill-num { color: #00ff88; font-weight: 700; }

  .share-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-3); }
  .share-btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 22px; border-radius: 10px; font-size: 14px; font-weight: 600;
    text-decoration: none; cursor: pointer; border: none; transition: opacity 150ms ease;
  }
  .share-btn:hover { opacity: 0.85; }
  .share-btn-twitter {
    background: #1d9bf0; color: #fff;
  }
  .share-btn-copy {
    background: rgba(0,255,136,0.12);
    border: 1px solid rgba(0,255,136,0.30);
    color: #00ff88;
  }
  .share-btn-copy:hover { background: rgba(0,255,136,0.20); }

  .share-preview-wrap {
    margin-bottom: var(--space-5);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .share-preview-head {
    padding: 12px 20px; border-bottom: 1px solid var(--border);
    font-size: 12px; color: var(--text-muted); font-weight: 500;
    display: flex; align-items: center; gap: 8px;
  }
  .share-preview-dot { width: 8px; height: 8px; border-radius: 9999px; background: var(--border-strong); }
  .share-preview-img { display: block; width: 100%; }

  .share-breakdown {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .share-breakdown-head {
    padding: 14px 20px; border-bottom: 1px solid var(--border);
    font-size: 13px; font-weight: 700; color: var(--text-strong);
  }
  .share-breakdown-body { padding: 0; }
  .share-stat-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 20px; border-bottom: 1px solid var(--border-subtle);
    font-size: 13.5px;
  }
  .share-stat-row:last-child { border-bottom: 0; }
  .share-stat-label { color: var(--text-muted); }
  .share-stat-val { font-family: var(--font-mono); font-weight: 600; color: var(--text-strong); }
  .share-stat-hrs { color: #00ff88; margin-left: 8px; font-size: 12px; }

  .share-foot {
    text-align: center; font-size: 12.5px; color: var(--text-muted);
    padding-top: var(--space-4); border-top: 1px solid var(--border);
  }
  .share-foot a { color: var(--accent); text-decoration: none; }
  .share-foot a:hover { text-decoration: underline; }
`;

/**
 * GET /share/:username
 * HTML page with OG meta tags + stat display + Twitter share button.
 */
share.get("/share/:username", async (c) => {
  const username = c.req.param("username");
  const user = c.get("user");

  let targetUser: typeof users.$inferSelect | null = null;
  let stats: HoursSaved;
  let isGlobal = false;

  const [found] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (found) {
    targetUser = found;
    stats = await computeHoursForUser(found.id);
  } else {
    // Unknown user — show global stats with a note
    stats = await computeGlobalHours();
    isGlobal = true;
  }

  const hoursStr = fmtHours(stats.totalHours);
  const ogImageUrl = `/share/hours-saved?user=${encodeURIComponent(username)}`;

  const ogTitle = isGlobal
    ? `The Gluecron community saved ${hoursStr} hours with AI`
    : `I saved ${hoursStr} hours with Gluecron AI`;

  const ogDesc =
    "AI review, auto-merge, and spec-to-PR — all automatic. Try Gluecron free.";

  // Pre-filled tweet text
  const tweetText = isGlobal
    ? `The @gluecron community has saved ${hoursStr} hours with AI review, auto-merge, and CI healing. This is what AI-native git looks like. gluecron.com/share/${username}`
    : `I've saved ${hoursStr} hours using @gluecron's AI review, auto-merge, and CI healing. This is what AI-native git looks like. gluecron.com/share/${username}`;

  const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
  const shareUrl = `https://gluecron.com/share/${username}`;

  return c.html(
    <Layout
      title={ogTitle + " — Gluecron"}
      user={user}
      ogTitle={ogTitle}
      ogDescription={ogDesc}
      ogType="website"
      twitterCard="summary_large_image"
    >
      <style dangerouslySetInnerHTML={{ __html: shareStyles }} />
      {/* og:image injected inline since Layout doesn't support it yet */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function(){
              var m = document.createElement('meta');
              m.setAttribute('property','og:image');
              m.setAttribute('content','${ogImageUrl}');
              document.head.appendChild(m);
              var tw = document.createElement('meta');
              tw.setAttribute('name','twitter:image');
              tw.setAttribute('content','${ogImageUrl}');
              document.head.appendChild(tw);
            })();
          `,
        }}
      />
      <div class="share-wrap">
        {/* Hero card */}
        <section class="share-hero">
          <div class="share-orb" aria-hidden="true" />
          <div class="share-hero-inner">
            <div class="share-eyebrow">
              <span class="share-eyebrow-dot" aria-hidden="true" />
              {isGlobal
                ? "Platform-wide · all-time · AI impact"
                : `@${username} · all-time · AI impact`}
            </div>

            <div class="share-hours-num">{hoursStr}</div>
            <p class="share-hours-label">
              {isGlobal
                ? "hours saved with AI — platform-wide"
                : "hours saved with AI"}
            </p>

            <div class="share-pills">
              <span class="share-pill">
                <span class="share-pill-num">{stats.aiMergedPrs.toLocaleString()}</span>
                auto-merged PRs
              </span>
              <span class="share-pill">
                <span class="share-pill-num">{stats.aiReviews.toLocaleString()}</span>
                AI reviews
              </span>
              <span class="share-pill">
                <span class="share-pill-num">{stats.ciHeals.toLocaleString()}</span>
                CI heals
              </span>
            </div>

            <div class="share-actions">
              <a
                href={twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="share-btn share-btn-twitter"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                Share on X / Twitter
              </a>
              <button
                class="share-btn share-btn-copy"
                onclick={`navigator.clipboard.writeText('${shareUrl}').then(()=>this.textContent='Copied!').catch(()=>{})`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                Copy link
              </button>
            </div>
          </div>
        </section>

        {/* OG image preview */}
        <div class="share-preview-wrap">
          <div class="share-preview-head">
            <span class="share-preview-dot" aria-hidden="true" />
            <span class="share-preview-dot" aria-hidden="true" />
            <span class="share-preview-dot" aria-hidden="true" />
            OG image preview — how this link appears when shared
          </div>
          <img
            src={ogImageUrl}
            alt={`OG image card: ${hoursStr} hours saved`}
            class="share-preview-img"
            loading="lazy"
          />
        </div>

        {/* Breakdown table */}
        <section class="share-breakdown">
          <div class="share-breakdown-head">How hours are calculated</div>
          <div class="share-breakdown-body">
            <div class="share-stat-row">
              <span class="share-stat-label">AI-merged pull requests</span>
              <span class="share-stat-val">
                {stats.aiMergedPrs.toLocaleString()}
                <span class="share-stat-hrs">× 1.5h = {fmtHours(stats.aiMergedPrs * 1.5)}h</span>
              </span>
            </div>
            <div class="share-stat-row">
              <span class="share-stat-label">AI code reviews</span>
              <span class="share-stat-val">
                {stats.aiReviews.toLocaleString()}
                <span class="share-stat-hrs">× 0.5h = {fmtHours(stats.aiReviews * 0.5)}h</span>
              </span>
            </div>
            <div class="share-stat-row">
              <span class="share-stat-label">CI heals (auto-repair)</span>
              <span class="share-stat-val">
                {stats.ciHeals.toLocaleString()}
                <span class="share-stat-hrs">× 0.3h = {fmtHours(stats.ciHeals * 0.3)}h</span>
              </span>
            </div>
            <div class="share-stat-row">
              <span class="share-stat-label" style="font-weight:700;color:var(--text-strong)">Total hours saved</span>
              <span class="share-stat-val" style="color:#00ff88;font-size:16px">{hoursStr}h</span>
            </div>
          </div>
        </section>

        <p class="share-foot">
          {isGlobal ? (
            <>
              Platform-wide stats. Want your personal card?{" "}
              <a href="/register">Sign up free</a> and visit{" "}
              <a href="/share/{your-username}">/share/{"{your-username}"}</a>.
            </>
          ) : (
            <>
              Share your stats · <a href="/billing/usage">View AI usage dashboard</a> ·{" "}
              <a href="/">Back to Gluecron</a>
            </>
          )}
        </p>
      </div>
    </Layout>
  );
});

export default share;
