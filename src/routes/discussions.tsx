/**
 * Block E2 — Discussions: forum-style threaded conversations attached to a repo.
 *
 * Similar to GitHub Discussions: categorised, pinnable, answer-able threads
 * that sit alongside issues but are conversational (Q&A, ideas, announcements).
 *
 * Categories are stored in `discussion_categories` (migration 0077) and seeded
 * lazily on first discussion creation:
 *   - General    💬  (not answerable)
 *   - Q&A        ❓  (answerable — surfaces "Mark as answer")
 *   - Announcements 📢  (not answerable)
 *   - Ideas      💡  (not answerable)
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
import { and, eq, desc, sql, asc } from "drizzle-orm";
import { db } from "../db";
import {
  discussions,
  discussionCategories,
  discussionComments,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

// ---------------------------------------------------------------------------
// Legacy category validation helper — kept for test compatibility.
// The new system validates against the discussion_categories DB table;
// this covers the old text-enum values so existing tests don't break.
// ---------------------------------------------------------------------------
const LEGACY_CATEGORIES = [
  "general",
  "q-and-a",
  "ideas",
  "announcements",
  "show-and-tell",
] as const;

/** @deprecated Use DB-backed discussion_categories instead. Kept for test compat. */
export function isValidCategory(c: string): boolean {
  return (LEGACY_CATEGORIES as readonly string[]).includes(c);
}

// ---------------------------------------------------------------------------
// Default categories seeded on first discussion creation per repo.
// ---------------------------------------------------------------------------
const DEFAULT_CATEGORIES: Array<{
  name: string;
  emoji: string;
  description: string;
  isAnswerable: boolean;
}> = [
  {
    name: "General",
    emoji: "💬",
    description: "General discussion — anything that doesn't fit elsewhere.",
    isAnswerable: false,
  },
  {
    name: "Q&A",
    emoji: "❓",
    description: "Ask questions and get answers from the community.",
    isAnswerable: true,
  },
  {
    name: "Announcements",
    emoji: "📢",
    description: "Important updates and announcements from maintainers.",
    isAnswerable: false,
  },
  {
    name: "Ideas",
    emoji: "💡",
    description: "Feature requests, proposals, and brainstorming.",
    isAnswerable: false,
  },
];

/**
 * Ensure the 4 default categories exist for a repository.
 * Idempotent — checks count before inserting to avoid duplicates.
 * Called lazily on first discussion creation so no migration data seeding
 * is needed; existing repos get their categories on first use.
 */
async function ensureDefaultCategories(repositoryId: string): Promise<void> {
  try {
    const existing = await db
      .select({ id: discussionCategories.id })
      .from(discussionCategories)
      .where(eq(discussionCategories.repositoryId, repositoryId))
      .limit(1);
    if (existing.length > 0) return; // already seeded
    await db.insert(discussionCategories).values(
      DEFAULT_CATEGORIES.map((cat) => ({
        repositoryId,
        name: cat.name,
        emoji: cat.emoji,
        description: cat.description,
        isAnswerable: cat.isAnswerable,
      }))
    );
  } catch {
    // Silently ignore — categories are cosmetic; a missing row is not fatal.
  }
}

