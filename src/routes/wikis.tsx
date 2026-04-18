/**
 * Block E3 — Wikis: per-repo markdown page collection with revision history.
 *
 * v1 is DB-backed (no git bare repo). Each wiki_pages row holds the current
 * title+body+revision counter; every edit appends a wiki_revisions row for
 * history/diff/revert.
 *
 * Never throws.
 */

import { Hono } from "hono";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db";
import {
  wikiPages,
  wikiRevisions,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

/** lowercase-alphanumerics joined by single dashes, trimmed. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const wikiRoutes = new Hono<AuthEnv>();

async function resolveRepo(ownerName: string, repoName: string) {
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return null;
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function notFound(user: any, label = "Page not found") {
  return (
    <Layout title={label} user={user}>
      <div class="empty-state">
        <h2>{label}</h2>
      </div>
    </Layout>
  );
}

function WikiSidebar(props: {
  ownerName: string;
  repoName: string;
  pages: { slug: string; title: string }[];
  user: any;
}) {
  const { ownerName, repoName, pages, user } = props;
  return (
    <aside style="min-width: 220px; border-right: 1px solid var(--border); padding-right: 16px;">
      <div style="font-weight: 600; margin-bottom: 8px;">Pages</div>
      <ul style="list-style: none; padding: 0; margin: 0;">
        {pages.map((p) => (
          <li>
            <a href={`/${ownerName}/${repoName}/wiki/${p.slug}`}>{p.title}</a>
          </li>
        ))}
      </ul>
      {user && (
        <div style="margin-top: 16px;">
          <a
            href={`/${ownerName}/${repoName}/wiki/new`}
            class="btn btn-primary"
          >
            + New page
          </a>
        </div>
      )}
    </aside>
  );
}

async function listPages(repoId: string) {
  try {
    return await db
      .select({ slug: wikiPages.slug, title: wikiPages.title })
      .from(wikiPages)
      .where(eq(wikiPages.repositoryId, repoId))
      .orderBy(wikiPages.title);
  } catch {
    return [];
  }
}

// Root — render "home" page if exists, else CTA
wikiRoutes.get("/:owner/:repo/wiki", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  const pages = await listPages(resolved.repo.id);

  let home: any = null;
  try {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.repositoryId, resolved.repo.id),
          eq(wikiPages.slug, "home")
        )
      )
      .limit(1);
    if (row) home = row;
  } catch {
    // leave null
  }

  return c.html(
    <Layout title={`Wiki — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="display: flex; gap: 24px; margin-top: 16px;">
        <WikiSidebar
          ownerName={ownerName}
          repoName={repoName}
          pages={pages}
          user={user}
        />
        <main style="flex: 1;">
          {home ? (
            <>
              <h1>{home.title}</h1>
              <div
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(home.body || ""),
                }}
              />
            </>
          ) : (
            <div class="empty-state">
              <h2>No wiki yet</h2>
              {user ? (
                <a
                  href={`/${ownerName}/${repoName}/wiki/new`}
                  class="btn btn-primary"
                >
                  Create the Home page
                </a>
              ) : (
                <p>Nothing here yet.</p>
              )}
            </div>
          )}
        </main>
      </div>
    </Layout>
  );
});

// All pages index
wikiRoutes.get("/:owner/:repo/wiki/pages", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  let rows: any[] = [];
  try {
    rows = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.repositoryId, resolved.repo.id))
      .orderBy(wikiPages.title);
  } catch {
    rows = [];
  }
  return c.html(
    <Layout title={`Wiki pages — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <h2 style="margin-top: 16px;">Wiki pages</h2>
      {rows.length === 0 ? (
        <div class="empty-state">
          <p>No pages.</p>
        </div>
      ) : (
        <table class="file-table">
          <tbody>
            {rows.map((p) => (
              <tr>
                <td>
                  <a href={`/${ownerName}/${repoName}/wiki/${p.slug}`}>
                    {p.title}
                  </a>
                </td>
                <td style="text-align: right; color: var(--text-muted); font-size: 13px;">
                  r{p.revision}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
});

// New page form
wikiRoutes.get("/:owner/:repo/wiki/new", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  return c.html(
    <Layout title="New wiki page" user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <h2 style="margin-top: 20px;">New wiki page</h2>
      <form
        method="post"
        action={`/${ownerName}/${repoName}/wiki`}
        style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;"
      >
        <input
          type="text"
          name="title"
          placeholder="Page title"
          required
          style="padding: 8px;"
        />
        <textarea
          name="body"
          rows={16}
          placeholder="Markdown body"
          style="padding: 8px; font-family: monospace;"
        ></textarea>
        <button type="submit" class="btn btn-primary">
          Create page
        </button>
      </form>
    </Layout>
  );
});

// Create
wikiRoutes.post("/:owner/:repo/wiki", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

  const form = await c.req.formData();
  const title = (form.get("title") as string || "").trim();
  const body = (form.get("body") as string || "").trim();
  if (!title) {
    return c.redirect(`/${ownerName}/${repoName}/wiki/new`);
  }
  const slug = slugifyTitle(title) || "page";

  try {
    const [page] = await db
      .insert(wikiPages)
      .values({
        repositoryId: resolved.repo.id,
        slug,
        title,
        body,
        revision: 1,
        updatedBy: user.id,
      })
      .returning({ id: wikiPages.id });
    await db.insert(wikiRevisions).values({
      pageId: page.id,
      revision: 1,
      title,
      body,
      message: "Initial",
      authorId: user.id,
    });
  } catch {
    // likely unique-violation on slug; redirect to the existing page
  }
  return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
});

// View page
wikiRoutes.get("/:owner/:repo/wiki/:slug", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName, slug } = c.req.param();
  const user = c.get("user");
  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

  let page: any = null;
  try {
    const [row] = await db
      .select()
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.repositoryId, resolved.repo.id),
          eq(wikiPages.slug, slug)
        )
      )
      .limit(1);
    if (row) page = row;
  } catch {
    // leave null
  }
  if (!page) return c.html(notFound(user, "Page not found"), 404);
  const pages = await listPages(resolved.repo.id);
  const isOwner = user && user.id === resolved.repo.ownerId;

  return c.html(
    <Layout title={`${page.title} — wiki`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div style="display: flex; gap: 24px; margin-top: 16px;">
        <WikiSidebar
          ownerName={ownerName}
          repoName={repoName}
          pages={pages}
          user={user}
        />
        <main style="flex: 1;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h1 style="margin: 0;">{page.title}</h1>
            <div style="display: flex; gap: 8px;">
              <a
                href={`/${ownerName}/${repoName}/wiki/${slug}/history`}
                class="btn"
              >
                History
              </a>
              {user && (
                <a
                  href={`/${ownerName}/${repoName}/wiki/${slug}/edit`}
                  class="btn"
                >
                  Edit
                </a>
              )}
              {isOwner && (
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/wiki/${slug}/delete`}
                  style="display: inline;"
                  onsubmit="return confirm('Delete this page?')"
                >
                  <button type="submit" class="btn">
                    Delete
                  </button>
                </form>
              )}
            </div>
          </div>
          <div
            style="margin-top: 16px;"
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(page.body || ""),
            }}
          />
        </main>
      </div>
    </Layout>
  );
});

// Edit form
wikiRoutes.get(
  "/:owner/:repo/wiki/:slug/edit",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let page: any = null;
    try {
      const [row] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (row) page = row;
    } catch {
      // leave null
    }
    if (!page) return c.html(notFound(user, "Page not found"), 404);

    return c.html(
      <Layout title={`Edit ${page.title}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <h2 style="margin-top: 20px;">Edit "{page.title}"</h2>
        <form
          method="post"
          action={`/${ownerName}/${repoName}/wiki/${slug}/edit`}
          style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;"
        >
          <input
            type="text"
            name="title"
            value={page.title}
            required
            style="padding: 8px;"
          />
          <textarea
            name="body"
            rows={16}
            style="padding: 8px; font-family: monospace;"
          >
            {page.body}
          </textarea>
          <input
            type="text"
            name="message"
            placeholder="Revision message (optional)"
            style="padding: 8px;"
          />
          <button type="submit" class="btn btn-primary">
            Save
          </button>
        </form>
      </Layout>
    );
  }
);

// Save edit
wikiRoutes.post(
  "/:owner/:repo/wiki/:slug/edit",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const title = (form.get("title") as string || "").trim();
    const body = (form.get("body") as string || "").trim();
    const message = (form.get("message") as string || "").trim();
    if (!title) {
      return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}/edit`);
    }

    try {
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (page) {
        const nextRev = page.revision + 1;
        await db
          .update(wikiPages)
          .set({
            title,
            body,
            revision: nextRev,
            updatedAt: new Date(),
            updatedBy: user.id,
          })
          .where(eq(wikiPages.id, page.id));
        await db.insert(wikiRevisions).values({
          pageId: page.id,
          revision: nextRev,
          title,
          body,
          message: message || null,
          authorId: user.id,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
  }
);

// Delete
wikiRoutes.post(
  "/:owner/:repo/wiki/:slug/delete",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    if (user.id !== resolved.repo.ownerId) {
      return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
    }
    try {
      await db
        .delete(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        );
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/wiki`);
  }
);

// History
wikiRoutes.get(
  "/:owner/:repo/wiki/:slug/history",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let page: any = null;
    let revs: any[] = [];
    try {
      const [row] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (row) {
        page = row;
        revs = await db
          .select({
            r: wikiRevisions,
            author: { username: users.username },
          })
          .from(wikiRevisions)
          .innerJoin(users, eq(wikiRevisions.authorId, users.id))
          .where(eq(wikiRevisions.pageId, page.id))
          .orderBy(desc(wikiRevisions.revision));
      }
    } catch {
      // leave null
    }
    if (!page) return c.html(notFound(user, "Page not found"), 404);

    return c.html(
      <Layout title={`${page.title} — history`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <h2 style="margin-top: 20px;">
          <a href={`/${ownerName}/${repoName}/wiki/${slug}`}>{page.title}</a> —
          history
        </h2>
        <table class="file-table">
          <tbody>
            {revs.map((rv) => (
              <tr>
                <td>
                  <a
                    href={`/${ownerName}/${repoName}/wiki/${slug}/revisions/${rv.r.revision}`}
                  >
                    Revision {rv.r.revision}
                  </a>
                  {rv.r.message && (
                    <span style="color: var(--text-muted);">
                      {" "}
                      — {rv.r.message}
                    </span>
                  )}
                </td>
                <td style="text-align: right; color: var(--text-muted); font-size: 13px;">
                  by @{rv.author.username}
                  {user && user.id === resolved.repo.ownerId &&
                    rv.r.revision !== page.revision && (
                      <>
                        {" "}
                        ·{" "}
                        <form
                          method="post"
                          action={`/${ownerName}/${repoName}/wiki/${slug}/revert/${rv.r.revision}`}
                          style="display: inline;"
                        >
                          <button type="submit" class="btn" style="font-size: 11px;">
                            Revert to this
                          </button>
                        </form>
                      </>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Layout>
    );
  }
);

// View revision
wikiRoutes.get(
  "/:owner/:repo/wiki/:slug/revisions/:rev",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const user = c.get("user");
    const rev = Number(c.req.param("rev"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let rv: any = null;
    try {
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (page) {
        const [r] = await db
          .select()
          .from(wikiRevisions)
          .where(
            and(
              eq(wikiRevisions.pageId, page.id),
              eq(wikiRevisions.revision, rev)
            )
          )
          .limit(1);
        if (r) rv = r;
      }
    } catch {
      // leave null
    }
    if (!rv) return c.html(notFound(user, "Revision not found"), 404);

    return c.html(
      <Layout title={`${rv.title} @ r${rev}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div style="margin-top: 16px; color: var(--text-muted);">
          Viewing revision {rev} of{" "}
          <a href={`/${ownerName}/${repoName}/wiki/${slug}`}>{rv.title}</a>
        </div>
        <h1>{rv.title}</h1>
        <div
          dangerouslySetInnerHTML={{ __html: renderMarkdown(rv.body || "") }}
        />
      </Layout>
    );
  }
);

// Revert
wikiRoutes.post(
  "/:owner/:repo/wiki/:slug/revert/:rev",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, slug } = c.req.param();
    const rev = Number(c.req.param("rev"));
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    if (user.id !== resolved.repo.ownerId) {
      return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
    }
    try {
      const [page] = await db
        .select()
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.repositoryId, resolved.repo.id),
            eq(wikiPages.slug, slug)
          )
        )
        .limit(1);
      if (!page) {
        return c.redirect(`/${ownerName}/${repoName}/wiki`);
      }
      const [target] = await db
        .select()
        .from(wikiRevisions)
        .where(
          and(
            eq(wikiRevisions.pageId, page.id),
            eq(wikiRevisions.revision, rev)
          )
        )
        .limit(1);
      if (target) {
        const nextRev = page.revision + 1;
        await db
          .update(wikiPages)
          .set({
            title: target.title,
            body: target.body,
            revision: nextRev,
            updatedAt: new Date(),
            updatedBy: user.id,
          })
          .where(eq(wikiPages.id, page.id));
        await db.insert(wikiRevisions).values({
          pageId: page.id,
          revision: nextRev,
          title: target.title,
          body: target.body,
          message: `Reverted to revision ${rev}`,
          authorId: user.id,
        });
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/wiki/${slug}`);
  }
);

export default wikiRoutes;
