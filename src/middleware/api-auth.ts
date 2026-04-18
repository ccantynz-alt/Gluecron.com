/**
 * API Token Authentication Middleware
 *
 * Validates Bearer tokens from the Authorization header against stored API tokens.
 * Supports both session cookies (for web UI) and API tokens (for programmatic access).
 */

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { eq, gt } from "drizzle-orm";
import { db } from "../db";
import { apiTokens, sessions, users } from "../db/schema";
import type { User } from "../db/schema";

export type ApiAuthEnv = {
  Variables: {
    user: User | null;
    authMethod: "session" | "token" | "none";
    tokenScopes: string[];
  };
};

/**
 * Authenticate via Bearer token OR session cookie.
 * Sets c.get("user"), c.get("authMethod"), c.get("tokenScopes").
 */
export const apiAuth = createMiddleware<ApiAuthEnv>(async (c, next) => {
  // Try Bearer token first
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(token);
      const tokenHash = hasher.digest("hex");

      const [apiToken] = await db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, tokenHash))
        .limit(1);

      if (!apiToken) {
        return c.json({ error: "Invalid API token" }, 401);
      }

      // Check expiration
      if (apiToken.expiresAt && new Date(apiToken.expiresAt) < new Date()) {
        return c.json({ error: "API token expired" }, 401);
      }

      // Get user
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, apiToken.userId))
        .limit(1);

      if (!user) {
        return c.json({ error: "Token owner not found" }, 401);
      }

      // Update last used
      await db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, apiToken.id));

      c.set("user", user);
      c.set("authMethod", "token");
      c.set("tokenScopes", apiToken.scopes.split(",").map((s) => s.trim()));
      return next();
    } catch {
      return c.json({ error: "Authentication failed" }, 401);
    }
  }

  // Fall back to session cookie
  try {
    const sessionToken = getCookie(c, "session");
    if (sessionToken) {
      const [session] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.token, sessionToken))
        .limit(1);

      if (session && new Date(session.expiresAt) >= new Date()) {
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, session.userId))
          .limit(1);

        if (user) {
          c.set("user", user);
          c.set("authMethod", "session");
          c.set("tokenScopes", ["repo", "user", "admin"]);
          return next();
        }
      }
    }
  } catch {
    // DB unavailable — fall through to unauthenticated
  }

  c.set("user", null);
  c.set("authMethod", "none");
  c.set("tokenScopes", []);
  return next();
});

/**
 * Require authentication — returns 401 for API routes instead of redirecting.
 */
export const requireApiAuth = createMiddleware<ApiAuthEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json(
      { error: "Authentication required", hint: "Use Authorization: Bearer <token> header" },
      401
    );
  }
  return next();
});

/**
 * Require specific token scope.
 */
export function requireScope(scope: string) {
  return createMiddleware<ApiAuthEnv>(async (c, next) => {
    const scopes = c.get("tokenScopes") || [];
    if (!scopes.includes(scope) && !scopes.includes("admin")) {
      return c.json(
        { error: `Insufficient scope. Required: ${scope}` },
        403
      );
    }
    return next();
  });
}
