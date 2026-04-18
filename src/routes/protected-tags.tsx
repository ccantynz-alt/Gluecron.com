/**
 * Block E7 — Protected tags settings UI.
 *
 *   GET  /:owner/:repo/settings/protected-tags            — CRUD list
 *   POST /:owner/:repo/settings/protected-tags            — create
 *   POST /:owner/:repo/settings/protected-tags/:id/delete — remove
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  addProtectedTag,
  listProtectedTags,
  removeProtectedTag,
} from "../lib/protected-tags";
import { audit } from "../lib/notify";

const protectedTagsRoutes = new Hono<AuthEnv>();
protectedTagsRoutes.use("*", softAuth);

async function loadRepo(ownerName: string, repoName: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

protectedTagsRoutes.get(
  "/:owner/:repo/settings/protected-tags",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}`);

    const tags = await listProtectedTags(repoRow.id);
    const success = c.req.query("success");
    const error = c.req.query("error");

    return c.html(
      <Layout title={`Protected tags — ${owner}/${repo}`} user={user}>
        <RepoHeader
          owner={owner}
          repo={repo}
          starCount={repoRow.starCount}
          forkCount={repoRow.forkCount}
          currentUser={user.username}
        />
        <RepoNav owner={owner} repo={repo} active="gates" />

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3>Protected tags</h3>
          <a href={`/${owner}/${repo}/settings`} class="btn btn-sm">
            Back to settings
          </a>
        </div>

        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
          Mark tag patterns as protected. Only repo owners can create, update,
          or delete tags matching one of these patterns. Supports globs:
          <code>v*</code>, <code>release-*</code>, <code>**</code>.
        </p>

        {success && <div class="auth-success">{decodeURIComponent(success)}</div>}
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}

        <div class="panel" style="margin-bottom:16px">
          {tags.length === 0 ? (
            <div class="panel-empty">No protected tag patterns.</div>
          ) : (
            tags.map((t) => (
              <div class="panel-item" style="justify-content:space-between">
                <div>
                  <code
                    style="background:var(--bg-tertiary);padding:2px 8px;border-radius:3px"
                  >
                    {t.pattern}
                  </code>
                  <div
                    class="meta"
                    style="margin-top:4px;font-size:12px;color:var(--text-muted)"
                  >
                    Added{" "}
                    {t.createdAt
                      ? new Date(t.createdAt as unknown as string).toLocaleDateString()
                      : ""}
                  </div>
                </div>
                <form
                  method="POST"
                  action={`/${owner}/${repo}/settings/protected-tags/${t.id}/delete`}
                  onsubmit="return confirm('Remove protection for this pattern?')"
                >
                  <button type="submit" class="btn btn-sm btn-danger">
                    Remove
                  </button>
                </form>
              </div>
            ))
          )}
        </div>

        <form
          method="POST"
          action={`/${owner}/${repo}/settings/protected-tags`}
          class="panel"
          style="padding:16px"
        >
          <div class="form-group">
            <label>Pattern</label>
            <input
              type="text"
              name="pattern"
              required
              placeholder="v* or release-*"
              style="font-family:var(--font-mono)"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Protect pattern
          </button>
        </form>
      </Layout>
    );
  }
);

protectedTagsRoutes.post(
  "/:owner/:repo/settings/protected-tags",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}`);

    const body = await c.req.parseBody();
    const pattern = String(body.pattern || "").trim();
    if (!pattern) {
      return c.redirect(
        `/${owner}/${repo}/settings/protected-tags?error=${encodeURIComponent("Pattern required")}`
      );
    }

    const created = await addProtectedTag({
      repositoryId: repoRow.id,
      pattern,
      createdBy: user.id,
    });

    if (created) {
      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "protected_tags.create",
        metadata: { pattern },
      });
    }

    return c.redirect(
      `/${owner}/${repo}/settings/protected-tags?success=${encodeURIComponent(
        created ? `Pattern '${pattern}' protected` : "Could not save pattern"
      )}`
    );
  }
);

protectedTagsRoutes.post(
  "/:owner/:repo/settings/protected-tags/:id/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, id } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}`);

    const ok = await removeProtectedTag(repoRow.id, id);
    if (ok) {
      await audit({
        userId: user.id,
        repositoryId: repoRow.id,
        action: "protected_tags.delete",
        targetId: id,
      });
    }

    return c.redirect(
      `/${owner}/${repo}/settings/protected-tags?success=${encodeURIComponent(
        ok ? "Pattern removed" : "Nothing removed"
      )}`
    );
  }
);

export default protectedTagsRoutes;
