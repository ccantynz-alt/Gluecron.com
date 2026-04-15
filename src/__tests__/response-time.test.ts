/**
 * Block J25 — Time-to-first-response metric. Pure rollup tests.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_WINDOW_DAYS,
  VALID_WINDOWS,
  parseWindow,
  computeTimeToFirstResponse,
  computeIssueStats,
  summariseResponseTimes,
  bucketResponseTimes,
  buildResponseReport,
  formatDuration,
  __internal,
  type ResponseIssueInput,
} from "../lib/response-time";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("response-time — parseWindow", () => {
  it("returns the default for undefined/null/empty", () => {
    expect(parseWindow(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindow(null)).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindow("")).toBe(DEFAULT_WINDOW_DAYS);
  });
  it("accepts valid windows as strings", () => {
    expect(parseWindow("0")).toBe(0);
    expect(parseWindow("7")).toBe(7);
    expect(parseWindow("30")).toBe(30);
    expect(parseWindow("90")).toBe(90);
    expect(parseWindow("365")).toBe(365);
  });
  it("rejects unknown values", () => {
    expect(parseWindow("14")).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindow("-5")).toBe(DEFAULT_WINDOW_DAYS);
    expect(parseWindow("garbage")).toBe(DEFAULT_WINDOW_DAYS);
  });
  it("exports the canonical window list", () => {
    expect(VALID_WINDOWS).toContain(0);
    expect(VALID_WINDOWS).toContain(DEFAULT_WINDOW_DAYS);
  });
});

describe("response-time — computeTimeToFirstResponse", () => {
  const created = new Date("2025-01-01T00:00:00Z");

  it("returns null when no comments", () => {
    expect(
      computeTimeToFirstResponse({
        issueCreatedAt: created,
        issueAuthorId: "author",
        comments: [],
      })
    ).toBeNull();
  });

  it("ignores comments by the issue author", () => {
    expect(
      computeTimeToFirstResponse({
        issueCreatedAt: created,
        issueAuthorId: "author",
        comments: [
          {
            authorId: "author",
            createdAt: new Date("2025-01-01T01:00:00Z"),
          },
        ],
      })
    ).toBeNull();
  });

  it("returns earliest non-author comment delta", () => {
    const ms = computeTimeToFirstResponse({
      issueCreatedAt: created,
      issueAuthorId: "author",
      comments: [
        {
          authorId: "author",
          createdAt: new Date("2025-01-01T00:30:00Z"),
        },
        {
          authorId: "responder",
          createdAt: new Date("2025-01-01T01:00:00Z"),
        },
        {
          authorId: "other",
          createdAt: new Date("2025-01-01T02:00:00Z"),
        },
      ],
    });
    expect(ms).toBe(HOUR);
  });

  it("handles string dates", () => {
    const ms = computeTimeToFirstResponse({
      issueCreatedAt: "2025-01-01T00:00:00Z",
      issueAuthorId: "author",
      comments: [
        { authorId: "responder", createdAt: "2025-01-01T00:30:00Z" },
      ],
    });
    expect(ms).toBe(30 * 60 * 1000);
  });

  it("clamps negative deltas to 0", () => {
    const ms = computeTimeToFirstResponse({
      issueCreatedAt: created,
      issueAuthorId: "author",
      comments: [
        {
          authorId: "responder",
          createdAt: new Date("2024-12-31T23:59:00Z"),
        },
      ],
    });
    expect(ms).toBe(0);
  });

  it("skips unparseable dates", () => {
    const ms = computeTimeToFirstResponse({
      issueCreatedAt: created,
      issueAuthorId: "author",
      comments: [
        { authorId: "responder", createdAt: "not-a-date" },
        { authorId: "responder", createdAt: new Date("2025-01-01T01:00:00Z") },
      ],
    });
    expect(ms).toBe(HOUR);
  });

  it("returns null when the issue timestamp is unparseable", () => {
    expect(
      computeTimeToFirstResponse({
        issueCreatedAt: "not-a-date",
        issueAuthorId: "author",
        comments: [{ authorId: "r", createdAt: new Date() }],
      })
    ).toBeNull();
  });
});

describe("response-time — computeIssueStats + window filter", () => {
  const now = new Date("2025-04-01T00:00:00Z").getTime();
  const issues: ResponseIssueInput[] = [
    {
      id: "a",
      state: "open",
      authorId: "alice",
      createdAt: new Date(now - 2 * DAY),
      comments: [
        { authorId: "bob", createdAt: new Date(now - 2 * DAY + HOUR) },
      ],
    },
    {
      id: "b",
      state: "closed",
      authorId: "alice",
      createdAt: new Date(now - 45 * DAY),
      comments: [],
    },
    {
      id: "c",
      state: "open",
      authorId: "alice",
      createdAt: new Date(now - 5 * DAY),
      comments: [], // unresponded
    },
    {
      id: "d",
      state: "open",
      authorId: "alice",
      createdAt: "bad-date",
      comments: [],
    },
  ];

  it("filters to the window (windowDays=30)", () => {
    const out = computeIssueStats(issues, 30, now);
    expect(out.map((s) => s.id).sort()).toEqual(["a", "c"]);
  });

  it("windowDays=0 includes all (except unparseable dates)", () => {
    const out = computeIssueStats(issues, 0, now);
    expect(out.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("reports responseMs + null correctly", () => {
    const out = computeIssueStats(issues, 30, now);
    const a = out.find((s) => s.id === "a");
    const c = out.find((s) => s.id === "c");
    expect(a?.responseMs).toBe(HOUR);
    expect(c?.responseMs).toBeNull();
  });
});

describe("response-time — summariseResponseTimes", () => {
  it("zero stats", () => {
    const s = summariseResponseTimes([]);
    expect(s.total).toBe(0);
    expect(s.medianMs).toBeNull();
    expect(s.p90Ms).toBeNull();
    expect(s.fastestMs).toBeNull();
    expect(s.slowestMs).toBeNull();
  });

  it("single responded issue", () => {
    const s = summariseResponseTimes([
      { id: "a", state: "open", createdAt: 0, responseMs: HOUR },
    ]);
    expect(s.total).toBe(1);
    expect(s.responded).toBe(1);
    expect(s.medianMs).toBe(HOUR);
    expect(s.meanMs).toBe(HOUR);
    expect(s.p90Ms).toBe(HOUR);
    expect(s.fastestMs).toBe(HOUR);
    expect(s.slowestMs).toBe(HOUR);
  });

  it("counts open+unresponded towards `unresponded`, not closed", () => {
    const s = summariseResponseTimes([
      { id: "o", state: "open", createdAt: 0, responseMs: null },
      { id: "c", state: "closed", createdAt: 0, responseMs: null },
      { id: "r", state: "open", createdAt: 0, responseMs: HOUR },
    ]);
    expect(s.total).toBe(3);
    expect(s.responded).toBe(1);
    expect(s.unresponded).toBe(1);
  });

  it("computes median/mean/p90 on responded only", () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => n * HOUR);
    const s = summariseResponseTimes(
      vals.map((v, i) => ({
        id: String(i),
        state: "open",
        createdAt: 0,
        responseMs: v,
      }))
    );
    expect(s.responded).toBe(10);
    // median of 10 values (indices 0..9) at p=50 → rank 4.5 → between idx 4,5 → (5+6)/2 h = 5.5h
    expect(s.medianMs).toBe(Math.round(5.5 * HOUR));
    expect(s.meanMs).toBe(Math.round(5.5 * HOUR));
    // p90 → rank 8.1 → between idx 8,9 → 9h + 0.1*(10h-9h) = 9.1h
    expect(s.p90Ms).toBe(Math.round(9.1 * HOUR));
    expect(s.fastestMs).toBe(HOUR);
    expect(s.slowestMs).toBe(10 * HOUR);
  });
});

describe("response-time — bucketResponseTimes", () => {
  it("distributes into the four buckets", () => {
    const b = bucketResponseTimes([
      { id: "1", state: "open", createdAt: 0, responseMs: 30 * 60 * 1000 }, // 30m → within1h
      { id: "2", state: "open", createdAt: 0, responseMs: HOUR }, // 1h exactly → within1h
      { id: "3", state: "open", createdAt: 0, responseMs: 2 * HOUR }, // within1d
      { id: "4", state: "open", createdAt: 0, responseMs: 25 * HOUR }, // within1w
      { id: "5", state: "open", createdAt: 0, responseMs: 8 * DAY }, // over1w
      { id: "n", state: "open", createdAt: 0, responseMs: null }, // ignored
    ]);
    expect(b.within1h).toBe(2);
    expect(b.within1d).toBe(1);
    expect(b.within1w).toBe(1);
    expect(b.over1w).toBe(1);
  });
});

describe("response-time — formatDuration", () => {
  it("handles null", () => {
    expect(formatDuration(null)).toBe("\u2014");
  });
  it("ms", () => {
    expect(formatDuration(750)).toBe("750ms");
  });
  it("seconds", () => {
    expect(formatDuration(45 * 1000)).toBe("45s");
  });
  it("minutes", () => {
    expect(formatDuration(90 * 1000)).toBe("2m");
  });
  it("hours with minutes", () => {
    expect(formatDuration(HOUR + 30 * 60 * 1000)).toBe("1h 30m");
  });
  it("exact hours omit minutes", () => {
    expect(formatDuration(3 * HOUR)).toBe("3h");
  });
  it("days with hours", () => {
    expect(formatDuration(2 * DAY + 5 * HOUR)).toBe("2d 5h");
  });
  it("exact days omit hours", () => {
    expect(formatDuration(3 * DAY)).toBe("3d");
  });
  it("negative clamps to 0s", () => {
    expect(formatDuration(-100)).toBe("0s");
  });
});

describe("response-time — buildResponseReport", () => {
  const now = new Date("2025-04-01T00:00:00Z").getTime();

  it("builds a complete report", () => {
    const issues: ResponseIssueInput[] = [
      {
        id: "a",
        state: "open",
        authorId: "alice",
        createdAt: new Date(now - HOUR * 3),
        comments: [
          { authorId: "bob", createdAt: new Date(now - HOUR * 2) },
        ],
      },
      {
        id: "b",
        state: "open",
        authorId: "alice",
        createdAt: new Date(now - DAY),
        comments: [],
      },
      {
        id: "c",
        state: "closed",
        authorId: "alice",
        createdAt: new Date(now - 10 * DAY),
        comments: [
          { authorId: "carol", createdAt: new Date(now - 10 * DAY + 2 * HOUR) },
        ],
      },
    ];
    const r = buildResponseReport({ issues, windowDays: 30, now });
    expect(r.windowDays).toBe(30);
    expect(r.now).toBe(now);
    expect(r.perIssue).toHaveLength(3);
    expect(r.summary.responded).toBe(2);
    expect(r.summary.unresponded).toBe(1);
    expect(r.unrepliedIssueIds).toEqual(["b"]);
  });

  it("defaults `now` to Date.now when omitted", () => {
    const before = Date.now();
    const r = buildResponseReport({
      issues: [],
      windowDays: 30,
    });
    const after = Date.now();
    expect(r.now).toBeGreaterThanOrEqual(before);
    expect(r.now).toBeLessThanOrEqual(after);
  });

  it("sorts unrepliedIssueIds oldest-first", () => {
    const issues: ResponseIssueInput[] = [
      {
        id: "younger",
        state: "open",
        authorId: "alice",
        createdAt: new Date(now - DAY),
        comments: [],
      },
      {
        id: "older",
        state: "open",
        authorId: "alice",
        createdAt: new Date(now - 3 * DAY),
        comments: [],
      },
    ];
    const r = buildResponseReport({ issues, windowDays: 30, now });
    expect(r.unrepliedIssueIds).toEqual(["older", "younger"]);
  });
});

describe("response-time — routes", () => {
  it("GET /insights/response-time returns 2xx or 404 (never 500)", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/insights/response-time");
    expect([200, 404]).toContain(res.status);
  });

  it("ignores bogus window values", async () => {
    const { default: app } = await import("../app");
    const res = await app.request(
      "/alice/repo/insights/response-time?window=garbage"
    );
    expect([200, 404]).toContain(res.status);
  });
});

describe("response-time — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.parseWindow).toBe(parseWindow);
    expect(__internal.computeTimeToFirstResponse).toBe(
      computeTimeToFirstResponse
    );
    expect(__internal.computeIssueStats).toBe(computeIssueStats);
    expect(__internal.summariseResponseTimes).toBe(summariseResponseTimes);
    expect(__internal.bucketResponseTimes).toBe(bucketResponseTimes);
    expect(__internal.buildResponseReport).toBe(buildResponseReport);
    expect(__internal.formatDuration).toBe(formatDuration);
  });
});
