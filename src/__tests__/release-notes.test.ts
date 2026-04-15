/**
 * Block J15 — Release-notes generator. Pure helpers + route-auth smoke.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  classifyCommit,
  groupCommits,
  contributorsFrom,
  renderNotesMarkdown,
  BUCKET_ORDER,
  __internal,
} from "../lib/release-notes";

describe("release-notes — classifyCommit", () => {
  it("recognises feat / fix / perf / refactor / docs / chore / revert prefixes", () => {
    expect(classifyCommit({ sha: "a", message: "feat: thing" }).bucket).toBe(
      "features"
    );
    expect(classifyCommit({ sha: "b", message: "fix: thing" }).bucket).toBe(
      "fixes"
    );
    expect(classifyCommit({ sha: "c", message: "perf: thing" }).bucket).toBe(
      "perf"
    );
    expect(classifyCommit({ sha: "d", message: "refactor: thing" }).bucket).toBe(
      "refactor"
    );
    expect(classifyCommit({ sha: "e", message: "docs: thing" }).bucket).toBe(
      "docs"
    );
    expect(classifyCommit({ sha: "f", message: "chore: thing" }).bucket).toBe(
      "chore"
    );
    expect(classifyCommit({ sha: "g", message: "revert: thing" }).bucket).toBe(
      "revert"
    );
  });

  it("treats aliases (feature, bugfix, doc) as canonical", () => {
    expect(classifyCommit({ sha: "a", message: "feature: x" }).bucket).toBe(
      "features"
    );
    expect(classifyCommit({ sha: "b", message: "bugfix: x" }).bucket).toBe(
      "fixes"
    );
    expect(classifyCommit({ sha: "c", message: "doc: x" }).bucket).toBe("docs");
    expect(classifyCommit({ sha: "d", message: "tests: x" }).bucket).toBe("test");
  });

  it("is case-insensitive on the prefix", () => {
    expect(classifyCommit({ sha: "a", message: "Feat: x" }).bucket).toBe(
      "features"
    );
    expect(classifyCommit({ sha: "b", message: "FIX: x" }).bucket).toBe("fixes");
  });

  it("extracts scope from feat(scope): ...", () => {
    const c = classifyCommit({ sha: "a", message: "feat(api): add endpoint" });
    expect(c.bucket).toBe("features");
    expect(c.scope).toBe("api");
    expect(c.subject).toBe("add endpoint");
  });

  it("flags breaking with the `!` marker", () => {
    const c = classifyCommit({ sha: "a", message: "feat(api)!: drop v1" });
    expect(c.isBreaking).toBe(true);
    expect(c.scope).toBe("api");
  });

  it("flags breaking with BREAKING CHANGE in subject", () => {
    expect(
      classifyCommit({ sha: "a", message: "feat: drop v1 BREAKING CHANGE" })
        .isBreaking
    ).toBe(true);
  });

  it("captures trailing (#NNN) PR number", () => {
    const c = classifyCommit({
      sha: "a",
      message: "fix: off-by-one (#123)",
    });
    expect(c.prNumber).toBe(123);
    expect(c.subject).toBe("off-by-one");
  });

  it("parses Merge pull request #N commits into merges bucket", () => {
    const c = classifyCommit({
      sha: "a",
      message: "Merge pull request #42 from user/branch",
    });
    expect(c.bucket).toBe("merges");
    expect(c.prNumber).toBe(42);
  });

  it("parses Merge branch commits into merges bucket", () => {
    const c = classifyCommit({
      sha: "a",
      message: "Merge branch 'main' into feature",
    });
    expect(c.bucket).toBe("merges");
    expect(c.prNumber).toBeNull();
  });

  it("falls back to 'other' for non-conventional subjects", () => {
    expect(
      classifyCommit({ sha: "a", message: "fix the thing that broke" }).bucket
    ).toBe("other");
    expect(classifyCommit({ sha: "b", message: "WIP" }).bucket).toBe("other");
  });

  it("does not match fake prefixes embedded in words", () => {
    // `fixed: ...` shouldn't match `fix:` — the regex needs the literal prefix+colon.
    const c = classifyCommit({ sha: "a", message: "fixed some stuff" });
    expect(c.bucket).toBe("other");
  });

  it("handles blank subjects gracefully", () => {
    const c = classifyCommit({ sha: "a", message: "" });
    expect(c.bucket).toBe("other");
    expect(c.subject).toBe("");
  });

  it("preserves author on the classified row", () => {
    const c = classifyCommit({
      sha: "a",
      message: "feat: x",
      author: "ada",
    });
    expect(c.author).toBe("ada");
  });
});

describe("release-notes — groupCommits", () => {
  it("splits a mixed list into the right buckets", () => {
    const groups = groupCommits([
      { sha: "1", message: "feat: a" },
      { sha: "2", message: "fix: b" },
      { sha: "3", message: "chore: c" },
      { sha: "4", message: "feat: d" },
      { sha: "5", message: "nothing special" },
    ]);
    expect(groups.features.map((x) => x.sha)).toEqual(["1", "4"]);
    expect(groups.fixes.map((x) => x.sha)).toEqual(["2"]);
    expect(groups.chore.map((x) => x.sha)).toEqual(["3"]);
    expect(groups.other.map((x) => x.sha)).toEqual(["5"]);
  });

  it("preserves input order within each bucket", () => {
    const groups = groupCommits([
      { sha: "b", message: "feat: b" },
      { sha: "a", message: "feat: a" },
      { sha: "c", message: "feat: c" },
    ]);
    expect(groups.features.map((x) => x.sha)).toEqual(["b", "a", "c"]);
  });
});

describe("release-notes — contributorsFrom", () => {
  it("returns unique authors sorted case-insensitively", () => {
    expect(
      contributorsFrom([
        { sha: "1", message: "x", author: "Zoe" },
        { sha: "2", message: "y", author: "ada" },
        { sha: "3", message: "z", author: "Zoe" },
        { sha: "4", message: "w", author: "" },
      ])
    ).toEqual(["ada", "Zoe"]);
  });

  it("returns [] when no authors", () => {
    expect(contributorsFrom([{ sha: "1", message: "x" }])).toEqual([]);
  });
});

describe("release-notes — renderNotesMarkdown", () => {
  it("returns a placeholder for empty input", () => {
    const md = renderNotesMarkdown([]);
    expect(md).toContain("No commits between these refs");
  });

  it("renders bucket headings in BUCKET_ORDER", () => {
    const md = renderNotesMarkdown([
      { sha: "1", message: "chore: c" },
      { sha: "2", message: "feat: a" },
      { sha: "3", message: "fix: b" },
    ]);
    const featIdx = md.indexOf("## Features");
    const fixIdx = md.indexOf("## Bug fixes");
    const choreIdx = md.indexOf("## Chores");
    expect(featIdx).toBeGreaterThanOrEqual(0);
    expect(fixIdx).toBeGreaterThan(featIdx);
    expect(choreIdx).toBeGreaterThan(fixIdx);
  });

  it("surfaces a 'Breaking changes' section at the top", () => {
    const md = renderNotesMarkdown([
      { sha: "1", message: "feat!: drop v1" },
      { sha: "2", message: "fix: tidy" },
    ]);
    const breakIdx = md.indexOf("Breaking changes");
    const featIdx = md.indexOf("## Features");
    expect(breakIdx).toBeGreaterThanOrEqual(0);
    expect(breakIdx).toBeLessThan(featIdx);
  });

  it("emits bold scope prefixes in list rows", () => {
    const md = renderNotesMarkdown([
      { sha: "abcdef1", message: "feat(api): add endpoint" },
    ]);
    expect(md).toContain("**api:**");
    expect(md).toContain("add endpoint");
    expect(md).toContain("abcdef1");
  });

  it("includes a Contributors section when authors present", () => {
    const md = renderNotesMarkdown(
      [{ sha: "1", message: "feat: a", author: "ada" }],
      { includeContributors: true }
    );
    expect(md).toContain("## Contributors");
    expect(md).toContain("@ada");
  });

  it("skips Contributors when includeContributors: false", () => {
    const md = renderNotesMarkdown(
      [{ sha: "1", message: "feat: a", author: "ada" }],
      { includeContributors: false }
    );
    expect(md).not.toContain("## Contributors");
  });

  it("emits a compare link when owner/repo + tags provided", () => {
    const md = renderNotesMarkdown(
      [{ sha: "1", message: "feat: a" }],
      { ownerRepo: "acme/widget", previousTag: "v1", newTag: "v2" }
    );
    expect(md).toContain("/acme/widget/compare/v1...v2");
  });

  it("produces Markdown links for PR numbers when ownerRepo provided", () => {
    const md = renderNotesMarkdown(
      [{ sha: "abcdef0", message: "feat: a (#7)" }],
      { ownerRepo: "acme/widget", newTag: "v1" }
    );
    expect(md).toContain("/acme/widget/pulls/7");
    expect(md).toContain("/acme/widget/commit/abcdef0");
  });
});

describe("release-notes — BUCKET_ORDER", () => {
  it("lists features before fixes before perf", () => {
    expect(BUCKET_ORDER.indexOf("features")).toBeLessThan(
      BUCKET_ORDER.indexOf("fixes")
    );
    expect(BUCKET_ORDER.indexOf("fixes")).toBeLessThan(
      BUCKET_ORDER.indexOf("perf")
    );
  });

  it("puts 'other' last", () => {
    expect(BUCKET_ORDER[BUCKET_ORDER.length - 1]).toBe("other");
  });
});

describe("release-notes — route smoke", () => {
  it("POST /generate-notes requires auth (redirects or 401)", async () => {
    const res = await app.request(
      "/alice/nope/releases/generate-notes",
      { method: "POST", body: "target=main" }
    );
    expect([302, 401, 404].includes(res.status)).toBe(true);
  });

  it("POST with invalid bearer → 401 JSON", async () => {
    const res = await app.request(
      "/alice/nope/releases/generate-notes",
      {
        method: "POST",
        headers: { authorization: "Bearer glc_garbage" },
        body: "target=main",
      }
    );
    expect(res.status).toBe(401);
  });
});

describe("release-notes — __internal symmetry", () => {
  it("re-exports the same classifyCommit / groupCommits / renderNotesMarkdown", () => {
    expect(__internal.classifyCommit).toBe(classifyCommit);
    expect(__internal.groupCommits).toBe(groupCommits);
    expect(__internal.renderNotesMarkdown).toBe(renderNotesMarkdown);
  });
});
