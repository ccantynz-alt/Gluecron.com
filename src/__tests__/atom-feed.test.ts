/**
 * Block J19 — Atom feed renderer. Pure XML + route smokes.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  escapeXml,
  toIsoUtc,
  renderAtomFeed,
  ATOM_CONTENT_TYPE,
  __internal,
  type AtomEntry,
} from "../lib/atom-feed";

describe("atom-feed — escapeXml", () => {
  it("escapes the five XML metacharacters", () => {
    expect(escapeXml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(escapeXml(`"single'`)).toBe("&quot;single&apos;");
  });

  it("returns '' for empty / falsy input", () => {
    expect(escapeXml("")).toBe("");
  });

  it("idempotent escape of already-escaped text", () => {
    // Double-escaping is expected — this is a serialiser, not a re-encoder.
    // We just need it not to throw or drop content.
    const once = escapeXml("&");
    const twice = escapeXml(once);
    expect(twice).toBe("&amp;amp;");
  });
});

describe("atom-feed — toIsoUtc", () => {
  it("converts valid ISO strings to ISO-UTC", () => {
    const out = toIsoUtc("2026-04-15T12:00:00Z");
    expect(out).toBe("2026-04-15T12:00:00.000Z");
  });

  it("accepts Date instances", () => {
    const out = toIsoUtc(new Date("2026-04-15T12:00:00Z"));
    expect(out).toBe("2026-04-15T12:00:00.000Z");
  });

  it("falls back to epoch on garbage", () => {
    expect(toIsoUtc("not-a-date")).toBe("1970-01-01T00:00:00.000Z");
    expect(toIsoUtc(null)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIsoUtc(undefined)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIsoUtc("")).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("atom-feed — renderAtomFeed", () => {
  const entry: AtomEntry = {
    id: "tag:gluecron,2026:alice/repo/commit/abc",
    title: "Fix bug",
    href: "https://gluecron.com/alice/repo/commit/abc",
    updatedAt: "2026-04-15T12:00:00Z",
    summary: "Fix a bug",
    author: { name: "Alice", email: "a@x" },
  };

  it("prefixes with the XML declaration + feed root", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test",
      selfHref: "https://gluecron.com/feed",
      entries: [],
    });
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(
      true
    );
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml.trim().endsWith("</feed>")).toBe(true);
  });

  it("emits required feed-level elements", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test Feed",
      subtitle: "Sub",
      selfHref: "https://g.c/feed",
      alternateHref: "https://g.c/",
      entries: [],
    });
    expect(xml).toContain("<id>tag:feed</id>");
    expect(xml).toContain("<title>Test Feed</title>");
    expect(xml).toContain("<subtitle>Sub</subtitle>");
    expect(xml).toContain('<link rel="self" href="https://g.c/feed"/>');
    expect(xml).toContain('<link rel="alternate" href="https://g.c/"/>');
    expect(xml).toMatch(/<updated>.+<\/updated>/);
  });

  it("renders entry title, id, link, updated, published, author, summary", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test",
      selfHref: "https://g.c/feed",
      entries: [entry],
    });
    expect(xml).toContain("<entry>");
    expect(xml).toContain("</entry>");
    expect(xml).toContain(`<id>${entry.id}</id>`);
    expect(xml).toContain(`<title>${entry.title}</title>`);
    expect(xml).toContain(`<link rel="alternate" href="${entry.href}"/>`);
    expect(xml).toContain("<updated>2026-04-15T12:00:00.000Z</updated>");
    expect(xml).toContain("<published>2026-04-15T12:00:00.000Z</published>");
    expect(xml).toContain("<name>Alice</name>");
    expect(xml).toContain("<email>a@x</email>");
    expect(xml).toContain('<summary type="text">Fix a bug</summary>');
  });

  it("escapes entry text fields", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test & Ampersand",
      selfHref: "https://g.c/feed?x=1&y=2",
      entries: [
        {
          id: "tag:e",
          title: "<script>bad</script>",
          href: "https://g.c/x?a=1&b=2",
          updatedAt: "2026-04-15T12:00:00Z",
          summary: 'She said "hi"',
        },
      ],
    });
    expect(xml).toContain("Test &amp; Ampersand");
    expect(xml).toContain("x=1&amp;y=2");
    expect(xml).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(xml).toContain("&quot;hi&quot;");
    // Must not contain the raw unescaped forms.
    expect(xml).not.toContain("<script>bad</script>");
  });

  it("picks feed updated from the newest entry when not set explicitly", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test",
      selfHref: "https://g.c/feed",
      entries: [
        { id: "a", title: "A", href: "h", updatedAt: "2026-04-10T00:00:00Z" },
        { id: "b", title: "B", href: "h", updatedAt: "2026-04-14T00:00:00Z" },
        { id: "c", title: "C", href: "h", updatedAt: "2026-04-12T00:00:00Z" },
      ],
    });
    // The feed `<updated>` should pick the newest entry (Apr 14)
    expect(xml).toContain("<updated>2026-04-14T00:00:00.000Z</updated>");
  });

  it("respects explicit feed updatedAt", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test",
      selfHref: "https://g.c/feed",
      updatedAt: "2026-01-01T00:00:00Z",
      entries: [
        { id: "a", title: "A", href: "h", updatedAt: "2026-04-14T00:00:00Z" },
      ],
    });
    expect(xml).toContain("<updated>2026-01-01T00:00:00.000Z</updated>");
  });

  it("produces a well-formed document even with zero entries", () => {
    const xml = renderAtomFeed({
      id: "tag:empty",
      title: "Empty",
      selfHref: "https://g.c/empty.atom",
      entries: [],
    });
    expect(xml).toContain("<id>tag:empty</id>");
    expect(xml).not.toContain("<entry>");
  });

  it("falls back to (untitled) when a title is empty", () => {
    const xml = renderAtomFeed({
      id: "tag:feed",
      title: "Test",
      selfHref: "https://g.c/feed",
      entries: [
        { id: "a", title: "", href: "h", updatedAt: "2026-04-14T00:00:00Z" },
      ],
    });
    expect(xml).toContain("<title>(untitled)</title>");
  });
});

describe("atom-feed — ATOM_CONTENT_TYPE", () => {
  it("is the canonical Atom mime with charset", () => {
    expect(ATOM_CONTENT_TYPE).toBe("application/atom+xml; charset=utf-8");
  });
});

describe("atom-feed — __internal", () => {
  it("re-exports the helpers for parity", () => {
    expect(__internal.escapeXml).toBe(escapeXml);
    expect(__internal.toIsoUtc).toBe(toIsoUtc);
    expect(__internal.renderAtomFeed).toBe(renderAtomFeed);
    expect(__internal.ATOM_CONTENT_TYPE).toBe(ATOM_CONTENT_TYPE);
  });
});

describe("atom-feed — routes", () => {
  it("GET /:o/:r/commits.atom returns 200 with Atom content-type", async () => {
    const res = await app.request("/alice/nope/commits.atom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ATOM_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
  });

  it("GET /:o/:r/releases.atom returns 200 Atom", async () => {
    const res = await app.request("/alice/nope/releases.atom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ATOM_CONTENT_TYPE);
  });

  it("GET /:o/:r/issues.atom returns 200 Atom", async () => {
    const res = await app.request("/alice/nope/issues.atom");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ATOM_CONTENT_TYPE);
  });

  it("cache headers set for feed reader friendliness", async () => {
    const res = await app.request("/alice/nope/commits.atom");
    const cc = res.headers.get("cache-control") || "";
    expect(cc).toContain("max-age");
    expect(cc).toContain("stale-while-revalidate");
  });
});
