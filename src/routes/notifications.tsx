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
import {
  Container,
  PageHeader,
  Flex,
  FilterTabs,
  EmptyState,
  List,
  ListItem,
  Form,
  Button,
  Text,
  formatRelative,
} from "../views/ui";

const notificationRoutes = new Hono<AuthEnv>();

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
  try {
    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), eq(notifications.isRead, false)));
    unreadCount = result?.count ?? 0;
  } catch {
    // Table may not exist yet
  }

  const markAllReadAction = unreadCount > 0 ? (
    <Form action="/notifications/read-all" csrfToken={csrfToken}>
      <Button size="sm" type="submit">Mark all read</Button>
    </Form>
  ) : null;

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

        {items.length === 0 ? (
          <EmptyState title="All caught up">
            <p>No {filter === "unread" ? "unread " : ""}notifications.</p>
          </EmptyState>
        ) : (
          <List>
            {items.map((n: any) => (
              <ListItem style={n.isRead ? "opacity:0.6" : ""}>
                <div style="font-size:18px;padding-top:2px">
                  {n.type === "issue_comment" ? "\u{1F4AC}" :
                   n.type === "pr_review" ? "\u{1F50D}" :
                   n.type === "mention" ? "\u{1F4E3}" :
                   n.type === "star" ? "\u2B50" :
                   n.type === "ci_status" ? "\u2699\uFE0F" : "\u{1F514}"}
                </div>
                <Flex direction="column" style="flex:1">
                  <Text size={14} weight={500}>
                    {n.url ? <a href={n.url} style="color:var(--text)">{n.title}</a> : n.title}
                  </Text>
                  {n.body && (
                    <Text size={13} muted style="margin-top:2px">
                      {n.body.length > 120 ? n.body.slice(0, 120) + "..." : n.body}
                    </Text>
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
