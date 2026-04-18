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
      <Container maxWidth={800}>
        <PageHeader title="Notifications" actions={markAllReadAction} />

        <div style="margin-bottom:16px">
          <FilterTabs tabs={[
            {
              label: `Unread${unreadCount > 0 ? ` (${unreadCount})` : ""}`,
              href: "/notifications?filter=unread",
              active: filter === "unread",
            },
            {
              label: "All",
              href: "/notifications?filter=all",
              active: filter === "all",
            },
          ]} />
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
                  <Text size={12} muted style="margin-top:4px">
                    {formatRelative(n.createdAt)}
                  </Text>
                </Flex>
                {!n.isRead && (
                  <div style="flex-shrink:0">
                    <Form action={`/notifications/${n.id}/read`} csrfToken={csrfToken}>
                      <Button size="sm" variant="ghost" type="submit">
                        {"\u2713"}
                      </Button>
                    </Form>
                  </div>
                )}
              </ListItem>
            ))}
          </List>
        )}
      </Container>
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
