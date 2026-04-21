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

// ─── IMPORT PAGE ─────────────────────────────────────────────

importRoutes.get("/import", requireAuth, requireAdmin, async (c) => {
  const user = c.get("user")!;
  const success = c.req.query("success");
  const error = c.req.query("error");
  const imported = c.req.query("imported");

  // Inline progress banner: the clone subprocess can take 30+s for big
  // repos, so give the user visible feedback while the POST is in flight.
  // Pure client-side — no extra routes, no websockets, no polling.
  const progressScript = `
    (function () {
      var forms = document.querySelectorAll('form[data-import-form]');
      var banner = document.getElementById('import-progress');
      if (!banner) return;
      forms.forEach(function (form) {
        form.addEventListener('submit', function () {
          // Validate non-empty required fields before showing progress.
          var req = form.querySelectorAll('[required]');
          for (var i = 0; i < req.length; i++) {
            if (!req[i].value || !req[i].value.trim()) return;
          }
          banner.style.display = 'block';
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
      <div style="max-width: 700px">
        <h2 style="margin-bottom: 4px">Import from GitHub</h2>
        <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px">
          Migrate your repositories from GitHub to gluecron automatically.
          All branches, all history, all code — one click.
        </p>
        <a
          href="/import/bulk"
          style="display: block; background: var(--bg-secondary); border: 1px solid var(--border); border-left: 3px solid #3fb950; border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px; font-size: 14px; text-decoration: none; color: inherit"
        >
          <strong>Migrating a whole org? Try the bulk importer →</strong>
          <div style="color: var(--text-muted); margin-top: 4px">
            Paste a GitHub org name + token and clone every repo in one shot.
          </div>
        </a>
        {success && (
          <div class="auth-success">
            {decodeURIComponent(success)}
            {imported && (
              <div style="margin-top: 8px">
                Successfully imported {decodeURIComponent(imported)} repositories.
              </div>
            )}
            <div style="margin-top: 10px">
              <a href={`/${user.username}`} class="btn btn-primary" style="margin-right: 8px">
                View my repositories
              </a>
              <a href="/explore" class="btn">Explore</a>
            </div>
          </div>
        )}
        {error && (
          <div class="auth-error">{decodeURIComponent(error)}</div>
        )}

        <div
          id="import-progress"
          role="status"
          aria-live="polite"
          style="display: none; background: var(--bg-secondary); border: 1px solid var(--border); border-left: 3px solid #f0b429; border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px; font-size: 14px"
        >
          <strong>Import in progress…</strong>
          <div style="color: var(--text-muted); margin-top: 4px">
            Cloning from GitHub. Large repositories can take 30+ seconds — don't close this tab.
          </div>
        </div>

        <div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 24px">
          <h3 style="margin-bottom: 12px">Option 1: Import by username</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px">
            Import all public repositories from a GitHub user or organization.
          </p>
          <form method="POST" action="/import/github/user" data-import-form>
            <div style="display: flex; gap: 8px">
              <input
                type="text"
                name="github_username"
                required
                placeholder="GitHub username or org"
                style="flex: 1; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px"
              />
              <button type="submit" class="btn btn-primary">
                Import all repos
              </button>
            </div>
          </form>
        </div>

        <div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 24px">
          <h3 style="margin-bottom: 12px">Option 2: Import single repo</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px">
            Import a specific repository by URL (https, ssh, or owner/repo).
          </p>
          <form method="POST" action="/import/github/repo" data-import-form>
            <div style="display: flex; gap: 8px">
              <input
                type="text"
                name="repo_url"
                required
                placeholder="https://github.com/owner/repo"
                style="flex: 1; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px"
              />
              <button type="submit" class="btn btn-primary">
                Import
              </button>
            </div>
          </form>
        </div>

        <div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px">
          <h3 style="margin-bottom: 12px">Option 3: Import with token (private repos)</h3>
          <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px">
            Use a GitHub personal access token to import private repositories too.
            Generate one at github.com → Settings → Developer settings → Personal access tokens.
          </p>
          <form method="POST" action="/import/github/user" data-import-form>
            <div class="form-group">
              <input
                type="text"
                name="github_username"
                required
                placeholder="GitHub username"
                style="padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; width: 100%"
              />
            </div>
            <div class="form-group">
              <input
                type="password"
                name="github_token"
                required
                placeholder="ghp_xxxxxxxxxxxx (GitHub personal access token)"
                style="padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; font-family: var(--font-mono); width: 100%"
              />
            </div>
            <button type="submit" class="btn btn-primary">
              Import all repos (public + private)
            </button>
          </form>
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
        console.error(`[import] failed to import ${ghRepo.full_name}:`, err);
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

  if (!repoUrl) {
    return c.redirect("/import?error=Repository+URL+is+required");
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
    const res = await fetch(
      `https://api.github.com/repos/${ghOwner}/${ghRepo}`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "gluecron/1.0",
        },
      }
    );

    if (!res.ok) {
      return c.redirect(
        `/import?error=${encodeURIComponent(
          `Repository not found on GitHub (${res.status}). Check the URL and that it's public.`
        )}`
      );
    }

    const ghRepoData: GitHubRepo = await res.json();

    await importSingleRepo(user, ghRepoData, null);

    return c.redirect(`/${user.username}/${sanitizeRepoName(ghRepoData.name)}`);
  } catch (err) {
    console.error("[import] error:", err);
    return c.redirect(
      `/import?error=${encodeURIComponent(`Import failed: ${String(err)}`)}`
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
