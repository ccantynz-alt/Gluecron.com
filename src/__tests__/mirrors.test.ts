/**
 * Block I9 — Repository mirroring tests.
 *
 * Pure validation tests for URL safety + auth smoke on mirror routes.
 * Actual git fetch is exercised by the live server — `runMirrorSync` is
 * not tested here because it needs a real upstream.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { validateUpstreamUrl, safeUrlForLog } from "../lib/mirrors";

describe("mirrors — validateUpstreamUrl", () => {
  it("accepts https URLs", () => {
    expect(validateUpstreamUrl("https://github.com/foo/bar.git").ok).toBe(true);
  });

  it("accepts http URLs", () => {
    expect(validateUpstreamUrl("http://git.example.com/x.git").ok).toBe(true);
  });

  it("accepts git:// URLs", () => {
    expect(validateUpstreamUrl("git://kernel.org/linux.git").ok).toBe(true);
  });

  it("rejects ssh URLs", () => {
    const r = validateUpstreamUrl("ssh://git@github.com/foo/bar.git");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https|http|git/);
  });

  it("rejects file:// URLs", () => {
    const r = validateUpstreamUrl("file:///tmp/evil.git");
    expect(r.ok).toBe(false);
  });

  it("rejects local paths", () => {
    expect(validateUpstreamUrl("/etc/passwd").ok).toBe(false);
    expect(validateUpstreamUrl("./foo.git").ok).toBe(false);
  });

  it("rejects URLs with shell metacharacters", () => {
    expect(validateUpstreamUrl("https://evil;rm -rf /").ok).toBe(false);
    expect(validateUpstreamUrl("https://evil`id`").ok).toBe(false);
    expect(validateUpstreamUrl("https://evil$(whoami)").ok).toBe(false);
    expect(validateUpstreamUrl("https://evil|nc 1.2.3.4 9").ok).toBe(false);
    expect(validateUpstreamUrl("https://evil<payload").ok).toBe(false);
  });

  it("rejects empty or whitespace-only URLs", () => {
    expect(validateUpstreamUrl("").ok).toBe(false);
    expect(validateUpstreamUrl("   ").ok).toBe(false);
  });

  it("rejects URLs over 2048 chars", () => {
    const long = "https://example.com/" + "a".repeat(2100);
    expect(validateUpstreamUrl(long).ok).toBe(false);
  });
});

describe("mirrors — safeUrlForLog", () => {
  it("passes plain URLs through", () => {
    expect(safeUrlForLog("https://github.com/foo/bar.git")).toBe(
      "https://github.com/foo/bar.git"
    );
  });

  it("redacts embedded credentials", () => {
    const redacted = safeUrlForLog("https://user:pw@github.com/foo/bar.git");
    expect(redacted).not.toContain("user:pw");
    expect(redacted).not.toContain("pw");
    expect(redacted).toContain("***");
    expect(redacted).toContain("github.com");
  });

  it("returns original on unparseable input", () => {
    expect(safeUrlForLog("not-a-url")).toBe("not-a-url");
  });
});

describe("mirrors — route auth", () => {
  it("GET /:owner/:repo/settings/mirror without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/mirror");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /:owner/:repo/settings/mirror without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/mirror", {
      method: "POST",
      body: new URLSearchParams({ upstream_url: "https://example.com/x.git" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /:owner/:repo/settings/mirror/sync without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/mirror/sync", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /:owner/:repo/settings/mirror/delete without auth → 302 /login", async () => {
    const res = await app.request("/alice/repo/settings/mirror/delete", {
      method: "POST",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("POST /admin/mirrors/sync-all without auth → 302 /login", async () => {
    const res = await app.request("/admin/mirrors/sync-all", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});
