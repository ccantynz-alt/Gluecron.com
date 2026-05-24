/**
 * GitHub Import — automatic migration from GitHub to gluecron.
 *
 * Developer connects GitHub, gluecron pulls ALL their repos
 * automatically. Issues, descriptions, branches — everything.
 * One click. Walk away. Come back to everything migrated.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";
import type { AuthEnv } from "../middleware/auth";
import { config } from "../lib/config";
import { mkdir } from "fs/promises";
import { join } from "path";
import {
  parseGithubUrl,
  sanitizeRepoName,
  buildCloneUrl,
  scrubSecrets,
} from "../lib/import-helper";

const importRoutes = new Hono<AuthEnv>();

importRoutes.use("*", softAuth);

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  clone_url: string;
  default_branch: string;
  stargazers_count: number;
  fork: boolean;
  language: string | null;
}

// ─── PAGE-SCOPED CSS ─────────────────────────────────────────
// All classes prefixed with .import- so the block cannot bleed into
// neighbouring routes. Mirrors the dashboard-hero + settings polish.
const importStyles = `
  .import-container { max-width: 880px; margin: 0 auto; }

  /* ─── Hero ─── */
  .import-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .import-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .import-hero-bg {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 360px; height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .import-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: importHeroOrb 14s ease-in-out infinite;
  }
  @keyframes importHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .import-hero-orb { animation: none; }
  }
  .import-hero-inner {
    position: relative;
    z-index: 1;
    max-width: 640px;
  }
  .import-hero-eyebrow {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: -0.005em;
  }
  .import-hero-eyebrow-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px rgba(140,109,255,0.6);
    margin-right: 8px;
    vertical-align: 1px;
  }
  .import-hero-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .import-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .import-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* ─── Bulk CTA strip (between hero and options) ─── */
  .import-bulk-cta {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 14px 18px;
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    text-decoration: none;
    color: inherit;
    overflow: hidden;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .import-bulk-cta:hover {
    border-color: rgba(140,109,255,0.45);
    transform: translateY(-1px);
  }
  .import-bulk-cta::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    background: linear-gradient(180deg, #8c6dff 0%, #36c5d6 100%);
  }
  .import-bulk-cta-text strong {
    display: block;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 15px;
    color: var(--text-strong);
    letter-spacing: -0.012em;
  }
  .import-bulk-cta-text .import-bulk-cta-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin-top: 3px;
    line-height: 1.4;
  }
  .import-bulk-cta-arrow {
    flex-shrink: 0;
    font-size: 18px;
    color: var(--accent);
    transition: transform 140ms ease;
  }
  .import-bulk-cta:hover .import-bulk-cta-arrow { transform: translateX(3px); }

  /* ─── Banners ─── */
  .import-banner {
    position: relative;
    padding: 14px 16px 14px 44px;
    margin-bottom: var(--space-5);
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 14px;
    line-height: 1.5;
  }
  .import-banner::before {
    content: '';
    position: absolute;
    left: 14px; top: 18px;
    width: 14px; height: 14px;
    border-radius: 50%;
  }
  .import-banner-success {
    border-color: rgba(63, 185, 80, 0.32);
    background: linear-gradient(180deg, rgba(63,185,80,0.06) 0%, var(--bg-elevated) 100%);
  }
  .import-banner-success::before {
    background: radial-gradient(circle, #3fb950 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(63,185,80,0.5);
  }
  .import-banner-error {
    border-color: rgba(248, 81, 73, 0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
  }
  .import-banner-error::before {
    background: radial-gradient(circle, #f85149 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(248,81,73,0.5);
  }
  .import-banner-title { font-weight: 600; color: var(--text-strong); }
  .import-banner-detail { color: var(--text-muted); margin-top: 4px; font-size: 13.5px; }
  .import-banner-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }

  /* ─── Progress card with step pipeline ─── */
  .import-progress-card {
    position: relative;
    margin-bottom: var(--space-5);
    padding: 18px 18px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .import-progress-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 50%, #8c6dff 100%);
    background-size: 200% 100%;
    animation: importProgressShimmer 2.2s linear infinite;
    pointer-events: none;
  }
  @keyframes importProgressShimmer {
    0%   { background-position: 0% 0%; }
    100% { background-position: 200% 0%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .import-progress-card::before { animation: none; }
  }
  .import-progress-title {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 16px;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    margin: 0 0 4px;
  }
  .import-progress-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 14px;
  }
  .import-steps {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
  }
  .import-step {
    position: relative;
    padding: 10px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .import-step-dot {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: var(--bg-tertiary, #1a1d2a);
    border: 1.5px solid var(--border-strong);
    flex-shrink: 0;
    position: relative;
  }
  .import-step.is-active {
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    background: rgba(140,109,255,0.07);
  }
  .import-step.is-active .import-step-dot {
    background: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 10px rgba(140,109,255,0.6);
    animation: importStepPulse 1.4s ease-in-out infinite;
  }
  @keyframes importStepPulse {
    0%, 100% { box-shadow: 0 0 8px rgba(140,109,255,0.4); }
    50%      { box-shadow: 0 0 14px rgba(140,109,255,0.85); }
  }
  @media (prefers-reduced-motion: reduce) {
    .import-step.is-active .import-step-dot { animation: none; }
  }
  .import-step-label { font-weight: 500; }
  @media (max-width: 640px) {
    .import-steps { grid-template-columns: repeat(2, 1fr); }
  }

  /* ─── Option cards ─── */
  .import-options {
    display: grid;
    gap: var(--space-4);
  }
  .import-option {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .import-option:hover { border-color: var(--border-strong); }
  .import-option-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 4px;
  }
  .import-option-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px; height: 24px;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18) 0%, rgba(54,197,214,0.18) 100%);
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    border: 1px solid rgba(140,109,255,0.28);
  }
  .import-option-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    color: var(--text-strong);
    margin: 0;
  }
  .import-option-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 14px;
  }
  .import-option-form .import-row {
    display: flex;
    gap: 8px;
  }
  .import-input {
    flex: 1;
    width: 100%;
    padding: 9px 12px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    color: var(--text);
    font-size: 14px;
    font-family: var(--font-sans);
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .import-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .import-input.is-mono { font-family: var(--font-mono); font-size: 13px; }
  .import-field { margin-top: 10px; }
  .import-field-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 4px;
    letter-spacing: -0.005em;
  }
  .import-field-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    line-height: 1.45;
  }

  @media (max-width: 600px) {
    .import-option-form .import-row { flex-direction: column; }
    .import-option-form .import-row .btn { width: 100%; }
  }
