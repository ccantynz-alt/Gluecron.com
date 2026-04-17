/**
 * Block L — GitHub import UI.
 *
 * GET  /new/import — form (PAT + owner/repo + target name + visibility).
 * POST /new/import — clones the repo via `git clone --mirror`, then walks
 *                    GitHub metadata synchronously. Redirects to the target
 *                    repo page on success.
 *
 * v1 is synchronous: we return when the clone + walk finishes (caps keep
 * this bounded). Later this can be moved to a background worker.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { join } from "path";
import { db } from "../db";
import {
  githubImports,
  repositories,
  users,
} from "../db/schema";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { config } from "../lib/config";
import { repoExists } from "../git/repository";
import { audit } from "../lib/notify";
import {
  buildAuthedCloneUrl,
  createImportRow,
  finaliseImportRow,
  redactCloneUrl,
  runImport,
  type ImportStats,
} from "../lib/github-import";

const githubImport = new Hono<AuthEnv>();

githubImport.use("*", softAuth);

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

githubImport.get("/new/import", requireAuth, async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  // Show recent imports by this user so they can see what's been pulled.
  let recent: Array<{
    id: string;
    sourceOwner: string;
    sourceRepo: string;
    status: string;
    stats: string;
    startedAt: Date;
    repositoryId: string | null;
  }> = [];
  try {
    const rows = await db
      .select()
      .from(githubImports)
      .where(eq(githubImports.userId, user.id))
      .orderBy(desc(githubImports.startedAt))
      .limit(10);
    recent = rows.map((r) => ({
      id: r.id,
      sourceOwner: r.sourceOwner,
      sourceRepo: r.sourceRepo,
      status: r.status,
      stats: r.stats,
      startedAt: r.startedAt,
      repositoryId: r.repositoryId,
    }));
  } catch {
    recent = [];
  }

  return c.html(
    <Layout title="Import from GitHub" user={user}>
      <div class="new-repo-form">
        <h2>Import from GitHub</h2>
        <p style="color: var(--muted); margin-bottom: 16px">
          Clone a GitHub repository into your Gluecron namespace, including
          issues, pull requests, comments, releases, and labels.
        </p>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="POST" action="/new/import">
          <div class="form-group">
            <label for="source">GitHub repo (owner/repo)</label>
            <input
              type="text"
              id="source"
              name="source"
              required
              placeholder="octocat/hello-world"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label for="token">GitHub personal access token</label>
            <input
              type="password"
              id="token"
              name="token"
              required
              placeholder="github_pat_... or ghp_..."
              autocomplete="off"
            />
            <small style="color: var(--muted)">
              Needs <code>repo</code> scope for private repos, or <code>public_repo</code>.
              Never stored.
            </small>
          </div>
          <div class="form-group">
            <label for="name">Target name on Gluecron</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              pattern="^[a-zA-Z0-9._-]+$"
              placeholder="hello-world"
              autocomplete="off"
            />
          </div>
          <div class="visibility-options">
            <label class="visibility-option">
              <input type="radio" name="visibility" value="public" checked />
              <div class="vis-label">Public</div>
              <div class="vis-desc">Anyone can see this repository</div>
            </label>
            <label class="visibility-option">
              <input type="radio" name="visibility" value="private" />
              <div class="vis-label">Private</div>
              <div class="vis-desc">Only you can see this repository</div>
            </label>
          </div>
          <button type="submit" class="btn btn-primary">
            Start import
          </button>
        </form>

        {recent.length > 0 && (
          <div style="margin-top: 32px">
            <h3>Recent imports</h3>
            <table style="width: 100%; margin-top: 8px">
              <thead>
                <tr>
                  <th style="text-align: left">Source</th>
                  <th style="text-align: left">Status</th>
                  <th style="text-align: left">Stats</th>
                  <th style="text-align: left">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr>
                    <td>
                      <code>
                        {r.sourceOwner}/{r.sourceRepo}
                      </code>
                    </td>
                    <td>
                      <span class={`badge badge-${r.status}`}>{r.status}</span>
                    </td>
                    <td>
                      <code style="font-size: 11px">{r.stats}</code>
                    </td>
                    <td style="font-size: 12px; color: var(--muted)">
                      {r.startedAt.toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

githubImport.post("/new/import", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const source = String(body.source || "").trim();
  const token = String(body.token || "").trim();
  const targetName = String(body.name || "").trim();
  const isPrivate = body.visibility === "private";

  const bail = (msg: string) =>
    c.redirect(`/new/import?error=${encodeURIComponent(msg)}`);

  const sourceMatch = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!sourceMatch) return bail("Source must be owner/repo");
  const [, sourceOwner, sourceRepo] = sourceMatch;

  if (!token) return bail("GitHub token is required");
  if (!/^[a-zA-Z0-9._-]+$/.test(targetName)) {
    return bail("Invalid target repository name");
  }
  if (await repoExists(user.username, targetName)) {
    return bail("Target repository already exists");
  }

  const cloneUrl = buildAuthedCloneUrl(token, sourceOwner, sourceRepo);
  if (!cloneUrl.ok) return bail(cloneUrl.error);

  // Create the import ledger row up front so the user can see progress.
  const importId = await createImportRow({
    userId: user.id,
    sourceOwner,
    sourceRepo,
  });

  // Clone the git content first. `git clone --mirror` gives us every ref.
  const destPath = join(
    config.gitReposPath,
    user.username,
    `${targetName}.git`
  );
  if (importId) {
    await finaliseImportRow(importId, { status: "cloning" });
  }

  const proc = Bun.spawn(["git", "clone", "--mirror", cloneUrl.data, destPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) =>
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        resolve(124);
      }, 10 * 60 * 1000)
    ),
  ]);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    const redacted = redactCloneUrl(stderr).slice(0, 500);
    if (importId) {
      await finaliseImportRow(importId, {
        status: "error",
        error: `git clone exited ${exitCode}: ${redacted}`,
      });
    }
    return bail(`Clone failed (exit ${exitCode})`);
  }

  // Create the target repo row.
  let newRepoId: string;
  try {
    const [newRepo] = await db
      .insert(repositories)
      .values({
        name: targetName,
        ownerId: user.id,
        description: `Imported from github.com/${sourceOwner}/${sourceRepo}`,
        isPrivate,
        defaultBranch: "main",
        diskPath: destPath,
      })
      .returning();
    if (!newRepo) throw new Error("insert returned nothing");
    newRepoId = newRepo.id;
  } catch (err) {
    if (importId) {
      await finaliseImportRow(importId, {
        status: "error",
        error: err instanceof Error ? err.message : "DB insert failed",
      });
    }
    return bail("Could not create Gluecron repo row");
  }

  // Green-by-default bootstrap (gates, protection, labels, welcome).
  try {
    const { bootstrapRepository } = await import("../lib/repo-bootstrap");
    await bootstrapRepository({
      repositoryId: newRepoId,
      ownerUserId: user.id,
      defaultBranch: "main",
      skipWelcomeIssue: true,
    });
  } catch {
    // non-fatal
  }

  if (importId) {
    await finaliseImportRow(importId, {
      repositoryId: newRepoId,
      status: "walking",
    });
  }

  // Walk GitHub metadata.
  let stats: ImportStats;
  let walkError: string | undefined;
  try {
    const res = await runImport({
      token,
      sourceOwner,
      sourceRepo,
      targetRepoId: newRepoId,
      importerUserId: user.id,
    });
    stats = res.stats;
    walkError = res.error;
  } catch (err) {
    stats = {
      labels: 0,
      issues: 0,
      pulls: 0,
      issueComments: 0,
      prComments: 0,
      releases: 0,
      stargazers: 0,
    };
    walkError = err instanceof Error ? err.message : "unknown error";
  }

  if (importId) {
    await finaliseImportRow(importId, {
      repositoryId: newRepoId,
      status: walkError ? "error" : "ok",
      stats,
      error: walkError,
    });
  }

  try {
    await audit({
      userId: user.id,
      repositoryId: newRepoId,
      action: "github_import",
      targetType: "repository",
      targetId: newRepoId,
      metadata: { source: `${sourceOwner}/${sourceRepo}`, stats, walkError },
    });
  } catch {
    // ignore
  }

  return c.redirect(`/${user.username}/${targetName}`);
});

// ---------------------------------------------------------------------------
// Status API (JSON) — useful for polling from the UI later.
// ---------------------------------------------------------------------------

githubImport.get("/api/imports/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { id } = c.req.param();
  try {
    const [row] = await db
      .select()
      .from(githubImports)
      .where(eq(githubImports.id, id))
      .limit(1);
    if (!row || row.userId !== user.id) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({
      id: row.id,
      source: `${row.sourceOwner}/${row.sourceRepo}`,
      status: row.status,
      stats: (() => {
        try {
          return JSON.parse(row.stats);
        } catch {
          return {};
        }
      })(),
      error: row.error,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    });
  } catch {
    return c.json({ error: "not available" }, 503);
  }
});

export default githubImport;

// Silence unused-import complaint for tests that need `users`.
void users;
