/**
 * Block G1 — PWA (progressive web app) support.
 *
 *   GET /manifest.webmanifest    — app manifest (install prompt)
 *   GET /sw.js                   — service worker (cache-first for static, network-first for HTML)
 *   GET /icon.svg                — monochrome logo used by the manifest
 *
 * The service worker deliberately keeps the cache small (static CSS-in-JS is
 * inlined so there's nothing to cache beyond the manifest + icon). HTML pages
 * fall through to the network; cached copies only serve offline fallback.
 *
 * Adding `<link rel="manifest" href="/manifest.webmanifest">` + a tiny SW
 * registration snippet to `Layout` turns any repo page into an installable
 * PWA on Chrome/Safari.
 */

import { Hono } from "hono";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  getVapidPublicKey,
  sendPushToUser,
  subscribeUser,
  unsubscribeUser,
} from "../lib/push";

const pwa = new Hono<AuthEnv>();

export const MANIFEST = {
  name: "Gluecron",
  short_name: "Gluecron",
  description: "AI-native code intelligence + git hosting",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0d1117",
  theme_color: "#0d1117",
  icons: [
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable",
    },
  ],
  categories: ["developer", "productivity"],
} as const;

pwa.get("/manifest.webmanifest", (c) => {
  c.header("content-type", "application/manifest+json");
  c.header("cache-control", "public, max-age=3600");
  return c.body(JSON.stringify(MANIFEST));
});

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#0d1117"/>
  <g fill="#58a6ff" font-family="monospace" font-size="58" font-weight="700" text-anchor="middle">
    <text x="64" y="82">gc</text>
  </g>
  <circle cx="28" cy="28" r="5" fill="#3fb950"/>
</svg>`;

pwa.get("/icon.svg", (c) => {
  c.header("content-type", "image/svg+xml");
  c.header("cache-control", "public, max-age=86400, immutable");
  return c.body(ICON_SVG);
});

/**
 * Bare-bones service worker — v4 NUKE EDITION.
 *
 * After repeated reports of stale HTML being served from old cache versions,
 * this SW does ONE job: unregister itself and purge every cache. Browsers
 * that previously installed v1/v2/v3 will load this v4, see the unregister
 * call, and stop intercepting fetches. From now on EVERY page load goes
 * straight to the network — no SW, no cache, instant fresh content on push.
 *
 * Once we trust the auto-deploy pipeline + want offline support back, ship
 * a real SW with conservative network-first behaviour. Until then: instant
 * deploys win.
 */
export const SERVICE_WORKER_SRC = `// gluecron service worker — v4 (self-nuke)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge every cache from any prior SW version
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    // Tell every client we're done so they reload onto clean network state
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) c.navigate(c.url).catch(() => {});
    // Then unregister this SW so future loads skip the SW layer entirely
    await self.registration.unregister();
  })());
});
// No fetch handler — every request goes straight to the network.
`;

/**
 * Block S2 — deploy-SHA-pinned cache bust.
 *
 * The SW source we SERVE from `/sw.js` is built per-request and pins its
 * cache name to the current deploy SHA. The locked Block-G1
 * `SERVICE_WORKER_SRC` constant above is preserved (exported for tests +
 * historical context); the served body is built afresh in the handler so
 * the SW_VERSION is always current.
 *
 * Behaviour:
 *   - `install` calls `skipWaiting()` so the new SW activates immediately
 *     instead of waiting for every tab to close.
 *   - `activate` deletes every `gluecron-*` cache that isn't the current
 *     version's cache, then `clients.claim()`s so open tabs adopt the new
 *     SW without a manual reload.
 *
 * The `Cache-Control: no-store` header on `/sw.js` itself ensures browsers
 * always re-fetch the SW source on update checks — critical for the new
 * version to actually reach returning visitors.
 *
 * BUILD_SHA is read from `process.env.BUILD_SHA` at request time so the
 * deploy pipeline can rotate it without a rebuild. Falls back to a STABLE
 * `dev-stable` constant when unset — the previous `dev-<pid>` fallback
 * changed on every systemd restart, which invalidated the SW on every
 * restart and triggered the layout's updatefound→reload hook, producing
 * visible page flashing on long-lived admin tabs. Use a constant fallback
 * so the SW only rotates when BUILD_SHA actually changes (real deploy).
 * A one-shot warn() is logged so operators still notice misconfigured
 * deploys.
 */

// One-shot warning latch — exported only for tests to reset between cases.
let _missingShaWarned = false;
export function _resetSwShaWarningForTests(): void {
  _missingShaWarned = false;
}

export function buildSwVersion(): string {
  const sha = process.env.BUILD_SHA?.trim();
  if (sha) return sha;
  if (!_missingShaWarned) {
    _missingShaWarned = true;
    console.warn(
      "[pwa] BUILD_SHA env not set — service worker will fall back to a dev-mode version string. Set BUILD_SHA in the deploy environment so cache-busting pins to the deploy SHA."
    );
  }
  // Dev fallback: STABLE across systemd restarts (no `${process.pid}` —
  // that was rotating on every restart and forcing browser reloads via
  // the layout's updatefound hook). Distinct prefix `dev-` so operators
  // can tell at a glance the deploy pipeline didn't set BUILD_SHA.
  return "dev-stable";
}

export function buildVersionedServiceWorker(version: string): string {
  // PWA removed 2026-05-16. The body served at /sw.js is now a self-
  // unregister script. Browsers with the old SW installed fetch this
  // body on their next SW update check (every navigation, since
  // Cache-Control: no-store on the response) and the SW unregisters
  // itself. Combined with the layout-side kill-switch script, every
  // browser self-recovers within one page load.
  //
  // SW_VERSION is still pinned + preserved in the body so the existing
  // cache-bust tests keep asserting against a non-empty literal. The
  // cache-prefix delete + clients.claim are also preserved (they nuke
  // any caches the old SW left behind). Final step: unregister.
  const safe = version.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `// gluecron service worker — self-unregister edition (2026-05-16)