const discussionRoutes = new Hono<AuthEnv>();

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.disc-` so this surface can't bleed
 * into the wider repo polish. Mirrors the gradient-hairline hero + radial
 * orb + card patterns from `insights.tsx` and `error-page.tsx`.
 * ───────────────────────────────────────────────────────────────────── */
const styles = `
  .disc-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4); }

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

  /* Category cards on the form */
  .disc-cat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
  }
  .disc-cat-option {
    position: relative;
  }
  .disc-cat-option input[type="radio"] {
    position: absolute;
    opacity: 0;
    width: 0; height: 0;
  }
  .disc-cat-label {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .disc-cat-label:hover { border-color: rgba(140,109,255,0.45); }
  .disc-cat-option input[type="radio"]:checked + .disc-cat-label {
    border-color: rgba(140,109,255,0.6);
    background: rgba(140,109,255,0.08);
    color: var(--text-strong);
  }
  .disc-cat-emoji { font-size: 18px; line-height: 1; }
  .disc-cat-desc { font-size: 11px; color: var(--text-muted); font-weight: 400; margin-top: 1px; }

  /* Answer highlight */
  .disc-answer {
    border: 1.5px solid rgba(52,211,153,0.55) !important;
    box-shadow: 0 0 0 3px rgba(52,211,153,0.10);
  }
  .disc-answer-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    background: rgba(52,211,153,0.12);
    color: #34d399;
    font-size: 11px;
    font-weight: 700;
    border: 1px solid rgba(52,211,153,0.35);
  }

  /* Thread detail comment cards */
  .disc-thread { margin-top: 18px; }
  .disc-comment {
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--bg-elevated);
    margin-bottom: 14px;
  }
  .disc-comment-header {
    background: var(--bg-secondary);
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .disc-comment-header strong { color: var(--text-strong); font-weight: 600; }
  .disc-comment-body { padding: 14px 18px; }
`;

function relTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d).getTime() : (d as Date).getTime();
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

function notFound(user: ReturnType<typeof Object>, label = "Not found") {
  return (
    <Layout title={label} user={user as any}>
      <div class="empty-state">
        <h2>{label}</h2>
      </div>
    </Layout>
  );
}

// ---------------------------------------------------------------------------
// GET /:owner/:repo/discussions — list discussions, filter by category
// ---------------------------------------------------------------------------
discussionRoutes.get("/:owner/:repo/discussions", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const categoryParam = c.req.query("category") || "";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.html(notFound(user, "Repository not found"), 404);
  const { repo } = resolved;

  // Load categories for this repo (may be empty if never seeded yet)
  let categories: Array<{ id: number; name: string; emoji: string; description: string | null; isAnswerable: boolean }> = [];
  try {
    categories = await db
      .select()
      .from(discussionCategories)
      .where(eq(discussionCategories.repositoryId, repo.id))
      .orderBy(asc(discussionCategories.id));
  } catch {
    categories = [];
  }

  // Find the active category object by name (URL param is the category name)
  const activeCategory = categories.find(
    (cat) => cat.name.toLowerCase() === categoryParam.toLowerCase()
  ) ?? null;

  let rows: Array<{
    d: typeof discussions.$inferSelect;
    author: { username: string };
    commentCount: number;
    catName: string | null;
    catEmoji: string | null;
  }> = [];

  try {
    const whereClause = activeCategory
      ? and(
          eq(discussions.repositoryId, repo.id),
          eq(discussions.category, activeCategory.name)
        )
      : eq(discussions.repositoryId, repo.id);

    const rawRows = await db
      .select({
        d: discussions,
        author: { username: users.username },
        commentCount: sql<number>`(SELECT count(*)::int FROM discussion_comments WHERE discussion_id = ${discussions.id})`,
      })
      .from(discussions)
      .innerJoin(users, eq(discussions.authorId, users.id))
      .where(whereClause)
      .orderBy(desc(discussions.pinned), desc(discussions.updatedAt));

    rows = rawRows.map((r) => {
      const cat = categories.find((c) => c.name === r.d.category) ?? null;
      return {
        d: r.d,
        author: r.author,
        commentCount: Number(r.commentCount || 0),
        catName: cat ? cat.name : r.d.category,
        catEmoji: cat ? cat.emoji : "💬",
      };
    });
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title={`Discussions — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="discussions" />

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

        {categories.length > 0 && (
          <div class="disc-filters" aria-label="Filter by category">
            <a
              href={`/${ownerName}/${repoName}/discussions`}
              class={"disc-chip" + (!activeCategory ? " is-active" : "")}
            >
              All
            </a>
            {categories.map((cat) => (
              <a
                href={`/${ownerName}/${repoName}/discussions?category=${encodeURIComponent(cat.name)}`}
                class={"disc-chip" + (cat.id === activeCategory?.id ? " is-active" : "")}
              >
                {cat.emoji} {cat.name}
              </a>
            ))}
          </div>
        )}

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
              const replies = r.commentCount;
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
                        {r.catName && (
                          <span class="disc-tag">
                            {r.catEmoji} {r.catName}
                          </span>
                        )}
                        {r.d.pinned && (
                          <span class="disc-tag is-pinned">📌 pinned</span>
                        )}
                        {r.d.state === "closed" && (
                          <span class="disc-tag is-closed">closed</span>
                        )}
                        {r.d.locked && (
                          <span class="disc-tag is-locked">🔒 locked</span>
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

// ---------------------------------------------------------------------------
// GET /:owner/:repo/discussions/new — new discussion form (pick category)
// ---------------------------------------------------------------------------
discussionRoutes.get(
  "/:owner/:repo/discussions/new",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    // Ensure default categories exist (lazy seed)
    await ensureDefaultCategories(resolved.repo.id);

    let categories: Array<{ id: number; name: string; emoji: string; description: string | null; isAnswerable: boolean }> = [];
    try {
      categories = await db
        .select()
        .from(discussionCategories)
        .where(eq(discussionCategories.repositoryId, resolved.repo.id))
        .orderBy(asc(discussionCategories.id));
    } catch {
      categories = [];
    }

    return c.html(
      <Layout title="New discussion" user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="discussions" />
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

              {categories.length > 0 ? (
                <fieldset style="border:none;padding:0;margin:0">
                  <legend style="font-size:13px;font-weight:600;color:var(--text-muted);margin-bottom:10px">
                    Category
                  </legend>
                  <div class="disc-cat-grid">
                    {categories.map((cat, i) => (
                      <div class="disc-cat-option">
                        <input
                          type="radio"
                          name="category"
                          id={`cat-${cat.id}`}
                          value={cat.name}
                          checked={i === 0}
                        />
                        <label for={`cat-${cat.id}`} class="disc-cat-label">
                          <span class="disc-cat-emoji" aria-hidden="true">{cat.emoji}</span>
                          <span>
                            <span style="display:block">{cat.name}</span>
                            {cat.description && (
                              <span class="disc-cat-desc">{cat.description}</span>
                            )}
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                </fieldset>
              ) : (
                <select name="category" class="disc-select">
                  <option value="General">💬 General</option>
                  <option value="Q&A">❓ Q&amp;A</option>
                  <option value="Announcements">📢 Announcements</option>
                  <option value="Ideas">💡 Ideas</option>
                </select>
              )}

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

// ---------------------------------------------------------------------------
// POST /:owner/:repo/discussions — create discussion
// ---------------------------------------------------------------------------
discussionRoutes.post(
  "/:owner/:repo/discussions",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    // Ensure default categories are seeded before we create the first discussion
    await ensureDefaultCategories(resolved.repo.id);

    const form = await c.req.formData();
    const title = (form.get("title") as string || "").trim();
    const body = (form.get("body") as string || "").trim();
    const categoryRaw = (form.get("category") as string || "General").trim();

    if (!title) {
      return c.redirect(`/${ownerName}/${repoName}/discussions/new`);
    }

    // Validate category against the DB — fall back to "General"
    let category = "General";
    try {
      const [cat] = await db
        .select({ name: discussionCategories.name })
        .from(discussionCategories)
        .where(
          and(
            eq(discussionCategories.repositoryId, resolved.repo.id),
            eq(discussionCategories.name, categoryRaw)
          )
        )
        .limit(1);
      if (cat) category = cat.name;
    } catch {
      category = "General";
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

// ---------------------------------------------------------------------------
// GET /:owner/:repo/discussions/:id — view discussion thread with replies
// ---------------------------------------------------------------------------
discussionRoutes.get(
  "/:owner/:repo/discussions/:number",
  softAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.html(notFound(user, "Repository not found"), 404);

    let discussion: { d: typeof discussions.$inferSelect; author: { username: string } } | null = null;
    let comments: Array<{ c: typeof discussionComments.$inferSelect; author: { username: string } }> = [];
    let category: { id: number; name: string; emoji: string; isAnswerable: boolean } | null = null;

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
          .orderBy(asc(discussionComments.createdAt));

        // Look up the full category record so we know if it's answerable
        const [catRow] = await db
          .select()
          .from(discussionCategories)
          .where(
            and(
              eq(discussionCategories.repositoryId, resolved.repo.id),
              eq(discussionCategories.name, discussion.d.category)
            )
          )
          .limit(1);
        if (catRow) category = catRow;
      }
    } catch {
      // leave nulls
    }

    if (!discussion) return c.html(notFound(user, "Discussion not found"), 404);

    const isOwner = !!(user && user.id === resolved.repo.ownerId);
    const isAuthor = !!(user && user.id === discussion.d.authorId);
    const canModerate = isOwner || isAuthor;

    // A discussion is answerable if its category is marked is_answerable
    // OR if the legacy category string is "q-and-a" (backwards-compat).
    const isAnswerable =
      (category?.isAnswerable ?? false) ||
      discussion.d.category === "q-and-a" ||
      discussion.d.category === "Q&A";

    return c.html(
      <Layout
        title={`${discussion.d.title} · discussion #${discussion.d.number}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <RepoNav owner={ownerName} repo={repoName} active="discussions" />

        <div class="disc-wrap">
          {/* ── Discussion header ── */}
          <section class="disc-hero" style="margin-bottom:var(--space-4)">
            <div class="disc-hero-orb" aria-hidden="true" />
            <div class="disc-hero-inner">
              <div class="disc-hero-text" style="max-width:100%">
                <div class="disc-eyebrow">
                  <span class="disc-eyebrow-dot" aria-hidden="true" />
                  {ownerName}/{repoName} · Discussions
                </div>
                <h1 class="disc-title" style="font-size:clamp(20px,3vw,30px)">
                  {discussion.d.title}
                  <span style="color:var(--text-muted);font-weight:500;font-size:0.65em;margin-left:8px">
                    #{discussion.d.number}
                  </span>
                </h1>
                <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px">
                  <span style="font-size:13px;color:var(--text-muted)">
                    Started by <strong style="color:var(--text)">@{discussion.author.username}</strong>
                    {" · "}{relTime(discussion.d.createdAt)}
                  </span>
                  {category && (
                    <span class="disc-tag">
                      {category.emoji} {category.name}
                    </span>
                  )}
                  {discussion.d.state === "closed" && (
                    <span class="disc-tag is-closed">closed</span>
                  )}
                  {discussion.d.locked && (
                    <span class="disc-tag is-locked">🔒 locked</span>
                  )}
                  {discussion.d.pinned && (
                    <span class="disc-tag is-pinned">📌 pinned</span>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ── Original post ── */}
          <div class="disc-thread">
            {discussion.d.body && (
              <article class="disc-comment">
                <header class="disc-comment-header">
                  <strong>@{discussion.author.username}</strong>
                  <span style="background:rgba(140,109,255,0.10);color:var(--accent);font-size:11px;font-weight:700;padding:1px 8px;border-radius:9999px;text-transform:uppercase;letter-spacing:0.02em">
                    Author
                  </span>
                  <span>{relTime(discussion.d.createdAt)}</span>
                </header>
                <div
                  class="disc-comment-body markdown-body"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(discussion.d.body || ""),
                  }}
                />
              </article>
            )}

            {/* ── Replies ── */}
            {comments.length > 0 && (
              <h3 style="font-size:15px;font-weight:700;color:var(--text-muted);margin:24px 0 12px">
                {comments.length} {comments.length === 1 ? "reply" : "replies"}
              </h3>
            )}

            {comments.map((com) => {
              const isAnswer = com.c.id === discussion!.d.answerCommentId;
              return (
                <article
                  class={"disc-comment" + (isAnswer ? " disc-answer" : "")}
                  id={`comment-${com.c.id}`}
                >
                  <header class="disc-comment-header">
                    <strong>@{com.author.username}</strong>
                    {isAnswer && (
                      <span class="disc-answer-badge">
                        ✅ Answer
                      </span>
                    )}
                    <span>{relTime(com.c.createdAt)}</span>
                    {/* Mark-as-answer — only for answerable categories, only for owner/author, only when not already answered */}
                    {isAnswerable &&
                      canModerate &&
                      !isAnswer &&
                      discussion!.d.state === "open" && (
                        <form
                          method="post"
                          action={`/${ownerName}/${repoName}/discussions/${discussion!.d.number}/comments/${com.c.id}/answer`}
                          style="display:inline;margin-left:auto"
                        >
                          <button type="submit" class="btn" style="font-size:12px;padding:4px 10px">
                            Mark as answer
                          </button>
                        </form>
                      )}
                  </header>
                  <div
                    class="disc-comment-body markdown-body"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(com.c.body || ""),
                    }}
                  />
                </article>
              );
            })}

            {/* ── Reply composer ── */}
            {user && !discussion.d.locked && discussion.d.state === "open" && (
              <form
                method="post"
                action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/comments`}
                style="margin-top:24px;display:flex;flex-direction:column;gap:8px"
              >
                <textarea
                  name="body"
                  rows={5}
                  placeholder="Add a reply (markdown supported)"
                  required
                  class="disc-textarea"
                  style="border-radius:10px"
                ></textarea>
                <button type="submit" class="disc-cta" style="align-self:flex-start">
                  Comment
                </button>
              </form>
            )}

            {/* ── Moderation actions ── */}
            {user && (
              <div style="margin-top:24px;display:flex;gap:8px;flex-wrap:wrap">
                {canModerate && (
                  <form
                    method="post"
                    action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/close`}
                    style="display:inline"
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
                      style="display:inline"
                    >
                      <button type="submit" class="btn">
                        {discussion.d.locked ? "Unlock" : "Lock"}
                      </button>
                    </form>
                    <form
                      method="post"
                      action={`/${ownerName}/${repoName}/discussions/${discussion.d.number}/pin`}
                      style="display:inline"
                    >
                      <button type="submit" class="btn">
                        {discussion.d.pinned ? "Unpin" : "Pin"}
                      </button>
                    </form>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/discussions/:id/comments — post reply
// ---------------------------------------------------------------------------
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/comments",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const numParam = Number(c.req.param("number"));
    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const form = await c.req.formData();
    const body = (form.get("body") as string || "").trim();
    const parentCommentId = (form.get("parent_comment_id") as string) || null;
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
        parentCommentId: parentCommentId || null,
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

// ---------------------------------------------------------------------------
// POST /:owner/:repo/discussions/:id/comments/:commentId/answer
// Mark as answer (author or repo owner only)
// ---------------------------------------------------------------------------
discussionRoutes.post(
  "/:owner/:repo/discussions/:number/comments/:commentId/answer",
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

      // Verify the category is answerable
      const [cat] = await db
        .select({ isAnswerable: discussionCategories.isAnswerable })
        .from(discussionCategories)
        .where(
          and(
            eq(discussionCategories.repositoryId, resolved.repo.id),
            eq(discussionCategories.name, row.category)
          )
        )
        .limit(1);

      const answerable =
        (cat?.isAnswerable ?? false) ||
        row.category === "q-and-a" ||
        row.category === "Q&A";

      if (!answerable) {
        return c.text("Only answerable discussions can have a marked answer", 400);
      }

      // Clear any previous answer flag, then set the new one
      await db
        .update(discussionComments)
        .set({ isAnswer: false })
        .where(eq(discussionComments.discussionId, row.id));

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

// ---------------------------------------------------------------------------
// Legacy comment route (kept for backwards compat — old forms post here)
// ---------------------------------------------------------------------------
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
    const parentCommentId = (form.get("parent_comment_id") as string) || null;
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
        parentCommentId: parentCommentId || null,
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

// ---------------------------------------------------------------------------
// Legacy answer route (kept for backwards compat)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Toggle lock (owner)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Toggle pin (owner)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Toggle close (owner or author)
// ---------------------------------------------------------------------------
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
