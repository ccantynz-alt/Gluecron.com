/**
 * Block J28 — Issue title similarity tests. Pure ranker + route smoke tests.
 */

import { describe, it, expect } from "bun:test";
import {
  MIN_TOKEN_LENGTH,
  STOPWORDS,
  DEFAULT_MIN_SCORE,
  DEFAULT_LIMIT,
  tokeniseTitle,
  jaccard,
  rankCandidates,
  findSimilar,
  formatSimilarityPercent,
  __internal,
  type SimilarityCandidate,
} from "../lib/issue-similarity";

describe("issue-similarity — tokeniseTitle", () => {
  it("empty / non-string input returns empty set", () => {
    expect(tokeniseTitle("")).toEqual(new Set());
    expect(tokeniseTitle(null)).toEqual(new Set());
    expect(tokeniseTitle(undefined)).toEqual(new Set());
    expect(tokeniseTitle(42)).toEqual(new Set());
    expect(tokeniseTitle({})).toEqual(new Set());
  });

  it("lowercases and splits on whitespace", () => {
    const t = tokeniseTitle("Add Auth To API");
    expect(t.has("add")).toBe(true);
    expect(t.has("auth")).toBe(true);
    expect(t.has("api")).toBe(true);
    // "to" is a stopword
    expect(t.has("to")).toBe(false);
  });

  it("strips punctuation", () => {
    const t = tokeniseTitle("fix: crash on window.resize()");
    expect(t.has("fix")).toBe(true);
    expect(t.has("crash")).toBe(true);
    expect(t.has("window")).toBe(true);
    expect(t.has("resize")).toBe(true);
  });

  it("drops stopwords", () => {
    const t = tokeniseTitle("the quick and the dead");
    expect(t.has("the")).toBe(false);
    expect(t.has("and")).toBe(false);
    expect(t.has("quick")).toBe(true);
    expect(t.has("dead")).toBe(true);
  });

  it("drops tokens shorter than MIN_TOKEN_LENGTH", () => {
    const t = tokeniseTitle("x y z hello");
    expect(t.has("x")).toBe(false);
    expect(t.has("y")).toBe(false);
    expect(t.has("z")).toBe(false);
    expect(t.has("hello")).toBe(true);
  });

  it("handles Unicode letters", () => {
    const t = tokeniseTitle("café français resumé");
    expect(t.has("café")).toBe(true);
    expect(t.has("français")).toBe(true);
    expect(t.has("resumé")).toBe(true);
  });

  it("dedups via Set", () => {
    const t = tokeniseTitle("crash crash crash boom crash");
    expect(t.size).toBe(2);
    expect(t.has("crash")).toBe(true);
    expect(t.has("boom")).toBe(true);
  });

  it("preserves hyphens + underscores inside tokens", () => {
    const t = tokeniseTitle("check-ref-format cors_policy");
    expect(t.has("check-ref-format")).toBe(true);
    expect(t.has("cors_policy")).toBe(true);
  });

  it("retains digits", () => {
    const t = tokeniseTitle("support HTTP2 and IPv6");
    expect(t.has("http2")).toBe(true);
    expect(t.has("ipv6")).toBe(true);
  });
});

