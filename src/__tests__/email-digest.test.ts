/**
 * Block I7 — Weekly email digest tests.
 *
 * Pure helper coverage for textToHtml / escapeHtml / fmtRange, plus route auth
 * smoke on /settings/digest/preview and the admin trigger endpoints. DB-backed
 * calls (composeDigest / sendDigestForUser / sendDigestsToAll) are exercised
 * against the live server.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { __internal } from "../lib/email-digest";

const { textToHtml, escapeHtml, fmtRange } = __internal;

describe("email-digest — escapeHtml", () => {
  it("escapes <, >, & and quotes", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(
      `&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;`
    );
  });

  it("leaves plain text alone", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("email-digest — fmtRange", () => {
  it("returns a single date when from === to (by day)", () => {
    const d = new Date("2025-06-01T00:00:00Z");
    expect(fmtRange(d, d)).toBe("2025-06-01");
  });

  it("joins distinct dates with arrow", () => {
    const a = new Date("2025-06-01T00:00:00Z");
    const b = new Date("2025-06-08T00:00:00Z");
    const out = fmtRange(a, b);
    expect(out).toContain("2025-06-01");
    expect(out).toContain("2025-06-08");
    expect(out).toContain("\u2192");
  });
});

describe("email-digest — textToHtml", () => {
  it("wraps H2 headings and list items", () => {
    const html = textToHtml("## Section\n- item 1", "https://gluecron.com");
    expect(html).toContain("<h3");
    expect(html).toContain("Section");
    expect(html).toContain("<li>item 1</li>");
  });

  it("renders <hr> for --- separator", () => {
    const html = textToHtml("hello\n---\nfooter", "https://gluecron.com");
    expect(html).toContain("<hr");
  });

  it("escapes user-controlled text in paragraphs", () => {
    const html = textToHtml("<script>alert(1)</script>", "https://gluecron.com");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes the base URL footer", () => {
    const html = textToHtml("body", "https://gluecron.com");
    expect(html).toContain("https://gluecron.com");
  });
});

describe("email-digest — route auth", () => {
  it("GET /settings/digest/preview without auth → 302 /login", async () => {
    const res = await app.request("/settings/digest/preview");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/digests/run without auth → 302 /login", async () => {
    const res = await app.request("/admin/digests/run", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/digests/preview without auth → 302 /login", async () => {
    const res = await app.request("/admin/digests/preview", {
      method: "POST",
      body: new URLSearchParams({ username: "alice" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("GET /admin/digests without auth → 302 /login", async () => {
    const res = await app.request("/admin/digests");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});

describe("email-digest — settings form", () => {
  it("POST /settings/notifications without auth → 302 /login", async () => {
    const res = await app.request("/settings/notifications", {
      method: "POST",
      body: new URLSearchParams({ notify_email_digest_weekly: "1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});
