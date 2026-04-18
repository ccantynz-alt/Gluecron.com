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
 * Bare-bones service worker. Offline behaviour:
 *   - HTML  → network first, cached response on failure, fallback offline page
 *   - other → pass-through (the static CSS is inlined into the HTML, so there's
 *             no cross-request asset worth caching for v1)
 */
export const SERVICE_WORKER_SRC = `// gluecron service worker — v1
const CACHE = 'gluecron-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never intercept git, API, or auth endpoints — they must stay fresh.
  if (
    url.pathname.includes('.git/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/login') ||
    url.pathname.startsWith('/logout') ||
    url.pathname.startsWith('/register')
  ) {
    return;
  }
  const wantsHtml = req.headers.get('accept')?.includes('text/html');
  if (wantsHtml) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
  }
});
`;

pwa.get("/sw.js", (c) => {
  c.header("content-type", "application/javascript");
  c.header("cache-control", "public, max-age=60");
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
