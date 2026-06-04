/**
 * Block J4 — User following routes.
 *
 *   POST /:user/follow                — auth required
 *   POST /:user/unfollow              — auth required
 *   GET  /:user/followers             — public list
 *   GET  /:user/following             — public list
 *   GET  /feed                        — auth required, personalised activity
 *
 * 2026 polish: scoped `.follows-*` class system gives this surface a card
 * grid, gradient hairline hero, and per-row follow/unfollow buttons. No
 * shared files touched; the actions and queries are preserved verbatim.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  describeAction,
  feedForUser,
  followCounts,
  followUser,
  isFollowing,
  listFollowers,
  listFollowing,
  resolveUserByName,
  unfollowUser,
} from "../lib/follows";
import { audit } from "../lib/notify";

const follows = new Hono<AuthEnv>();
follows.use("*", softAuth);

const RESERVED = new Set([
  "login",
  "register",
  "logout",
  "new",
  "settings",
  "api",
  "feed",
  "dashboard",
  "explore",
  "search",
  "notifications",
  "admin",
  "orgs",
  "gists",
  "marketplace",
  "sponsors",
  "developer",
  "ask",
  "help",
]);

function profileUrl(username: string): string {
  return `/${username}`;
}

// ─── Scoped CSS (.follows-*) ────────────────────────────────────────────────
//
// All selectors namespaced with `.follows-` to avoid bleeding into shared
// chrome (RepoHeader, layout nav). Pulls tokens from the layout for theme
// continuity (--bg-elevated, --border, --text-strong, --accent, --space-*).

const followStyles = `
  .follows-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Header ─── */
  .follows-head { margin-bottom: var(--space-5); }
  .follows-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .follows-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .follows-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .follows-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .follows-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 680px;
  }
  .follows-sub a { color: var(--accent); text-decoration: none; }
  .follows-sub a:hover { text-decoration: underline; }

  /* ─── Tab strip ─── */
  .follows-tabs {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: var(--space-3) 0 var(--space-5);
    padding: 4px;
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .follows-tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 13px;
    border-radius: 9px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-decoration: none;
    border: 1px solid transparent;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .follows-tab:hover {
    color: var(--text-strong);
    background: rgba(255,255,255,0.03);
    text-decoration: none;
  }
  .follows-tab.is-active {
    background: linear-gradient(135deg, rgba(140,109,255,0.16), rgba(54,197,214,0.14));
    color: #e9e2ff;
    border-color: rgba(140,109,255,0.40);
  }
  .follows-tab-count {
    font-family: var(--font-mono);
    font-size: 11.5px;
    opacity: 0.75;
  }

  /* ─── Section card (wraps the grid) ─── */
  .follows-section {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .follows-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .follows-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── User card grid ─── */
  .follows-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }
  .follows-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .follows-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .follows-avatar {
    width: 48px; height: 48px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.25));
    color: #ffffff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 18px;
    flex-shrink: 0;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
    text-decoration: none;
  }
  .follows-avatar img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  .follows-card-body { flex: 1; min-width: 0; }
  .follows-card-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .follows-card-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .follows-card-name:hover { text-decoration: underline; }
  .follows-card-handle {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .follows-card-bio {
    margin: 6px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .follows-card-action { margin-top: 10px; }
  .follows-card-action form { margin: 0; }

  /* ─── Buttons ─── */
  .follows-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 9px;
    font-size: 12.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    white-space: nowrap;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .follows-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .follows-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #ffffff;
    text-decoration: none;
  }
  .follows-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .follows-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Empty state ─── */
  .follows-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .follows-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .follows-empty-inner { position: relative; z-index: 1; }
  .follows-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin-bottom: 14px;
  }
  .follows-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .follows-empty-sub {
    margin: 0 auto;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }
  .follows-empty-sub a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .follows-empty-sub a:hover { text-decoration: underline; }

  /* ─── Feed entries ─── */
  .follows-feed {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .follows-feed-entry {
    padding: 12px 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 11px;
    transition: border-color 120ms ease, background 120ms ease;
  }
  .follows-feed-entry:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .follows-feed-line {
    font-size: 13.5px;
    color: var(--text);
    line-height: 1.45;
  }
  .follows-feed-line a {
    color: var(--text-strong);
    text-decoration: none;
    font-weight: 600;
  }
  .follows-feed-line a:hover { text-decoration: underline; }
  .follows-feed-verb {
    color: var(--text-muted);
    font-weight: 400;
  }
  .follows-feed-meta {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .follows-feed-meta a { color: var(--text-muted); text-decoration: none; }
  .follows-feed-meta a:hover { color: var(--text); text-decoration: underline; }
  .follows-feed-sha {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    padding: 1px 6px;
    border-radius: 4px;
  }
`;

function IconUsers() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconFeed() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1.5" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ---------- Follow / unfollow ----------

follows.post("/:user/follow", requireAuth, async (c) => {
  const me = c.get("user")!;
  const targetName = c.req.param("user");
  if (RESERVED.has(targetName)) return c.notFound();
  const target = await resolveUserByName(targetName);
  if (!target) return c.notFound();
  const res = await followUser(me.id, target.id);
  if (res === "ok") {
    await audit({
      userId: me.id,
      action: "user.follow",
      targetId: target.id,
      metadata: { username: target.username },
    });
  }
  return c.redirect(profileUrl(targetName));
});

follows.post("/:user/unfollow", requireAuth, async (c) => {
  const me = c.get("user")!;
  const targetName = c.req.param("user");
  if (RESERVED.has(targetName)) return c.notFound();
  const target = await resolveUserByName(targetName);
  if (!target) return c.notFound();
  const ok = await unfollowUser(me.id, target.id);
  if (ok) {
    await audit({
      userId: me.id,
      action: "user.unfollow",
      targetId: target.id,
      metadata: { username: target.username },
    });
  }
  return c.redirect(profileUrl(targetName));
});

// ---------- Lists ----------

async function renderUserList(
  c: any,
  ownerName: string,
  mode: "followers" | "following"
) {
  const user = c.get("user");
  if (RESERVED.has(ownerName)) return c.notFound();
  const target = await resolveUserByName(ownerName);
  if (!target) return c.notFound();
  const list =
    mode === "followers"
      ? await listFollowers(target.id)
      : await listFollowing(target.id);
  const counts = await followCounts(target.id);

  // For each row, compute whether the viewer already follows them. This is
  // best-effort: anonymous viewers / self-references skip the lookup so the
  // page still renders if `isFollowing` errors.
  const viewerFollows = new Map<string, boolean>();
  if (user) {
    await Promise.all(
      list.map(async (u) => {
        if (u.id === user.id) return;
        try {
          viewerFollows.set(u.id, await isFollowing(user.id, u.id));
        } catch {
          viewerFollows.set(u.id, false);
        }
      })
    );
  }

  return c.html(
    <Layout
      title={`${mode === "followers" ? "Followers" : "Following"} — ${ownerName}`}
      user={user}
    >
      <div class="follows-wrap">
        <header class="follows-head">
          <div class="follows-eyebrow">
            <span class="follows-eyebrow-dot" aria-hidden="true" />
            Profile · @{ownerName}
          </div>
          <h1 class="follows-title">
            <span class="follows-title-grad">
              {mode === "followers" ? "Followers" : "Following"}.
            </span>
          </h1>
          <p class="follows-sub">
            {mode === "followers" ? (
              <>People who follow <a href={`/${ownerName}`}>@{ownerName}</a>.</>
            ) : (
              <>People <a href={`/${ownerName}`}>@{ownerName}</a> follows.</>
            )}
          </p>

          <nav class="follows-tabs" aria-label="Follow view">
            <a
              href={`/${ownerName}/followers`}
              class={"follows-tab" + (mode === "followers" ? " is-active" : "")}
            >
              Followers <span class="follows-tab-count">{counts.followers}</span>
            </a>
            <a
              href={`/${ownerName}/following`}
              class={"follows-tab" + (mode === "following" ? " is-active" : "")}
            >
              Following <span class="follows-tab-count">{counts.following}</span>
            </a>
          </nav>
        </header>

        {list.length === 0 ? (
          <div class="follows-empty">
            <div class="follows-empty-orb" aria-hidden="true" />
            <div class="follows-empty-inner">
              <div class="follows-empty-icon" aria-hidden="true">
                <IconUsers />
              </div>
              <h3 class="follows-empty-title">No {mode} yet</h3>
              <p class="follows-empty-sub">
                {mode === "followers"
                  ? "Nobody follows this account yet."
                  : "This account hasn't followed anyone yet."}
              </p>
            </div>
          </div>
        ) : (
          <section class="follows-section">
            <div class="follows-section-body">
              <div class="follows-grid">
                {list.map((u) => {
                  const isSelf = !!user && u.id === user.id;
                  const already = viewerFollows.get(u.id) === true;
                  return (
                    <div class="follows-card">
                      <a
                        href={`/${u.username}`}
                        class="follows-avatar"
                        aria-hidden="true"
                        tabIndex={-1}
                      >
                        {u.avatarUrl ? (
                          <img src={u.avatarUrl} alt="" loading="lazy" />
                        ) : (
                          u.username[0]?.toUpperCase() ?? "?"
                        )}
                      </a>
                      <div class="follows-card-body">
                        <div class="follows-card-row">
                          <a href={`/${u.username}`} class="follows-card-name">
                            {u.displayName || u.username}
                          </a>
                          <span class="follows-card-handle">@{u.username}</span>
                        </div>
                        {u.bio && <p class="follows-card-bio">{u.bio}</p>}
                        {user && !isSelf && (
                          <div class="follows-card-action">
                            {already ? (
                              <form
                                method="post"
                                action={`/${u.username}/unfollow`}
                              >
                                <button
                                  type="submit"
                                  class="follows-btn follows-btn-ghost"
                                >
                                  <IconCheck />
                                  Following
                                </button>
                              </form>
                            ) : (
                              <form
                                method="post"
                                action={`/${u.username}/follow`}
                              >
                                <button
                                  type="submit"
                                  class="follows-btn follows-btn-primary"
                                >
                                  <IconPlus />
                                  Follow
                                </button>
                              </form>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: followStyles }} />
    </Layout>
  );
}

follows.get("/:user/followers", async (c) =>
  renderUserList(c, c.req.param("user"), "followers")
);
follows.get("/:user/following", async (c) =>
  renderUserList(c, c.req.param("user"), "following")
);

// ---------- Personalised feed ----------

follows.get("/feed", requireAuth, async (c) => {
  const user = c.get("user")!;
  const entries = await feedForUser(user.id, 50);
  return c.html(
    <Layout title="Feed" user={user}>
      <div class="follows-wrap">
        <header class="follows-head">
          <div class="follows-eyebrow">
            <span class="follows-eyebrow-dot" aria-hidden="true" />
            Your network · Live activity
          </div>
          <h1 class="follows-title">
            <span class="follows-title-grad">Your feed.</span>
          </h1>
          <p class="follows-sub">
            Recent activity from accounts you follow. Find more people on{" "}
            <a href="/explore">/explore</a> and follow them from their profile.
          </p>
        </header>

        {entries.length === 0 ? (
          <div class="follows-empty">
            <div class="follows-empty-orb" aria-hidden="true" />
            <div class="follows-empty-inner">
              <div class="follows-empty-icon" aria-hidden="true">
                <IconFeed />
              </div>
              <h3 class="follows-empty-title">Nothing here yet</h3>
              <p class="follows-empty-sub">
                Try the <a href="/explore">explore page</a> to find people to
                follow — their pushes, PRs, and issues will surface here.
              </p>
            </div>
          </div>
        ) : (
          <section class="follows-section">
            <div class="follows-section-body">
              <div class="follows-feed">
                {entries.map((e) => {
                  const repoUrl = `/${e.ownerUsername}/${e.repository.name}`;
                  return (
                    <div class="follows-feed-entry">
                      <div class="follows-feed-line">
                        <a href={`/${e.actor.username}`}>
                          @{e.actor.username}
                        </a>{" "}
                        <span class="follows-feed-verb">
                          {describeAction(e.activity.action)}
                        </span>{" "}
                        <a href={repoUrl}>
                          {e.ownerUsername}/{e.repository.name}
                        </a>
                      </div>
                      <div class="follows-feed-meta">
                        {new Date(e.activity.createdAt).toLocaleString()}
                        {e.activity.targetType === "issue" &&
                          e.activity.targetId && (
                            <>
                              {" · "}
                              <a
                                href={`${repoUrl}/issues/${e.activity.targetId}`}
                              >
                                #{e.activity.targetId}
                              </a>
                            </>
                          )}
                        {e.activity.targetType === "pr" &&
                          e.activity.targetId && (
                            <>
                              {" · "}
                              <a href={`${repoUrl}/pulls/${e.activity.targetId}`}>
                                #{e.activity.targetId}
                              </a>
                            </>
                          )}
                        {e.activity.targetType === "commit" &&
                          e.activity.targetId && (
                            <>
                              {" · "}
                              <a
                                href={`${repoUrl}/commit/${e.activity.targetId}`}
                                class="follows-feed-sha"
                              >
                                {String(e.activity.targetId).slice(0, 7)}
                              </a>
                            </>
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: followStyles }} />
    </Layout>
  );
});

export default follows;

// Exported for profile page use (web.tsx).
export { isFollowing, followCounts, resolveUserByName };
