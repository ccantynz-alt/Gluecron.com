/**
 * Block E2 — Discussions: forum-style threaded conversations attached to a repo.
 *
 * Similar to GitHub Discussions: categorised, pinnable, answer-able threads
 * that sit alongside issues but are conversational (Q&A, ideas, announcements).
 *
 * 2026 polish: gradient-hairline hero + radial orb + thread cards with
 * author chip + reply count + recent timestamp + category chip. Every class
 * prefixed `.disc-` so this surface doesn't bleed into the rest of the repo
 * polish. All data fetches, queries, and POST handlers preserved exactly.
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

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.disc-` so this surface can't bleed
 * into the wider repo polish. Mirrors the gradient-hairline hero + radial
 * orb + card patterns from `insights.tsx` and `error-page.tsx`.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .disc-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

  .disc-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .disc-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .disc-hero-orb {
    position: absolute;
    inset: -30% -15% auto auto;
    width: 460px; height: 460px;
    background: radial-gradient(circle, rgba(140,109,255,0.22), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.75;
    pointer-events: none;
    z-index: 0;
  }
  .disc-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .disc-hero-text { max-width: 720px; }
  .disc-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 14px;
  }
  .disc-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .disc-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .disc-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .disc-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
  }

  /* Primary CTA — gradient pill that matches the hero stripe. */
  .disc-cta {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
    transition: transform 120ms ease, box-shadow 120ms ease;
    white-space: nowrap;
  }
  .disc-cta:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }

  /* Category filter chips */
  .disc-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 var(--space-4);
  }
  .disc-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text-muted);
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    text-transform: lowercase;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .disc-chip:hover { border-color: rgba(140,109,255,0.45); color: var(--text-strong); text-decoration: none; }
  .disc-chip.is-active {
    color: #fff;
    background: linear-gradient(135deg, rgba(140,109,255,0.85), rgba(54,197,214,0.85));
    border-color: rgba(140,109,255,0.55);
  }

  /* Thread card list */
  .disc-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
  }
  .disc-card {
    position: relative;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-3) var(--space-4);
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .disc-card:hover { border-color: var(--border-strong, var(--border)); transform: translateY(-1px); }
  .disc-card.is-pinned { border-color: rgba(140,109,255,0.32); }

  .disc-card-row {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .disc-avatar {
    flex: none;
    width: 36px; height: 36px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18);
  }
  .disc-card-main { flex: 1; min-width: 0; }
  .disc-card-title {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.005em;
    line-height: 1.3;
    margin: 0 0 4px;
    word-break: break-word;
  }
  .disc-card-title a { color: inherit; text-decoration: none; }
  .disc-card-title a:hover { color: var(--accent); }
  .disc-card-sub {
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
  }
  .disc-card-sub a { color: var(--text); text-decoration: none; }
  .disc-card-sub a:hover { color: var(--text-strong); }
  .disc-num {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  .disc-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(140,109,255,0.10);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .disc-tag.is-pinned { background: rgba(252,211,77,0.10); color: #fcd34d; box-shadow: inset 0 0 0 1px rgba(252,211,77,0.32); }
  .disc-tag.is-closed { background: rgba(248,113,113,0.10); color: #fca5a5; box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32); }
  .disc-tag.is-locked { background: rgba(148,163,184,0.10); color: #cbd5e1; box-shadow: inset 0 0 0 1px rgba(148,163,184,0.32); }

  .disc-card-meta {
    flex: none;
    text-align: right;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    min-width: 80px;
  }
  .disc-card-meta .replies {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    line-height: 1;
  }
  .disc-card-meta .replies-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-weight: 700;
  }

  /* Empty state — dashed orb card */
  .disc-empty {
    position: relative;
    overflow: hidden;
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 16px;
    background: rgba(255,255,255,0.012);
    color: var(--text-muted);
    margin-bottom: var(--space-5);
  }
  .disc-empty::before {
    content: '';
    position: absolute;
    inset: -40% -20% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.14), rgba(54,197,214,0.06) 45%, transparent 70%);
    filter: blur(60px);
    pointer-events: none;
  }
  .disc-empty-inner { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .disc-empty strong {
    display: block;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0;
  }
  .disc-empty p { font-size: 13px; margin: 0; max-width: 420px; }

  /* New-discussion form polish (preserves form action + field names) */
  .disc-form-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-4) var(--space-5);
    margin-top: var(--space-4);
  }
  .disc-form { display: flex; flex-direction: column; gap: 12px; }
  .disc-input,
  .disc-textarea,
  .disc-select {
    width: 100%;
    padding: 10px 12px;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    outline: none;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .disc-textarea { font-family: var(--font-mono); font-size: 13px; line-height: 1.55; }
  .disc-input:focus,
  .disc-textarea:focus,
  .disc-select:focus {
    border-color: var(--border-focus, rgba(140,109,255,0.55));
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
`;

function relTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  if (!Number.isFinite(t)) return "";
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return new Date(t).toLocaleDateString();
}

function initials(name: string): string {
  if (!name) return "?";
  return name.slice(0, 2);
}

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

      <div class="disc-wrap">
        <section class="disc-hero">
          <div class="disc-hero-orb" aria-hidden="true" />
          <div class="disc-hero-inner">
            <div class="disc-hero-text">
              <div class="disc-eyebrow">
                <span class="disc-eyebrow-dot" aria-hidden="true" />
                Discussions · {ownerName}/{repoName}
              </div>
              <h2 class="disc-title">
                <span class="disc-title-grad">Talk it out.</span>
              </h2>
              <p class="disc-sub">
                Q&amp;A, ideas, announcements, and show-and-tell — the
                conversational space alongside issues and PRs.
              </p>
            </div>
            {user && (
              <a
                href={`/${ownerName}/${repoName}/discussions/new`}
                class="disc-cta"
              >
                + New discussion
              </a>
            )}
          </div>
        </section>

        <div class="disc-filters" aria-label="Filter by category">
          <a
            href={`/${ownerName}/${repoName}/discussions`}
            class={"disc-chip" + (!category ? " is-active" : "")}
          >
            all
          </a>
          {CATEGORIES.map((cat) => (
            <a
              href={`/${ownerName}/${repoName}/discussions?category=${cat}`}
              class={"disc-chip" + (cat === category ? " is-active" : "")}
            >
              {cat}
            </a>
          ))}
        </div>

        {rows.length === 0 ? (
          <div class="disc-empty">
            <div class="disc-empty-inner">
              <strong>No discussions yet</strong>
              <p>
                Start a thread to ask a question, float an idea, or share an
                announcement with the community.
              </p>
              {user && (
                <a
                  href={`/${ownerName}/${repoName}/discussions/new`}
                  class="disc-cta"
                  style="margin-top:6px"
                >
                  + Start a discussion
                </a>
              )}
            </div>
          </div>
        ) : (
          <div class="disc-list">
            {rows.map((r) => {
              const replies = Number(r.commentCount || 0);
              const updated = r.d.updatedAt || r.d.createdAt;
              return (
                <article
                  class={"disc-card" + (r.d.pinned ? " is-pinned" : "")}
                >
                  <div class="disc-card-row">
                    <div
                      class="disc-avatar"
                      aria-label={`@${r.author.username}`}
                    >
                      {initials(r.author.username)}
                    </div>
                    <div class="disc-card-main">
                      <h3 class="disc-card-title">
                        <a
                          href={`/${ownerName}/${repoName}/discussions/${r.d.number}`}
                        >
                          {r.d.title}
                        </a>
                      </h3>
                      <div class="disc-card-sub">
                        <span class="disc-num">#{r.d.number}</span>
                        <span>by @{r.author.username}</span>
                        {updated && <span>· active {relTime(updated)}</span>}
                        <span class="disc-tag">{r.d.category}</span>
                        {r.d.pinned && (
                          <span class="disc-tag is-pinned">pinned</span>
                        )}
                        {r.d.state === "closed" && (
                          <span class="disc-tag is-closed">closed</span>
                        )}
                        {r.d.locked && (
                          <span class="disc-tag is-locked">locked</span>
                        )}
                      </div>
                    </div>
                    <div class="disc-card-meta">
                      <span class="replies">{replies}</span>
                      <span class="replies-label">
                        {replies === 1 ? "reply" : "replies"}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: styles }} />
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
        <div class="disc-wrap">
          <section class="disc-hero">
            <div class="disc-hero-orb" aria-hidden="true" />
            <div class="disc-hero-inner">
              <div class="disc-hero-text">
                <div class="disc-eyebrow">
                  <span class="disc-eyebrow-dot" aria-hidden="true" />
                  New discussion · {ownerName}/{repoName}
                </div>
                <h2 class="disc-title">
                  <span class="disc-title-grad">Start a thread.</span>
                </h2>
                <p class="disc-sub">
                  Pick a category, add a clear title, and tell folks what's on
                  your mind. Markdown supported.
                </p>
              </div>
            </div>
          </section>

          <div class="disc-form-card">
            <form
              method="post"
              action={`/${ownerName}/${repoName}/discussions`}
              class="disc-form"
            >
              <input
                type="text"
                name="title"
                placeholder="Title"
                required
                aria-label="Discussion title"
                class="disc-input"
              />
              <select name="category" class="disc-select">
                {CATEGORIES.map((c) => (
                  <option value={c}>{c}</option>
                ))}
              </select>
              <textarea
                name="body"
                rows={10}
                placeholder="Write your post (markdown supported)"
                class="disc-textarea"
              ></textarea>
              <div>
                <button type="submit" class="disc-cta">
                  Start discussion
                </button>
              </div>
            </form>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
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
        <h2 style="margin-top: 32px;">{comments.length} Comments</h2>
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
