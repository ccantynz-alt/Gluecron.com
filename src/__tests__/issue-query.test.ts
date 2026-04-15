/**
 * Block J23 — Issue/PR search query DSL. Pure parser + matcher tests.
 */

import { describe, it, expect } from "bun:test";
import {
  tokenise,
  parseIssueQuery,
  matchIssue,
  sortIssues,
  applyQuery,
  formatIssueQuery,
  DEFAULT_SORT,
  __internal,
  type IssueQuery,
  type QueryableIssue,
} from "../lib/issue-query";

function mkIssue(overrides: Partial<QueryableIssue> = {}): QueryableIssue {
  return {
    title: "Hello world",
    body: "Body text",
    state: "open",
    authorName: "alice",
    labelNames: [],
    milestoneTitle: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-02T00:00:00Z"),
    commentCount: 0,
    ...overrides,
  };
}

describe("issue-query — tokenise", () => {
  it("splits on whitespace", () => {
    expect(tokenise("a b c")).toEqual(["a", "b", "c"]);
  });
  it("collapses multiple whitespace", () => {
    expect(tokenise("a   b\t\tc")).toEqual(["a", "b", "c"]);
  });
  it("respects double-quoted spans", () => {
    expect(tokenise('foo "bar baz" qux')).toEqual(["foo", "bar baz", "qux"]);
  });
  it("attaches quoted value to a key:", () => {
    expect(tokenise('label:"help wanted"')).toEqual(["label:help wanted"]);
  });
  it("returns [] for empty input", () => {
    expect(tokenise("")).toEqual([]);
    expect(tokenise("   ")).toEqual([]);
  });
  it("tolerates trailing unterminated quote", () => {
    // Missing closing quote — buf flushes at EOF.
    expect(tokenise('foo "bar')).toEqual(["foo", "bar"]);
  });
});

describe("issue-query — parseIssueQuery", () => {
  it("returns default shape for empty input", () => {
    const q = parseIssueQuery("");
    expect(q.text).toBe("");
    expect(q.labels).toEqual([]);
    expect(q.excludeLabels).toEqual([]);
    expect(q.noLabel).toBe(false);
    expect(q.sort).toBe(DEFAULT_SORT);
    expect(q.is).toBeUndefined();
    expect(q.author).toBeUndefined();
    expect(q.milestone).toBeUndefined();
  });

  it("returns default for null/undefined", () => {
    expect(parseIssueQuery(null).text).toBe("");
    expect(parseIssueQuery(undefined).text).toBe("");
  });

  it("returns default for non-string input", () => {
    expect(parseIssueQuery(123 as unknown as string).text).toBe("");
  });

  it("parses is:open and is:closed", () => {
    expect(parseIssueQuery("is:open").is).toBe("open");
    expect(parseIssueQuery("is:closed").is).toBe("closed");
  });

  it("ignores bogus is: values", () => {
    expect(parseIssueQuery("is:draft").is).toBeUndefined();
  });

  it("parses author:", () => {
    expect(parseIssueQuery("author:alice").author).toBe("alice");
  });

  it("parses multiple label: (AND)", () => {
    const q = parseIssueQuery("label:bug label:frontend");
    expect(q.labels).toEqual(["bug", "frontend"]);
  });

  it("parses -label: as excludeLabels", () => {
    const q = parseIssueQuery("-label:wontfix -label:duplicate");
    expect(q.excludeLabels).toEqual(["wontfix", "duplicate"]);
  });

  it("parses no:label", () => {
    expect(parseIssueQuery("no:label").noLabel).toBe(true);
  });

  it("ignores no: with other values", () => {
    expect(parseIssueQuery("no:milestone").noLabel).toBe(false);
  });

  it("parses milestone: with quotes", () => {
    const q = parseIssueQuery('milestone:"v1.0 rc"');
    expect(q.milestone).toBe("v1.0 rc");
  });

  it("accepts allow-listed sort values", () => {
    expect(parseIssueQuery("sort:created-desc").sort).toBe("created-desc");
    expect(parseIssueQuery("sort:created-asc").sort).toBe("created-asc");
    expect(parseIssueQuery("sort:updated-desc").sort).toBe("updated-desc");
    expect(parseIssueQuery("sort:updated-asc").sort).toBe("updated-asc");
    expect(parseIssueQuery("sort:comments-desc").sort).toBe("comments-desc");
  });

  it("falls back to default sort for unknown sort:", () => {
    expect(parseIssueQuery("sort:garbage").sort).toBe(DEFAULT_SORT);
  });

  it("joins unmatched tokens into text", () => {
    const q = parseIssueQuery('race condition');
    expect(q.text).toBe("race condition");
  });

  it("treats unknown qualifiers as text", () => {
    const q = parseIssueQuery("weird:thing hello");
    expect(q.text).toContain("weird:thing");
    expect(q.text).toContain("hello");
  });

  it("is case-insensitive on qualifier keys", () => {
    expect(parseIssueQuery("IS:open").is).toBe("open");
    expect(parseIssueQuery("Author:bob").author).toBe("bob");
  });

  it("supports quoted text phrase as free text", () => {
    const q = parseIssueQuery('"race condition"');
    expect(q.text).toBe("race condition");
  });

  it("parses a complex real-world query", () => {
    const q = parseIssueQuery(
      'is:open label:bug -label:wontfix author:alice milestone:"v1.0" sort:updated-desc "null pointer"'
    );
    expect(q.is).toBe("open");
    expect(q.labels).toEqual(["bug"]);
    expect(q.excludeLabels).toEqual(["wontfix"]);
    expect(q.author).toBe("alice");
    expect(q.milestone).toBe("v1.0");
    expect(q.sort).toBe("updated-desc");
    expect(q.text).toBe("null pointer");
  });

  it("drops empty values (key: with no value)", () => {
    const q = parseIssueQuery("label: author:");
    expect(q.labels).toEqual([]);
    expect(q.author).toBeUndefined();
  });

  it("never throws on weird input", () => {
    expect(() => parseIssueQuery(":::")).not.toThrow();
    expect(() => parseIssueQuery(":foo")).not.toThrow();
    expect(() => parseIssueQuery('"""')).not.toThrow();
  });
});

