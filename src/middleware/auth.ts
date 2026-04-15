/**
 * Auth middleware — reads session cookie, injects user into context.
 * Uses in-memory session cache to avoid DB roundtrip on every request.
 *
 * B6: API requests can also authenticate via `Authorization: Bearer <token>`
 * using an OAuth access token. The token's scopes and the owning app are
 * stashed on the context for scope checks downstream.
 */

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { eq, gt } from "drizzle-orm";
import { db } from "../db";
import { sessions, users, oauthAccessTokens } from "../db/schema";
import type { User } from "../db/schema";
import { sessionCache } from "../lib/cache";
import { sha256Hex } from "../lib/oauth";

export type AuthEnv = {
  Variables: {
    user: User | null;
    /** When the caller authenticated via an OAuth bearer token, these are set. */
    oauthScopes?: string[];
    oauthAppId?: string;
  };
};

async function loadUserFromBearer(
  token: string
): Promise<{ user: User; scopes: string[]; appId: string } | null> {
  if (!token.startsWith("glct_")) return null;
  try {
    const hash = await sha256Hex(token);
    const [row] = await db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.accessTokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (new Date(row.expiresAt) < new Date()) return null;
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!user) return null;
    // Best-effort: update lastUsedAt. Never fail auth on this.
    db
      .update(oauthAccessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(oauthAccessTokens.id, row.id))
      .catch(() => {});
    return {
      user,
      scopes: row.scopes ? row.scopes.split(/\s+/).filter(Boolean) : [],
      appId: row.appId,
    };
  } catch {
    return null;
  }
}

/**
 * Soft auth — sets c.get("user") to the current user or null.
 * Does NOT block unauthenticated requests.
 * Caches session->user mapping for 2 minutes to avoid DB roundtrip per request.
 */
export const softAuth = createMiddleware<AuthEnv>(async (c, next) => {
  // B6: Bearer token takes precedence over cookie for API calls.
  const authHeader = c.req.header("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer.startsWith("glct_")) {
      const result = await loadUserFromBearer(bearer);
      if (result) {
        c.set("user", result.user);
        c.set("oauthScopes", result.scopes);
        c.set("oauthAppId", result.appId);
        return next();
      }
    }
  }

  const token = getCookie(c, "session");
  if (!token) {
    c.set("user", null);
    return next();
  }

  // Check session cache first
  const cachedUser = sessionCache.get(token) as User | null | undefined;
  if (cachedUser !== undefined) {
    c.set("user", cachedUser);
    return next();
  }

  try {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);

    if (
      !session ||
      new Date(session.expiresAt) < new Date() ||
      session.requires2fa
    ) {
      sessionCache.set(token, null as any);
      c.set("user", null);
      return next();
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    // Cache the result (user or null)
    sessionCache.set(token, (user || null) as any);
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
  // B6: Bearer token takes precedence over cookie for API calls.
  const authHeader = c.req.header("authorization") || "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer.startsWith("glct_")) {
      const result = await loadUserFromBearer(bearer);
      if (result) {
        c.set("user", result.user);
        c.set("oauthScopes", result.scopes);
        c.set("oauthAppId", result.appId);
        return next();
      }
      // Bearer token was presented but invalid — return 401 instead of
      // redirecting to /login (API clients don't follow HTML redirects).
      return c.json({ error: "Invalid or expired token" }, 401);
    }
  }

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

    // 2FA pending — route the user to the code prompt instead of letting
    // them access protected pages.
    if (session.requires2fa) {
      return c.redirect(
        `/login/2fa?redirect=${encodeURIComponent(c.req.path)}`
      );
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
