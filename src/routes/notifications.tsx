/**
 * Notification routes — bell icon, list, mark read, clear.
 */

import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { notifications } from "../db/schema-extensions";
import { users, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const notificationRoutes = new Hono<AuthEnv>();

// Notification list page
notificationRoutes.get("/notifications", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const filter = c.req.query("filter") || "unread";

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
  try {
    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)));
    unreadCount = result?.count ?? 0;
  } catch {
    // Table may not exist yet
  }

  return c.html(
    <Layout title="Notifications" user={user}>
      <div style="max-width:800px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
          <h2>Notifications</h2>
          <div style="display:flex;gap:8px">
            {unreadCount > 0 && (
              <form method="post" action="/notifications/read-all">
                <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
                <button type="submit" class="btn btn-sm">Mark all read</button>
              </form>
            )}
          </div>
        </div>

        <div class="issue-tabs" style="margin-bottom:16px">
          <a href="/notifications?filter=unread" class={filter === "unread" ? "active" : ""}>
            Unread {unreadCount > 0 && `(${unreadCount})`}
          </a>
          <a href="/notifications?filter=all" class={filter === "all" ? "active" : ""}>
            All
          </a>
        </div>

        {items.length === 0 ? (
          <div class="empty-state">
            <h2>All caught up</h2>
            <p>No {filter === "unread" ? "unread " : ""}notifications.</p>
          </div>
        ) : (
          <div class="issue-list">
            {items.map((n: any) => (
              <div class="issue-item" style={n.isRead ? "opacity:0.6" : ""}>
                <div style="font-size:18px;padding-top:2px">
                  {n.type === "issue_comment" ? "\u{1F4AC}" :
                   n.type === "pr_review" ? "\u{1F50D}" :
                   n.type === "mention" ? "\u{1F4E3}" :
                   n.type === "star" ? "\u2B50" :
                   n.type === "ci_status" ? "\u2699\uFE0F" : "\u{1F514}"}
                </div>
                <div style="flex:1">
                  <div style="font-size:14px;font-weight:500">
                    {n.url ? <a href={n.url} style="color:var(--text)">{n.title}</a> : n.title}
                  </div>
                  {n.body && (
                    <div style="font-size:13px;color:var(--text-muted);margin-top:2px">
                      {n.body.length > 120 ? n.body.slice(0, 120) + "..." : n.body}
                    </div>
                  )}
                  <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
                    {formatRelative(n.createdAt)}
                  </div>
                </div>
                {!n.isRead && (
                  <form method="post" action={`/notifications/${n.id}/read`} style="flex-shrink:0">
                    <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
                    <button type="submit" class="btn btn-sm btn-ghost" title="Mark as read">
                      \u2713
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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

function formatRelative(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default notificationRoutes;
