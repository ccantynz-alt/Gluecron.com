/**
 * Helper to fetch the unread notification count for a user.
 * Extracted so any handler can pass it to <Layout> without importing the route file.
 * Errors are swallowed — the nav must never break because of a counter.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { notifications } from "../db/schema";

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
