/**
 * Auth middleware — reads session cookie, injects user into context.
 */

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { eq, gt } from "drizzle-orm";
import { db } from "../db";
import { sessions, users } from "../db/schema";
import type { User } from "../db/schema";

export type AuthEnv = {
  Variables: {
    user: User | null;
  };
};

/**
 * Soft auth — sets c.get("user") to the current user or null.
 * Does NOT block unauthenticated requests.
 */
export const softAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, "session");
  if (!token) {
    c.set("user", null);
    return next();
  }

  try {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);

    if (!session || new Date(session.expiresAt) < new Date()) {
      c.set("user", null);
      return next();
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    c.set("user", user || null);
  } catch {
    c.set("user", null);
  }

  return next();
});

/**
 * Hard auth — redirects to /login if not authenticated.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, "session");
  if (!token) {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
  }

  try {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);

    if (!session || new Date(session.expiresAt) < new Date()) {
      return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
    }

    c.set("user", user);
  } catch {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
  }

  return next();
});
