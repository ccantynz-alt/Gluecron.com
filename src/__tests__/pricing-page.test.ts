/**
 * Block L8 — public /pricing page tests.
 *
 * Anonymous-safe route. Verifies:
 *   - GET /pricing returns 200 HTML to a logged-out visitor
 *   - All four plan names (Free, Pro, Team, Enterprise) render
 *   - The "what you get on free" block contains the AI features
 *   - All five FAQ questions are present verbatim
 *   - CTA links resolve to /register?next=... or /settings/billing
 *   - The self-host column mentions the curl install line
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { FALLBACK_PLANS } from "../lib/billing";

describe("L8 — /pricing public page", () => {
  it("returns 200 HTML to an anonymous visitor", async () => {
    const res = await app.request("/pricing");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("text/html");
  });

  it("renders all four plan names (Free, Pro, Team, Enterprise)", async () => {
    const res = await app.request("/pricing");
    const body = await res.text();
    // FALLBACK_PLANS guarantees the four names exist regardless of whether
    // the DB seeds are loaded — listPlans() falls back to these.
    for (const slug of Object.keys(FALLBACK_PLANS)) {
      const name = FALLBACK_PLANS[slug].name;
      expect(body).toContain(name);
    }
  });

  it("the free-tier block lists at least 6 of the included AI features", async () => {
    const res = await app.request("/pricing");
    const body = await res.text();
    const features = [
      "Unlimited public repos",
      "AI code review on every PR",
      "AI auto-merge",
      "ai:build label",
      "Sleep Mode digest",
      "AI hours saved counter",
      "MCP server access",
      "Claude Code skill bundle",
      "One-command install",
      "GitHub OIDC sign-in",
    ];
    const present = features.filter((f) => body.includes(f));
    expect(present.length).toBeGreaterThanOrEqual(6);
  });

  it("FAQ contains all five required questions", async () => {
    const res = await app.request("/pricing");
    const body = await res.text();
    expect(body).toContain("Is it really free? What&#39;s the catch?");
    expect(body).toContain(
      "Do I need to bring my own Anthropic API key on the free tier?"
    );
    expect(body).toContain("What happens when I exceed my plan&#39;s quota?");
    expect(body).toContain("Can I migrate from GitHub for free?");
    expect(body).toContain("Does the free tier include private repos?");
  });

  it("CTAs route anonymous users through /register?next=/settings/billing", async () => {
    const res = await app.request("/pricing");
    const body = await res.text();
    // At least one register-funnel CTA must exist.
    expect(body).toMatch(/href="\/register(\?next=\/settings\/billing[^"]*)?"/);
    // And the page must mention /settings/billing somewhere as the
    // destination after sign-up.
    expect(body).toContain("/settings/billing");
  });

  it("self-host column mentions `curl gluecron.com/install`", async () => {
    const res = await app.request("/pricing");
    const body = await res.text();
    expect(body).toContain("curl gluecron.com/install");
  });

  it("does not require authentication (no redirect)", async () => {
    const res = await app.request("/pricing");
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(401);
  });

  it("hero copy reflects the 2026 polish — bundle-math positioning", async () => {
    // 2026-05-16 polish — pricing hero copy rewritten to emphasise the
    // "GitHub bundle math" positioning instead of the original
    // "Free for the AI-curious" line. The new hero leads with "One
    // subscription. Replaces three on GitHub." and the sub-copy lands
    // the $89/user/mo GitHub-stack comparison.
    const res = await app.request("/pricing");
    const body = await res.text();
    expect(body).toContain("One subscription.");
    expect(body).toContain("Replaces three on GitHub.");
    // The "vs GitHub bundle math" comparison block must render.
    expect(body).toContain("Bundle math vs GitHub");
    expect(body).toContain("$89");
  });
});
