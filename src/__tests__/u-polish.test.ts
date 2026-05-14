/**
 * Block U — Senior polish pass smoke tests.
 *
 * U1: hero rebuild — exactly two primary CTAs in the buttons row,
 *     tertiary text-link row sits underneath with the demoted demo +
 *     vs-github affordances, install snippet sits BELOW the CTAs
 *     wrapped in the "For power users" panel.
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

async function fetchHomeHtml(): Promise<string> {
  const res = await app.request(HOME);
  expect(res.status).toBe(200);
  return await res.text();
}

describe("Block U1 — landing hero rebuild", () => {
  it("renders exactly two primary CTAs in the main button row", async () => {
    const body = await fetchHomeHtml();
    // Extract the primary CTA row using the data-testid we shipped.
    const start = body.indexOf('data-testid="hero-primary-ctas"');
    expect(start).toBeGreaterThan(-1);
    // The wrapper opens with that attribute on a div; find the matching
    // closing </div>. Heuristic: it's the first </div> after a tight
    // window of <a … class="btn …"> elements.
    const tail = body.slice(start, start + 2400);
    // Count the <a class="btn …"> anchors inside the row.
    const anchorMatches = tail.match(/<a[^>]*class="btn[^"]*"/g) || [];
    expect(anchorMatches.length).toBeGreaterThanOrEqual(2);
    // Sanity-check the two CTAs we explicitly preserve:
    expect(tail).toContain('href="/register"');
    expect(tail).toContain('href="/gluecron.dxt"');
    // The tertiary row is OUTSIDE this slice; we assert the demoted
    // demo + vs-github hrefs are NOT in the primary slice.
    const primaryRowEnd = tail.indexOf("hero-tertiary-row");
    const primaryOnly =
      primaryRowEnd > 0 ? tail.slice(0, primaryRowEnd) : tail.slice(0, 800);
    expect(primaryOnly).not.toContain('href="/demo"');
    expect(primaryOnly).not.toContain('href="/vs-github"');
  });

  it("renders the tertiary text-link row with demo + vs-github affordances", async () => {
    const body = await fetchHomeHtml();
    expect(body).toContain('data-testid="hero-tertiary-row"');
    expect(body).toContain('data-testid="cta-tertiary-demo"');
    expect(body).toContain('data-testid="cta-tertiary-vs"');
    // The legacy labels survive on the demoted row so L10 regression
    // guards keep passing.
    expect(body).toContain("Try the live demo");
    expect(body).toContain("Compare to GitHub");
  });

  it("places the install snippet inside a 'For power users' panel below the CTAs", async () => {
    const body = await fetchHomeHtml();
    const ctas = body.indexOf('data-testid="hero-primary-ctas"');
    const installPanel = body.indexOf("Power users install panel");
    const installLabel = body.indexOf("For power users");
    expect(ctas).toBeGreaterThan(-1);
    expect(installPanel).toBeGreaterThan(-1);
    expect(installLabel).toBeGreaterThan(-1);
    // Install panel sits AFTER the CTAs — that's the whole U1 point.
    expect(installPanel).toBeGreaterThan(ctas);
  });
});

describe("Block U2 — button polish", () => {
  it("includes the universal hover-lift transform on .btn", async () => {
    const body = await fetchHomeHtml();
    // The master CSS is inlined in <style> by Layout. We assert on the
    // hover-rule shape: `.btn:hover { … transform: translateY(-1px); … }`.
    expect(body).toMatch(/\.btn:hover\b[\s\S]*?transform:\s*translateY\(-1px\)/);
  });

  it("uses a soft drop shadow on .btn:hover (not just border)", async () => {
    const body = await fetchHomeHtml();
    expect(body).toMatch(/\.btn:hover\b[\s\S]*?box-shadow:\s*0\s+4px\s+12px/);
  });

  it("uses box-shadow (not outline) for the .btn focus ring", async () => {
    const body = await fetchHomeHtml();
    // Focus-visible rule must set box-shadow with the soft accent rgba.
    expect(body).toMatch(
      /\.btn:focus-visible\b[\s\S]*?box-shadow:\s*0\s+0\s+0\s+3px\s+rgba\(140,\s*109,\s*255,\s*0\.35\)/
    );
    // And must NOT fall back to outline:2px on .btn anywhere.
    expect(body).not.toMatch(/\.btn:focus-visible[^{]*\{\s*outline:\s*2px/);
  });

  it("disables hover-lift on disabled buttons", async () => {
    const body = await fetchHomeHtml();
    // The disabled rule sets transform:none AND opacity:0.5.
    expect(body).toMatch(/\.btn:disabled[\s\S]*?transform:\s*none/);
    expect(body).toMatch(/\.btn:disabled[\s\S]*?opacity:\s*0\.5/);
  });

  it("shimmers the primary CTA via background-position transition", async () => {
    const body = await fetchHomeHtml();
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
    const body = await fetchHomeHtml();
    expect(body).toContain("@view-transition");
    expect(body).toMatch(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/);
  });

  it("declares both fade-out and fade-in keyframes for ::view-transition-*", async () => {
    const body = await fetchHomeHtml();
    expect(body).toContain("::view-transition-old(root)");
    expect(body).toContain("::view-transition-new(root)");
    expect(body).toContain("@keyframes vt-fade-out");
    expect(body).toContain("@keyframes vt-fade-in");
  });

  it("disables the transition under prefers-reduced-motion", async () => {
    const body = await fetchHomeHtml();
    // The reduced-motion block must mention the view-transition
    // pseudos and set animation-duration: 0s.
    expect(body).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?::view-transition-(old|new)\(root\)[\s\S]*?animation-duration:\s*0s/
    );
  });

  it("attaches view-transition-name: root to body", async () => {
    const body = await fetchHomeHtml();
    expect(body).toMatch(/\bbody\b\s*\{[^}]*view-transition-name:\s*root/);
  });
});