`;

// ─── IMPORT PAGE ─────────────────────────────────────────────

importRoutes.get("/import", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");
  const imported = c.req.query("imported");

  // Inline progress banner: the clone subprocess can take 30+s for big
  // repos, so give the user visible feedback while the POST is in flight.
  // Pure client-side — no extra routes, no websockets, no polling.
  // Polished step pipeline: clone → analyze → enable gates → done.
  const progressScript = `
    (function () {
      var forms = document.querySelectorAll('form[data-import-form]');
      var banner = document.getElementById('import-progress');
      if (!banner) return;
      var steps = banner.querySelectorAll('[data-step]');
      function setStep(idx) {
        steps.forEach(function (el, i) {
          if (i <= idx) el.classList.add('is-active');
          else el.classList.remove('is-active');
        });
      }
      forms.forEach(function (form) {
        form.addEventListener('submit', function () {
          // Validate non-empty required fields before showing progress.
          var req = form.querySelectorAll('[required]');
          for (var i = 0; i < req.length; i++) {
            if (!req[i].value || !req[i].value.trim()) return;
          }
          banner.style.display = 'block';
          setStep(0);
          // Walk through 'analyze' and 'gates' steps on a timer so the
          // pipeline visually advances even before the redirect lands.
          setTimeout(function () { setStep(1); }, 1800);
          setTimeout(function () { setStep(2); }, 4200);
          var btns = form.querySelectorAll('button[type="submit"]');
          btns.forEach(function (b) {
            b.disabled = true;
            b.textContent = 'Importing…';
          });
          // Scroll banner into view so user sees progress above the fold.
          try { banner.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
        });
      });
    })();
  `;

  return c.html(
    <Layout title="Import from GitHub" user={user}>
      <style dangerouslySetInnerHTML={{ __html: importStyles }} />
      <div class="import-container">
        {/* ─── Hero ─── */}
        <div class="import-hero">
          <div class="import-hero-bg" aria-hidden="true">
            <div class="import-hero-orb" />
          </div>
          <div class="import-hero-inner">
            <div class="import-hero-eyebrow">
              <span class="import-hero-eyebrow-dot" aria-hidden="true" />
              GitHub migration
            </div>
            <h1 class="import-hero-title">
              Import from{" "}
              <span class="gradient-text">GitHub</span>.
            </h1>
            <p class="import-hero-sub">
              Migrate your repositories from GitHub to gluecron automatically —
              all branches, all history, all code. One click, walk away, come
              back to everything migrated.
            </p>
          </div>
        </div>

        {/* ─── Bulk-import shortcut ─── */}
        <a href="/import/bulk" class="import-bulk-cta">
          <div class="import-bulk-cta-text">
            <strong>Migrating a whole org? Try the bulk importer.</strong>
            <div class="import-bulk-cta-sub">
              Paste a GitHub org name + token and clone every repo in one shot.
            </div>
          </div>
          <div class="import-bulk-cta-arrow" aria-hidden="true">→</div>
        </a>

        {/* ─── Success / error banners ─── */}
        {success && (
          <div class="import-banner import-banner-success" role="status">
            <div class="import-banner-title">{decodeURIComponent(success)}</div>
            {imported && (
              <div class="import-banner-detail">
                Successfully imported {decodeURIComponent(imported)} repositories.
              </div>
            )}
            <div class="import-banner-actions">
              <a href={`/${user.username}`} class="btn btn-primary">
                View my repositories
              </a>
              <a href="/explore" class="btn">Explore</a>
            </div>
          </div>
        )}
        {error && (
          <div class="import-banner import-banner-error" role="alert">
            <div class="import-banner-title">Import didn't complete</div>
            <div class="import-banner-detail">{decodeURIComponent(error)}</div>
          </div>
        )}

        {/* ─── In-flight progress pipeline ─── */}
        <div
          id="import-progress"
          class="import-progress-card"
          role="status"
          aria-live="polite"
          style="display: none"
        >
          <div class="import-progress-title">Import in progress</div>
          <div class="import-progress-sub">
            Large repositories can take 30+ seconds — don't close this tab.
          </div>
          <div class="import-steps">
            <div class="import-step" data-step="0">
              <span class="import-step-dot" aria-hidden="true" />
              <span class="import-step-label">Clone</span>
            </div>
            <div class="import-step" data-step="1">
              <span class="import-step-dot" aria-hidden="true" />
              <span class="import-step-label">Analyze</span>
            </div>
            <div class="import-step" data-step="2">
              <span class="import-step-dot" aria-hidden="true" />
              <span class="import-step-label">Enable gates</span>
            </div>
            <div class="import-step" data-step="3">
              <span class="import-step-dot" aria-hidden="true" />
              <span class="import-step-label">Done</span>
            </div>
          </div>
        </div>

        {/* ─── Option cards ─── */}
        <div class="import-options">
          <div class="import-option">
            <div class="import-option-head">
              <span class="import-option-badge" aria-hidden="true">1</span>
              <h3 class="import-option-title">Import by username</h3>
            </div>
            <p class="import-option-desc">
              Import all public repositories from a GitHub user or organization.
            </p>
            <form
              class="import-option-form"
              method="post"
              action="/import/github/user"
              data-import-form
            >
              <div class="import-row">
                <input
                  type="text"
                  name="github_username"
                  required
                  placeholder="GitHub username or org"
                  aria-label="GitHub username or org"
                  class="import-input"
                />
                <button type="submit" class="btn btn-primary">
                  Import all repos
                </button>
              </div>
            </form>
          </div>

          <div class="import-option">
            <div class="import-option-head">
              <span class="import-option-badge" aria-hidden="true">2</span>
              <h3 class="import-option-title">Import a single repo</h3>
            </div>
            <p class="import-option-desc">
              Import one specific repository by URL (https, ssh, or owner/repo).
            </p>
            <form
              class="import-option-form"
              method="post"
              action="/import/github/repo"
              data-import-form
            >
              <div class="import-row">
                <input
                  type="text"
                  name="repo_url"
                  required
                  placeholder="https://github.com/owner/repo"
                  aria-label="Repository URL"
                  class="import-input"
                />
                <button type="submit" class="btn btn-primary">
                  Import
                </button>
              </div>
              <div class="import-field">
                <input
                  type="password"
                  name="github_token"
                  placeholder="Optional: GitHub PAT to also migrate Actions secret names"
                  aria-label="Optional GitHub personal access token for secrets migration"
                  autocomplete="off"
                  class="import-input is-mono"
                />
                <div class="import-field-hint">
                  Token is only used in this request — never stored.
                </div>
              </div>
            </form>
          </div>

          <div class="import-option">
            <div class="import-option-head">
              <span class="import-option-badge" aria-hidden="true">3</span>
              <h3 class="import-option-title">
                Import with token (private repos)
              </h3>
            </div>
            <p class="import-option-desc">
              Use a GitHub personal access token to import private repositories
              too. Generate one at{" "}
              <strong>github.com → Settings → Developer settings → Personal access tokens</strong>.
            </p>
            <form
              class="import-option-form"
              method="post"
              action="/import/github/user"
              data-import-form
            >
              <div class="import-field">
                <label class="import-field-label">GitHub username</label>
                <input
                  type="text"
                  name="github_username"
                  required
                  placeholder="GitHub username"
                  aria-label="GitHub username"
                  class="import-input"
                />
              </div>
              <div class="import-field">
                <label class="import-field-label">
                  Personal access token (repo scope)
                </label>
                <input
                  type="password"
                  name="github_token"
                  required
                  placeholder="ghp_xxxxxxxxxxxx"
                  aria-label="GitHub personal access token"
                  class="import-input is-mono"
                />
              </div>
              <div class="import-field">
                <button type="submit" class="btn btn-primary">
                  Import all repos (public + private)
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: progressScript }} />
    </Layout>
  );
});

// ─── IMPORT ALL REPOS FROM GITHUB USER ───────────────────────

importRoutes.post("/import/github/user", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const githubUsername = String(body.github_username || "").trim();
  const githubToken = String(body.github_token || "").trim() || null;

  if (!githubUsername) {
    return c.redirect("/import?error=GitHub+username+is+required");
  }

  try {
    // Fetch repos from GitHub API
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "gluecron/1.0",
    };
    if (githubToken) {
      headers.Authorization = `Bearer ${githubToken}`;
    }

    const repos: GitHubRepo[] = [];
    let page = 1;
    while (true) {
      const url = githubToken
        ? `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner`
        : `https://api.github.com/users/${githubUsername}/repos?per_page=100&page=${page}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        const errText = await res.text();
        return c.redirect(
          `/import?error=${encodeURIComponent(`GitHub API error (${res.status}): ${errText.slice(0, 100)}`)}`
        );
      }
      const batch: GitHubRepo[] = await res.json();
      if (batch.length === 0) break;
      repos.push(...batch);
      page++;
      if (page > 10) break; // safety limit: 1000 repos
    }

    if (repos.length === 0) {
      return c.redirect("/import?error=No+repositories+found+for+this+user");
    }

    // Import each repo
    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (const ghRepo of repos) {
      const targetName = sanitizeRepoName(ghRepo.name);

      // Check uniqueness in THIS user's namespace (owner+name is the
      // real unique key — the previous check ignored ownerId and
      // could skip repos other users happened to share a name with).
      const [existing] = await db
        .select()
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, user.id),
            eq(repositories.name, targetName)
          )
        )
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      try {
        await importSingleRepo(user, ghRepo, githubToken);
        imported++;
      } catch (err) {
        failed++;
        // Belt + suspenders: even though importSingleRepo already redacts
        // tokens before throwing, scrub here in case a future code path
        // bypasses that. Tokens in console.error end up in journald and
        // any log shipper — a single leak is forever.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[import] failed to import ${ghRepo.full_name}:`,
          scrubSecrets(msg, githubToken)
        );
      }
    }

    const summary =
      `${imported}+imported%2C+${skipped}+skipped` +
      (failed > 0 ? `%2C+${failed}+failed` : "");
    return c.redirect(`/import?success=Import+complete&imported=${summary}`);
  } catch (err) {
    console.error("[import] error:", err);
    return c.redirect(
      `/import?error=${encodeURIComponent(`Import failed: ${String(err)}`)}`
    );
  }
});

