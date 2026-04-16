/**
 * Notifications — the central inbox for every event the user needs to act on.
 *
 * GET  /notifications             — full inbox UI, filterable (all / unread / mentions)
 * POST /notifications/:id/read    — mark single notification read
 * POST /notifications/read-all    — mark every unread notification read
 * POST /notifications/:id/delete  — dismiss a notification
 * GET  /api/notifications/unread  — JSON count for nav badge
 * GET  /api/notifications         — JSON list for third-party integrations
 */

import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { notifications, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const notificationsRoute = new Hono<AuthEnv>();

notificationsRoute.use("*", softAuth);

/**
 * Cheap count of unread notifications — used by the nav badge.
 * Returns 0 if the user is not logged in or DB is unreachable.
 */
export async function getUnreadCount(userId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

function kindBadge(kind: string): { label: string; color: string } {
  switch (kind) {
    case "mention":
      return { label: "@", color: "#58a6ff" };
    case "review_requested":
      return { label: "review", color: "#d29922" };
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      return { label: "PR", color: "#986ee2" };
    case "issue_opened":
    case "issue_closed":
      return { label: "issue", color: "#3fb950" };
    case "gate_failed":
      return { label: "gate", color: "#f85149" };
    case "gate_repaired":
      return { label: "repaired", color: "#bc8cff" };
    case "gate_passed":
      return { label: "green", color: "#3fb950" };
    case "security_alert":
      return { label: "security", color: "#f85149" };
    case "deploy_success":
      return { label: "deploy", color: "#3fb950" };
    case "deploy_failed":
      return { label: "deploy", color: "#f85149" };
    case "release_published":
      return { label: "release", color: "#58a6ff" };
    case "ai_review":
      return { label: "ai", color: "#bc8cff" };
    default:
      return { label: kind, color: "#8b949e" };
  }
}

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

// ---------- Web UI ----------

notificationsRoute.get("/notifications", requireAuth, async (c) => {
  const user = c.get("user")!;
  const filter = c.req.query("filter") || "all"; // all | unread | mentions

  let rows: Array<{
    id: string;
    kind: string;
    title: string;
    body: string | null;
    url: string | null;
    readAt: Date | null;
    createdAt: Date;
    repoName: string | null;
    repoOwner: string | null;
  }> = [];

  try {
    const owners = users;
    const base = db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        url: notifications.url,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        repoName: repositories.name,
        repoOwner: owners.username,
      })
      .from(notifications)
      .leftJoin(repositories, eq(notifications.repositoryId, repositories.id))
      .leftJoin(owners, eq(repositories.ownerId, owners.id));

    if (filter === "unread") {
      rows = await base
        .where(
          and(eq(notifications.userId, user.id), isNull(notifications.readAt))
        )
        .orderBy(desc(notifications.createdAt))
        .limit(100);
    } else if (filter === "mentions") {
      rows = await base
        .where(
          and(
            eq(notifications.userId, user.id),
            eq(notifications.kind, "mention")
          )
        )
        .orderBy(desc(notifications.createdAt))
        .limit(100);
    } else {
      rows = await base
        .where(eq(notifications.userId, user.id))
        .orderBy(desc(notifications.createdAt))
        .limit(100);
    }
  } catch (err) {
    console.error("[notifications] list:", err);
  }

  const unreadCount = rows.filter((r) => !r.readAt).length;

  return c.html(
    <Layout title="Notifications" user={user}>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
        <h2>Notifications</h2>
        {unreadCount > 0 && (
          <form method="post" action="/notifications/read-all">
            <button type="submit" class="btn btn-sm">
              Mark all as read
            </button>
          </form>
        )}
      </div>

      <div class="issue-tabs" style="margin-bottom: 16px">
        <a href="/notifications" class={filter === "all" ? "active" : ""}>
          All
        </a>
        <a
          href="/notifications?filter=unread"
          class={filter === "unread" ? "active" : ""}
        >
          Unread
        </a>
        <a
          href="/notifications?filter=mentions"
          class={filter === "mentions" ? "active" : ""}
        >
          Mentions
        </a>
      </div>

      {rows.length === 0 ? (
        <div class="empty-state">
          <h2>Inbox zero</h2>
          <p>You're all caught up.</p>
        </div>
      ) : (
        <div class="notification-list">
          {rows.map((n) => {
            const badge = kindBadge(n.kind);
            const unread = !n.readAt;
            return (
              <div class={`notification-item${unread ? " unread" : ""}`}>
                <span
                  class="notification-badge"
                  style={`background: ${badge.color}20; color: ${badge.color}; border-color: ${badge.color}`}
                >
                  {badge.label}
                </span>
                <div class="notification-body">
                  <div class="notification-title">
                    {n.url ? (
                      <a href={n.url}>{n.title}</a>
                    ) : (
                      <span>{n.title}</span>
                    )}
                  </div>
                  {n.body && (
                    <div class="notification-desc">{n.body}</div>
                  )}
                  <div class="notification-meta">
                    {n.repoOwner && n.repoName && (
                      <>
                        <a href={`/${n.repoOwner}/${n.repoName}`}>
                          {n.repoOwner}/{n.repoName}
                        </a>
                        <span> · </span>
                      </>
                    )}
                    <span>{formatRelative(n.createdAt)}</span>
                  </div>
                </div>
                <div class="notification-actions">
                  {unread && (
                    <form method="post" action={`/notifications/${n.id}/read`}>
                      <button
                        type="submit"
                        class="btn btn-sm"
                        title="Mark as read"
                      >
                        {"\u2713"}
                      </button>
                    </form>
                  )}
                  <form method="post" action={`/notifications/${n.id}/delete`}>
                    <button
                      type="submit"
                      class="btn btn-sm"
                      title="Dismiss"
                    >
                      {"\u00D7"}
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Layout>
  );
});

notificationsRoute.post("/notifications/:id/read", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  } catch (err) {
    console.error("[notifications] mark read:", err);
  }
  return c.redirect("/notifications");
});

notificationsRoute.post("/notifications/read-all", requireAuth, async (c) => {
  const user = c.get("user")!;
  try {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(eq(notifications.userId, user.id), isNull(notifications.readAt))
      );
  } catch (err) {
    console.error("[notifications] read-all:", err);
  }
  return c.redirect("/notifications");
});

notificationsRoute.post("/notifications/:id/delete", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    await db
      .delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  } catch (err) {
    console.error("[notifications] delete:", err);
  }
  return c.redirect(c.req.header("referer") || "/notifications");
});

// ---------- JSON API ----------

notificationsRoute.get("/api/notifications/unread", requireAuth, async (c) => {
  const user = c.get("user")!;
  const count = await getUnreadCount(user.id);
  return c.json({ count });
});

notificationsRoute.get("/api/notifications", requireAuth, async (c) => {
  const user = c.get("user")!;
  try {
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    return c.json(rows);
  } catch {
    return c.json([]);
  }
});

export default notificationsRoute;
