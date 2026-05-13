/**
 * Block L5 — Gluecron vs GitHub marketing page tests.
 *
 * Covers:
 *   - `GET /vs-github` returns 200 HTML, no auth required (anon request OK)
 *   - HTML mentions "GitHub" and "Gluecron" (sanity)
 *   - HTML contains the key AI-native rows from category 1
 *   - CTA points at /import
 *   - The existing /:owner/:repo/compare/* branch-diff route is untouched
 */

import { describe, it, expect } from "bun:test";
import app from "../app";

describe("vs-github — public marketing page", () => {
  it("GET /vs-github returns 200 HTML to an anonymous visitor", async () => {
    const res = await app.request("/vs-github");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    expect(ct.toLowerCase()).toContain("text/html");
  });

  it("mentions both GitHub and Gluecron (sanity)", async () => {
    const res = await app.request("/vs-github");
    const body = await res.text();
    // Brand names in the hero / table.
    expect(body).toContain("GitHub");
    // The brand can appear in either case in different visual contexts
    // (logo span uses lowercase "gluecron", body copy uses "Gluecron").
    expect(body.toLowerCase()).toContain("gluecron");
  });

  it("renders the AI-native workflow rows from category 1", async () => {
    const res = await app.request("/vs-github");
    const body = await res.text();
    // Category header
    expect(body).toContain("AI-native workflow");
    // A representative sample of rows that must be present
    expect(body).toContain("AI code review on every PR");
    expect(body).toContain("AI auto-merge when checks pass");
    expect(body).toContain("Spec → PR pipeline");
    expect(body).toContain("Label-an-issue");
    expect(body).toContain("AI explain-this-codebase");
    expect(body).toContain("AI changelog per commit range");
    expect(body).toContain("AI incident responder");
    expect(body).toContain("AI dependency updater");
    expect(body).toContain("AI security scan on every push");
    expect(body).toContain("AI Sleep Mode");
  });

  it("CTA points at /import", async () => {
    const res = await app.request("/vs-github");
    const body = await res.text();
    expect(body).toContain('href="/import"');
    // Killer-move banner also links to /sleep-mode.
    expect(body).toContain('href="/sleep-mode"');
  });

  it("does not require authentication (no redirect)", async () => {
    const res = await app.request("/vs-github");
    // Must not 30x to /login or anywhere else.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(302);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("does NOT clobber the existing /:owner/:repo/compare branch-diff route", async () => {
    // The legacy compare route at /:owner/:repo/compare/* is locked.
    // We aren't asserting its exact behaviour here — only that requesting a
    // path that matches the legacy pattern does NOT resolve to the new
    // marketing page. The page-id we look for is in the marketing route only.
    const res = await app.request("/some-owner/some-repo/compare/main...feature");
    const body = await res.text();
    // The marketing route's hero subtitle should not appear on the legacy
    // compare path even if it 404s.
    expect(body).not.toContain("The git host built around Claude.");
  });
});
