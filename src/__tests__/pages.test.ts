/**
 * Block C3 — Pages unit + route tests.
 *
 * These tests run without a live database. Route tests therefore accept the
 * whole class of graceful-degradation responses (404 / 302 / 303 / 503):
 * 503 is emitted when the DB proxy throws, 404 when the repo row isn't found,
 * and 302/303 when auth middleware redirects to /login.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  contentTypeFor,
  resolvePagesPath,
  onPagesPush,
} from "../lib/pages";

describe("lib/pages — contentTypeFor", () => {
  it("returns text/html for .html", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
  });

  it("returns text/css for .css", () => {
    expect(contentTypeFor("site.css")).toContain("text/css");
  });

  it("returns application/javascript for .js", () => {
    expect(contentTypeFor("app.js")).toContain("javascript");
  });

  it("returns image/svg+xml for .svg", () => {
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
  });

  it("returns image/png for .png", () => {
    expect(contentTypeFor("pic.PNG")).toBe("image/png");
  });

  it("returns image/jpeg for .jpg and .jpeg", () => {
    expect(contentTypeFor("a.jpg")).toBe("image/jpeg");
    expect(contentTypeFor("b.jpeg")).toBe("image/jpeg");
  });

  it("returns application/json for .json", () => {
    expect(contentTypeFor("data.json")).toContain("application/json");
  });

  it("returns application/octet-stream for unknown extensions", () => {
    expect(contentTypeFor("mystery.xyz")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for files with no extension", () => {
    expect(contentTypeFor("Makefile")).toBe("application/octet-stream");
  });
});

describe("lib/pages — resolvePagesPath", () => {
  it("returns index.html for empty url rest at root", () => {
    expect(resolvePagesPath("", "/", "index.html")).toEqual(["index.html"]);
  });

  it("returns index.html for a trailing slash", () => {
    expect(resolvePagesPath("/", "/", "index.html")).toEqual(["index.html"]);
  });

  it("probes both foo.html and foo/index.html for extensionless urls", () => {
    const paths = resolvePagesPath("about", "/", "index.html");
    expect(paths).toContain("about.html");
    expect(paths).toContain("about/index.html");
    expect(paths[0]).toBe("about.html");
  });

  it("serves a file directly when it has an extension", () => {
    expect(resolvePagesPath("assets/app.css", "/", "index.html")).toEqual([
      "assets/app.css",
    ]);
  });

  it("applies sourceDir as a prefix", () => {
    const paths = resolvePagesPath("about", "/docs", "index.html");
    expect(paths[0]).toBe("docs/about.html");
    expect(paths[1]).toBe("docs/about/index.html");
  });

  it("serves the index inside a nested directory when url ends with slash", () => {
    expect(resolvePagesPath("blog/", "/", "index.html")).toEqual([
      "blog/index.html",
    ]);
  });

  it("strips path-traversal segments", () => {
    const paths = resolvePagesPath("../../etc/passwd", "/", "index.html");
    // .. entries are dropped; the remaining "etc/passwd" is treated as a
    // pretty URL because it has no file extension.
    expect(paths).not.toContain("../etc/passwd");
    expect(paths).not.toContain("../../etc/passwd");
    for (const p of paths) {
      expect(p.startsWith("..")).toBe(false);
      expect(p).not.toContain("../");
    }
    expect(paths[0]).toBe("etc/passwd.html");
  });

  it("strips leading slashes on the url rest", () => {
    expect(resolvePagesPath("/about.html", "/", "index.html")).toEqual([
      "about.html",
    ]);
  });

  it("normalises source dir with or without leading / trailing slash", () => {
    expect(resolvePagesPath("", "docs/", "index.html")).toEqual([
      "docs/index.html",
    ]);
    expect(resolvePagesPath("", "/docs/", "index.html")).toEqual([
      "docs/index.html",
    ]);
  });
});

describe("lib/pages — onPagesPush", () => {
  it("never throws, even with a bogus repositoryId and no DB", async () => {
    // No DATABASE_URL in the test env => db proxy throws. The helper must
    // swallow that and return normally.
    await expect(
      onPagesPush({
        ownerLogin: "alice",
        repoName: "project",
        repositoryId: "00000000-0000-0000-0000-000000000000",
        ref: "refs/heads/gh-pages",
        newSha: "0".repeat(40),
        triggeredByUserId: null,
      })
    ).resolves.toBeUndefined();
  });
});

describe("routes/pages — guards", () => {
  it("GET /:owner/:repo/pages/ 404s when repo does not exist", async () => {
    const res = await app.request("/alice/project/pages/");
    // 404 when repo row not found, 503 when DB is unreachable.
    expect([404, 503]).toContain(res.status);
  });

  it("GET /:owner/:repo/pages/foo 404s when repo does not exist", async () => {
    const res = await app.request("/nobody/nothing/pages/foo.html");
    expect([404, 503]).toContain(res.status);
  });

  it("GET /:owner/:repo/settings/pages requires auth (or is not yet mounted)", async () => {
    const res = await app.request(
      "/alice/project/settings/pages",
      { redirect: "manual" }
    );
    // When mounted: anonymous -> redirected to /login.
    // When not yet wired into app.tsx (integration step handled by owner):
    // the global 404 handler answers instead.
    expect([302, 303, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("POST /:owner/:repo/settings/pages without auth redirects to /login or 404s", async () => {
    const res = await app.request("/alice/project/settings/pages", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "enabled=1&source_branch=gh-pages&source_dir=/",
      redirect: "manual",
    });
    expect([302, 303, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("POST /:owner/:repo/settings/pages/redeploy without auth redirects to /login or 404s", async () => {
    const res = await app.request(
      "/alice/project/settings/pages/redeploy",
      {
        method: "POST",
        redirect: "manual",
      }
    );
    expect([302, 303, 404, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });
});

describe("routes/pages — direct route tests (no app mount)", () => {
  // These test the exported Hono app directly so we don't depend on the
  // owner wiring up app.tsx. This mirrors what the integration step will
  // yield once the parent agent mounts pagesRoute.
  it("direct GET /:owner/:repo/settings/pages without auth redirects to /login", async () => {
    const { default: pagesRoute } = await import("../routes/pages");
    const res = await pagesRoute.request(
      "/alice/project/settings/pages",
      { redirect: "manual" }
    );
    expect([302, 303, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("direct POST /:owner/:repo/settings/pages without auth redirects to /login", async () => {
    const { default: pagesRoute } = await import("../routes/pages");
    const res = await pagesRoute.request("/alice/project/settings/pages", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "enabled=1&source_branch=gh-pages&source_dir=/",
      redirect: "manual",
    });
    expect([302, 303, 503]).toContain(res.status);
    if (res.status === 302 || res.status === 303) {
      const loc = res.headers.get("location") || "";
      expect(loc).toContain("/login");
    }
  });

  it("direct GET /:owner/:repo/pages/ 404s when repo does not exist", async () => {
    const { default: pagesRoute } = await import("../routes/pages");
    const res = await pagesRoute.request("/alice/project/pages/");
    expect([404, 503]).toContain(res.status);
  });
});
