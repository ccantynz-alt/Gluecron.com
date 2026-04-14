/**
 * Releases — tagged snapshots with AI-generated changelogs.
 *
 *   GET  /:owner/:repo/releases           — list
 *   GET  /:owner/:repo/releases/new       — create form (tag + target + AI notes)
 *   POST /:owner/:repo/releases           — create release + git tag + changelog
 *   GET  /:owner/:repo/releases/:tag      — view single release
 *   POST /:owner/:repo/releases/:tag/delete — owner-only delete (also removes git tag)
 *
 * Publishing a release fans out `release_published` notifications to starrers.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  releases,
  repositories,
  users,
  stars,
  repoSettings,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  listBranches,
  listTags,
  createTag,
  deleteTag,
  resolveRef,
  commitsBetween,
  getDefaultBranch,
} from "../git/repository";
import { generateChangelog } from "../lib/ai-generators";
import { notifyMany, audit } from "../lib/notify";
import { renderMarkdown } from "../lib/markdown";
import { getUnreadCount } from "../lib/unread";

const releasesRoute = new Hono<AuthEnv>();
releasesRoute.use("*", softAuth);

async function loadRepo(owner: string, repo: string) {
  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      defaultBranch: repositories.defaultBranch,
      ownerId: repositories.ownerId,
      starCount: repositories.starCount,
      forkCount: repositories.forkCount,
      forkedFromId: repositories.forkedFromId,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(users.username, owner), eq(repositories.name, repo)))
    .limit(1);
  return row;
}

releasesRoute.get("/:owner/:repo/releases", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const rows = await db
    .select({
      id: releases.id,
      tag: releases.tag,
      name: releases.name,
      body: releases.body,
      targetCommit: releases.targetCommit,
      isDraft: releases.isDraft,
      isPrerelease: releases.isPrerelease,
      createdAt: releases.createdAt,
      publishedAt: releases.publishedAt,
      authorName: users.username,
    })
    .from(releases)
    .innerJoin(users, eq(releases.authorId, users.id))
    .where(eq(releases.repositoryId, repoRow.id))
    .orderBy(desc(releases.createdAt));

  const unread = user ? await getUnreadCount(user.id) : 0;

  return c.html(
    <Layout
      title={`Releases — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="releases" />
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <h3>Releases</h3>
        {user && user.id === repoRow.ownerId && (
          <a href={`/${owner}/${repo}/releases/new`} class="btn btn-primary">
            + Draft release
          </a>
        )}
      </div>

      {rows.length === 0 ? (
        <div class="empty-state">
          <h2>No releases yet</h2>
          <p>Tag a commit and share a changelog with your users.</p>
        </div>
      ) : (
        <div>
          {rows.map((r, i) => (
            <div class="release-card">
              <div class="release-header">
                <div>
                  <span class="release-name">
                    <a href={`/${owner}/${repo}/releases/${encodeURIComponent(r.tag)}`}>
                      {r.name}
                    </a>
                  </span>
                  {i === 0 && !r.isDraft && !r.isPrerelease && (
                    <span class="release-tag release-latest" style="margin-left: 8px">
                      Latest
                    </span>
                  )}
                  {r.isDraft && (
                    <span class="badge" style="margin-left: 8px; color: var(--yellow); border-color: var(--yellow)">
                      Draft
                    </span>
                  )}
                  {r.isPrerelease && (
                    <span class="badge" style="margin-left: 8px; color: var(--accent); border-color: var(--accent)">
                      Pre-release
                    </span>
                  )}
                </div>
                <span class="release-tag">{r.tag}</span>
              </div>
              <div style="color: var(--text-muted); font-size: 13px; margin-bottom: 8px">
                {r.authorName} released{" "}
                {new Date(r.publishedAt || r.createdAt).toLocaleDateString()}
                {" · "}
                <a href={`/${owner}/${repo}/commit/${r.targetCommit}`}>
                  {r.targetCommit.slice(0, 7)}
                </a>
              </div>
              {r.body && (
                <div
                  class="markdown-body"
                  style="font-size: 13px; max-height: 200px; overflow: hidden; position: relative"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(r.body.slice(0, 600) + (r.body.length > 600 ? " …" : "")),
                  }}
                ></div>
              )}
              {user && user.id === repoRow.ownerId && (
                <form
                  method="POST"
                  action={`/${owner}/${repo}/releases/${encodeURIComponent(r.tag)}/delete`}
                  style="margin-top: 12px"
                  onsubmit="return confirm('Delete this release?')"
                >
                  <button type="submit" class="btn btn-sm btn-danger">
                    Delete
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
});

releasesRoute.get("/:owner/:repo/releases/new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/releases`);

  const branches = await listBranches(owner, repo);
  const tags = await listTags(owner, repo);
  const unread = await getUnreadCount(user.id);
  const error = c.req.query("error");

  return c.html(
    <Layout
      title={`Draft release — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="releases" />
      <h3>Draft a new release</h3>
      {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
      <form
        method="POST"
        action={`/${owner}/${repo}/releases`}
        style="max-width: 700px"
      >
        <div class="form-group">
          <label>Tag</label>
          <input
            type="text"
            name="tag"
            required
            placeholder="v1.0.0"
            pattern="[A-Za-z0-9._\\-]+"
          />
        </div>
        <div class="form-group">
          <label>Target branch / commit</label>
          <select name="target">
            {branches.map((b) => (
              <option value={b} selected={b === repoRow.defaultBranch}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div class="form-group">
          <label>Release name</label>
          <input type="text" name="name" required placeholder="v1.0.0 — the big one" />
        </div>
        <div class="form-group">
          <label>Previous tag (for AI changelog)</label>
          <select name="previousTag">
            <option value="">(auto — last tag)</option>
            {tags.map((t) => (
              <option value={t.name}>{t.name}</option>
            ))}
          </select>
        </div>
        <div class="form-group">
          <label>Notes (leave blank for AI-generated)</label>
          <textarea name="body" rows={10} placeholder="Markdown supported. Leave blank to have Claude generate a grouped changelog from commits."></textarea>
        </div>
        <div style="display: flex; gap: 12px">
          <label style="display: flex; align-items: center; gap: 6px; font-size: 14px">
            <input type="checkbox" name="isPrerelease" value="1" />
            Pre-release
          </label>
          <label style="display: flex; align-items: center; gap: 6px; font-size: 14px">
            <input type="checkbox" name="isDraft" value="1" />
            Save as draft
          </label>
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top: 16px">
          Publish release
        </button>
      </form>
    </Layout>
  );
});

releasesRoute.post("/:owner/:repo/releases", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) return c.redirect(`/${owner}/${repo}/releases`);

  const body = await c.req.parseBody();
  const tag = String(body.tag || "").trim();
  const name = String(body.name || "").trim() || tag;
  const target = String(body.target || repoRow.defaultBranch).trim();
  const previousTag = String(body.previousTag || "").trim();
  const notes = String(body.body || "").trim();
  const isDraft = !!body.isDraft;
  const isPrerelease = !!body.isPrerelease;

  if (!tag || !/^[A-Za-z0-9._\-]+$/.test(tag)) {
    return c.redirect(
      `/${owner}/${repo}/releases/new?error=Invalid+tag+name`
    );
  }

  const sha = await resolveRef(owner, repo, target);
  if (!sha) {
    return c.redirect(
      `/${owner}/${repo}/releases/new?error=Could+not+resolve+target`
    );
  }

  // Determine previous tag for changelog
  let autoPrev = previousTag;
  if (!autoPrev) {
    const tags = await listTags(owner, repo);
    autoPrev = tags[0]?.name || "";
  }

  // Generate changelog body if none provided
  let finalBody = notes;
  const [settings] = await db
    .select()
    .from(repoSettings)
    .where(eq(repoSettings.repositoryId, repoRow.id))
    .limit(1);
  const aiEnabled = settings ? settings.aiChangelogEnabled : true;

  if (!finalBody && aiEnabled) {
    const commits = await commitsBetween(owner, repo, autoPrev || null, sha);
    finalBody = await generateChangelog(`${owner}/${repo}`, autoPrev || null, tag, commits);
  }

  // Create the git tag (best-effort — if it already exists we reuse)
  const existing = await resolveRef(owner, repo, `refs/tags/${tag}`);
  if (!existing) {
    await createTag(owner, repo, tag, sha, name || tag);
  }

  // Persist release
  let releaseId = "";
  try {
    const [row] = await db
      .insert(releases)
      .values({
        repositoryId: repoRow.id,
        authorId: user.id,
        tag,
        name,
        body: finalBody,
        targetCommit: sha,
        isDraft,
        isPrerelease,
        publishedAt: isDraft ? null : new Date(),
      })
      .returning();
    releaseId = row?.id || "";
  } catch (err) {
    console.error("[releases] insert failed:", err);
    return c.redirect(
      `/${owner}/${repo}/releases/new?error=Tag+already+published`
    );
  }

  // Notify starrers (only on publish)
  if (!isDraft) {
    try {
      const starUsers = await db
        .select({ userId: stars.userId })
        .from(stars)
        .where(eq(stars.repositoryId, repoRow.id));
      await notifyMany(
        starUsers.map((s) => s.userId).filter((id) => id !== user.id),
        {
          kind: "release_published",
          title: `${owner}/${repo} ${tag} released`,
          body: name,
          url: `/${owner}/${repo}/releases/${encodeURIComponent(tag)}`,
          repositoryId: repoRow.id,
        }
      );
    } catch {
      /* ignore */
    }
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "release.publish",
    targetType: "release",
    targetId: releaseId,
    metadata: { tag, target, isDraft, isPrerelease },
  });

  return c.redirect(`/${owner}/${repo}/releases/${encodeURIComponent(tag)}`);
});

