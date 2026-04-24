/**
 * Health badge endpoint — public, no auth required.
 *
 * GET /badge/:owner/:repo
 *   Returns a shields.io-style SVG badge showing the repo's health grade.
 *   If no score has been computed yet, triggers a background computation
 *   and returns a grey "computing" badge.
 *
 * Cache-Control headers allow CDNs to cache the badge for up to 1 hour.
 * The badge is suitable for embedding in GitHub READMEs and other
 * Markdown-rendered surfaces.
 */

import { Hono } from "hono";
import {
  getLatestHealthScore,
  computeAndStoreHealthScore,
  getBadgeColor,
} from "../lib/health-score";
import { loadRepoByPath } from "../lib/namespace";

const badge = new Hono();

/**
 * Generate a shields.io-style SVG badge.
 *
 * Left panel: "health" label on dark grey (#555), 62px wide.
 * Right panel: grade letter (A–F or "?") coloured by getBadgeColor, 28px wide.
 * Total: 90×20px, rounded corners rx=3.
 * Font: DejaVu Sans 11px with 1px drop shadow.
 */
function makeBadgeSvg(grade: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="90" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="90" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="62" height="20" fill="#555"/>
    <rect x="62" width="28" height="20" fill="${color}"/>
    <rect width="90" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="32" y="15" fill="#010101" fill-opacity=".3" lengthAdjust="spacing">health</text>
    <text x="32" y="14" lengthAdjust="spacing">health</text>
    <text x="76" y="15" fill="#010101" fill-opacity=".3" font-weight="bold">${grade}</text>
    <text x="76" y="14" font-weight="bold">${grade}</text>
  </g>
</svg>`;
}

badge.get("/badge/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();

  // Set SVG content type and cache headers up front — we always return SVG.
  c.header("Content-Type", "image/svg+xml");
  c.header("Cache-Control", "max-age=3600, s-maxage=3600");
  c.header("X-Content-Type-Options", "nosniff");

  // Load the repo — for public repos no auth is required.
  const repoRow = await loadRepoByPath(owner, repo);

  if (!repoRow) {
    // Unknown repo — return a grey "unknown" badge rather than 404 so the
    // image tag doesn't break in READMEs.
    return c.body(makeBadgeSvg("?", "#9f9f9f"), 200);
  }

  // Private repos don't expose their health score publicly.
  if (repoRow.isPrivate) {
    return c.body(makeBadgeSvg("?", "#9f9f9f"), 200);
  }

  // Try to load an existing score.
  const scoreRow = await getLatestHealthScore(repoRow.id);

  if (!scoreRow) {
    // No score yet — fire a background computation and show a computing badge.
    computeAndStoreHealthScore(repoRow.id, owner, repo).catch((err) => {
      console.error("[badge] background compute failed:", err);
    });
    return c.body(makeBadgeSvg("?", "#9f9f9f"), 200);
  }

  const color = getBadgeColor(scoreRow.grade);
  return c.body(makeBadgeSvg(scoreRow.grade, color), 200);
});

export default badge;
