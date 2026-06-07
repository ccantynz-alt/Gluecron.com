/**
 * GitHub Org Migration Wizard — bulk import every repo from a GitHub org or
 * personal account with live per-repo progress tracking.
 *
 * Routes:
 *   GET  /migrate              — landing page with wizard form
 *   POST /migrate/start        — validate PAT, list repos, create session, redirect
 *   GET  /migrate/:sessionId   — live progress page (meta-refresh every 3s)
 *   GET  /migrate/:sessionId/status — JSON status endpoint
 *
 * Sessions live in-memory (Map). Repos use the existing `repositories` table.
 * Token is never stored — it lives only in the in-memory session for the
 * duration of cloning, then is scrubbed.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { config } from "../lib/config";
import { mkdir } from "fs/promises";
import { join } from "path";
import { sanitizeRepoName } from "../lib/import-helper";

const migrateRoutes = new Hono<AuthEnv>();

// ─── IN-MEMORY SESSION STORE ─────────────────────────────────

interface MigrationRepo {
  name: string;
  status: "pending" | "cloning" | "done" | "failed";
  error?: string;
  repoId?: string;
}

interface MigrationSession {
  id: string;
  userId: string;
  username: string;
  githubOrg: string;
  githubToken: string; // scrubbed after all clones complete
  useOrgEndpoint: boolean;
  repos: MigrationRepo[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

const migrationSessions = new Map<string, MigrationSession>();

// Purge sessions older than 2 hours to avoid unbounded growth.
function purgeStaleSessions(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, session] of migrationSessions) {
    if (session.createdAt.getTime() < cutoff) {
      migrationSessions.delete(id);
    }
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// ─── GITHUB API HELPERS ──────────────────────────────────────

interface GitHubRepo {
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  clone_url: string;
  default_branch: string;
}

const GITHUB_HEADERS = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "gluecron/1.0",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

async function fetchGithubRepos(
  org: string,
  token: string,
  useOrgEndpoint: boolean
): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = useOrgEndpoint
      ? `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?per_page=${perPage}&page=${page}&type=all`
      : `https://api.github.com/user/repos?type=all&per_page=${perPage}&page=${page}`;

    const res = await fetch(url, { headers: GITHUB_HEADERS(token) });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string };
        detail = body?.message ? ` — ${body.message}` : "";
      } catch {
        /* non-JSON */
      }
      throw new Error(`GitHub API error (${res.status})${detail}`);
    }
    const batch = (await res.json()) as GitHubRepo[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < perPage) break;
    page++;
    if (page > 10) break; // hard cap: 1000 repos
  }
  return repos;
}

// ─── BACKGROUND CLONE WORKER ─────────────────────────────────

/**
 * Runs sequentially in the background after the session is created.
 * Never throws — all errors are captured per-repo.
 */
async function runMigration(session: MigrationSession): Promise<void> {
  session.startedAt = new Date();
  const { githubOrg, githubToken, username } = session;

  for (const repo of session.repos) {
    repo.status = "cloning";
    try {
      const safeName = sanitizeRepoName(repo.name);

      // Check for existing repo in this user's namespace.
      const [existing] = await db
        .select({ id: repositories.id, name: repositories.name })
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, session.userId),
            eq(repositories.name, safeName)
          )
        )
        .limit(1);

      let finalName = safeName;
      if (existing) {
        // Rename with -2 suffix (or increment until unique).
        finalName = `${safeName}-2`;
        const [existing2] = await db
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.ownerId, session.userId),
              eq(repositories.name, finalName)
            )
          )
          .limit(1);
        if (existing2) {
          // Skip rather than loop indefinitely.
          repo.status = "failed";
          repo.error = `Repo "${safeName}" already exists (tried "${finalName}" too)`;
          continue;
        }
      }

      const destDir = join(config.gitReposPath, username);
      await mkdir(destDir, { recursive: true });
      const destPath = join(destDir, `${finalName}.git`);

      // Build authenticated clone URL.
      const cloneUrl = `https://${encodeURIComponent(githubToken)}@github.com/${githubOrg}/${repo.name}.git`;

      const proc = Bun.spawn(
        ["git", "clone", "--mirror", cloneUrl, destPath],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }
      );
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const safe = stderr.replaceAll(githubToken, "***").slice(0, 400);
        throw new Error(`git clone failed: ${safe}`);
      }

      // Insert into DB.
      const inserted = await db
        .insert(repositories)
        .values({
          name: finalName,
          ownerId: session.userId,
          description: null,
          isPrivate: false, // unknown at this point without per-repo metadata
          defaultBranch: "main",
          diskPath: destPath,
          starCount: 0,
        })
        .returning({ id: repositories.id });

      repo.repoId = inserted[0]?.id;
      repo.name = finalName; // update to actual stored name
      repo.status = "done";
    } catch (err) {
      repo.status = "failed";
      const msg = err instanceof Error ? err.message : String(err);
      repo.error = msg.replaceAll(session.githubToken, "***").slice(0, 300);
    }
  }

  session.completedAt = new Date();
  // Scrub the token from the session now that cloning is done.
  (session as { githubToken: string }).githubToken = "***";
}