describe("issue-similarity — jaccard", () => {
  it("returns 0 for two empty sets", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("half overlap is 1/3", () => {
    // {a,b} ∩ {b,c} = {b}; union = {a,b,c}; 1/3
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(
      1 / 3,
      6
    );
  });
  it("subset: {a} ⊂ {a,b} → 1/2", () => {
    expect(jaccard(new Set(["a"]), new Set(["a", "b"]))).toBe(0.5);
  });
  it("order of arguments doesn't matter", () => {
    const a = new Set(["x", "y", "z"]);
    const b = new Set(["y", "z", "w"]);
    expect(jaccard(a, b)).toBe(jaccard(b, a));
  });
});

describe("issue-similarity — rankCandidates", () => {
  const candidates: SimilarityCandidate[] = [
    { id: "1", number: 1, title: "Crash on startup", state: "open" },
    { id: "2", number: 2, title: "Application crashes on boot", state: "open" },
    { id: "3", number: 3, title: "Dark mode toggle", state: "open" },
    { id: "4", number: 4, title: "Crash on startup with fresh install", state: "closed" },
    { id: "5", number: 5, title: "", state: "open" },
  ];

  it("empty title returns empty", () => {
    expect(rankCandidates("", candidates)).toEqual([]);
  });

  it("ranks by score descending", () => {
    const r = rankCandidates("crash on startup", candidates);
    expect(r.length).toBeGreaterThan(0);
    // #1 is an exact token-match → score 1.0
    expect(r[0]!.id).toBe("1");
    expect(r[0]!.score).toBe(1);
  });

  it("minScore drops weak matches", () => {
    const r = rankCandidates("dark", candidates, { minScore: 0.5 });
    // "dark" matches "Dark mode toggle" with 1/3 only → under threshold
    expect(r.length).toBe(0);
  });

  it("limit caps the result count", () => {
    const r = rankCandidates("crash startup", candidates, {
      limit: 1,
      minScore: 0,
    });
    expect(r).toHaveLength(1);
  });

  it("excludeId skips a candidate by primary key", () => {
    const r = rankCandidates("crash on startup", candidates, {
      excludeId: "1",
      minScore: 0,
    });
    expect(r.some((x) => x.id === "1")).toBe(false);
  });

  it("excludeNumber skips a candidate by issue number", () => {
    const r = rankCandidates("crash on startup", candidates, {
      excludeNumber: 1,
      minScore: 0,
    });
    expect(r.some((x) => x.number === 1)).toBe(false);
  });

  it("state filter restricts candidates", () => {
    const r = rankCandidates("crash startup", candidates, {
      state: "open",
      minScore: 0,
    });
    expect(r.every((x) => x.state === "open")).toBe(true);
  });

  it("ignores candidates whose title yields no tokens", () => {
    const r = rankCandidates("crash", candidates, { minScore: 0 });
    expect(r.some((x) => x.id === "5")).toBe(false);
  });

  it("tie-breaks by createdAt desc", () => {
    const list: SimilarityCandidate[] = [
      { id: "old", number: 10, title: "foo bar", createdAt: "2025-01-01" },
      { id: "new", number: 20, title: "foo bar", createdAt: "2025-06-01" },
    ];
    const r = rankCandidates("foo bar", list, { minScore: 0 });
    expect(r[0]!.id).toBe("new");
    expect(r[1]!.id).toBe("old");
  });

  it("falls back to number-desc when createdAt equal", () => {
    const list: SimilarityCandidate[] = [
      { id: "a", number: 10, title: "foo bar" },
      { id: "b", number: 20, title: "foo bar" },
    ];
    const r = rankCandidates("foo bar", list, { minScore: 0 });
    expect(r[0]!.number).toBe(20);
  });

  it("limit=0 short-circuits to empty", () => {
    const r = rankCandidates("crash", candidates, { limit: 0, minScore: 0 });
    expect(r).toEqual([]);
  });

  it("never mutates the candidate list", () => {
    const snap = candidates.map((c) => c.id).join(",");
    rankCandidates("crash startup", candidates);
    expect(candidates.map((c) => c.id).join(",")).toBe(snap);
  });

  it("stopword-only title returns empty", () => {
    const r = rankCandidates("the and or", candidates);
    expect(r).toEqual([]);
  });

  it("uses DEFAULT_MIN_SCORE + DEFAULT_LIMIT when opts omitted", () => {
    expect(DEFAULT_MIN_SCORE).toBe(0.15);
    expect(DEFAULT_LIMIT).toBe(5);
    const r = rankCandidates("crash on startup", candidates);
    expect(r.length).toBeLessThanOrEqual(5);
    for (const item of r) expect(item.score).toBeGreaterThanOrEqual(0.15);
  });
});

describe("issue-similarity — findSimilar", () => {
  it("alias of rankCandidates", () => {
    const cs: SimilarityCandidate[] = [
      { id: "x", number: 1, title: "hello world" },
    ];
    expect(findSimilar("hello", cs, { minScore: 0 })).toEqual(
      rankCandidates("hello", cs, { minScore: 0 })
    );
  });
});

describe("issue-similarity — formatSimilarityPercent", () => {
  it("formats with percent suffix", () => {
    expect(formatSimilarityPercent(0)).toBe("0%");
    expect(formatSimilarityPercent(0.5)).toBe("50%");
    expect(formatSimilarityPercent(1)).toBe("100%");
  });
  it("rounds half-up", () => {
    expect(formatSimilarityPercent(0.456)).toBe("46%");
    expect(formatSimilarityPercent(0.454)).toBe("45%");
  });
  it("clamps out-of-range to [0,100]", () => {
    expect(formatSimilarityPercent(-0.5)).toBe("0%");
    expect(formatSimilarityPercent(2)).toBe("100%");
  });
  it("non-finite → 0%", () => {
    expect(formatSimilarityPercent(Number.NaN)).toBe("0%");
    expect(formatSimilarityPercent(Number.POSITIVE_INFINITY)).toBe("0%");
  });
});

describe("issue-similarity — constants", () => {
  it("MIN_TOKEN_LENGTH default", () => {
    expect(MIN_TOKEN_LENGTH).toBe(2);
  });
  it("STOPWORDS contains common fillers", () => {
    for (const w of ["the", "and", "is", "it", "for"]) {
      expect(STOPWORDS.has(w)).toBe(true);
    }
    expect(STOPWORDS.has("crash")).toBe(false);
  });
});

describe("issue-similarity — routes", () => {
  it("GET /:o/:r/issues/similar.json is guarded (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/issues/similar.json?q=crash+startup"
    );
    expect([200, 400, 404]).toContain(res.status);
  });

  it("GET /:o/:r/issues/:n/similar is guarded (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/issues/1/similar");
    expect([200, 404]).toContain(res.status);
  });
});

describe("issue-similarity — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.tokeniseTitle).toBe(tokeniseTitle);
    expect(__internal.jaccard).toBe(jaccard);
    expect(__internal.rankCandidates).toBe(rankCandidates);
    expect(__internal.findSimilar).toBe(findSimilar);
    expect(__internal.formatSimilarityPercent).toBe(formatSimilarityPercent);
    expect(__internal.MIN_TOKEN_LENGTH).toBe(MIN_TOKEN_LENGTH);
    expect(__internal.STOPWORDS).toBe(STOPWORDS);
    expect(__internal.DEFAULT_MIN_SCORE).toBe(DEFAULT_MIN_SCORE);
    expect(__internal.DEFAULT_LIMIT).toBe(DEFAULT_LIMIT);
    expect(typeof __internal.toTime).toBe("function");
  });
});
