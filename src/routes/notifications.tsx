/**
 * Notification routes — bell icon, list, mark read, clear.
 *
 * Visual polish: 2026 hero + filter pills + AI-row treatment.
 * All visual styling scoped to `.notif-*` classes via an inline <style>
 * block so we never bleed into shared view files. No logic touched —
 * the route still reads/writes the same query params and endpoints.
 */

import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { notifications } from "../db/schema-extensions";
import { users, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { formatRelative } from "../views/ui";

const notificationRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Inline, scoped CSS — every class prefixed with `.notif-` so it cannot
// bleed onto other surfaces. Pattern mirrors the dashboard-hero polish
// (commit a004c46), issues row treatment (f7ad7b8), and settings section
// cards (98eb360). All tokens come from :root in layout.tsx.
// ---------------------------------------------------------------------------
const notifStyles = `
  /* ─── Hero card ─── */
  .notif-hero {
    position: relative;
    margin: 4px 0 24px;
    padding: 28px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .notif-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .notif-hero-bg {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 360px;
    height: 360px;
    pointer-events: none;
    z-index: 0;
  }
  .notif-hero-orb {
    position: absolute;
    inset: 0;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    animation: notifHeroOrb 14s ease-in-out infinite;
  }
  @keyframes notifHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.6; }
    50%      { transform: scale(1.1) translate(-10px, 8px); opacity: 0.85; }
  }
  @media (prefers-reduced-motion: reduce) {
    .notif-hero-orb { animation: none; }
  }
  .notif-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 24px;
    flex-wrap: wrap;
  }
  .notif-hero-text { flex: 1; min-width: 280px; }
  .notif-hero-eyebrow {
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: 8px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
  }
  .notif-hero-eyebrow .notif-hero-username {
    color: var(--accent);
    text-transform: none;
    letter-spacing: -0.005em;
    font-weight: 600;
  }
  .notif-hero-title {
    font-family: var(--font-display);
    font-size: clamp(28px, 4vw, 40px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 10px;
    color: var(--text-strong);
  }
  .notif-hero-title .gradient-text {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .notif-hero-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.5;
    max-width: 580px;
  }
  .notif-hero-sub strong {
    color: var(--text-strong);
    font-weight: 600;
  }
  .notif-hero-sub .notif-dot {
    margin: 0 8px;
    color: var(--text-faint, var(--text-muted));
  }
  .notif-hero-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  @media (max-width: 720px) {
    .notif-hero { padding: 24px 20px; }
    .notif-hero-inner { flex-direction: column; align-items: flex-start; }
    .notif-hero-actions { width: 100%; }
  }

  /* ─── Filter row + Mark all read button ─── */
  .notif-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin: 0 0 16px;
  }
  .notif-filters {
    display: inline-flex;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 9999px;
    padding: 4px;
    gap: 2px;
    max-width: 100%;
    overflow-x: auto;
  }
  .notif-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 9999px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    transition: color 120ms ease, background 120ms ease;
    line-height: 1.4;
    white-space: nowrap;
  }
  .notif-filter:hover { color: var(--text-strong); text-decoration: none; }
  .notif-filter.is-active {
    background: rgba(140,109,255,0.14);
    color: var(--text-strong);
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.30);
  }
  .notif-filter-count {
    font-variant-numeric: tabular-nums;
    font-size: 11.5px;
    color: var(--text-muted);
    background: rgba(255,255,255,0.04);
    padding: 1px 7px;
    border-radius: 9999px;
  }
  .notif-filter.is-active .notif-filter-count {
    background: rgba(140,109,255,0.22);
    color: var(--text);
  }
  .notif-mark-all {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    background: var(--bg-elevated);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 9999px;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
    font-family: inherit;
  }
  .notif-mark-all:hover {
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    background: rgba(140,109,255,0.06);
  }
  .notif-mark-all-form { margin: 0; padding: 0; }

  /* ─── Notification list ─── */
  .notif-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    background: var(--bg-elevated);
  }
  .notif-row {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px 18px 14px 22px;
    border-bottom: 1px solid var(--border);
    transition: background 140ms ease, transform 140ms ease, box-shadow 140ms ease;
  }
  .notif-row:last-child { border-bottom: none; }
  .notif-row:hover {
    background: rgba(140,109,255,0.04);
    transform: translateY(-1px);
    box-shadow: 0 8px 24px -16px rgba(0,0,0,0.45);
  }
  .notif-row.is-read { opacity: 0.72; }
  .notif-row.is-unread::before {
    content: '';
    position: absolute;
    left: 0; top: 12px; bottom: 12px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: linear-gradient(180deg, #a48bff 0%, #8c6dff 60%, #36c5d6 100%);
    box-shadow: 0 0 10px rgba(140,109,255,0.45);
  }
  .notif-row-icon {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    color: var(--text);
    margin-top: 2px;
  }
  .notif-row-icon.is-comment { color: #60a5fa; background: rgba(96,165,250,0.10); border-color: rgba(96,165,250,0.25); }
  .notif-row-icon.is-mention { color: #fbbf24; background: rgba(251,191,36,0.10); border-color: rgba(251,191,36,0.25); }
  .notif-row-icon.is-star    { color: #fbbf24; background: rgba(251,191,36,0.10); border-color: rgba(251,191,36,0.25); }
  .notif-row-icon.is-ci      { color: #34d399; background: rgba(52,211,153,0.10); border-color: rgba(52,211,153,0.25); }
  .notif-row-icon.is-ai      {
    color: #fff;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    border-color: rgba(140,109,255,0.55);
    box-shadow: 0 0 14px rgba(140,109,255,0.40);
  }
  .notif-row-main { flex: 1; min-width: 0; }
  .notif-row-title {
    font-family: var(--font-display);
    font-size: 14.5px;
    line-height: 1.4;
    letter-spacing: -0.01em;
    margin: 0;
    color: var(--text);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .notif-row-title a {
    color: inherit;
    text-decoration: none;
    transition: color 120ms ease;
  }
  .notif-row-title a:hover { color: var(--accent); }
  .notif-row-title strong { color: var(--text-strong); font-weight: 700; }
  .notif-row-body {
    margin-top: 4px;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .notif-row-meta {
    margin-top: 6px;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .notif-row-meta a {
    color: var(--text-link);
    text-decoration: none;
    font-variant-numeric: tabular-nums;
  }
  .notif-row-meta a:hover { color: var(--accent-hover, var(--accent)); }
  .notif-row-meta .notif-dot { color: var(--text-faint, var(--text-muted)); }
  .notif-row-actions {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 1px;
  }
  .notif-row-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid transparent;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
    font-family: inherit;
    font-size: 14px;
    line-height: 1;
  }
  .notif-row-action:hover {
    color: var(--text-strong);
    background: rgba(140,109,255,0.10);
    border-color: rgba(140,109,255,0.30);
  }
  .notif-row-action.is-open {
    width: auto;
    padding: 0 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text);
  }
  .notif-row-action-form { margin: 0; padding: 0; display: inline; }

  /* AI-specific row treatment — purple-tinted */
  .notif-row.notif-row-ai {
    background:
      linear-gradient(90deg, rgba(140,109,255,0.06) 0%, rgba(140,109,255,0.015) 60%, transparent 100%),
      var(--bg-elevated);
  }
  .notif-row.notif-row-ai:hover {
    background:
      linear-gradient(90deg, rgba(140,109,255,0.10) 0%, rgba(140,109,255,0.03) 60%, transparent 100%),
      var(--bg-elevated);
  }
  .notif-row-ai .notif-row-title strong { color: var(--text-strong); }
  .notif-ai-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    line-height: 1.4;
    box-shadow: 0 0 10px rgba(140,109,255,0.30);
  }

  /* ─── Empty state ─── */
  .notif-empty {
    position: relative;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    overflow: hidden;
  }
  .notif-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .notif-empty-art {
    width: 96px;
    height: 96px;
    margin: 0 auto 18px;
    display: block;
    opacity: 0.9;
  }
  .notif-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .notif-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto;
    max-width: 460px;
  }

  @media (max-width: 720px) {
    .notif-row { padding: 12px 14px 12px 18px; gap: 10px; }
    .notif-row-icon { width: 30px; height: 30px; font-size: 14px; }
    .notif-toolbar { flex-direction: column; align-items: stretch; }
    .notif-filters { width: 100%; justify-content: center; }
    .notif-mark-all { width: 100%; justify-content: center; }
  }
`;

// ---------------------------------------------------------------------------
// Heuristics — purely cosmetic. Detects AI-origin notifications so we can
// give them a distinct treatment. The classification only changes CSS; the
// underlying record + actions are unchanged.
// ---------------------------------------------------------------------------
function isAiNotification(n: any): boolean {
  if (n?.type === "pr_review") return true;
  const hay = `${n?.title ?? ""} ${n?.body ?? ""}`.toLowerCase();
  return (
    hay.includes("ai review") ||
    hay.includes("ai triage") ||
    hay.includes("claude ") ||
    hay.includes("auto-merge") ||
    hay.includes("incident report")
  );
}

function iconForKind(type: string, ai: boolean): { glyph: string; cls: string } {
  if (ai) return { glyph: "✨", cls: "is-ai" };          // ✨
  switch (type) {
    case "issue_comment": return { glyph: "\u{1F4AC}", cls: "is-comment" };  // 💬
    case "pr_review":     return { glyph: "✨",   cls: "is-ai" };        // ✨ (covered above)
    case "mention":       return { glyph: "@",        cls: "is-mention" };
    case "star":          return { glyph: "★",   cls: "is-star" };      // ★
    case "ci_status":     return { glyph: "⚙",   cls: "is-ci" };        // ⚙
    default:              return { glyph: "\u{1F514}", cls: "" };            // 🔔
  }
}

// Empty-state illustration — abstract, gluecron-tinted bell with a gradient
// "all-clear" check inside. Inline so we don't depend on external assets.
function EmptyArt() {
  return (
    <svg
      class="notif-empty-art"
      viewBox="0 0 96 96"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="notifEmptyGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#a48bff" />
          <stop offset="55%" stop-color="#8c6dff" />
          <stop offset="100%" stop-color="#36c5d6" />
        </linearGradient>
        <radialGradient id="notifEmptyGlow" cx="0.5" cy="0.55" r="0.6">
          <stop offset="0%" stop-color="rgba(140,109,255,0.40)" />
          <stop offset="100%" stop-color="rgba(140,109,255,0)" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="50" r="36" fill="url(#notifEmptyGlow)" />
      <path
        d="M48 18c-9 0-16 7-16 16v10c0 5-2 8-5 11-1.5 1.5-1 4 1 4h40c2 0 2.5-2.5 1-4-3-3-5-6-5-11V34c0-9-7-16-16-16Z"
        stroke="url(#notifEmptyGrad)"
        stroke-width="2"
        stroke-linejoin="round"
        fill="rgba(140,109,255,0.06)"
      />
      <path
        d="M42 64c1.5 3 3.5 4.5 6 4.5s4.5-1.5 6-4.5"
        stroke="url(#notifEmptyGrad)"
        stroke-width="2"
        stroke-linecap="round"
        fill="none"
      />
      <path
        d="M40 42.5 L46 48.5 L57 37"
        stroke="url(#notifEmptyGrad)"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  );
}

// Notification list page
notificationRoutes.get("/notifications", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const filter = c.req.query("filter") || "unread";
  const csrfToken = (c as any).get("csrfToken") || "";

  const query = db
    .select()
    .from(notifications)
    .where(
      filter === "all"
        ? eq(notifications.userId, user.id)
        : and(eq(notifications.userId, user.id), eq(notifications.isRead, false))
    )
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  let items: any[] = [];
  try {
    items = await query;
  } catch {
    // Table may not exist yet
  }

  let unreadCount = 0;
  let totalCount = 0;
  let weekReadCount = 0;
  let mentionsCount = 0;
  try {
    const [r1] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)));
    unreadCount = r1?.count ?? 0;
  } catch { /* table may not exist */ }
  try {
    const [r2] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(eq(notifications.userId, user.id));
    totalCount = r2?.count ?? 0;
  } catch { /* table may not exist */ }
  try {
    const [r3] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.id),
          eq(notifications.isRead, true),
          sql`${notifications.createdAt} > now() - interval '7 days'`
        )
      );
    weekReadCount = r3?.count ?? 0;
  } catch { /* table may not exist */ }
  try {
    const [r4] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), eq(notifications.type, "mention")));
    mentionsCount = r4?.count ?? 0;
  } catch { /* table may not exist */ }

  // Context-aware sub-line for the hero.
  const subLine = (() => {
    if (unreadCount === 0 && totalCount === 0) {
      return <>You are all caught up. Notifications about AI reviews, mentions, and CI activity will land here.</>;
    }
    if (unreadCount === 0) {
      return <>You are all caught up. <strong>{weekReadCount}</strong> read this week.</>;
    }
    const unreadLabel = unreadCount === 1 ? "unread" : "unread";
    return (
      <>
        <strong>{unreadCount}</strong> {unreadLabel}
        <span class="notif-dot">·</span>
        <strong>{weekReadCount}</strong> read this week
      </>
    );
  })();

  // Filter pill definitions — labels are cosmetic, query values are preserved.
  const filterPills: Array<{
    key: string;
    href: string;
    label: string;
    count: number | null;
  }> = [
    { key: "unread",   href: "/notifications?filter=unread",   label: "Inbox",    count: unreadCount },
    { key: "mentions", href: "/notifications?filter=mentions", label: "Mentions", count: mentionsCount },
    { key: "all",      href: "/notifications?filter=all",      label: "All",      count: totalCount },
  ];

  return c.html(
    <Layout title="Notifications" user={user}>
      <style dangerouslySetInnerHTML={{ __html: notifStyles }} />

      {/* ─── Hero ─── */}
      <section class="notif-hero">
        <div class="notif-hero-bg" aria-hidden="true">
          <div class="notif-hero-orb" />
        </div>
        <div class="notif-hero-inner">
          <div class="notif-hero-text">
            <div class="notif-hero-eyebrow">
              Inbox{" "}
              <span class="notif-hero-username">· @{user.username}</span>
            </div>
            <h1 class="notif-hero-title">
              <span class="gradient-text">Notifications</span>
            </h1>
            <p class="notif-hero-sub">{subLine}</p>
          </div>
          <div class="notif-hero-actions">
            {unreadCount > 0 && (
              <form method="post" action="/notifications/read-all" class="notif-mark-all-form">
                {csrfToken && <input type="hidden" name="_csrf" value={csrfToken} />}
                <button type="submit" class="notif-mark-all" title="Mark all as read">
                  <span aria-hidden="true">{"✓"}</span>
                  Mark all read
                </button>
              </form>
            )}
          </div>
        </div>
      </section>

      {/* ─── Filter pill row ─── */}
      <div class="notif-toolbar">
        <nav class="notif-filters" aria-label="Notification filters">
          {filterPills.map((p) => (
            <a
              href={p.href}
              class={"notif-filter" + (filter === p.key ? " is-active" : "")}
            >
              {p.label}
              {p.count !== null && p.count > 0 && (
                <span class="notif-filter-count">{p.count}</span>
              )}
            </a>
          ))}
        </nav>
      </div>

      {/* ─── List / empty state ─── */}
      {items.length === 0 ? (
        <div class="notif-empty">
          <EmptyArt />
          <h2 class="notif-empty-title">All caught up</h2>
          <p class="notif-empty-sub">
            {filter === "unread"
              ? "No unread notifications. New AI reviews, mentions, and activity on your repos will appear here."
              : filter === "mentions"
              ? "No mentions yet. When someone @-mentions you in an issue or PR, you'll see it here."
              : "No notifications. Once you're collaborating, this is where everything lands."}
          </p>
        </div>
      ) : (
        <ul class="notif-list">
          {items.map((n: any) => {
            const ai = isAiNotification(n);
            const icon = iconForKind(n.type, ai);
            const rowCls =
              "notif-row " +
              (n.isRead ? "is-read" : "is-unread") +
              (ai ? " notif-row-ai" : "");
            return (
              <li class={rowCls}>
                <span class={"notif-row-icon " + icon.cls} aria-hidden="true">
                  {icon.glyph}
                </span>
                <div class="notif-row-main">
                  <div class="notif-row-title">
                    {n.url ? (
                      <a href={n.url}>{n.title}</a>
                    ) : (
                      <span>{n.title}</span>
                    )}
                    {ai && <span class="notif-ai-badge">AI</span>}
                  </div>
                  {n.body && (
                    <div class="notif-row-body">
                      {n.body.length > 140 ? n.body.slice(0, 140) + "…" : n.body}
                    </div>
                  )}
                  <div class="notif-row-meta">
                    {n.repoOwner && n.repoName && (
                      <>
                        <a href={`/${n.repoOwner}/${n.repoName}`}>
                          {n.repoOwner}/{n.repoName}
                        </a>
                        <span class="notif-dot">·</span>
                      </>
                    )}
                    <span>{formatRelative(n.createdAt)}</span>
                  </div>
                </div>
                <div class="notif-row-actions">
                  {n.url && (
                    <a
                      href={n.url}
                      class="notif-row-action is-open"
                      title="Open"
                    >
                      Open
                    </a>
                  )}
                  {!n.isRead && (
                    <form
                      method="post"
                      action={`/notifications/${n.id}/read`}
                      class="notif-row-action-form"
                    >
                      {csrfToken && <input type="hidden" name="_csrf" value={csrfToken} />}
                      <button
                        type="submit"
                        class="notif-row-action"
                        title="Mark as read"
                        aria-label="Mark as read"
                      >
                        {"✓"}
                      </button>
                    </form>
                  )}
                  <form
                    method="post"
                    action={`/notifications/${n.id}/delete`}
                    class="notif-row-action-form"
                  >
                    {csrfToken && <input type="hidden" name="_csrf" value={csrfToken} />}
                    <button
                      type="submit"
                      class="notif-row-action"
                      title="Dismiss"
                      aria-label="Dismiss"
                    >
                      {"×"}
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Layout>
  );
});

// Mark single notification as read
notificationRoutes.post("/notifications/:id/read", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  try {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  } catch {
    // Table may not exist
  }

  return c.redirect("/notifications");
});

// Mark all as read
notificationRoutes.post("/notifications/read-all", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;

  try {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)));
  } catch {
    // Table may not exist
  }

  return c.redirect("/notifications");
});

// API: Get unread count (for bell icon polling)
notificationRoutes.get("/api/notifications/count", softAuth, async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ count: 0 });

  try {
    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)));
    return c.json({ count: result?.count ?? 0 });
  } catch {
    return c.json({ count: 0 });
  }
});

export default notificationRoutes;