// ─── SCOPED CSS ──────────────────────────────────────────────

const migrateStyles = `
  .mig-wiz-wrap { max-width: 900px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* Hero */
  .mig-wiz-hero {
    position: relative;
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .mig-wiz-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    pointer-events: none;
  }
  .mig-wiz-hero-orb-wrap {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 340px; height: 340px;
    pointer-events: none;
    z-index: 0;
  }
  .mig-wiz-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: migWizOrb 14s ease-in-out infinite;
  }
  @keyframes migWizOrb {
    0%, 100% { transform: scale(1); opacity: 0.6; }
    50%       { transform: scale(1.1) translate(-8px, 6px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) { .mig-wiz-hero-orb { animation: none; } }
  .mig-wiz-hero-inner { position: relative; z-index: 1; max-width: 600px; }
  .mig-wiz-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: -0.005em;
  }
  .mig-wiz-eyebrow-dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px rgba(140,109,255,0.6);
    margin-right: 8px;
    vertical-align: 1px;
  }
  .mig-wiz-title {
    font-size: clamp(26px, 4vw, 38px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .mig-wiz-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .mig-wiz-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* Form card */
  .mig-wiz-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    overflow: hidden;
  }
  .mig-wiz-card-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  .mig-wiz-card-eyebrow {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 5px;
  }
  .mig-wiz-card-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.016em;
    color: var(--text-strong);
    margin: 0 0 3px;
  }
  .mig-wiz-card-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
  }
  .mig-wiz-card-body { padding: var(--space-4) var(--space-5); }

  /* Fields */
  .mig-wiz-field { margin-bottom: var(--space-4); }
  .mig-wiz-field:last-child { margin-bottom: 0; }
  .mig-wiz-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-strong);
    margin-bottom: 5px;
    letter-spacing: -0.005em;
  }
  .mig-wiz-hint {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    line-height: 1.45;
  }
  .mig-wiz-input {
    width: 100%;
    padding: 9px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    outline: none;
    font-family: var(--font-sans);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .mig-wiz-input.is-mono { font-family: var(--font-mono); font-size: 13px; }
  .mig-wiz-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .mig-wiz-toggle {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 13px;
    border-radius: 9px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
  }
  .mig-wiz-toggle input[type="checkbox"] {
    margin-top: 2px;
    width: 15px; height: 15px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .mig-wiz-toggle-text { font-size: 13.5px; color: var(--text); line-height: 1.45; }
  .mig-wiz-toggle-hint { display: block; margin-top: 2px; font-size: 12px; color: var(--text-muted); }
  .mig-wiz-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: var(--space-4); }

  /* Banner */
  .mig-wiz-banner {
    position: relative;
    padding: 13px 15px 13px 42px;
    margin-bottom: var(--space-5);
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 14px;
    line-height: 1.5;
  }
  .mig-wiz-banner::before {
    content: '';
    position: absolute;
    left: 13px; top: 17px;
    width: 13px; height: 13px;
    border-radius: 50%;
  }
  .mig-wiz-banner-error {
    border-color: rgba(248,81,73,0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
  }
  .mig-wiz-banner-error::before { background: #f85149; box-shadow: 0 0 10px rgba(248,81,73,0.5); }
  .mig-wiz-banner-title { font-weight: 600; color: var(--text-strong); }
  .mig-wiz-banner-detail { color: var(--text-muted); margin-top: 4px; font-size: 13px; }

  /* Progress page */
  .mig-prog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }
  .mig-prog-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 3vw, 28px);
    font-weight: 800;
    letter-spacing: -0.024em;
    color: var(--text-strong);
    margin: 0;
  }
  .mig-prog-count {
    font-size: 14px;
    color: var(--text-muted);
    margin-top: 4px;
  }
  .mig-prog-count strong { color: var(--text-strong); }

  /* Progress bar */
  .mig-prog-bar-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
    margin-bottom: var(--space-5);
  }
  .mig-prog-bar-label {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .mig-prog-bar-label strong { color: var(--text-strong); }
  .mig-prog-bar-track {
    height: 8px;
    border-radius: 9999px;
    background: var(--bg-secondary);
    overflow: hidden;
  }
  .mig-prog-bar-fill {
    height: 100%;
    border-radius: 9999px;
    background: linear-gradient(90deg, #8c6dff 0%, #36c5d6 100%);
    transition: width 0.8s ease;
    min-width: 4px;
  }

  /* Repo list */
  .mig-prog-list {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .mig-prog-list-head {
    padding: 10px 16px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .mig-prog-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 13.5px;
    transition: background 100ms ease;
  }
  .mig-prog-item:last-child { border-bottom: 0; }
  .mig-prog-item:hover { background: rgba(255,255,255,0.015); }
  .mig-prog-icon { font-size: 16px; flex-shrink: 0; width: 20px; text-align: center; }
  .mig-prog-name { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 13px; color: var(--text-strong); }
  .mig-prog-name a { color: var(--accent); text-decoration: none; }
  .mig-prog-name a:hover { text-decoration: underline; }
  .mig-prog-status {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 9999px;
  }
  .mig-prog-status-pending { color: var(--text-muted); background: var(--bg-secondary); }
  .mig-prog-status-cloning {
    color: #f0b429;
    background: rgba(240,180,41,0.13);
    border: 1px solid rgba(240,180,41,0.3);
    animation: migCloningPulse 1.3s ease-in-out infinite;
  }
  @keyframes migCloningPulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.55; }
  }
  @media (prefers-reduced-motion: reduce) { .mig-prog-status-cloning { animation: none; } }
  .mig-prog-status-done { color: #3fb950; background: rgba(63,185,80,0.13); border: 1px solid rgba(63,185,80,0.28); }
  .mig-prog-status-failed { color: #f85149; background: rgba(248,81,73,0.13); border: 1px solid rgba(248,81,73,0.28); }
  .mig-prog-error { font-size: 11.5px; color: #f85149; margin-top: 2px; word-break: break-all; }

  /* Complete banner */
  .mig-prog-complete {
    padding: 24px 20px;
    background: linear-gradient(135deg, rgba(63,185,80,0.08) 0%, var(--bg-elevated) 100%);
    border: 1px solid rgba(63,185,80,0.32);
    border-radius: 14px;
    margin-bottom: var(--space-5);
    text-align: center;
  }
  .mig-prog-complete-icon { font-size: 36px; margin-bottom: 8px; }
  .mig-prog-complete-title {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -0.022em;
    color: #3fb950;
    margin: 0 0 8px;
  }
  .mig-prog-complete-sub { font-size: 14px; color: var(--text-muted); margin: 0 0 16px; }
`;

