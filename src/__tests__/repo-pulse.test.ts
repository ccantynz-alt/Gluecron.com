/**
 * Block J18 — Repository pulse. Pure rollup unit tests + a route-auth
 * smoke to make sure the pulse page is wired up.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  PULSE_WINDOWS,
  DEFAULT_WINDOW,
  parseWindow,
  windowStart,
  windowDays,
  summariseCommits,
  summarisePrs,
  summariseIssues,
  buildPulseReport,
  __internal,
  type PulseCommit,
  type PulsePr,
  type PulseIssue,
} from "../lib/repo-pulse";

const NOW = new Date("2026-04-15T12:00:00Z");

describe("repo-pulse — parseWindow", () => {
  it("accepts the four canonical windows", () => {
    for (const w of PULSE_WINDOWS) expect(parseWindow(w)).toBe(w);
  });

  it("falls back to DEFAULT_WINDOW on garbage", () => {
    expect(parseWindow("")).toBe(DEFAULT_WINDOW);
    expect(parseWindow("forever")).toBe(DEFAULT_WINDOW);
    expect(parseWindow(null)).toBe(DEFAULT_WINDOW);
    expect(parseWindow(undefined)).toBe(DEFAULT_WINDOW);
    expect(parseWindow(42)).toBe(DEFAULT_WINDOW);
  });
});

describe("repo-pulse — windowStart + windowDays", () => {
  it("subtracts the correct day count from `now`", () => {
    expect(windowDays("1d")).toBe(1);
    expect(windowDays("7d")).toBe(7);
    expect(windowDays("30d")).toBe(30);
    expect(windowDays("90d")).toBe(90);
    const s = windowStart(NOW, "7d");
    expect(NOW.getTime() - s.getTime()).toBe(7 * 24 * 3600 * 1000);
  });

  it("does not mutate `now`", () => {
    const t0 = NOW.getTime();
    windowStart(NOW, "30d");
    expect(NOW.getTime()).toBe(t0);
  });
});

describe("repo-pulse — summariseCommits", () => {
  const commits: PulseCommit[] = [
    // In window
    { sha: "a", author: "Alice", authorEmail: "a@x", date: "2026-04-14T00:00:00Z" },
    { sha: "b", author: "Bob", authorEmail: "b@x", date: "2026-04-13T00:00:00Z" },
    { sha: "c", author: "Alice", authorEmail: "a@x", date: "2026-04-12T00:00:00Z" },
    // Out of window (older than 7d)
    { sha: "d", author: "Alice", authorEmail: "a@x", date: "2026-04-01T00:00:00Z" },
  ];

  it("counts only commits in [start, end]", () => {
    const start = windowStart(NOW, "7d");
    const r = summariseCommits(commits, start, NOW);
    expect(r.total).toBe(3);
    expect(r.byAuthor.length).toBe(2);
  });

  it("sorts contributors by count desc, name asc as tiebreak", () => {
    const start = windowStart(NOW, "7d");
    const r = summariseCommits(commits, start, NOW);
    expect(r.byAuthor[0].author).toBe("Alice");
    expect(r.byAuthor[0].count).toBe(2);
    expect(r.byAuthor[1].author).toBe("Bob");
  });

  it("groups by lowercased email, falling back to name", () => {
    const cs: PulseCommit[] = [
      { sha: "1", author: "Alice", authorEmail: "A@X", date: "2026-04-14T00:00:00Z" },
      { sha: "2", author: "Alice", authorEmail: "a@x", date: "2026-04-13T00:00:00Z" },
    ];
    const r = summariseCommits(cs, windowStart(NOW, "7d"), NOW);
    expect(r.byAuthor.length).toBe(1);
    expect(r.byAuthor[0].count).toBe(2);
  });

  it("tracks firstSha + lastSha", () => {
    const start = windowStart(NOW, "7d");
    const r = summariseCommits(commits, start, NOW);
    // Commits are newest-first, so lastSha is the newest (first in array).
    expect(r.lastSha).toBe("a");
    expect(r.firstSha).toBe("c");
  });

  it("returns zero counts on empty input", () => {
    const r = summariseCommits([], windowStart(NOW, "7d"), NOW);
    expect(r.total).toBe(0);
    expect(r.byAuthor).toEqual([]);
    expect(r.firstSha).toBeNull();
    expect(r.lastSha).toBeNull();
  });

  it("ignores commits with invalid dates", () => {
    const cs: PulseCommit[] = [
      { sha: "1", author: "X", authorEmail: "x@x", date: "not-a-date" },
      { sha: "2", author: "Y", authorEmail: "y@x", date: "2026-04-14T00:00:00Z" },
    ];
    const r = summariseCommits(cs, windowStart(NOW, "7d"), NOW);
    expect(r.total).toBe(1);
  });

  it("falls back to (unknown) when author + email are both empty", () => {
    const cs: PulseCommit[] = [
      { sha: "1", author: "", authorEmail: "", date: "2026-04-14T00:00:00Z" },
    ];
    const r = summariseCommits(cs, windowStart(NOW, "7d"), NOW);
    expect(r.byAuthor[0].author).toBe("(unknown)");
  });
});

describe("repo-pulse — summarisePrs", () => {
  const iso = (s: string) => s;
  const prs: PulsePr[] = [
    // Opened + merged in window
    {
      number: 1,
      title: "A",
      state: "merged",
      createdAt: iso("2026-04-14T00:00:00Z"),
      updatedAt: iso("2026-04-14T00:00:00Z"),
      closedAt: iso("2026-04-14T00:00:00Z"),
      mergedAt: iso("2026-04-14T00:00:00Z"),
    },
    // Opened in window, still open
    {
      number: 2,
      title: "B",
      state: "open",
      createdAt: iso("2026-04-13T00:00:00Z"),
      updatedAt: iso("2026-04-14T00:00:00Z"),
      closedAt: null,
      mergedAt: null,
    },
    // Closed (not merged) in window
    {
      number: 3,
      title: "C",
      state: "closed",
      createdAt: iso("2026-01-01T00:00:00Z"),
      updatedAt: iso("2026-04-12T00:00:00Z"),
      closedAt: iso("2026-04-12T00:00:00Z"),
      mergedAt: null,
    },
    // Entirely outside window
    {
      number: 4,
      title: "D",
      state: "merged",
      createdAt: iso("2026-01-01T00:00:00Z"),
      updatedAt: iso("2026-01-02T00:00:00Z"),
      closedAt: iso("2026-01-02T00:00:00Z"),
      mergedAt: iso("2026-01-02T00:00:00Z"),
    },
  ];

  const start = windowStart(NOW, "7d");

  it("counts opened/merged/closed correctly", () => {
    const r = summarisePrs(prs, start, NOW);
    expect(r.opened).toBe(2);
    expect(r.mergedCount).toBe(1);
    expect(r.closed).toBe(1);
  });

  it("reports `active` only for state=open with updatedAt in window", () => {
    const r = summarisePrs(prs, start, NOW);
    expect(r.active).toBe(1);
  });

  it("includes the merged PR in mergedList + opened PRs in openedList", () => {
    const r = summarisePrs(prs, start, NOW);
    expect(r.mergedList.map((p) => p.number)).toEqual([1]);
    expect(r.openedList.map((p) => p.number).sort()).toEqual([1, 2]);
  });

  it("accepts Date instances as well as ISO strings", () => {
    const withDates: PulsePr[] = [
      {
        number: 5,
        title: "E",
        state: "merged",
        createdAt: new Date("2026-04-14T00:00:00Z"),
        updatedAt: new Date("2026-04-14T00:00:00Z"),
        closedAt: new Date("2026-04-14T00:00:00Z"),
        mergedAt: new Date("2026-04-14T00:00:00Z"),
      },
    ];
    const r = summarisePrs(withDates, start, NOW);
    expect(r.opened).toBe(1);
    expect(r.mergedCount).toBe(1);
  });

  it("handles empty list", () => {
    const r = summarisePrs([], start, NOW);
    expect(r.opened).toBe(0);
    expect(r.mergedCount).toBe(0);
    expect(r.closed).toBe(0);
    expect(r.active).toBe(0);
  });
});

describe("repo-pulse — summariseIssues", () => {
  const start = windowStart(NOW, "7d");
  const issueList: PulseIssue[] = [
    {
      number: 1,
      title: "x",
      state: "open",
      createdAt: "2026-04-14T00:00:00Z",
      updatedAt: "2026-04-14T00:00:00Z",
      closedAt: null,
    },
    {
      number: 2,
      title: "y",
      state: "closed",
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-13T00:00:00Z",
      closedAt: "2026-04-13T00:00:00Z",
    },
    // Out of window
    {
      number: 3,
      title: "z",
      state: "closed",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      closedAt: "2026-01-02T00:00:00Z",
    },
  ];

  it("buckets opened / closed / active", () => {
    const r = summariseIssues(issueList, start, NOW);
    expect(r.opened).toBe(1);
    expect(r.closed).toBe(1);
    expect(r.active).toBe(1);
  });

  it("populates openedList + closedList", () => {
    const r = summariseIssues(issueList, start, NOW);
    expect(r.openedList.map((i) => i.number)).toEqual([1]);
    expect(r.closedList.map((i) => i.number)).toEqual([2]);
  });

  it("tolerates null closedAt / weird dates", () => {
    const bad: PulseIssue[] = [
      {
        number: 99,
        title: "bad",
        state: "open",
        createdAt: "oops",
        updatedAt: "also oops",
        closedAt: null,
      },
    ];
    const r = summariseIssues(bad, start, NOW);
    expect(r.opened).toBe(0);
    expect(r.closed).toBe(0);
    expect(r.active).toBe(0);
  });
});

describe("repo-pulse — buildPulseReport", () => {
  it("bundles all three rollups with a resolved window", () => {
    const r = buildPulseReport({
      window: "7d",
      now: NOW,
      commits: [
        {
          sha: "a",
          author: "A",
          authorEmail: "a@x",
          date: "2026-04-14T00:00:00Z",
        },
      ],
      prs: [],
      issues: [],
    });
    expect(r.window).toBe("7d");
    expect(r.days).toBe(7);
    expect(r.start < r.end).toBe(true);
    expect(r.commits.total).toBe(1);
    expect(r.prs.opened).toBe(0);
    expect(r.issues.opened).toBe(0);
  });
});

describe("repo-pulse — __internal", () => {
  it("re-exports the pure helpers for parity", () => {
    expect(__internal.parseWindow).toBe(parseWindow);
    expect(__internal.windowStart).toBe(windowStart);
    expect(__internal.windowDays).toBe(windowDays);
    expect(__internal.summariseCommits).toBe(summariseCommits);
    expect(__internal.summarisePrs).toBe(summarisePrs);
    expect(__internal.summariseIssues).toBe(summariseIssues);
    expect(__internal.buildPulseReport).toBe(buildPulseReport);
    expect(__internal.PULSE_WINDOWS).toBe(PULSE_WINDOWS);
    expect(__internal.DEFAULT_WINDOW as string).toBe(DEFAULT_WINDOW);
  });
});

describe("repo-pulse — routes", () => {
  it("GET /:o/:r/pulse returns 404 for unknown repo", async () => {
    const res = await app.request("/alice/nope/pulse");
    expect(res.status).toBe(404);
  });

  it("GET /:o/:r/pulse?window=bogus normalises to default", async () => {
    // Route resolves repo first, so we still expect 404 for unknown — this
    // asserts the route accepts the query without crashing.
    const res = await app.request("/alice/nope/pulse?window=bogus");
    expect(res.status).toBe(404);
  });
});
