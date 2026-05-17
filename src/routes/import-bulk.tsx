/**
 * Bulk GitHub import — "paste my org + token → import everything".
 *
 * Owner flow for migrating many products at once. Reuses the single-repo
 * import logic from `src/lib/import-helper.ts` so the clone + DB insert
 * code path is identical to `/import`.
 *
 * Token never leaves this process: it's read from the form body, passed
 * to GitHub's API via `Authorization` header, and embedded in the git
 * clone URL only at the moment of spawning `git`. Results never contain
 * the token — `scrubSecrets()` in the helper redacts it before display.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  sanitizeRepoName,
  importOneRepo,
  type ImportOneRepoResult,
} from "../lib/import-helper";

const importBulkRoutes = new Hono<AuthEnv>();

importBulkRoutes.use("*", softAuth);

// Hard limits to keep a single request bounded.
const MAX_REPOS = 200;
const MAX_REPO_SIZE_KB = 500 * 1024; // 500 MB in KB (GitHub reports size in KB)
const GITHUB_PER_PAGE = 100;

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  clone_url: string;
  default_branch: string;
  fork: boolean;
  size: number; // KB
}

type Visibility = "public" | "private" | "both";

// ─── PAGE-SCOPED CSS ─────────────────────────────────────────
// All classes prefixed with .import-bulk- so the block cannot bleed
// into neighbouring routes. Mirrors the /import polish.
const importBulkStyles = `
  .import-bulk-container { max-width: 880px; margin: 0 auto; }

  /* ─── Hero ─── */
  .import-bulk-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .import-bulk-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .import-bulk-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .import-bulk-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: importBulkHeroOrb 14s ease-in-out infinite;
  }
  @keyframes importBulkHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .import-bulk-hero-orb { animation: none; }
  }
  .import-bulk-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .import-bulk-hero-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: -0.005em;
  }
  .import-bulk-hero-eyebrow-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px rgba(140,109,255,0.6);
    margin-right: 8px;
    vertical-align: 1px;
  }
  .import-bulk-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .import-bulk-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .import-bulk-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Banners ─── */
  .import-bulk-banner {
    position: relative;
    padding: 14px 16px 14px 44px;
    margin-bottom: var(--space-5);
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 14px;
    line-height: 1.5;
  }
  .import-bulk-banner::before {
    content: '';
    position: absolute;
    left: 14px; top: 18px;
    width: 14px; height: 14px;
    border-radius: 50%;
  }
  .import-bulk-banner-error {
    border-color: rgba(248, 81, 73, 0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
  }
  .import-bulk-banner-error::before {
    background: radial-gradient(circle, #f85149 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(248,81,73,0.5);
  }
  .import-bulk-banner-title { font-weight: 600; color: var(--text-strong); }
  .import-bulk-banner-detail { color: var(--text-muted); margin-top: 4px; font-size: 13.5px; }

  /* ─── Section cards ─── */
  .import-bulk-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .import-bulk-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .import-bulk-section-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .import-bulk-section-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.018em;
    margin: 0 0 4px;
    color: var(--text-strong);
  }
  .import-bulk-section-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .import-bulk-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Form ─── */
  .import-bulk-field { margin-bottom: var(--space-4); }
  .import-bulk-field:last-child { margin-bottom: 0; }
  .import-bulk-field-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 6px;
    letter-spacing: -0.005em;
  }
  .import-bulk-field-label code {
    font-size: 12px;
    background: var(--bg-tertiary, var(--bg-secondary));
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 500;
    color: var(--text-muted);
  }
  .import-bulk-input,
  .import-bulk-select {
    width: 100%;
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
    font-family: var(--font-sans);
  }
  .import-bulk-input.is-mono { font-family: var(--font-mono); font-size: 13px; }
  .import-bulk-input:focus,
  .import-bulk-select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }

  /* ─── Toggle row (dry-run checkbox) ─── */
  .import-bulk-toggle {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    transition: border-color 120ms ease;
  }
  .import-bulk-toggle:hover { border-color: var(--border); }
  .import-bulk-toggle input[type="checkbox"] {
    margin-top: 2px;
    width: 16px; height: 16px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .import-bulk-toggle-text {
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.45;
  }
  .import-bulk-toggle-hint {
    display: block;
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--text-muted);
  }

  .import-bulk-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: var(--space-4);
  }

  /* ─── Info / "what this does" panel ─── */
  .import-bulk-info {
    position: relative;
    padding: 14px 16px 14px 18px;
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .import-bulk-info::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: linear-gradient(180deg, #8c6dff 0%, #36c5d6 100%);
  }
  .import-bulk-info strong {
    display: block;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    color: var(--text-strong);
    letter-spacing: -0.012em;
    margin-bottom: 6px;
  }
  .import-bulk-info ul {
    margin: 0;
    padding-left: 18px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .import-bulk-info code {
    font-size: 12px;
    background: var(--bg-secondary);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text);
  }

  /* ─── Summary strip (counts) ─── */
  .import-bulk-summary {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding: 12px 16px;
    margin-bottom: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 13.5px;
    color: var(--text-muted);
  }
  .import-bulk-summary code {
    font-size: 12.5px;
    background: var(--bg-secondary);
    padding: 1px 6px;
    border-radius: 4px;
    color: var(--text);
  }
  .import-bulk-summary-stat {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 9999px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    font-weight: 500;
    color: var(--text-strong);
    font-size: 12.5px;
  }
  .import-bulk-summary-stat .num { color: var(--accent); font-weight: 700; }

  /* ─── Results table ─── */
  .import-bulk-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .import-bulk-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  .import-bulk-table thead tr {
    background: var(--bg-secondary);
    text-align: left;
  }
  .import-bulk-table th {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .import-bulk-table tbody tr {
    transition: background 120ms ease;
  }
  .import-bulk-table tbody tr:hover {
    background: rgba(255,255,255,0.018);
  }
  .import-bulk-table td {
    padding: 9px 14px;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }
  .import-bulk-table tbody tr:last-child td { border-bottom: 0; }
  .import-bulk-table-name {
    font-family: var(--font-mono);
    color: var(--text-strong);
    font-size: 13px;
  }
  .import-bulk-table-notes {
    color: var(--text-muted);
    font-size: 12.5px;
  }

  /* ─── Status badge ─── */
  .import-bulk-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .import-bulk-badge-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .import-bulk-badge-success {
    color: #3fb950;
    background: rgba(63,185,80,0.13);
    border: 1px solid rgba(63,185,80,0.28);
  }
  .import-bulk-badge-success .import-bulk-badge-dot {
    background: #3fb950;
    box-shadow: 0 0 6px rgba(63,185,80,0.7);
  }
  .import-bulk-badge-warn {
    color: #f0b429;
    background: rgba(240,180,41,0.12);
    border: 1px solid rgba(240,180,41,0.28);
  }
  .import-bulk-badge-warn .import-bulk-badge-dot { background: #f0b429; }
  .import-bulk-badge-info {
    color: #58a6ff;
    background: rgba(88,166,255,0.12);
    border: 1px solid rgba(88,166,255,0.28);
  }
  .import-bulk-badge-info .import-bulk-badge-dot { background: #58a6ff; }
  .import-bulk-badge-error {
    color: #f85149;
    background: rgba(248,81,73,0.12);
    border: 1px solid rgba(248,81,73,0.28);
  }
  .import-bulk-badge-error .import-bulk-badge-dot { background: #f85149; }

  .import-bulk-empty {
    padding: 18px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13.5px;
  }

  .import-bulk-callout {
    margin-top: var(--space-4);
    padding: 12px 14px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 10px;
    font-size: 13px;
    color: var(--text-muted);
  }
  .import-bulk-callout em { color: var(--text-strong); font-style: normal; font-weight: 600; }

  .import-bulk-subhead {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    color: var(--text-strong);
    margin: var(--space-5) 0 var(--space-3);
  }
`;

/**
 * Paginate the GitHub "list org repos" endpoint. Caps at MAX_REPOS so a
 * single request can't fan out indefinitely. Throws on non-2xx so the
 * caller can surface a friendly error.
 */
async function fetchOrgRepos(
  org: string,
  token: string
): Promise<GitHubRepo[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "gluecron/1.0",
    Authorization: `Bearer ${token}`,
  };

  const repos: GitHubRepo[] = [];
  let page = 1;
  while (repos.length < MAX_REPOS) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(
      org
    )}/repos?per_page=${GITHUB_PER_PAGE}&page=${page}&type=all`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      // Never echo the token. Include only the status + first slice of body.
      const errBody = (await res.text()).slice(0, 200);
      throw new Error(`GitHub API error (${res.status}): ${errBody}`);
    }
    const batch = (await res.json()) as GitHubRepo[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < GITHUB_PER_PAGE) break;
    page++;
    if (page > 10) break; // hard page ceiling: 1000 entries, we cap earlier anyway
  }
  return repos.slice(0, MAX_REPOS);
}

function matchesVisibility(repo: GitHubRepo, v: Visibility): boolean {
  if (v === "both") return true;
  if (v === "public") return repo.private === false;
  if (v === "private") return repo.private === true;
  return true;
}

// ─── FORM PAGE ───────────────────────────────────────────────

importBulkRoutes.get("/import/bulk", requireAuth, async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="Bulk import from GitHub" user={user}>
      <style dangerouslySetInnerHTML={{ __html: importBulkStyles }} />
      <div class="import-bulk-container">
        {/* ─── Hero ─── */}
        <div class="import-bulk-hero">
          <div class="import-bulk-hero-bg" aria-hidden="true">
            <div class="import-bulk-hero-orb" />
          </div>
          <div class="import-bulk-hero-inner">
            <div class="import-bulk-hero-eyebrow">
              <span class="import-bulk-hero-eyebrow-dot" aria-hidden="true" />
              Bulk migration
            </div>
            <h1 class="import-bulk-hero-title">
              Import{" "}
              <span class="gradient-text">many at once</span>.
            </h1>
            <p class="import-bulk-hero-sub">
              Paste a GitHub org + personal access token. Gluecron clones every
              repo into your namespace as a mirror — sequentially, with per-repo
              status so one failure can't abort the batch.
            </p>
          </div>
        </div>

        {error && (
          <div class="import-bulk-banner import-bulk-banner-error" role="alert">
            <div class="import-bulk-banner-title">Bulk import didn't run</div>
            <div class="import-bulk-banner-detail">
              {decodeURIComponent(error)}
            </div>
          </div>
        )}

        {/* ─── What this does (info panel) ─── */}
        <div class="import-bulk-info">
          <strong>What this does</strong>
          <ul>
            <li>
              Lists every repo in the org via the GitHub API
              (<code>/orgs/{"{org}"}/repos</code>, paginated).
            </li>
            <li>
              Clones each one as a bare mirror into your gluecron account
              (<code>{user.username}/{"{repo}"}</code>).
            </li>
            <li>
              Reports per-repo success / failure / skipped-if-exists at
              the end. One failure does not abort the batch.
            </li>
            <li>
              Hard caps: <code>{MAX_REPOS}</code> repos per run, 500MB per repo.
            </li>
          </ul>
        </div>

        {/* ─── Form section ─── */}
        <div class="import-bulk-section">
          <div class="import-bulk-section-head">
            <div class="import-bulk-section-eyebrow">Configure</div>
            <h2 class="import-bulk-section-title">Org + token</h2>
            <p class="import-bulk-section-desc">
              Token is used only in this request — never stored.
            </p>
          </div>
          <div class="import-bulk-section-body">
            <form method="post" action="/import/bulk">
              <div class="import-bulk-field">
                <label class="import-bulk-field-label">GitHub org</label>
                <input
                  type="text"
                  name="githubOrg"
                  required
                  placeholder="my-company"
                  aria-label="GitHub org"
                  class="import-bulk-input"
                />
              </div>

              <div class="import-bulk-field">
                <label class="import-bulk-field-label">
                  Personal access token <code>repo:read</code> scope
                </label>
                <input
                  type="password"
                  name="githubToken"
                  required
                  placeholder="ghp_xxxxxxxxxxxx"
                  autocomplete="off"
                  aria-label="GitHub personal access token"
                  class="import-bulk-input is-mono"
                />
              </div>

              <div class="import-bulk-field">
                <label class="import-bulk-field-label">Visibility filter</label>
                <select
                  name="visibility"
                  aria-label="Visibility filter"
                  class="import-bulk-select"
                >
                  <option value="both" selected>Both (public + private)</option>
                  <option value="public">Public only</option>
                  <option value="private">Private only</option>
                </select>
              </div>

              <div class="import-bulk-field">
                <label class="import-bulk-toggle">
                  <input type="checkbox" name="dryRun" value="1" checked />
                  <span class="import-bulk-toggle-text">
                    Dry run — preview the list without cloning
                    <span class="import-bulk-toggle-hint">
                      Recommended for the first pass. Uncheck once the preview
                      looks right.
                    </span>
                  </span>
                </label>
              </div>

              <div class="import-bulk-actions">
                <button type="submit" class="btn btn-primary">
                  Run bulk import
                </button>
                <a href="/import" class="btn">
                  Back to /import
                </a>
              </div>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// ─── POST HANDLER ────────────────────────────────────────────

importBulkRoutes.post("/import/bulk", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  const githubOrg = String(body.githubOrg || "").trim();
  const githubToken = String(body.githubToken || "").trim();
  const visibilityRaw = String(body.visibility || "both").trim();
  const visibility: Visibility =
    visibilityRaw === "public" || visibilityRaw === "private"
      ? (visibilityRaw as Visibility)
      : "both";
  const dryRun = Boolean(body.dryRun); // unchecked box = undefined = false

  if (!githubOrg) {
    return c.redirect("/import/bulk?error=GitHub+org+is+required");
  }
  if (!githubToken) {
    return c.redirect(
      "/import/bulk?error=GitHub+token+is+required+%28repo%3Aread+scope%29"
    );
  }

  // Validate the token has at least read access before we start cloning.
  // `GET /user` is the cheapest call that requires a valid token. We also
  // inspect the `X-OAuth-Scopes` header so we can warn early if the token
  // is missing `repo`/`repo:read`.
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "gluecron/1.0",
        Authorization: `Bearer ${githubToken}`,
      },
    });
    if (!userRes.ok) {
      return c.redirect(
        `/import/bulk?error=${encodeURIComponent(
          `Invalid GitHub token (${userRes.status}). Check scope repo:read.`
        )}`
      );
    }
    const scopes = (userRes.headers.get("x-oauth-scopes") || "").toLowerCase();
    if (
      scopes &&
      !scopes.includes("repo") &&
      !scopes.includes("public_repo")
    ) {
      return c.redirect(
        `/import/bulk?error=${encodeURIComponent(
          "Token is missing repo:read scope. Regenerate with repo (or public_repo) checked."
        )}`
      );
    }
  } catch (err) {
    // Network-level failure talking to GitHub. Don't leak err details.
    return c.redirect(
      "/import/bulk?error=Could+not+reach+GitHub+to+validate+the+token"
    );
  }

  // Pull the repo list.
  let allRepos: GitHubRepo[];
  try {
    allRepos = await fetchOrgRepos(githubOrg, githubToken);
  } catch (err) {
    const msg = (err as Error).message || "Unknown error";
    return c.redirect(
      `/import/bulk?error=${encodeURIComponent(msg).slice(0, 400)}`
    );
  }

  if (allRepos.length === 0) {
    return c.redirect(
      `/import/bulk?error=${encodeURIComponent(
        `No repos visible for org "${githubOrg}" with this token.`
      )}`
    );
  }

  // Apply visibility filter + size cap; track why things were skipped.
  const candidates: GitHubRepo[] = [];
  const oversized: { name: string; sizeKB: number }[] = [];
  for (const r of allRepos) {
    if (!matchesVisibility(r, visibility)) continue;
    if (typeof r.size === "number" && r.size > MAX_REPO_SIZE_KB) {
      oversized.push({ name: r.name, sizeKB: r.size });
      continue;
    }
    candidates.push(r);
  }

  // Dry run: render a preview + counts, never touch disk or DB.
  if (dryRun) {
    return c.html(
      <Layout title="Bulk import preview" user={user}>
        <style dangerouslySetInnerHTML={{ __html: importBulkStyles }} />
        <div class="import-bulk-container">
          <div class="import-bulk-hero">
            <div class="import-bulk-hero-bg" aria-hidden="true">
              <div class="import-bulk-hero-orb" />
            </div>
            <div class="import-bulk-hero-inner">
              <div class="import-bulk-hero-eyebrow">
                <span class="import-bulk-hero-eyebrow-dot" aria-hidden="true" />
                Preview only — nothing imported yet
              </div>
              <h1 class="import-bulk-hero-title">
                Bulk import{" "}
                <span class="gradient-text">dry run</span>.
              </h1>
              <p class="import-bulk-hero-sub">
                This is what gluecron would clone from{" "}
                <code>{githubOrg}</code> when you uncheck the dry-run box.
              </p>
            </div>
          </div>

          <div class="import-bulk-summary">
            <span>
              Org <code>{githubOrg}</code>
            </span>
            <span>
              Visibility <code>{visibility}</code>
            </span>
            <span class="import-bulk-summary-stat">
              <span class="num">{candidates.length}</span> to import
            </span>
            {oversized.length > 0 && (
              <span class="import-bulk-summary-stat">
                <span class="num">{oversized.length}</span> skipped (&gt;500MB)
              </span>
            )}
          </div>

          <ResultsTable
            rows={candidates.map((r) => ({
              name: sanitizeRepoName(r.name),
              status: "dry-run",
              notes: `${r.private ? "private" : "public"} · ${(
                r.size / 1024
              ).toFixed(1)} MB`,
            }))}
          />

          {oversized.length > 0 && (
            <>
              <h3 class="import-bulk-subhead">Skipped — over 500MB</h3>
              <ResultsTable
                rows={oversized.map((r) => ({
                  name: sanitizeRepoName(r.name),
                  status: "too-large",
                  notes: `${(r.sizeKB / 1024).toFixed(1)} MB`,
                }))}
              />
            </>
          )}

          <div class="import-bulk-callout">
            Looks good? Go back and uncheck <em>Dry run</em> to actually import.
          </div>

          <div class="import-bulk-actions">
            <a href="/import/bulk" class="btn btn-primary">
              Back to form
            </a>
          </div>
        </div>
      </Layout>
    );
  }

  // Real run: clone each candidate sequentially. Collect results.
  const results: ImportOneRepoResult[] = [];
  for (const r of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await importOneRepo({
      cloneUrl: r.clone_url,
      targetName: r.name,
      ownerId: user.id,
      ownerUsername: user.username,
      token: githubToken,
      description: r.description,
      isPrivate: r.private,
      defaultBranch: r.default_branch,
    });
    results.push(res);
  }

  for (const o of oversized) {
    results.push({
      status: "failed",
      name: sanitizeRepoName(o.name),
      notes: `Skipped — over 500MB (${(o.sizeKB / 1024).toFixed(1)} MB)`,
    });
  }

  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return c.html(
    <Layout title="Bulk import results" user={user}>
      <style dangerouslySetInnerHTML={{ __html: importBulkStyles }} />
      <div class="import-bulk-container">
        <div class="import-bulk-hero">
          <div class="import-bulk-hero-bg" aria-hidden="true">
            <div class="import-bulk-hero-orb" />
          </div>
          <div class="import-bulk-hero-inner">
            <div class="import-bulk-hero-eyebrow">
              <span class="import-bulk-hero-eyebrow-dot" aria-hidden="true" />
              Bulk migration complete
            </div>
            <h1 class="import-bulk-hero-title">
              Bulk import{" "}
              <span class="gradient-text">results</span>.
            </h1>
            <p class="import-bulk-hero-sub">
              From <code>{githubOrg}</code> into{" "}
              <code>{user.username}</code>.
            </p>
          </div>
        </div>

        <div class="import-bulk-summary">
          <span class="import-bulk-summary-stat">
            <span class="num">{counts["success"] || 0}</span> imported
          </span>
          <span class="import-bulk-summary-stat">
            <span class="num">{counts["skipped-exists"] || 0}</span> skipped
          </span>
          <span class="import-bulk-summary-stat">
            <span class="num">{counts["failed"] || 0}</span> failed
          </span>
        </div>

        <ResultsTable rows={results} />

        <div class="import-bulk-actions">
          <a href={`/${user.username}`} class="btn btn-primary">
            View my repositories
          </a>
          <a href="/import/bulk" class="btn">
            Run another import
          </a>
        </div>
      </div>
    </Layout>
  );
});

// ─── COMPONENTS ──────────────────────────────────────────────

function ResultsTable({
  rows,
}: {
  rows: { name: string; status: string; notes: string }[];
}) {
  if (rows.length === 0) {
    return (
      <div class="import-bulk-table-wrap">
        <div class="import-bulk-empty">No rows.</div>
      </div>
    );
  }
  return (
    <div class="import-bulk-table-wrap">
      <table class="import-bulk-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td class="import-bulk-table-name">{r.name}</td>
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td class="import-bulk-table-notes">{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "success"
      ? "import-bulk-badge-success"
      : status === "skipped-exists"
        ? "import-bulk-badge-warn"
        : status === "dry-run"
          ? "import-bulk-badge-info"
          : status === "too-large"
            ? "import-bulk-badge-warn"
            : "import-bulk-badge-error";
  return (
    <span class={`import-bulk-badge ${cls}`}>
      <span class="import-bulk-badge-dot" aria-hidden="true" />
      {status}
    </span>
  );
}

export default importBulkRoutes;