// ─── GET /migrate — wizard form ──────────────────────────────

migrateRoutes.get("/migrate", requireAuth, async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="GitHub Org Migration" user={user}>
      <style dangerouslySetInnerHTML={{ __html: migrateStyles }} />
      <div class="mig-wiz-wrap">
        {/* Hero */}
        <div class="mig-wiz-hero">
          <div class="mig-wiz-hero-orb-wrap" aria-hidden="true">
            <div class="mig-wiz-hero-orb" />
          </div>
          <div class="mig-wiz-hero-inner">
            <div class="mig-wiz-eyebrow">
              <span class="mig-wiz-eyebrow-dot" aria-hidden="true" />
              GitHub Migration Wizard
            </div>
            <h1 class="mig-wiz-title">
              Import your entire{" "}
              <span class="gradient-text">GitHub org</span>.
            </h1>
            <p class="mig-wiz-sub">
              Paste your GitHub PAT and org name — Gluecron clones every repo
              sequentially with live progress. Come back to everything migrated.
            </p>
          </div>
        </div>

        {error && (
          <div class="mig-wiz-banner mig-wiz-banner-error" role="alert">
            <div class="mig-wiz-banner-title">Migration could not start</div>
            <div class="mig-wiz-banner-detail">
              {decodeURIComponent(error)}
            </div>
          </div>
        )}

        {/* Form card */}
        <div class="mig-wiz-card">
          <div class="mig-wiz-card-head">
            <div class="mig-wiz-card-eyebrow">Configure</div>
            <h2 class="mig-wiz-card-title">GitHub credentials</h2>
            <p class="mig-wiz-card-desc">
              Your token is used only for this session — it is never written to
              disk or the database.
            </p>
          </div>
          <div class="mig-wiz-card-body">
            <form method="post" action="/migrate/start">
              <div class="mig-wiz-field">
                <label class="mig-wiz-label">GitHub Personal Access Token</label>
                <input
                  type="password"
                  name="githubToken"
                  required
                  placeholder="ghp_xxxxxxxxxxxx"
                  autocomplete="off"
                  aria-label="GitHub personal access token"
                  class="mig-wiz-input is-mono"
                />
                <div class="mig-wiz-hint">
                  Needs <strong>repo</strong> scope for private repos, or
                  <strong> public_repo</strong> for public only. Generate at{" "}
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    github.com/settings/tokens
                  </a>
                  .
                </div>
              </div>

              <div class="mig-wiz-field">
                <label class="mig-wiz-label">
                  GitHub org or personal account name
                </label>
                <input
                  type="text"
                  name="githubOrg"
                  placeholder="my-company or my-username"
                  aria-label="GitHub org or username"
                  class="mig-wiz-input"
                />
                <div class="mig-wiz-hint">
                  Leave blank to import your own account's repos
                  (<code>GET /user/repos</code>). Fill in to import all repos
                  from an org (<code>GET /orgs/:org/repos</code>).
                </div>
              </div>

              <div class="mig-wiz-field">
                <label class="mig-wiz-toggle">
                  <input type="checkbox" name="useOrgEndpoint" value="1" />
                  <span class="mig-wiz-toggle-text">
                    This is an org (not a personal account)
                    <span class="mig-wiz-toggle-hint">
                      Uses <code>/orgs/:org/repos</code> endpoint. Uncheck for
                      personal accounts.
                    </span>
                  </span>
                </label>
              </div>

              <div class="mig-wiz-actions">
                <button type="submit" class="btn btn-primary">
                  Start migration
                </button>
                <a href="/import/bulk" class="btn">
                  Try bulk importer instead
                </a>
              </div>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// ─── POST /migrate/start ─────────────────────────────────────

migrateRoutes.post("/migrate/start", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  const githubToken = String(body.githubToken || "").trim();
  const githubOrg = String(body.githubOrg || "").trim();
  const useOrgEndpoint = Boolean(body.useOrgEndpoint);

  if (!githubToken) {
    return c.redirect(
      "/migrate?error=" + encodeURIComponent("GitHub PAT is required.")
    );
  }

  // Validate the token by calling /user.
  let tokenScopes = "";
  try {
    const checkRes = await fetch("https://api.github.com/user", {
      headers: GITHUB_HEADERS(githubToken),
    });
    if (!checkRes.ok) {
      const msg = `GitHub rejected the token (${checkRes.status}). Check scope + expiry.`;
      return c.redirect("/migrate?error=" + encodeURIComponent(msg));
    }
    tokenScopes = (checkRes.headers.get("x-oauth-scopes") || "").toLowerCase();
  } catch {
    return c.redirect(
      "/migrate?error=" +
        encodeURIComponent("Could not reach GitHub to validate the token.")
    );
  }

  // Warn if the token is missing repo scope.
  if (
    tokenScopes &&
    !tokenScopes.includes("repo") &&
    !tokenScopes.includes("public_repo")
  ) {
    return c.redirect(
      "/migrate?error=" +
        encodeURIComponent(
          "Token is missing repo / public_repo scope. Regenerate at github.com/settings/tokens."
        )
    );
  }

  // If org endpoint requested, require an org name.
  if (useOrgEndpoint && !githubOrg) {
    return c.redirect(
      "/migrate?error=" +
        encodeURIComponent(
          "Org name is required when the org endpoint is selected."
        )
    );
  }

  // Fetch the repo list.
  let ghRepos: GitHubRepo[];
  try {
    ghRepos = await fetchGithubRepos(githubOrg, githubToken, useOrgEndpoint);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.redirect(
      "/migrate?error=" + encodeURIComponent(msg.slice(0, 300))
    );
  }

  if (ghRepos.length === 0) {
    return c.redirect(
      "/migrate?error=" +
        encodeURIComponent(
          `No repos found for "${githubOrg || "your account"}" with this token.`
        )
    );
  }

  // Create the in-memory session.
  purgeStaleSessions();
  const sessionId = randomId();
  const session: MigrationSession = {
    id: sessionId,
    userId: user.id,
    username: user.username,
    githubOrg: githubOrg || user.username,
    githubToken,
    useOrgEndpoint,
    repos: ghRepos.map((r) => ({
      name: r.name,
      status: "pending",
    })),
    createdAt: new Date(),
  };
  migrationSessions.set(sessionId, session);

  // Kick off background cloning (fire and forget).
  runMigration(session).catch((err) => {
    console.error("[migrate] background worker crashed:", err);
  });

  return c.redirect(`/migrate/${sessionId}`);
});

