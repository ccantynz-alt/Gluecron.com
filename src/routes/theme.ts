/**
 * Theme toggle — flips a "theme" cookie between dark and light.
 * Cookie is read by both the SSR layout (via middleware-injected prop) and
 * a pre-paint inline script to avoid FOUC.
 */

import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const theme = new Hono();

function readTheme(c: any): "dark" | "light" {
  const v = getCookie(c, "theme");
  return v === "light" ? "light" : "dark";
}

function writeTheme(c: any, value: "dark" | "light") {
  setCookie(c, "theme", value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "Lax",
    httpOnly: false, // must be readable by the pre-paint script
  });
}

function redirectBack(c: any): Response {
  const ref = c.req.header("referer");
  // Only follow same-origin referers — anything else falls back to /.
  try {
    if (ref) {
      const u = new URL(ref);
      const host = c.req.header("host");
      if (u.host === host) return c.redirect(u.pathname + u.search);
    }
  } catch {
    // fall through
  }
  return c.redirect("/");
}

// GET /theme/toggle — flip current value, redirect back.
// Lives outside /settings/* so it doesn't get blocked by the settings
// auth middleware — theme should work for logged-out visitors too.
theme.get("/theme/toggle", (c) => {
  const next = readTheme(c) === "light" ? "dark" : "light";
  writeTheme(c, next);
  return redirectBack(c);
});

// GET /theme/set?mode=dark|light — explicit setter (for tests + API).
theme.get("/theme/set", (c) => {
  const mode = c.req.query("mode");
  if (mode !== "dark" && mode !== "light") {
    return c.json({ ok: false, error: "mode must be 'dark' or 'light'" }, 400);
  }
  writeTheme(c, mode);
  if ((c.req.header("accept") || "").includes("application/json")) {
    return c.json({ ok: true, theme: mode });
  }
  return redirectBack(c);
});

export { readTheme };
export default theme;
