/**
 * Block E2 — Discussions: forum-style threaded conversations attached to a repo.
 *
 * Similar to GitHub Discussions: categorised, pinnable, answer-able threads
 * that sit alongside issues but are conversational (Q&A, ideas, announcements).
 *
 * Never throws — all DB paths wrapped in try/catch; callers see a 500-like
 * shell page or a redirect on any failure.
 */

import { Hono } from "hono";
import { and, eq, desc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  discussions,
  discussionComments,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const CATEGORIES = [
  "general",
  "q-and-a",
  "ideas",
  "announcements",
  "show-and-tell",
] as const;

export function isValidCategory(c: string): boolean {
  return (CATEGORIES as readonly string[]).includes(c);
}

const discussionRoutes = new Hono<AuthEnv>();

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

function notFound(user: any, label = "Not found") {
  return (
    <Layout title={label} user={user}>
      <div class="empty-state">
        <h2>{label}</h2>
      </div>
    </Layout>
  );
}

// List
discussionRoutes.get("/:owner/:repo/discussions", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const category = c.req.query("category") || "";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  const { repo } = resolved;

  let rows: any[] = [];
  try {
    const whereClause =
      category && isValidCategory(category)
        ? and(
            eq(discussions.repositoryId, repo.id),
            eq(discussions.category, category)
          )
        : eq(discussions.repositoryId, repo.id);
    rows = await db
      .select({
        d: discussions,
        author: { username: users.username },
        commentCount: sql<number>`(SELECT count(*) FROM discussion_comments WHERE discussion_id = ${discussions.id})`,
      })
      .from(discussions)
      .innerJoin(users, eq(discussions.authorId, users.id))
      .where(whereClause)
      .orderBy(desc(discussions.pinned), desc(discussions.updatedAt));
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title={`Discussions — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <div class="repo-nav">
        <a href={`/${ownerName}/${repoName}`}>Code</a>
        <a href={`/${ownerName}/${repoName}/issues`}>Issues</a>
        <a href={`/${ownerName}/${repoName}/pulls`}>Pull Requests</a>
        <a href={`/${ownerName}/${repoName}/discussions`} class="active">
          Discussions
        </a>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin: 16px 0;">
        <div style="display: flex; gap: 8px;">
          <a
            href={`/${ownerName}/${repoName}/discussions`}
            class={!category ? "active" : ""}
            style="padding: 4px 10px; border-radius: 6px;"
          >
            All
          </a>
          {CATEGORIES.map((cat) => (
            <a
              href={`/${ownerName}/${repoName}/discussions?category=${cat}`}
              class={cat === category ? "active" : ""}
              style="padding: 4px 10px; border-radius: 6px;"
            >
              {cat}
            </a>
          ))}
        </div>
        {user && (
          <a
            href={`/${ownerName}/${repoName}/discussions/new`}
            class="btn btn-primary"
          >
            New discussion
          </a>
        )}
      </div>
      {rows.length === 0 ? (
        <div class="empty-state">
          <p>No discussions yet.</p>
        </div>
      ) : (
        <table class="file-table">
          <tbody>
            {rows.map((r) => (
              <tr>
                <td style="width: 40px; color: var(--text-muted);">
                  #{r.d.number}
                </td>
                <td>
                  {r.d.pinned && <span class="badge">📌 Pinned</span>}{" "}
                  <a
                    href={`/${ownerName}/${repoName}/discussions/${r.d.number}`}
                  >
                    <strong>{r.d.title}</strong>
                  </a>{" "}
                  <span class="badge">{r.d.category}</span>
                  <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                    by @{r.author.username}
                    {r.d.state === "closed" ? " · closed" : ""}
                    {r.d.locked ? " · locked" : ""}
                  </div>
                </td>
                <td style="text-align: right; color: var(--text-muted); font-size: 13px;">
                  💬 {r.commentCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  );
});

// New discussion form
discussionRoutes.get(
  "/:owner/:repo/discussions/new",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
    return c.html(
      <Layout title="New discussion" user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <h2 style="margin-top: 20px;">Start a discussion</h2>
        <form
          method="post"
          action={`/${ownerName}/${repoName}/discussions`}
          style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;"
        >
          <input
            type="text"
            name="title"
            placeholder="Title"
            required
            style="padding: 8px;"
          />
          <select name="category" style="padding: 8px;">
            {CATEGORIES.map((c) => (
              <option value={c}>{c}</option>
            ))}
          </select>
          <textarea
            name="body"
            rows={10}
            placeholder="Write your post (markdown supported)"
            style="padding: 8px; font-family: inherit;"
          ></textarea>
          <button type="submit" class="btn btn-primary">
            Start discussion
          </button>
        </form>
      </Layout>
    );
  }
);

// Create
discussionRoutes.post(
  "/:owner/:repo/discussions",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const title = (form.get("title") as string || "").trim();
    const body = (form.get("body") as string || "").trim();
    const categoryRaw = (form.get("category") as string || "general").trim();
    const category = isValidCategory(categoryRaw) ? categoryRaw : "general";

    if (!title) {
      return c.redirect(`/${ownerName}/${repoName}/discussions/new`);
    }

    try {
      const [row] = await db
        .insert(discussions)
        .values({
          repositoryId: resolved.repo.id,
          authorId: user.id,
          category,
          title,
          body,
        })
        .returning({ number: discussions.number });
      return c.redirect(
        `/${ownerName}/${repoName}/discussions/${row.number}`
      );
    } catch {
      return c.redirect(`/${ownerName}/${repoName}/discussions`);
    }
  }
);

// Detail
discussionRoutes.get(
  "/:owner/:repo/discussions/:number",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let discussion: any = null;
    let comments: any[] = [];
    try {
      const [row] = await db
        .select({ d: discussions, author: { username: users.username } })
        .from(discussions)
        .innerJoin(users, eq(discussions.authorId, users.id))
        .where(
          and(
            eq(discussions.repositoryId, resolved.repo.id),
            eq(discussions.number, numParam)
          )
        )
        .limit(1);
      if (row) discussion = row;
      if (discussion) {
        comments = await db
          .select({
            c: discussionComments,
            author: { username: users.username },
          })
          .from(discussionComments)
          .innerJoin(users, eq(discussionComments.authorId, users.id))
          .where(eq(discussionComments.discussionId, discussion.d.id))
          .orderBy(discussionComments.createdAt);
      }
    } catch {
      // leave nulls
    }

    if (!discussion) return c.html(notFound(user, "Discussion not found"), 404);

    const isOwner = user && user.id === resolved.repo.ownerId;
    const isAuthor = user && user.id === discussion.d.authorId;
    const canModerate = isOwner || isAuthor;

    return c.html(
      <Layout
        title={`${discussion.d.title} · discussion #${discussion.d.number}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <div style="margin-top: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <h1 style="margin: 0;">
              {discussion.d.title}{" "}
              <span style="color: var(--text-muted);">
                #{discussion.d.number}
              </span>
            </h1>
            <div style="display: flex; gap: 8px;">
              <span class="badge">{discussion.d.category}</span>
              {discussion.d.state === "closed" && (
                <span class="badge">closed</span>
              )}
              {discussion.d.locked && <span class="badge">🔒 locked</span>}
              {discussion.d.pinned && <span class="badge">📌 pinned</span>}
            </div>
          </div>
          <div style="color: var(--text-muted); font-size: 13px; margin-top: 4px;">
            Started by @{discussion.author.username}
          </div>
        </div>
        <article class="comment" style="margin-top: 16px;">
          <div
            // biome-ignore lint: rendered server-side from trusted markdown
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(discussion.d.body || ""),
            }}
          />
        </article>
        <h3 style="margin-top: 32px;">{comments.length} Comments</h3>
        {comments.map((com) => {
          const isAnswer = com.c.id === discussion.d.answerCommentId;
          return (
            <article
              class="comment"
              style={`margin-top: 12px; ${isAnswer ? "border: 2px solid var(--green); padding: 12px;" : ""}`}
            >
              <div style="display: flex; justify-content: space-between;">
                <div style="font-size: 13px; color: var(--text-muted);">
                  @{com.author.username}
                  {isAnswer && " · ✅ Answer"}
                </div>
                {isOwner &&
                  discussion.d.category === "q-and-a" &&
                  !isAnswer && (
                    <form
                      method="post"
                      action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/answer/${com.c.id}`}
                      style="display: inline;"
                    >
                      <button type="submit" class="btn">
                        Mark as answer
                      </button>
                    </form>
                  )}
              </div>
              <div
                style="margin-top: 8px;"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(com.c.body || ""),
                }}
              />
            </article>
          );
        })}
        {user && !discussion.d.locked && discussion.d.state === "open" && (
          <form
            method="post"
            action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/comment`}
            style="margin-top: 24px; display: flex; flex-direction: column; gap: 8px;"
          >
            <textarea
              name="body"
              rows={5}
              placeholder="Add a comment (markdown supported)"
              required
              style="padding: 8px; font-family: inherit;"
            ></textarea>
            <button type="submit" class="btn btn-primary">
              Comment
            </button>
          </form>
        )}
        {user && (
          <div style="margin-top: 24px; display: flex; gap: 8px;">
            {canModerate && (
              <form
                method="post"
                action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/close`}
                style="display: inline;"
              >
                <button type="submit" class="btn">
                  {discussion.d.state === "open" ? "Close" : "Reopen"}
                </button>
              </form>
            )}
            {isOwner && (
              <>
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/lock`}
                  style="display: inline;"
                >
                  <button type="submit" class="btn">
                    {discussion.d.locked ? "Unlock" : "Lock"}
                  </button>
                </form>
                <form
                  method="post"
                  action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/pin`}
                  style="display: inline;"
                >
                  <button type="submit" class="btn">
                    {discussion.d.pinned ? "Unpin" : "Pin"}
                  </button>
                </form>
              </>
            )}
          </div>
        )}
      </Layout>
    );
  }
);

// Add comment
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/comment",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const body = (form.get("body") as string || "").trim();
    const parent = (form.get("parent_comment_id") as string) || null;
    if (!body) {
      return c.redirect(
        `/${ownerName}/${repoName}/discussions/${numParam}`
      );
    }

    try {
      const [row] = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.repositoryId, resolved.repo.id),
            eq(discussions.number, numParam)
          )
        )
        .limit(1);
      if (!row || row.locked || row.state === "closed") {
        return c.redirect(
          `/${ownerName}/${repoName}/discussions/${numParam}`
        );
      }
      await db.insert(discussionComments).values({
        discussionId: row.id,
        authorId: user.id,
        body,
        parentCommentId: parent || null,
      });
      await db
        .update(discussions)
        .set({ updatedAt: new Date() })
        .where(eq(discussions.id, row.id));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/discussions/${numParam}`);
  }
);

// Toggle lock (owner)
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/lock",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    if (user.id !== resolved.repo.ownerId) {
      return c.redirect(
        `/${ownerName}/${repoName}/discussions/${numParam}`
      );
    }
    try {
      const [row] = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.repositoryId, resolved.repo.id),
            eq(discussions.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        await db
          .update(discussions)
          .set({ locked: !row.locked })
          .where(eq(discussions.id, row.id));
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/discussions/${numParam}`);
  }
);

// Toggle pin (owner)
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/pin",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    if (user.id !== resolved.repo.ownerId) {
      return c.redirect(
        `/${ownerName}/${repoName}/discussions/${numParam}`
      );
    }
    try {
      const [row] = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.repositoryId, resolved.repo.id),
            eq(discussions.number, numParam)
          )
        )
        .limit(1);
      if (row) {
        await db
          .update(discussions)
          .set({ pinned: !row.pinned })
          .where(eq(discussions.id, row.id));
      }
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/discussions/${numParam}`);
  }
);

// Mark answer (owner on q-and-a)
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/answer/:commentId",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, commentId } = c.req.param();
    const user = c.get("user")!;
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    try {
      const [row] = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.repositoryId, resolved.repo.id),
            eq(discussions.number, numParam)
          )
        )
        .limit(1);
      if (!row) {
        return c.redirect(`/${ownerName}/${repoName}/discussions`);
      }
      const isOwner = user.id === resolved.repo.ownerId;
      const isAuthor = user.id === row.authorId;
      if (!isOwner && !isAuthor) {
        return c.redirect(
          `/${ownerName}/${repoName}/discussions/${numParam}`
        );
      }
      if (row.category !== "q-and-a") {
        return c.text(
          "Only q-and-a discussions can have answers",
          400
        );
      }
      await db
        .update(discussions)
        .set({ answerCommentId: commentId })
        .where(eq(discussions.id, row.id));
      await db
        .update(discussionComments)
        .set({ isAnswer: true })
        .where(eq(discussionComments.id, commentId));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/discussions/${numParam}`);
  }
);

// Toggle close (owner or author)
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/close",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);
    try {
      const [row] = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.repositoryId, resolved.repo.id),
            eq(discussions.number, numParam)
          )
        )
        .limit(1);
      if (!row) {
        return c.redirect(`/${ownerName}/${repoName}/discussions`);
      }
      const isOwner = user.id === resolved.repo.ownerId;
      const isAuthor = user.id === row.authorId;
      if (!isOwner && !isAuthor) {
        return c.redirect(
          `/${ownerName}/${repoName}/discussions/${numParam}`
        );
      }
      await db
        .update(discussions)
        .set({ state: row.state === "open" ? "closed" : "open" })
        .where(eq(discussions.id, row.id));
    } catch {
      // swallow
    }
    return c.redirect(`/${ownerName}/${repoName}/discussions/${numParam}`);
  }
);

export default discussionRoutes;
