/**
 * Admin middleware — blocks non-admin users.
 * Must be used AFTER softAuth or requireAuth.
 */

import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "./auth";

export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get("user");

  if (!user) {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
  }

  if (!user.isAdmin) {
    return c.html(
      `<html><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh">
        <div style="text-align:center">
          <h1>403</h1>
          <p>Admin access required.</p>
          <a href="/" style="color:#58a6ff">Go home</a>
        </div>
      </body></html>`,
      403
    );
  }

  return next();
});
