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
// BLOCK O2 — polished 403 page renderer (standalone HTML, DB-free).
import { renderStandaloneErrorPage } from "../views/error-page";

export const requireAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get("user");

  if (!user) {
    return c.redirect(`/login?redirect=${encodeURIComponent(c.req.path)}`);
  }

  const admin = user.isAdmin === true || (await isSiteAdmin(user.id));
  if (!admin) {
    // BLOCK O2 — polished 403 page (was inline 80s-era markup). The
    // standalone renderer returns a self-contained <!doctype html>
    // document so this middleware has no Layout dependency.
    return c.html(
      renderStandaloneErrorPage({
        code: "403",
        eyebrow: "Forbidden",
        title: "Admin access required.",
        body:
          "This area is restricted to site admins. If you think this is " +
          "a mistake, contact a site admin or sign in as a different user.",
        signedIn: true,
      }),
      403
    );
  }

  return next();
});