const SW_VERSION = "${safe}";
const CACHE_PREFIX = "gluecron-";
const CURRENT_CACHE = CACHE_PREFIX + SW_VERSION;

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => caches.delete(n))
      );
    } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
  })());
});

// No fetch handler — once this SW activates and unregisters itself the
// browser never invokes it again. Every request goes straight to the
// network.
`;
}

pwa.get("/sw.js", (c) => {
  c.header("content-type", "application/javascript");
  // no-store on /sw.js itself: browsers must re-fetch the SW source on
  // every update check so the new SW_VERSION can actually propagate.
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
  // Service-Worker-Allowed required for root-scope SW served from root.
  c.header("service-worker-allowed", "/");
  const version = buildSwVersion();
  return c.body(buildVersionedServiceWorker(version));
});

/**
 * Inline script registering the SW. Loaded once at the bottom of every page.
 * Kept tiny so we don't bloat TTI.
 */
export const PWA_REGISTER_SNIPPET = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function() {});
  });
}
`.trim();

// ---------------------------------------------------------------------------
// Block M2 — additive routes + a SECOND service worker dedicated to push +
// offline support. The original `/sw.js` keeps its v4 self-nuke behaviour
// (locked) so the install/activate/unregister contract is preserved. The new
// SW lives at `/sw-push.js` and is registered separately by the install
// banner / settings page when the user opts into push.
// ---------------------------------------------------------------------------

/**
 * Push + offline service worker — SELF-NUKE EDITION (2026-05-16).
 *
 * Background: previously this SW handled push/notification/offline-fetch
 * AND was auto-registered by the layout at scope `/`. Combined with the
 * `/sw.js` auto-registration at the same scope it caused the AA reload
 * loop (two different script URLs at scope `/` keep replacing each
 * other → layout's `updatefound → reload` hook fires every page load,
 * input wiped, admin dashboard unusable). See commit d7ba05d for the
 * layout-side fix.
 *
 * The layout-side fix alone does not recover browsers that ALREADY have
 * the old push SW registered — the loop reloads the page before the new
 * layout's JS gets a chance to run its `getRegistrations() → unregister`
 * cleanup. So we also need the SW itself to clean up.
 *
 * What this body does now: on install, claim every client, delete every
 * `gluecron-*` cache the old version created, then call
 * `self.registration.unregister()` so the registration goes away
 * permanently. Browsers fetch this updated body on their next SW
 * update check (which fires on every navigation because `/sw-push.js`
 * is served with `Cache-Control: no-store`), so trapped browsers
 * auto-recover within one page load post-deploy.
 *
 * Push notifications: temporarily disabled. The folding of push +
 * notificationclick handlers into the locked `/sw.js` body is tracked
 * as a follow-up. Until then `/settings/push` will subscribe against
 * the existing `/sw.js` registration, which silently won't display
 * notifications — but won't loop either. That's the right trade-off
 * while the platform is in firefighting mode.
 */