// ─── IMPORT SINGLE REPO BY URL ───────────────────────────────

importRoutes.post("/import/github/repo", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const repoUrl = String(body.repo_url || "").trim();
  // Optional PAT — when supplied, used after the import succeeds to also
  // migrate GitHub Actions secret NAMES (values are never exposed by the
  // API) into placeholder rows the user can paste values into.
  const optionalToken = String(body.github_token || "").trim() || null;

  if (!repoUrl) {
    return c.redirect("/import?error=Repository+URL+is+required");
  }

  // P4 — same quota gate as /new + /api/v2/repos. Imports count toward
  // the user's plan limit.
  const { checkRepoCreateAllowed } = await import("../lib/repo-create-gate");
  const gate = await checkRepoCreateAllowed(user.id);
  if (!gate.ok) {
    return c.redirect(`/import?error=${encodeURIComponent(gate.reason)}`);
  }

  const parsed = parseGithubUrl(repoUrl);
  if (!parsed) {
    return c.redirect(
      "/import?error=" +
        encodeURIComponent(
          "Invalid GitHub URL. Use https://github.com/owner/repo or owner/repo."
        )
    );
  }

  const { owner: ghOwner, repo: ghRepo } = parsed;

  // Guard against double-import before we spin up a clone subprocess.
  const targetName = sanitizeRepoName(ghRepo);
  const [existing] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, user.id),
        eq(repositories.name, targetName)
      )
    )
    .limit(1);
  if (existing) {
    return c.redirect(
      `/import?error=${encodeURIComponent(
        `You already have a repository named "${targetName}". Delete it first, or rename on GitHub.`
      )}`
    );
  }

  try {
    // Fetch repo info
    const metaHeaders: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "gluecron/1.0",
    };
    if (optionalToken) metaHeaders.Authorization = `Bearer ${optionalToken}`;
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}`,
      { headers: metaHeaders }
    );

    if (!res.ok) {
      // Try to pull GitHub's actual error message — "Bad credentials",
      // "Not Found", or rate-limit text is far more useful than a bare code.
      let detail = "";
      try {
        const body = await res.json();
        detail = body?.message ? ` — ${String(body.message)}` : "";
      } catch {
        /* non-JSON body, skip */
      }
      return c.redirect(
        `/import?error=${encodeURIComponent(
          `GitHub said ${res.status}${detail}. Check the URL and that the repo is public (or supply a token).`
        )}`
      );
    }

    let ghRepoData: GitHubRepo;
    try {
      ghRepoData = (await res.json()) as GitHubRepo;
    } catch (err) {
      console.error("[import] non-JSON response from GitHub:", err);
      return c.redirect(
        `/import?error=${encodeURIComponent(
          "GitHub returned a response we couldn't parse. Try again in a moment."
        )}`
      );
    }

    await importSingleRepo(user, ghRepoData, optionalToken);

    // Block T1 — opportunistically migrate GitHub Actions secret NAMES
    // (values are never exposed by GitHub's API). If a token was supplied
    // on this request, list the secret names + pre-create empty
    // placeholders, then redirect the user to the paste-each-value
    // checklist. Fire-and-forget semantics: any failure (no token, network
    // error, no secrets, DB blip) collapses to "skip the checklist step"
    // and we redirect straight to the repo home.
    //
    // CRITICAL — never reconstruct the redirect path from local strings:
    // sanitizeRepoName/case/etc could differ from what importSingleRepo
    // actually wrote. We had a post-import 404 in production because the
    // shadowed targetName drifted from the DB row. Read the row back.
    const [storedRepo] = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, user.id),
          eq(repositories.name, sanitizeRepoName(ghRepoData.name))
        )
      )
      .limit(1);

    if (!storedRepo) {
      // The clone succeeded but the insert apparently didn't — fail loud
      // instead of redirecting the user into a 404.
      console.error(
        "[import] repo missing after import — owner=" + user.username +
        " ghRepo=" + ghRepoData.full_name
      );
      return c.redirect(
        `/import?error=${encodeURIComponent(
          "Import partially completed — please refresh and try again."
        )}`
      );
    }

    const targetName = storedRepo.name;
    let secretsRedirect: string | null = null;
    if (optionalToken) {
      try {
        const { importSecretsForRepo } = await import(
          "../lib/github-secrets-import"
        );
        const result = await importSecretsForRepo({
          githubOwner: ghOwner,
          githubRepo: ghRepo,
          githubToken: optionalToken,
          gluecronRepositoryId: storedRepo.id,
          importedByUserId: user.id,
        });
        if (result.imported.length > 0) {
          secretsRedirect = `/${user.username}/${targetName}/import/secrets`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          "[import] secrets migration skipped:",
          scrubSecrets(msg, optionalToken)
        );
      }
    }

    return c.redirect(secretsRedirect ?? `/${user.username}/${targetName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safe = scrubSecrets(msg, optionalToken);
    console.error("[import] error:", safe);
    return c.redirect(
      `/import?error=${encodeURIComponent(`Import failed: ${safe}`)}`
    );
  }
});

