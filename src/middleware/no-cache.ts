import type { MiddlewareHandler } from "hono";

// Applied to HTML routes that must never be served stale.
// CSS/JS/git pack files are NOT affected by this middleware.
export const noCache: MiddlewareHandler = async (c, next) => {
  await next();
  const ct = c.res.headers.get("Content-Type") || "";
  // Only add no-cache to HTML responses — don't break asset caching
  if (ct.includes("text/html")) {
    c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    c.res.headers.set("Pragma", "no-cache");
    c.res.headers.set("Vary", "Cookie");
  }
};
