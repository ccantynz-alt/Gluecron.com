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
  // Escape backslashes + double-quotes so the version is safe inside a
  // double-quoted JS string literal. Real SHAs are hex, but the dev
  // fallback could in principle contain anything — belt + braces.
  const safe = version.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `// gluecron service worker — Block S2 (deploy-SHA-pinned cache bust)
const SW_VERSION = "${safe}";
const CACHE_PREFIX = "gluecron-";
const CURRENT_CACHE = CACHE_PREFIX + SW_VERSION;

self.addEventListener("install", (e) => {
  // Activate immediately — don't wait for every tab to close. Pairs with
  // the layout's updatefound→reload hook so the user sees the new HTML
  // on the very next page load instead of "forever until DevTools".
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n.startsWith(CACHE_PREFIX) && n !== CURRENT_CACHE)
          .map((n) => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

// No fetch handler — every request goes straight to the network. The
// version-pinned cache machinery is in place for future opt-in caching
// without re-introducing the stale-HTML bug.
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
 * Push + offline service worker. Strictly additive to the v4 self-nuke SW.
 * Handles three things:
 *   1. `push` event → display a notification (title/body/url/tag).
 *   2. `notificationclick` → focus an existing tab on `url` or open a new one.
 *   3. `fetch` event → serve `/offline.html` as the fallback when the
 *      network fails on an HTML navigation. Non-HTML fetches passthrough.
 *
 * The cache name is unique so we don't collide with anything `/sw.js`
 * historically touched.
 */
export const PUSH_SERVICE_WORKER_SRC = `// gluecron push + offline service worker (Block M2)
const CACHE = 'gluecron-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try { await cache.add(new Request(OFFLINE_URL, { cache: 'reload' })); } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop any cache that isn't our current one.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Gluecron', body: '', url: '/', tag: 'gluecron', icon: '/icon.svg' };
  if (event.data) {
    try { data = Object.assign(data, event.data.json()); }
    catch (_) { try { data.body = event.data.text(); } catch (_) {} }
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.icon,
    tag: data.tag,
    data: { url: data.url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try {
        const u = new URL(c.url);
        if (u.pathname === target || c.url === target) {
          await c.focus();
          return;
        }
      } catch (_) {}
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const accept = req.headers.get('accept') || '';
  // Only intervene on top-level HTML navigations. Everything else (CSS,
  // images, API, /api/*, /.git/*, login/logout) passes straight through.
  if (req.mode !== 'navigate' && !accept.includes('text/html')) return;
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch (_) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(OFFLINE_URL);
      if (cached) return cached;
      return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
  })());
});
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
