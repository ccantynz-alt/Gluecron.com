/**
 * Smoke tests for the public /status page, /status.svg badge, and SEO
 * routes (/robots.txt + /sitemap.xml). These don't stub the DB — they
 * tolerate either success (dev DB reachable) or a graceful error page
 * so they work in the sandbox environment.
 */

import { test, expect } from "bun:test";
import app from "../app";

test("/status returns 200 with HTML body", async () => {
  const res = await app.request("/status");
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("<html");
  // Either the green or red headline should appear
  expect(
    body.includes("All systems operational") ||
      body.includes("Service degraded")
  ).toBe(true);
});

test("/status.svg returns an SVG badge", async () => {
  const res = await app.request("/status.svg");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/image\/svg/);
  const body = await res.text();
  expect(body).toContain("<svg");
  expect(body).toContain("</svg>");
});

test("/robots.txt returns 200 with crawler directives", async () => {
  const res = await app.request("/robots.txt");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  const body = await res.text();
  expect(body).toContain("User-agent:");
  expect(body).toContain("Sitemap:");
  expect(body).toContain("Disallow: /admin");
});

test("/sitemap.xml returns valid-looking XML", async () => {
  const res = await app.request("/sitemap.xml");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/xml/);
  const body = await res.text();
  expect(body).toContain('<?xml');
  expect(body).toContain("<urlset");
  expect(body).toContain("<loc>");
  expect(body).toContain("</urlset>");
});

test("sitemap includes the landing, status, explore URLs", async () => {
  const res = await app.request("/sitemap.xml");
  const body = await res.text();
  expect(body).toMatch(/<loc>[^<]*\/<\/loc>/);
  expect(body).toContain("/status");
  expect(body).toContain("/explore");
});
