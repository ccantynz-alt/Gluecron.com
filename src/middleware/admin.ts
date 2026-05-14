/**
 * Admin middleware — blocks non-admin users.
 * Must be used AFTER softAuth or requireAuth.
 *
 * "Admin" means EITHER:
 *   - the user is in the `site_admins` table (explicit grant), OR
 *   - the `site_admins` table is empty and this user is the oldest
 *     row in `users` (bootstrap rule from src/lib/admin.ts).
 *
 * The legacy `users.is_admin` column is ALSO honoured for backward
 * compatibility with accounts that pre-date the site_admins table.
 *
 * Until 2026-05-14 this middleware only checked `users.is_admin`,
 * which broke /import + every other requireAdmin-gated route for any
 * user who only had bootstrap-rule admin status (which is the case
 * after running scripts/reset-admin-password.ts).
 */

import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "./auth";
import { isSiteAdmin } from "../lib/admin";

export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get("user");

  if (!user) {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
  }

  const admin = user.isAdmin === true || (await isSiteAdmin(user.id));
  if (!admin) {
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