// ─── GET /migrate/:sessionId/status — JSON ───────────────────

migrateRoutes.get("/migrate/:sessionId/status", requireAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId");
  const session = migrationSessions.get(sessionId);

  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }
  if (session.userId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const done = session.repos.filter((r) => r.status === "done").length;
  const failed = session.repos.filter((r) => r.status === "failed").length;
  const total = session.repos.length;
  const complete = !!session.completedAt;

  return c.json({
    id: session.id,
    githubOrg: session.githubOrg,
    total,
    done,
    failed,
    complete,
    startedAt: session.startedAt?.toISOString(),
    completedAt: session.completedAt?.toISOString(),
    repos: session.repos.map((r) => ({
      name: r.name,
      status: r.status,
      error: r.error,
      repoId: r.repoId,
    })),
  });
});

// ─── GET /migrate/:sessionId — progress page ─────────────────

migrateRoutes.get("/migrate/:sessionId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId");
  const session = migrationSessions.get(sessionId);

  if (!session) {
    return c.html(
      <Layout title="Migration not found" user={user}>
        <div style="max-width:600px;margin:4rem auto;text-align:center;color:var(--text-muted)">
          <h1 style="color:var(--text-strong);font-size:22px;font-family:var(--font-display)">
            Session not found
          </h1>
          <p>This migration session has expired or doesn't exist.</p>
          <a href="/migrate" class="btn btn-primary" style="margin-top:1rem">
            Start a new migration
          </a>
        </div>
      </Layout>,
      404
    );
  }

  if (session.userId !== user.id) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <div style="max-width:600px;margin:4rem auto;text-align:center;color:var(--text-muted)">
          <h1 style="color:var(--text-strong);font-size:22px;font-family:var(--font-display)">
            Forbidden
          </h1>
          <p>This migration session belongs to another user.</p>
        </div>
      </Layout>,
      403
    );
  }

  const total = session.repos.length;
  const doneCount = session.repos.filter((r) => r.status === "done").length;
  const failedCount = session.repos.filter((r) => r.status === "failed").length;
  const finishedCount = doneCount + failedCount;
  const pct = total > 0 ? Math.round((finishedCount / total) * 100) : 0;
  const isComplete = !!session.completedAt;

  // JS polling — fetch /status every 3s and update the DOM without a full reload.
  // Falls back gracefully to the meta-refresh if JS is disabled.
  const pollScript = `
(function () {
  if (!window.fetch) return;
  var sessionId = ${JSON.stringify(sessionId)};
  var username = ${JSON.stringify(user.username)};
  function statusCls(s) {
    return 'mig-prog-status mig-prog-status-' + s;
  }
  function iconFor(s) {
    if (s === 'done')    return '\\u2713';
    if (s === 'failed')  return '\\u2717';
    if (s === 'cloning') return '\\u21bb';
    return '\\u23f3';
  }
  function poll() {
    fetch('/migrate/' + sessionId + '/status')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Update progress bar.
        var finished = data.done + data.failed;
        var pct = data.total > 0 ? Math.round(finished / data.total * 100) : 0;
        var bar = document.getElementById('mig-bar-fill');
        var lbl = document.getElementById('mig-bar-label');
        if (bar) bar.style.width = pct + '%';
        if (lbl) lbl.textContent = finished + ' / ' + data.total + ' repos (' + pct + '%)';

        // Update each repo row.
        data.repos.forEach(function (repo) {
          var row = document.getElementById('mig-repo-' + repo.name);
          if (!row) return;
          var icon = row.querySelector('.mig-prog-icon');
          var st   = row.querySelector('.mig-prog-status');
          var nm   = row.querySelector('.mig-prog-name');
          var err  = row.querySelector('.mig-prog-error');
          if (icon) icon.textContent = iconFor(repo.status);
          if (st)   { st.className = statusCls(repo.status); st.textContent = repo.status; }
          if (nm && repo.status === 'done' && repo.name) {
            nm.innerHTML = '<a href="/' + username + '/' + repo.name + '">' + repo.name + '</a>';
          }
          if (err) { err.textContent = repo.error || ''; err.style.display = repo.error ? '' : 'none'; }
        });

        // Show complete banner.
        if (data.complete) {
          var banner = document.getElementById('mig-complete-banner');
          if (banner) banner.style.display = '';
          // Stop polling.
          return;
        }
        setTimeout(poll, 3000);
      })
      .catch(function () { setTimeout(poll, 5000); });
  }
  setTimeout(poll, 3000);
})();
`;

  return c.html(
    <Layout title={`Migrating ${session.githubOrg}`} user={user}>
      {/* Meta-refresh fallback for no-JS environments */}
      {!isComplete && (
        <meta http-equiv="refresh" content="3" />
      )}
      <style dangerouslySetInnerHTML={{ __html: migrateStyles }} />
      <div class="mig-wiz-wrap">
        {/* Header */}
        <div class="mig-prog-header">
          <div>
            <h1 class="mig-prog-title">
              Migrating from GitHub: @{session.githubOrg}
            </h1>
            <div class="mig-prog-count">
              <strong>{total}</strong> {total === 1 ? "repo" : "repos"} found
            </div>
          </div>
        </div>

        {/* Complete banner */}
        <div
          id="mig-complete-banner"
          class="mig-prog-complete"
          style={isComplete ? "" : "display:none"}
        >
          <div class="mig-prog-complete-icon" aria-hidden="true">
            &#10003;
          </div>
          <div class="mig-prog-complete-title">Migration Complete!</div>
          <div class="mig-prog-complete-sub">
            {doneCount} repo{doneCount !== 1 ? "s" : ""} imported
            {failedCount > 0 ? `, ${failedCount} failed` : ""}.
          </div>
          <a href={`/${user.username}`} class="btn btn-primary">
            View my repositories
          </a>
        </div>

        {/* Progress bar */}
        <div class="mig-prog-bar-wrap">
          <div class="mig-prog-bar-label">
            <span>Progress</span>
            <span id="mig-bar-label">
              {finishedCount} / {total} repos ({pct}%)
            </span>
          </div>
          <div class="mig-prog-bar-track">
            <div
              id="mig-bar-fill"
              class="mig-prog-bar-fill"
              style={`width:${pct}%`}
            />
          </div>
        </div>

        {/* Repo list */}
        <div class="mig-prog-list">
          <div class="mig-prog-list-head">Repositories</div>
          {session.repos.map((repo) => {
            const icon =
              repo.status === "done"
                ? "✓"
                : repo.status === "failed"
                  ? "✗"
                  : repo.status === "cloning"
                    ? "↻"
                    : "⏳";
            const statusCls = `mig-prog-status mig-prog-status-${repo.status}`;
            return (
              <div class="mig-prog-item" id={`mig-repo-${repo.name}`}>
                <span class="mig-prog-icon" aria-hidden="true">
                  {icon}
                </span>
                <div style="flex:1;min-width:0">
                  <div class="mig-prog-name">
                    {repo.status === "done" ? (
                      <a href={`/${user.username}/${repo.name}`}>
                        {repo.name}
                      </a>
                    ) : (
                      repo.name
                    )}
                  </div>
                  {repo.error && (
                    <div class="mig-prog-error">{repo.error}</div>
                  )}
                </div>
                <span class={statusCls}>{repo.status}</span>
              </div>
            );
          })}
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: pollScript }} />
    </Layout>
  );
});

export default migrateRoutes;
