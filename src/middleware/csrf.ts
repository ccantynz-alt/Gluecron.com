/**
 * CSRF Protection Middleware
 *
 * Generates and validates CSRF tokens for form submissions.
 * Uses double-submit cookie pattern for stateless CSRF protection.
 */

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const CSRF_FIELD = "_csrf";

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sets a CSRF cookie on every request if not already present.
 * Also makes the token available via c.get("csrfToken").
 */
export const csrfToken = createMiddleware(async (c, next) => {
  let token = getCookie(c, CSRF_COOKIE);
  if (!token) {
    token = generateToken();
    setCookie(c, CSRF_COOKIE, token, {
      httpOnly: false, // JS needs to read it
      sameSite: "Lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });
  }
  c.set("csrfToken", token);
  return next();
});

/**
 * Validates CSRF on mutating requests (POST, PUT, DELETE, PATCH).
 *
 * Defence-in-depth, in order:
 *  1. Same-origin check via Origin/Referer header (OWASP-recommended primary
 *     defence against CSRF — a cross-site forged request from a victim's
 *     browser always carries the attacker's Origin, never the app's host).
 *  2. Double-submit cookie token (the `_csrf` form field or `X-CSRF-Token`
 *     header must equal the `csrf_token` cookie). Optional — used as a
 *     belt-and-braces fallback when present.
 *
 * The Origin check alone is sufficient for modern browsers (all major
 * browsers send Origin on cross-origin POSTs). The token check is retained
 * because some legacy clients strip Origin/Referer, and because it gives
 * forms an explicit "I came from a real page" signal.
 *
 * A request is accepted iff EITHER the Origin/Referer matches the request
 * host OR the token check passes.
 */
export const csrfProtect = createMiddleware(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next();
  }

  // Skip CSRF for API routes with Bearer token auth (they have their own auth)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return next();
  }

  // Skip CSRF for API routes (they use token auth, not cookies)
  const path = c.req.path;
  if (path.startsWith("/api/")) {
    return next();
  }

  // Skip CSRF for git protocol routes
  if (path.endsWith(".git/git-upload-pack") || path.endsWith(".git/git-receive-pack")) {
    return next();
  }

  // Skip CSRF for requests with no session cookie — they are unauthenticated
  // and will be redirected to /login (or 404) by downstream auth middleware.
  // CSRF only matters for authenticated, cookie-bearing sessions because the
  // attack vector is a malicious site tricking a logged-in user's browser.
  const sessionCookie = getCookie(c, "session");
  if (!sessionCookie) {
    return next();
  }

  // ---- 1) Same-origin check (Origin / Referer header) -----------------
  // A genuine same-origin request from our own pages will carry an Origin
  // (always for cross-origin POSTs, usually for same-origin too) or a
  // Referer that matches the request host. Cross-site forged requests
  // either carry the attacker's origin or are stripped — in both cases
  // they fail this check.
  const host = c.req.header("host");
  const origin = c.req.header("origin");
  const referer = c.req.header("referer");
  let originOk = false;
  if (host) {
    if (origin) {
      try {
        originOk = new URL(origin).host === host;
      } catch {
        originOk = false;
      }
    } else if (referer) {
      try {
        originOk = new URL(referer).host === host;
      } catch {
        originOk = false;
      }
    }
  }
  if (originOk) {
    return next();
  }

  // ---- 2) Double-submit cookie token (fallback) ------------------------
  const cookieToken = getCookie(c, CSRF_COOKIE);
  if (!cookieToken) {
    return c.text("CSRF check failed: no Origin/Referer header and no token cookie", 403);
  }

  // Check header first, then form body
  let submittedToken = c.req.header(CSRF_HEADER);
  if (!submittedToken) {
    try {
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        submittedToken = String(body[CSRF_FIELD] || "");
      }
    } catch {
      // Can't parse body — skip
    }
  }

  // For JSON API calls from the web UI
  if (!submittedToken) {
    try {
      const contentType = c.req.header("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = await c.req.json();
        submittedToken = body?._csrf;
      }
    } catch {
      // Can't parse JSON — skip
    }
  }

  if (!submittedToken || submittedToken !== cookieToken) {
    return c.text("CSRF token invalid", 403);
  }

  return next();
});

/**
 * Helper to generate a hidden CSRF input field for forms.
 */
export function csrfField(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD}" value="${token}" />`;
}
