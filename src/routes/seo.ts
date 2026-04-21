/**
 * SEO routes: robots.txt + sitemap.xml.
 *
 * robots.txt — allow crawlers on public surfaces, disallow admin/settings
 * and API write paths.
 * sitemap.xml — lists the stable public URLs (landing, explore, status,
 * marketplace, graphql explorer, shortcuts, terms). Public repo URLs are
 * not enumerated here — those live behind /explore which crawlers follow.
 */

import { Hono } from "hono";

const seo = new Hono();

const ROBOTS = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /settings
Disallow: /api/
Disallow: /login
Disallow: /register
Disallow: /logout
Disallow: /oauth/
Disallow: /*/settings
Disallow: /*.git/

Sitemap: /sitemap.xml
`;

seo.get("/robots.txt", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(ROBOTS);
});

const STATIC_PATHS = [
  "/",
  "/explore",
  "/marketplace",
  "/status",
  "/help",
  "/shortcuts",
  "/api/graphql",
  "/terms",
  "/privacy",
  "/acceptable-use",
];

seo.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = STATIC_PATHS.map(
    (p) =>
      `<url><loc>${origin}${p}</loc><lastmod>${lastmod}</lastmod></url>`
  ).join("\n  ");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls}
</urlset>
`;
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=3600");
  return c.body(body);
});

export default seo;
