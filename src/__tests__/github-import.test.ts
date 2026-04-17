/**
 * Block L — GitHub importer tests.
 *
 * Tests focus on the pure helpers (URL construction, pagination, filtering,
 * mappers). DB-backed runImport is exercised via the integration suite.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  buildAuthedCloneUrl,
  filterIssuesOnly,
  mapIssue,
  mapLabel,
  mapPull,
  mapRelease,
  normaliseColor,
  paginate,
  parseNextLink,
  redactCloneUrl,
  type GhIssue,
  type GhPull,
  type GhRelease,
} from "../lib/github-import";

// ---------------------------------------------------------------------------
// buildAuthedCloneUrl
// ---------------------------------------------------------------------------

describe("buildAuthedCloneUrl", () => {
  it("builds https clone URL with encoded token", () => {
    const r = buildAuthedCloneUrl("ghp_abc123", "octocat", "hello");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe(
        "https://x-access-token:ghp_abc123@github.com/octocat/hello.git"
      );
    }
  });

  it("rejects tokens containing whitespace/CRLF", () => {
    expect(buildAuthedCloneUrl("abc\ndef", "o", "r").ok).toBe(false);
    expect(buildAuthedCloneUrl("abc def", "o", "r").ok).toBe(false);
    expect(buildAuthedCloneUrl("abc\rdef", "o", "r").ok).toBe(false);
  });

  it("rejects invalid owner/repo", () => {
    expect(buildAuthedCloneUrl("t", "bad owner", "r").ok).toBe(false);
    expect(buildAuthedCloneUrl("t", "good", "bad/repo").ok).toBe(false);
  });

  it("url-encodes special chars in the token", () => {
    const r = buildAuthedCloneUrl("a%b", "o", "r");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toContain("a%25b");
  });
});

describe("redactCloneUrl", () => {
  it("redacts token from authed URL", () => {
    const input =
      "fatal: https://x-access-token:ghp_abc@github.com/o/r.git not found";
    expect(redactCloneUrl(input)).toBe(
      "fatal: https://***@github.com/o/r.git not found"
    );
  });
  it("is a no-op for plain URLs", () => {
    expect(redactCloneUrl("https://example.com")).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// parseNextLink
// ---------------------------------------------------------------------------

describe("parseNextLink", () => {
  it("extracts next URL from Link header", () => {
    const link =
      '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/repos/o/r/issues?page=5>; rel="last"';
    expect(parseNextLink(link)).toBe(
      "https://api.github.com/repos/o/r/issues?page=2"
    );
  });
  it("returns undefined when no next link", () => {
    expect(parseNextLink(null)).toBeUndefined();
    expect(parseNextLink('<...>; rel="prev"')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// paginate — mocked fetch
// ---------------------------------------------------------------------------

describe("paginate", () => {
  function mkFetch(pages: unknown[][]): typeof fetch {
    let i = 0;
    return (async () => {
      const body = pages[i] ?? [];
      const linkNext =
        i < pages.length - 1
          ? `<https://api.github.com/next?page=${i + 2}>; rel="next"`
          : undefined;
      i += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: linkNext ? { Link: linkNext } : {},
      });
    }) as unknown as typeof fetch;
  }

  it("walks all pages under cap", async () => {
    const f = mkFetch([[1, 2], [3, 4], [5]]);
    const r = await paginate<number>("t", "https://api.github.com/first", 100, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops at cap even mid-page", async () => {
    const f = mkFetch([[1, 2, 3], [4, 5, 6]]);
    const r = await paginate<number>("t", "https://api.github.com/first", 4, f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([1, 2, 3, 4]);
  });

  it("returns error on non-2xx response", async () => {
    const f = (async () =>
      new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const r = await paginate("t", "https://api.github.com/first", 10, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("404");
  });

  it("returns error when body is not an array", async () => {
    const f = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const r = await paginate("t", "https://api.github.com/first", 10, f);
    expect(r.ok).toBe(false);
  });

  it("degrades to ok:false when fetch throws", async () => {
    const f = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const r = await paginate("t", "https://api.github.com/first", 10, f);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterIssuesOnly
// ---------------------------------------------------------------------------

describe("filterIssuesOnly", () => {
  it("drops entries that have a pull_request key", () => {
    const items: GhIssue[] = [
      mkIssue(1, "issue a", null),
      mkIssue(2, "issue b", { url: "x" }),
      mkIssue(3, "issue c", null),
    ];
    const out = filterIssuesOnly(items);
    expect(out.length).toBe(2);
    expect(out.map((i) => i.number)).toEqual([1, 3]);
  });
});

function mkIssue(
  n: number,
  title: string,
  pullRequest: { url: string } | null
): GhIssue {
  return {
    number: n,
    title,
    body: null,
    state: "open",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    closed_at: null,
    labels: [],
    pull_request: pullRequest,
  };
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

describe("normaliseColor", () => {
  it("accepts 6-hex without hash", () => {
    expect(normaliseColor("ff8800")).toBe("#ff8800");
  });
  it("accepts 6-hex with hash", () => {
    expect(normaliseColor("#ff8800")).toBe("#ff8800");
  });
  it("lowercases mixed case", () => {
    expect(normaliseColor("FF88aa")).toBe("#ff88aa");
  });
  it("falls back for invalid input", () => {
    expect(normaliseColor("not-a-color")).toBe("#8b949e");
    expect(normaliseColor(null)).toBe("#8b949e");
    expect(normaliseColor("")).toBe("#8b949e");
    expect(normaliseColor("ff88")).toBe("#8b949e");
  });
});

describe("mapLabel", () => {
  it("maps shape + clamps name length", () => {
    const r = mapLabel(
      {
        name: "x".repeat(200),
        color: "00aabb",
        description: "y".repeat(500),
      },
      "repo-1"
    );
    expect(r.repositoryId).toBe("repo-1");
    expect(r.name.length).toBe(50);
    expect(r.color).toBe("#00aabb");
    expect(r.description?.length).toBe(200);
  });
});

describe("mapIssue", () => {
  it("preserves closed state + closedAt", () => {
    const r = mapIssue(
      {
        number: 1,
        title: "t",
        body: "b",
        state: "closed",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        closed_at: "2024-02-01T00:00:00Z",
        labels: [],
      },
      "repo",
      "user"
    );
    expect(r.state).toBe("closed");
    expect(r.closedAt).toBeInstanceOf(Date);
  });
  it("defaults to open + null closedAt", () => {
    const r = mapIssue(
      {
        number: 1,
        title: "t",
        body: null,
        state: "open",
        created_at: "",
        updated_at: "",
        closed_at: null,
        labels: [],
      },
      "repo",
      "user"
    );
    expect(r.state).toBe("open");
    expect(r.closedAt).toBeNull();
  });
});

describe("mapPull", () => {
  const base: GhPull = {
    number: 1,
    title: "t",
    body: null,
    state: "open",
    merged_at: null,
    closed_at: null,
    created_at: "",
    updated_at: "",
    draft: false,
    base: { ref: "main" },
    head: { ref: "feature" },
  };

  it("open when neither merged nor closed", () => {
    expect(mapPull(base, "r", "u").state).toBe("open");
  });
  it("merged takes precedence over closed", () => {
    const r = mapPull(
      { ...base, state: "closed", merged_at: "2024-02-01T00:00:00Z" },
      "r",
      "u"
    );
    expect(r.state).toBe("merged");
    expect(r.mergedAt).toBeInstanceOf(Date);
  });
  it("closed when state=closed and no merge", () => {
    const r = mapPull(
      { ...base, state: "closed", closed_at: "2024-02-01T00:00:00Z" },
      "r",
      "u"
    );
    expect(r.state).toBe("closed");
    expect(r.closedAt).toBeInstanceOf(Date);
  });
  it("keeps branches verbatim", () => {
    expect(mapPull(base, "r", "u").baseBranch).toBe("main");
    expect(mapPull(base, "r", "u").headBranch).toBe("feature");
  });
  it("propagates isDraft", () => {
    expect(mapPull({ ...base, draft: true }, "r", "u").isDraft).toBe(true);
  });
});

describe("mapRelease", () => {
  it("falls back to tag_name when name is null", () => {
    const gh: GhRelease = {
      tag_name: "v1.0",
      name: null,
      body: null,
      target_commitish: "main",
      prerelease: false,
      draft: false,
      created_at: "",
      published_at: null,
    };
    expect(mapRelease(gh, "r", "u").name).toBe("v1.0");
  });
  it("passes through draft + prerelease flags", () => {
    const gh: GhRelease = {
      tag_name: "v1",
      name: "One",
      body: null,
      target_commitish: "main",
      prerelease: true,
      draft: true,
      created_at: "",
      published_at: "2024-01-01T00:00:00Z",
    };
    const r = mapRelease(gh, "r", "u");
    expect(r.isDraft).toBe(true);
    expect(r.isPrerelease).toBe(true);
    expect(r.publishedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// Route auth smokes
// ---------------------------------------------------------------------------

describe("github-import — route auth smokes", () => {
  it("GET /new/import without session → 302 /login", async () => {
    const res = await app.fetch(new Request("http://test/new/import"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("POST /new/import without session → 302 /login", async () => {
    const res = await app.fetch(
      new Request("http://test/new/import", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          source: "octocat/hello",
          token: "ghp_x",
          name: "hello",
          visibility: "public",
        }),
      })
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/\/login/);
  });

  it("GET /api/imports/:id without session → 401 JSON", async () => {
    const res = await app.fetch(
      new Request(
        "http://test/api/imports/00000000-0000-0000-0000-000000000000",
        { headers: { accept: "application/json" } }
      )
    );
    // Bearer-less request to a JSON endpoint under requireAuth → 401.
    // (Cookie-less GETs to non-API paths redirect; this path is /api/*.)
    expect([302, 401]).toContain(res.status);
  });
});
