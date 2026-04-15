/**
 * Block C3 — Pages / static hosting routes.
 *
 *   GET  /:owner/:repo/pages/*             — serve a static file from the
 *                                            latest successful gh-pages
 *                                            deployment
 *   GET  /:owner/:repo/settings/pages      — settings UI (owner-only)
 *   POST /:owner/:repo/settings/pages      — upsert settings
 *   POST /:owner/:repo/settings/pages/redeploy — manual redeploy trigger
 *
 * The serving endpoint reads blobs directly out of the bare git repo at the
 * commit sha of the most recent pages_deployments row for that repo. There is
 * no on-disk export — the git store IS the CDN.
 */

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  pagesDeployments,
  pagesSettings,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getBlob, getRawBlob, resolveRef } from "../git/repository";
import { audit } from "../lib/notify";
import { getUnreadCount } from "../lib/unread";
import { config } from "../lib/config";
import {
  contentTypeFor,
  onPagesPush,
  resolvePagesPath,
} from "../lib/pages";

const pagesRoute = new Hono<AuthEnv>();
pagesRoute.use("*", softAuth);

interface LoadedRepo {
  id: string;
  name: string;
  ownerId: string;
  ownerUsername: string;
}

async function loadRepo(
  owner: string,
  repo: string
): Promise<LoadedRepo | null> {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

async function getEffectiveSettings(repositoryId: string) {
  try {
    const [row] = await db
      .select()
      .from(pagesSettings)
      .where(eq(pagesSettings.repositoryId, repositoryId))
      .limit(1);
    if (row) return row;
  } catch {
    /* fall through to defaults */
  }
  // Synthesise defaults when the row doesn't exist.
  return {
    repositoryId,
    enabled: true,
    sourceBranch: "gh-pages",
    sourceDir: "/",
    customDomain: null as string | null,
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Serve: GET /:owner/:repo/pages/*
// ---------------------------------------------------------------------------

pagesRoute.get("/:owner/:repo/pages/*", async (c) => {
  const { owner, repo } = c.req.param();

  // Hono gives us the full path via c.req.path; extract whatever sits after
  // the "/pages/" segment. This is the only path component we treat as the
  // user-facing URL.
  const full = c.req.path;
  const marker = `/${owner}/${repo}/pages/`;
  const idx = full.indexOf(marker);
  const urlRest = idx >= 0 ? full.slice(idx + marker.length) : "";

  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) {
    return c.text("No Pages site published for this repository.", 404);
  }

  const settings = await getEffectiveSettings(repoRow.id);
  if (!settings.enabled) {
    return c.text("No Pages site published for this repository.", 404);
  }

  let deployment:
    | { commitSha: string; createdAt: Date; status: string }
    | null = null;
  try {
    const [row] = await db
      .select({
        commitSha: pagesDeployments.commitSha,
        createdAt: pagesDeployments.createdAt,
        status: pagesDeployments.status,
      })
      .from(pagesDeployments)
      .where(
        and(
          eq(pagesDeployments.repositoryId, repoRow.id),
          eq(pagesDeployments.status, "success")
        )
      )
      .orderBy(desc(pagesDeployments.createdAt))
      .limit(1);
    deployment = row || null;
  } catch {
    return c.text("Service unavailable", 503);
  }

  if (!deployment) {
    return c.text(
      "No Pages site published for this repository. Push to the configured source branch to publish.",
      404
    );
  }

  const candidates = resolvePagesPath(urlRest, settings.sourceDir);

  for (const candidate of candidates) {
    // Try as text first — getBlob fills in isBinary for us.
    const blob = await getBlob(owner, repo, deployment.commitSha, candidate);
    if (!blob) continue;

    const headers: Record<string, string> = {
      "Content-Type": contentTypeFor(candidate),
      "Cache-Control": "public, max-age=60",
      "X-Gluecron-Pages-Sha": deployment.commitSha.slice(0, 7),
    };

    if (blob.isBinary) {
      // getBlob blanks the content for binary — re-read the raw bytes.
      const raw = await getRawBlob(
        owner,
        repo,
        deployment.commitSha,
        candidate
      );
      if (!raw) continue;
      return new Response(raw, { status: 200, headers });
    }

    return new Response(blob.content, { status: 200, headers });
  }

  return c.text("Not found in Pages site.", 404);
});

// ---------------------------------------------------------------------------
// Settings UI: GET /:owner/:repo/settings/pages
// ---------------------------------------------------------------------------

pagesRoute.get(
  "/:owner/:repo/settings/pages",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const success = c.req.query("success");
    const error = c.req.query("error");
    const info = c.req.query("info");

    const repoRow = await loadRepo(ownerName, repoName);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.html(
        <Layout title="Unauthorized" user={user}>
          <div class="empty-state">
            <h2>Unauthorized</h2>
            <p>Only the repository owner can configure Pages.</p>
          </div>
        </Layout>,
        403
      );
    }

    const settings = await getEffectiveSettings(repoRow.id);

    let recent: Array<{
      id: string;
      ref: string;
      commitSha: string;
      status: string;
      createdAt: Date;
    }> = [];
    try {
      recent = await db
        .select({
          id: pagesDeployments.id,
          ref: pagesDeployments.ref,
          commitSha: pagesDeployments.commitSha,
          status: pagesDeployments.status,
          createdAt: pagesDeployments.createdAt,
        })
        .from(pagesDeployments)
        .where(eq(pagesDeployments.repositoryId, repoRow.id))
        .orderBy(desc(pagesDeployments.createdAt))
        .limit(10);
    } catch {
      /* fall through; render with empty list */
    }

    const unread = await getUnreadCount(user.id);
    const siteUrl = `${config.appBaseUrl}/${ownerName}/${repoName}/pages/`;

    return c.html(
      <Layout
        title={`Pages — ${ownerName}/${repoName}`}
        user={user}
        notificationCount={unread}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="code" />
        <div style="max-width: 720px">
          <h2 style="margin-bottom: 16px">Pages</h2>
          {success && (
            <div class="auth-success">{decodeURIComponent(success)}</div>
          )}
          {info && <div class="auth-success">{decodeURIComponent(info)}</div>}
          {error && (
            <div class="auth-error">{decodeURIComponent(error)}</div>
          )}

          <p style="color: var(--text-muted); margin-bottom: 20px">
            Publish a static site from this repository. Push to the source
            branch and every successful push becomes a new deployment.
          </p>

          <div
            style="padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 24px; background: var(--bg-muted)"
          >
            <div style="font-size: 13px; color: var(--text-muted)">
              Your site is published at:
            </div>
            <div style="margin-top: 4px">
              <a href={siteUrl}>{siteUrl}</a>
            </div>
          </div>

          <form
            method="POST"
            action={`/${ownerName}/${repoName}/settings/pages`}
          >
            <div class="form-group">
              <label>
                <input
                  type="checkbox"
                  name="enabled"
                  value="1"
                  checked={settings.enabled}
                />
                {" "}Enable GitHub Pages
              </label>
            </div>
            <div class="form-group">
              <label for="source_branch">Source branch</label>
              <input
                type="text"
                id="source_branch"
                name="source_branch"
                value={settings.sourceBranch}
                placeholder="gh-pages"
              />
            </div>
            <div class="form-group">
              <label for="source_dir">Source directory</label>
              <input
                type="text"
                id="source_dir"
                name="source_dir"
                value={settings.sourceDir}
                placeholder="/"
              />
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px">
                Use "/" to serve from the repo root, or e.g. "/docs".
              </div>
            </div>
            <div class="form-group">
              <label for="custom_domain">Custom domain (optional)</label>
              <input
                type="text"
                id="custom_domain"
                name="custom_domain"
                value={settings.customDomain || ""}
                placeholder="example.com"
              />
            </div>
            <button type="submit" class="btn btn-primary">
              Save
            </button>
          </form>

          <div style="margin-top: 32px">
            <div
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px"
            >
              <h3>Recent deployments</h3>
              <form
                method="POST"
                action={`/${ownerName}/${repoName}/settings/pages/redeploy`}
                style="display: inline"
              >
                <button type="submit" class="btn">
                  Redeploy from HEAD
                </button>
              </form>
            </div>
            {recent.length === 0 ? (
              <div class="empty-state">
                <p>
                  No deployments yet — push to{" "}
                  <code>{settings.sourceBranch}</code> to publish.
                </p>
              </div>
            ) : (
              <table
                style="width: 100%; border-collapse: collapse; font-size: 13px"
              >
                <thead>
                  <tr style="text-align: left; color: var(--text-muted)">
                    <th style="padding: 6px 0">When</th>
                    <th>Ref</th>
                    <th>Commit</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((d) => (
                    <tr style="border-top: 1px solid var(--border)">
                      <td style="padding: 6px 0">
                        {new Date(d.createdAt).toISOString()}
                      </td>
                      <td>
                        <code>{d.ref}</code>
                      </td>
                      <td>
                        <code>{d.commitSha.slice(0, 7)}</code>
                      </td>
                      <td
                        style={`color: ${d.status === "success" ? "var(--green)" : "var(--red)"}`}
                      >
                        {d.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// Save settings: POST /:owner/:repo/settings/pages
// ---------------------------------------------------------------------------

pagesRoute.post(
  "/:owner/:repo/settings/pages",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();

    const repoRow = await loadRepo(ownerName, repoName);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const enabled = body.enabled === "1" || body.enabled === "on";
    const sourceBranch =
      String(body.source_branch || "gh-pages").trim() || "gh-pages";
    let sourceDir = String(body.source_dir || "/").trim() || "/";
    if (!sourceDir.startsWith("/")) sourceDir = `/${sourceDir}`;
    const customDomainRaw = String(body.custom_domain || "").trim();
    const customDomain = customDomainRaw === "" ? null : customDomainRaw;

    try {
      const [existing] = await db
        .select({ repositoryId: pagesSettings.repositoryId })
        .from(pagesSettings)
        .where(eq(pagesSettings.repositoryId, repoRow.id))
        .limit(1);
      if (existing) {
        await db
          .update(pagesSettings)
          .set({
            enabled,
            sourceBranch,
            sourceDir,
            customDomain,
            updatedAt: new Date(),
          })
          .where(eq(pagesSettings.repositoryId, repoRow.id));
      } else {
        await db.insert(pagesSettings).values({
          repositoryId: repoRow.id,
          enabled,
          sourceBranch,
          sourceDir,
          customDomain,
        });
      }
    } catch (err) {
      console.error("[pages] save settings:", err);
      return c.redirect(
        `/${ownerName}/${repoName}/settings/pages?error=${encodeURIComponent("Could not save settings")}`
      );
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "pages.settings.update",
      metadata: { enabled, sourceBranch, sourceDir, customDomain },
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings/pages?success=${encodeURIComponent("Pages settings saved")}`
    );
  }
);

// ---------------------------------------------------------------------------
// Manual redeploy: POST /:owner/:repo/settings/pages/redeploy
// ---------------------------------------------------------------------------

pagesRoute.post(
  "/:owner/:repo/settings/pages/redeploy",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;

    const repoRow = await loadRepo(ownerName, repoName);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}`);
    }

    const settings = await getEffectiveSettings(repoRow.id);
    const branch = settings.sourceBranch || "gh-pages";
    const ref = `refs/heads/${branch}`;

    // Try to resolve the current head of the source branch. If the branch
    // doesn't exist yet, tell the owner to push something to it instead of
    // recording a bogus deployment row.
    const sha = await resolveRef(ownerName, repoName, ref);
    if (!sha) {
      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "pages.redeploy",
        metadata: { ref, result: "no-branch" },
      });
      return c.redirect(
        `/${ownerName}/${repoName}/settings/pages?info=${encodeURIComponent(`Branch ${branch} has no commits yet — push to it to deploy.`)}`
      );
    }

    await onPagesPush({
      ownerLogin: ownerName,
      repoName,
      repositoryId: repoRow.id,
      ref,
      newSha: sha,
      triggeredByUserId: user.id,
    });

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "pages.redeploy",
      metadata: { ref, sha },
    });

    return c.redirect(
      `/${ownerName}/${repoName}/settings/pages?success=${encodeURIComponent("Redeploy recorded")}`
    );
  }
);

export default pagesRoute;