describe("issue-query — matchIssue", () => {
  it("matches when no filters set", () => {
    const q = parseIssueQuery("");
    expect(matchIssue(mkIssue(), q)).toBe(true);
  });

  it("filters by is:open / is:closed", () => {
    const q = parseIssueQuery("is:closed");
    expect(matchIssue(mkIssue({ state: "open" }), q)).toBe(false);
    expect(matchIssue(mkIssue({ state: "closed" }), q)).toBe(true);
  });

  it("filters by author (case-insensitive)", () => {
    const q = parseIssueQuery("author:ALICE");
    expect(matchIssue(mkIssue({ authorName: "alice" }), q)).toBe(true);
    expect(matchIssue(mkIssue({ authorName: "bob" }), q)).toBe(false);
  });

  it("filters by milestone (case-insensitive)", () => {
    const q = parseIssueQuery('milestone:"V1.0"');
    expect(matchIssue(mkIssue({ milestoneTitle: "v1.0" }), q)).toBe(true);
    expect(matchIssue(mkIssue({ milestoneTitle: "v2.0" }), q)).toBe(false);
    expect(matchIssue(mkIssue({ milestoneTitle: null }), q)).toBe(false);
  });

  it("no:label excludes labelled issues", () => {
    const q = parseIssueQuery("no:label");
    expect(matchIssue(mkIssue({ labelNames: [] }), q)).toBe(true);
    expect(matchIssue(mkIssue({ labelNames: ["bug"] }), q)).toBe(false);
  });

  it("label: requires all labels (AND)", () => {
    const q = parseIssueQuery("label:bug label:frontend");
    expect(matchIssue(mkIssue({ labelNames: ["bug", "frontend"] }), q)).toBe(true);
    expect(matchIssue(mkIssue({ labelNames: ["bug"] }), q)).toBe(false);
    expect(matchIssue(mkIssue({ labelNames: ["Bug", "FrontEnd"] }), q)).toBe(true);
  });

  it("-label: excludes matched labels", () => {
    const q = parseIssueQuery("-label:wontfix");
    expect(matchIssue(mkIssue({ labelNames: ["bug"] }), q)).toBe(true);
    expect(matchIssue(mkIssue({ labelNames: ["bug", "wontfix"] }), q)).toBe(false);
    expect(matchIssue(mkIssue({ labelNames: ["WontFix"] }), q)).toBe(false);
  });

  it("text substring matches title or body (case-insensitive)", () => {
    const q = parseIssueQuery("NULL pointer");
    expect(
      matchIssue(mkIssue({ title: "Got a null pointer crash", body: null }), q)
    ).toBe(true);
    expect(
      matchIssue(mkIssue({ title: "ok", body: "null pointer here" }), q)
    ).toBe(true);
    expect(matchIssue(mkIssue({ title: "ok", body: null }), q)).toBe(false);
  });

  it("text tolerates null body", () => {
    const q = parseIssueQuery("hello");
    expect(matchIssue(mkIssue({ title: "hello", body: null }), q)).toBe(true);
  });

  it("composes multiple filters", () => {
    const q = parseIssueQuery(
      "is:open author:alice label:bug -label:wontfix crash"
    );
    expect(
      matchIssue(
        mkIssue({
          state: "open",
          authorName: "alice",
          labelNames: ["bug"],
          title: "App crash on startup",
        }),
        q
      )
    ).toBe(true);
    expect(
      matchIssue(
        mkIssue({
          state: "open",
          authorName: "alice",
          labelNames: ["bug", "wontfix"],
          title: "App crash on startup",
        }),
        q
      )
    ).toBe(false);
  });
});

