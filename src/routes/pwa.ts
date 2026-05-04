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

const pwa = new Hono();

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

pwa.get("/sw.js", (c) => {
  c.header("content-type", "application/javascript");
  // No-cache: browser must check on every page load. Critical for the v4
  // self-nuke SW to actually reach all returning visitors.
  c.header("cache-control", "no-cache, no-store, must-revalidate");
  c.header("pragma", "no-cache");
  // Service-Worker-Allowed required for root-scope SW served from root
  c.header("service-worker-allowed", "/");
  return c.body(SERVICE_WORKER_SRC);
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

export default pwa;