export const PUSH_SERVICE_WORKER_SRC = `// gluecron push SW — self-unregister (2026-05-16 AA-loop kill)
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k && k.indexOf('gluecron-offline') === 0).map((k) => caches.delete(k))
      );
    } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
  })());
});
// No fetch / push / notificationclick handlers — by design. Once this SW
// activates and unregisters, the browser never invokes it again. The
// scope is freed and /sw.js becomes the sole controller at /.
`;

pwa.get("/sw-push.js", (c) => {
  c.header("content-type", "application/javascript");
  // Same caching policy as /sw.js so updates propagate immediately.
  c.header("cache-control", "no-cache, no-store, must-revalidate");
  c.header("pragma", "no-cache");
  c.header("service-worker-allowed", "/");
  return c.body(PUSH_SERVICE_WORKER_SRC);
});

/** Offline fallback — minimal, theme-consistent. */
export const OFFLINE_HTML = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Offline — gluecron</title>
<style>
  :root { --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --accent:#58a6ff; --border:#30363d; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  main { max-width: 480px; margin: 12vh auto 0; padding: 24px; text-align:center; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p  { color: var(--muted); line-height: 1.5; }
  a.btn {
    display:inline-block; margin-top:18px; padding:10px 18px;
    background:transparent; border:1px solid var(--border); border-radius:6px;
    color:var(--accent); text-decoration:none;
  }
  .pulse {
    width:10px; height:10px; border-radius:50%;
    background:#f85149; display:inline-block; margin-right:8px;
    box-shadow:0 0 12px rgba(248,81,73,0.6);
  }
</style>
</head>
<body>
<main>
  <h1><span class="pulse"></span>You're offline</h1>
  <p>We couldn't reach gluecron. Your last-known dashboard is still in cache &mdash; reconnect to refresh it.</p>
  <a class="btn" href="/dashboard">Retry</a>
</main>
</body>
</html>
`;

pwa.get("/offline.html", (c) => {
  c.header("content-type", "text/html; charset=utf-8");
  c.header("cache-control", "public, max-age=300");
  return c.body(OFFLINE_HTML);
});

// --- API: VAPID public key --------------------------------------------------
pwa.get("/pwa/vapid-public-key", async (c) => {
  try {
    const key = await getVapidPublicKey();
    return c.json({ key });
  } catch (err) {
    console.error("[pwa] vapid public key failed:", err);
    return c.json({ error: "vapid_unavailable" }, 500);
  }
});

// --- API: subscribe ---------------------------------------------------------
pwa.post("/pwa/subscribe", requireAuth, async (c) => {
  const user = c.get("user")!;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh =
    typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth) {
    return c.json({ error: "invalid_subscription" }, 400);
  }
  const ua = c.req.header("user-agent") ?? null;
  try {
    await subscribeUser(
      user.id,
      { endpoint, keys: { p256dh, auth } },
      ua ?? undefined
    );
  } catch (_) {
    return c.json({ error: "subscribe_failed" }, 500);
  }
  return c.json({ ok: true }, 201);
});

// --- API: unsubscribe -------------------------------------------------------
pwa.post("/pwa/unsubscribe", requireAuth, async (c) => {
  const user = c.get("user")!;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return c.json({ error: "missing_endpoint" }, 400);
  await unsubscribeUser(user.id, endpoint);
  return c.body(null, 204);
});

// --- API: send a test push to the calling user ------------------------------
pwa.post("/pwa/test", requireAuth, async (c) => {
  const user = c.get("user")!;
  const result = await sendPushToUser(user.id, {
    title: "Gluecron test notification",
    body: "If you can read this, push delivery is working on this device.",
    url: "/notifications",
    tag: "gluecron-test",
  });
  return c.json(result);
});

export default pwa;