releasesRoute.get("/:owner/:repo/releases/:tag", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const tag = decodeURIComponent(c.req.param("tag"));
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [release] = await db
    .select({
      id: releases.id,
      tag: releases.tag,
      name: releases.name,
      body: releases.body,
      targetCommit: releases.targetCommit,
      isDraft: releases.isDraft,
      isPrerelease: releases.isPrerelease,
      createdAt: releases.createdAt,
      publishedAt: releases.publishedAt,
      authorName: users.username,
    })
    .from(releases)
    .innerJoin(users, eq(releases.authorId, users.id))
    .where(
      and(eq(releases.repositoryId, repoRow.id), eq(releases.tag, tag))
    )
    .limit(1);
  if (!release) return c.notFound();

  const unread = user ? await getUnreadCount(user.id) : 0;

  return c.html(
    <Layout
      title={`${release.name} — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="releases" />
      <div style="margin-bottom: 8px">
        <a href={`/${owner}/${repo}/releases`}>{"\u2190"} All releases</a>
      </div>
      <div class="release-card">
        <div class="release-header">
          <span class="release-name">{release.name}</span>
          <span class="release-tag">{release.tag}</span>
        </div>
        <div style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px">
          {release.authorName} released{" "}
          {new Date(release.publishedAt || release.createdAt).toLocaleString()}
          {" · "}
          <a href={`/${owner}/${repo}/commit/${release.targetCommit}`}>
            {release.targetCommit.slice(0, 7)}
          </a>
          {" · "}
          <a
            href={`/${owner}/${repo}/archive/${encodeURIComponent(release.tag)}.zip`}
          >
            Download
          </a>
        </div>
        {release.body && (
          <div
            class="markdown-body"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(release.body),
            }}
          ></div>
        )}
      </div>
    </Layout>
  );
});

releasesRoute.post(
  "/:owner/:repo/releases/:tag/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo } = c.req.param();
    const tag = decodeURIComponent(c.req.param("tag"));
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}/releases`);
    }

    await db
      .delete(releases)
      .where(
        and(eq(releases.repositoryId, repoRow.id), eq(releases.tag, tag))
      );
    await deleteTag(owner, repo, tag);
    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "release.delete",
      targetType: "release",
      metadata: { tag },
    });
    return c.redirect(`/${owner}/${repo}/releases`);
  }
);

export default releasesRoute;