describe("issue-query — sortIssues", () => {
  const a = mkIssue({
    title: "A",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-02-01T00:00:00Z"),
    commentCount: 5,
  });
  const b = mkIssue({
    title: "B",
    createdAt: new Date("2025-01-02T00:00:00Z"),
    updatedAt: new Date("2025-01-15T00:00:00Z"),
    commentCount: 10,
  });
  const c = mkIssue({
    title: "C",
    createdAt: new Date("2025-01-03T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    commentCount: 1,
  });

  it("created-desc (newest first)", () => {
    const out = sortIssues([a, b, c], "created-desc");
    expect(out.map((i) => i.title)).toEqual(["C", "B", "A"]);
  });

  it("created-asc (oldest first)", () => {
    const out = sortIssues([b, a, c], "created-asc");
    expect(out.map((i) => i.title)).toEqual(["A", "B", "C"]);
  });

  it("updated-desc", () => {
    const out = sortIssues([a, b, c], "updated-desc");
    expect(out.map((i) => i.title)).toEqual(["A", "B", "C"]);
  });

  it("updated-asc", () => {
    const out = sortIssues([a, b, c], "updated-asc");
    expect(out.map((i) => i.title)).toEqual(["C", "B", "A"]);
  });

  it("comments-desc", () => {
    const out = sortIssues([a, b, c], "comments-desc");
    expect(out.map((i) => i.title)).toEqual(["B", "A", "C"]);
  });

  it("does not mutate the input array", () => {
    const list = [a, b, c];
    const snapshot = [...list];
    sortIssues(list, "created-asc");
    expect(list).toEqual(snapshot);
  });

  it("handles string dates", () => {
    const sa = mkIssue({ title: "a", createdAt: "2025-01-01T00:00:00Z" });
    const sb = mkIssue({ title: "b", createdAt: "2025-01-02T00:00:00Z" });
    const out = sortIssues([sa, sb], "created-desc");
    expect(out.map((i) => i.title)).toEqual(["b", "a"]);
  });

  it("treats unparseable dates as 0", () => {
    const bad = mkIssue({ title: "bad", createdAt: "not-a-date" });
    const good = mkIssue({ title: "good", createdAt: "2025-01-01T00:00:00Z" });
    const out = sortIssues([bad, good], "created-desc");
    expect(out[0].title).toBe("good");
  });

  it("treats missing commentCount as 0", () => {
    const i1 = mkIssue({ title: "i1", commentCount: undefined });
    const i2 = mkIssue({ title: "i2", commentCount: 3 });
    const out = sortIssues([i1, i2], "comments-desc");
    expect(out[0].title).toBe("i2");
  });
});

describe("issue-query — applyQuery", () => {
  const issues: QueryableIssue[] = [
    mkIssue({
      title: "Memory leak in scheduler",
      state: "open",
      authorName: "alice",
      labelNames: ["bug", "performance"],
      createdAt: new Date("2025-02-01T00:00:00Z"),
    }),
    mkIssue({
      title: "Typo in README",
      state: "closed",
      authorName: "bob",
      labelNames: ["docs"],
      createdAt: new Date("2025-01-15T00:00:00Z"),
    }),
    mkIssue({
      title: "Add dark mode",
      state: "open",
      authorName: "carol",
      labelNames: [],
      createdAt: new Date("2025-03-01T00:00:00Z"),
    }),
  ];

  it("filters + sorts end-to-end", () => {
    const { query, matches } = applyQuery("is:open sort:created-asc", issues);
    expect(query.is).toBe("open");
    expect(matches.map((i) => i.title)).toEqual([
      "Memory leak in scheduler",
      "Add dark mode",
    ]);
  });

  it("combines text + labels + state", () => {
    const { matches } = applyQuery("is:open label:bug leak", issues);
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe("Memory leak in scheduler");
  });

  it("no:label returns unlabelled issues only", () => {
    const { matches } = applyQuery("no:label", issues);
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe("Add dark mode");
  });

  it("empty query returns all, default sort applied", () => {
    const { matches } = applyQuery("", issues);
    expect(matches).toHaveLength(3);
    // default sort is created-desc
    expect(matches[0].title).toBe("Add dark mode");
  });

  it("does not mutate the input list", () => {
    const snapshot = [...issues];
    applyQuery("sort:created-asc", issues);
    expect(issues).toEqual(snapshot);
  });
});

describe("issue-query — formatIssueQuery", () => {
  it("emits empty string for default shape", () => {
    const empty: IssueQuery = {
      text: "",
      labels: [],
      excludeLabels: [],
      noLabel: false,
      sort: DEFAULT_SORT,
    };
    expect(formatIssueQuery(empty)).toBe("");
  });

  it("round-trips a simple query", () => {
    const q = parseIssueQuery("is:open label:bug author:alice");
    const s = formatIssueQuery(q);
    expect(s).toContain("is:open");
    expect(s).toContain("label:bug");
    expect(s).toContain("author:alice");
  });

  it("quotes values with whitespace", () => {
    const q = parseIssueQuery('milestone:"v1.0 rc" label:"help wanted"');
    const s = formatIssueQuery(q);
    expect(s).toContain('milestone:"v1.0 rc"');
    expect(s).toContain('label:"help wanted"');
  });

  it("quotes text with whitespace", () => {
    const q = parseIssueQuery('"race condition"');
    const s = formatIssueQuery(q);
    expect(s).toContain('"race condition"');
  });

  it("omits default sort", () => {
    const q = parseIssueQuery("");
    expect(formatIssueQuery(q)).not.toContain("sort:");
  });

  it("includes non-default sort", () => {
    const q = parseIssueQuery("sort:updated-desc");
    expect(formatIssueQuery(q)).toContain("sort:updated-desc");
  });

  it("emits no:label when set", () => {
    const q = parseIssueQuery("no:label");
    expect(formatIssueQuery(q)).toContain("no:label");
  });

  it("round-trips complex query → parse → format (structural equality)", () => {
    const original = parseIssueQuery(
      'is:open label:bug -label:wontfix author:alice milestone:"v1.0" sort:updated-desc crash'
    );
    const s = formatIssueQuery(original);
    const reparsed = parseIssueQuery(s);
    expect(reparsed.is).toBe(original.is);
    expect(reparsed.author).toBe(original.author);
    expect(reparsed.milestone).toBe(original.milestone);
    expect(reparsed.labels).toEqual(original.labels);
    expect(reparsed.excludeLabels).toEqual(original.excludeLabels);
    expect(reparsed.noLabel).toBe(original.noLabel);
    expect(reparsed.sort).toBe(original.sort);
    expect(reparsed.text).toBe(original.text);
  });
});

describe("issue-query — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.tokenise).toBe(tokenise);
    expect(__internal.parseIssueQuery).toBe(parseIssueQuery);
    expect(__internal.matchIssue).toBe(matchIssue);
    expect(__internal.sortIssues).toBe(sortIssues);
    expect(__internal.applyQuery).toBe(applyQuery);
    expect(__internal.formatIssueQuery).toBe(formatIssueQuery);
    expect(__internal.DEFAULT_SORT).toBe(DEFAULT_SORT);
  });
});
