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
 * Validates CSRF token on mutating requests (POST, PUT, DELETE, PATCH).
 * Checks form body field '_csrf' or header 'x-csrf-token' against cookie.
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

  // Skip CSRF for git protocol routes
  const path = c.req.path;
  if (path.endsWith(".git/git-upload-pack") || path.endsWith(".git/git-receive-pack")) {
    return next();
  }

  const cookieToken = getCookie(c, CSRF_COOKIE);
  if (!cookieToken) {
    return c.text("CSRF token missing", 403);
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