// ─── CORE IMPORT FUNCTION ────────────────────────────────────

async function importSingleRepo(
  user: { id: string; username: string },
  ghRepo: GitHubRepo,
  token: string | null
): Promise<void> {
  const safeName = sanitizeRepoName(ghRepo.name);
  const destPath = join(
    config.gitReposPath,
    user.username,
    `${safeName}.git`
  );

  // Ensure parent directory exists
  await mkdir(join(config.gitReposPath, user.username), { recursive: true });

  // Clone bare from GitHub (with token if provided for private repos)
  const cloneUrl = buildCloneUrl(ghRepo.clone_url, token);

  console.log(`[import] cloning ${ghRepo.full_name} -> ${destPath}`);

  const proc = Bun.spawn(
    ["git", "clone", "--bare", "--mirror", cloneUrl, destPath],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // Never echo the token back in an error message.
    const sanitized = token
      ? stderr.replaceAll(token, "***")
      : stderr;
    throw new Error(`git clone failed: ${sanitized.slice(0, 400)}`);
  }

  // Insert into database
  await db.insert(repositories).values({
    name: safeName,
    ownerId: user.id,
    description: ghRepo.description,
    isPrivate: ghRepo.private,
    defaultBranch: ghRepo.default_branch || "main",
    diskPath: destPath,
    starCount: 0,
  });

  console.log(`[import] ${ghRepo.full_name} imported successfully`);
}

export default importRoutes;
