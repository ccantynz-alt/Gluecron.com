/**
 * Block U — Senior polish pass smoke tests.
 *
 * 2026-06-10 update: `GET /` now serves the self-contained
 * `Landing2030Page` (src/views/landing-2030.tsx) — the legacy
 * `LandingPage` + master Layout CSS no longer render on the home route.
 * U1 assertions therefore target the 2030 hero contract; U2/U4 master-CSS
 * assertions target /help, a public Layout-rendered page that needs no DB.
 *
 * U1: hero — exactly two CTAs in the hero actions row, trust line
 *     beneath, product-card mock below the CTAs.
 * U2: button CSS — hover lifts every .btn by translateY(-1px) with a
 *     soft drop shadow; focus-visible uses box-shadow (not outline);
 *     primary CTA shimmers via background-position; disabled buttons
 *     never lift.
 * U4: master CSS contains the @view-transition block and the
 *     prefers-reduced-motion guard.
 *
 * No DB stubs, no mock pollution — pure rendering checks against the
 * already-mounted Hono app.
 */
import { describe, it, expect } from "bun:test";
import app from "../app";

const HOME = "/";
// Public, Layout-rendered, DB-free page that carries the master CSS.
const LAYOUT_PAGE = "/help";

async function fetchHomeHtml(): Promise<string> {
  const res = await app.request(HOME);
  expect(res.status).toBe(200);
  return await res.text();
}

async function fetchLayoutHtml(): Promise<string> {
  const res = await app.request(LAYOUT_PAGE);
  expect(res.status).toBe(200);
  return await res.text();
}

describe("Block U1 — landing hero (2030 reboot)", () => {
  it("renders exactly two CTAs in the hero actions row", async () => {
    const body = await fetchHomeHtml();
    const start = body.indexOf('class="hero-actions');
    expect(start).toBeGreaterThan(-1);
    // The actions row is a tight window of <a … class="btn …"> anchors.
    const tail = body.slice(start, start + 600);
    const anchorMatches = tail.match(/<a[^>]*class="btn[^"]*"/g) || [];
    expect(anchorMatches.length).toBe(2);
    expect(tail).toContain('href="/register"');
    expect(tail).toContain('href="#loop"');
  });

  it("renders the trust line beneath the CTAs", async () => {
    const body = await fetchHomeHtml();
    const ctas = body.indexOf('class="hero-actions');
    const trust = body.indexOf('class="hero-trust');
    expect(ctas).toBeGreaterThan(-1);
    expect(trust).toBeGreaterThan(ctas);
    expect(body).toContain("Self-hosted · Git-native · Claude-first");
  });

  it("places the product-card mock below the CTAs", async () => {
    const body = await fetchHomeHtml();
    const ctas = body.indexOf('class="hero-actions');
    const card = body.indexOf('class="hero-card');
    expect(ctas).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(ctas);
  });
});

describe("Block U2 — button polish", () => {
  it("includes the universal hover-lift transform on .btn", async () => {
    const body = await fetchLayoutHtml();
    // The master CSS is inlined in <style> by Layout. We assert on the
    // hover-rule shape: `.btn:hover { … transform: translateY(-1px); … }`.
    expect(body).toMatch(/\.btn:hover\b[\s\S]*?transform:\s*translateY\(-1px\)/);
  });

  it("uses a soft drop shadow on .btn:hover (not just border)", async () => {
    const body = await fetchLayoutHtml();
    expect(body).toMatch(/\.btn:hover\b[\s\S]*?box-shadow:\s*0\s+4px\s+12px/);
  });

  it("uses box-shadow (not outline) for the .btn focus ring", async () => {
    const body = await fetchLayoutHtml();
    // Focus-visible rule must set box-shadow with the soft accent rgba.
    expect(body).toMatch(
      /\.btn:focus-visible\b[\s\S]*?box-shadow:\s*0\s+0\s+0\s+3px\s+rgba\(140,\s*109,\s*255,\s*0\.35\)/
    );
    // And must NOT fall back to outline:2px on .btn anywhere.
    expect(body).not.toMatch(/\.btn:focus-visible[^{]*\{\s*outline:\s*2px/);
  });

  it("disables hover-lift on disabled buttons", async () => {
    const body = await fetchLayoutHtml();
    // The disabled rule sets transform:none AND opacity:0.5.
    expect(body).toMatch(/\.btn:disabled[\s\S]*?transform:\s*none/);
    expect(body).toMatch(/\.btn:disabled[\s\S]*?opacity:\s*0\.5/);
  });

  it("shimmers the primary CTA via background-position transition", async () => {
    const body = await fetchLayoutHtml();
    // Primary button declares background-size 200% so the position
    // animation has somewhere to travel.
    expect(body).toMatch(/\.btn-primary\b[\s\S]*?background-size:\s*200%/);
    // The transition lists background-position with the 600ms duration.
    expect(body).toMatch(
      /\.btn-primary\b[\s\S]*?transition:[\s\S]*?background-position\s+600ms/
    );
  });
});

describe("Block U4 — view transitions", () => {
  it("includes the @view-transition opt-in", async () => {
    const body = await fetchLayoutHtml();
    expect(body).toContain("@view-transition");
    expect(body).toMatch(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/);
  });

  it("declares both fade-out and fade-in keyframes for ::view-transition-*", async () => {
    const body = await fetchLayoutHtml();
    expect(body).toContain("::view-transition-old(root)");
    expect(body).toContain("::view-transition-new(root)");
    expect(body).toContain("@keyframes vt-fade-out");
    expect(body).toContain("@keyframes vt-fade-in");
  });

  it("disables the transition under prefers-reduced-motion", async () => {
    const body = await fetchLayoutHtml();
    // The reduced-motion block must mention the view-transition
    // pseudos and set animation-duration: 0s.
    expect(body).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?::view-transition-(old|new)\(root\)[\s\S]*?animation-duration:\s*0s/
    );
  });

  it("attaches view-transition-name: root to body", async () => {
    const body = await fetchLayoutHtml();
    expect(body).toMatch(/\bbody\b\s*\{[^}]*view-transition-name:\s*root/);
  });
});
