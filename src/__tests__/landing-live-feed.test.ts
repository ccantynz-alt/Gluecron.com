/**
 * Block M1 — Live-now landing feed tests.
 *
 * Covers:
 *   - The new "Live now" section renders with SSR data
 *   - Empty-state copy renders when all four endpoints return empty
 *   - The inline poller script is present + references the four
 *     `/api/v2/demo/*` endpoints + `setInterval`
 *   - `relativeTimeFromNow` handles <60s, <60m, <24h, >24h, future, NaN,
 *     null, undefined, Date, ISO string, number
 *
 * DB-mocking strategy: spread-from-real (K1 pattern). We capture the
 * real `../lib/demo-activity` module *before* installing `mock.module`
 * so every other export keeps working, then restore in `afterAll`.
 * The five listing helpers are replaced with deterministic stubs that
 * a test can mutate via `setLiveFeedStubs`.
 */

import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import {
  relativeTimeFromNow,
  LandingPage,
  type LandingLiveFeed,
} from "../views/landing";

// ---------------------------------------------------------------------
// Spread-from-real stubs for the demo-activity helpers.
// ---------------------------------------------------------------------

const _real_demoActivity = await import("../lib/demo-activity");

let _stubQueued: any[] = [];
let _stubMerges: any[] = [];
let _stubReviews: any[] = [];
let _stubReviewCount = 0;
let _stubFeed: any[] = [];

function setLiveFeedStubs(opts: {
  queued?: any[];
  merges?: any[];
  reviews?: any[];
  reviewCount?: number;
  feed?: any[];
}): void {
  if (opts.queued !== undefined) _stubQueued = opts.queued;
  if (opts.merges !== undefined) _stubMerges = opts.merges;
  if (opts.reviews !== undefined) _stubReviews = opts.reviews;
  if (opts.reviewCount !== undefined) _stubReviewCount = opts.reviewCount;
  if (opts.feed !== undefined) _stubFeed = opts.feed;
}

mock.module("../lib/demo-activity", () => ({
  ..._real_demoActivity,
  listQueuedAiBuildIssues: async () => _stubQueued,
  listRecentAutoMerges: async () => _stubMerges,
  listRecentAiReviews: async () => _stubReviews,
  countAiReviewsSince: async () => _stubReviewCount,
  listDemoActivityFeed: async () => _stubFeed,
}));

afterAll(() => {
  _stubQueued = [];
  _stubMerges = [];
  _stubReviews = [];
  _stubReviewCount = 0;
  _stubFeed = [];
  // Best-effort restoration. Downstream test files that already
  // imported demo-activity have their bindings cached — this is a
  // hygiene measure for files using dynamic imports.
  mock.module("../lib/demo-activity", () => _real_demoActivity);
});

beforeEach(() => {
  _stubQueued = [];
  _stubMerges = [];
  _stubReviews = [];
  _stubReviewCount = 0;
  _stubFeed = [];
});

// ---------------------------------------------------------------------
// SSR fixtures — used by the JSX-level renders below.
// ---------------------------------------------------------------------

const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000);
const TWO_HOUR_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000);

const FULL_LIVE_FEED: LandingLiveFeed = {
  queued: [
    {
      repo: "todo-api",
      number: 42,
      title: "Add JSON export",
      createdAt: FIVE_MIN_AGO,
    },
    {
      repo: "hello-python",
      number: 7,
      title: "Wire up CLI flag",
      createdAt: FIVE_MIN_AGO,
    },
  ],
  merges: [
    {
      repo: "todo-api",
      number: 88,
      title: "Fix flake in test",
      mergedAt: FIVE_MIN_AGO,
    },
  ],
  reviews: [
    {
      repo: "todo-api",
      prNumber: 91,
      commentSnippet: "Looks good, minor nit on naming.",
      createdAt: TWO_HOUR_AGO,
    },
  ],
  reviewCount: 47,
  feed: [
    {
      kind: "auto_merge.merged",
      repo: "todo-api",
      ref: { type: "pr", number: 88 },
      at: FIVE_MIN_AGO,
    },
    {
      kind: "ai_review.posted",
      repo: "todo-api",
      ref: { type: "pr", number: 91 },
      at: TWO_HOUR_AGO,
    },
    {
      kind: "ai_build.dispatched",
      repo: "hello-python",
      ref: { type: "issue", number: 7 },
      at: FIVE_MIN_AGO,
    },
  ],
};

const EMPTY_LIVE_FEED: LandingLiveFeed = {
  queued: [],
  merges: [],
  reviews: [],
  reviewCount: 0,
  feed: [],
};

// `LandingPage` is a JSX function component; calling it directly returns
// a hono/jsx node whose `.toString()` is the rendered HTML. We avoid
// JSX literals in this `.ts` test file (Bun's test loader only enables
// JSX parsing for `.tsx`) and instead invoke the component as a plain
// function — semantically identical, no JSX transform required.
async function renderLanding(props: {
  liveFeed?: LandingLiveFeed | null;
}): Promise<string> {
  // hono/jsx components return a Promise<HtmlEscapedString> or an
  // HtmlEscapedString — either way, awaiting + String() yields HTML.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const node: any = await (LandingPage as any)(props);
  return String(node);
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("Block M1 — Live-now section SSR", () => {
  it("renders the Live now heading + pulse + endpoint script when liveFeed is present", async () => {
    const html = await renderLanding({ liveFeed: FULL_LIVE_FEED });
    expect(html).toContain("Live now");
    expect(html).toContain(
      "Claude is working on demo repos as you read this."
    );
    // Pulse indicator class is the cheap "is the live block here" tell.
    expect(html).toContain("landing-livenow-pulse");
    expect(html).toContain("landing-livenow-grid");
  });

  it("renders the four card titles", async () => {
    const html = await renderLanding({ liveFeed: FULL_LIVE_FEED });
    expect(html).toContain("Issues queued for AI");
    expect(html).toContain("Recently merged by AI");
    expect(html).toContain("AI reviews posted");
    expect(html).toContain("Activity feed");
  });

  it("renders the queued issue + merge + review rows from the SSR snapshot", async () => {
    const html = await renderLanding({ liveFeed: FULL_LIVE_FEED });
    expect(html).toContain("#42");
    expect(html).toContain("Add JSON export");
    expect(html).toContain("#88");
    expect(html).toContain("Fix flake in test");
    expect(html).toContain("#91");
    expect(html).toContain("Looks good, minor nit on naming.");
    // Review count visible.
    expect(html).toContain("47");
    expect(html).toContain("reviews today");
  });

  it("renders the activity feed entries with their kind labels", async () => {
    const html = await renderLanding({ liveFeed: FULL_LIVE_FEED });
    expect(html).toContain("auto-merged");
    expect(html).toContain("AI review posted");
    expect(html).toContain("AI-build queued");
  });

  it("renders the CTA banner at the bottom of the section", async () => {
    const html = await renderLanding({ liveFeed: FULL_LIVE_FEED });
    expect(html).toContain("Want this for your repos?");
    expect(html).toContain('href="/register"');
    expect(html).toContain('href="/demo"');
  });

  it("renders friendly empty states when all four endpoints return empty", async () => {
    const html = await renderLanding({ liveFeed: EMPTY_LIVE_FEED });
    // The block still renders.
    expect(html).toContain("Live now");
    expect(html).toContain("landing-livenow-grid");
    // Empty-state copy for each card.
    expect(html).toContain("No queued AI builds");
    expect(html).toContain("No auto-merges in the last 24h");
    expect(html).toContain("No AI reviews in the last 24h");
    expect(html).toContain("Quiet right now");
    // Big-number count falls back to 0.
    expect(html).toMatch(/data-tick-target="0"/);
  });

  it("still renders the live section when liveFeed is absent (null)", async () => {
    const html = await renderLanding({ liveFeed: null });
    expect(html).toContain("Live now");
    expect(html).toContain("No queued AI builds");
  });
});

describe("Block M1 — inline poller script", () => {
  it("contains setInterval + the four /api/v2/demo/* endpoint URLs", async () => {
    const html = await renderLanding({ liveFeed: EMPTY_LIVE_FEED });
    expect(html).toContain("setInterval");
    expect(html).toContain("/api/v2/demo/queued");
    expect(html).toContain("/api/v2/demo/merges");
    expect(html).toContain("/api/v2/demo/reviews");
    expect(html).toContain("/api/v2/demo/activity");
  });

  it("refreshes on visibilitychange (tab focus)", async () => {
    const html = await renderLanding({ liveFeed: EMPTY_LIVE_FEED });
    expect(html).toContain("visibilitychange");
    expect(html).toContain("visibilityState");
  });

  it("ticks numbers + flashes new rows", async () => {
    const html = await renderLanding({ liveFeed: EMPTY_LIVE_FEED });
    // The implementation labels for the two motion effects.
    expect(html).toContain("tickNumber");
    expect(html).toContain("flashRow");
    expect(html).toContain("landing-livecard-flash");
  });
});

describe("Block M1 — relativeTimeFromNow helper edges", () => {
  const NOW = 1_700_000_000_000;

  it("returns 'just now' for deltas under 60 seconds", () => {
    expect(relativeTimeFromNow(NOW - 5_000, NOW)).toBe("just now");
    expect(relativeTimeFromNow(NOW - 59_000, NOW)).toBe("just now");
    expect(relativeTimeFromNow(NOW, NOW)).toBe("just now");
  });

  it("returns 'about N minutes ago' under an hour", () => {
    expect(relativeTimeFromNow(NOW - 60_000, NOW)).toBe("about 1 minute ago");
    expect(relativeTimeFromNow(NOW - 5 * 60_000, NOW)).toBe(
      "about 5 minutes ago"
    );
    expect(relativeTimeFromNow(NOW - 59 * 60_000, NOW)).toBe(
      "about 59 minutes ago"
    );
  });

  it("returns 'about N hours ago' under a day", () => {
    expect(relativeTimeFromNow(NOW - 60 * 60_000, NOW)).toBe(
      "about 1 hour ago"
    );
    expect(relativeTimeFromNow(NOW - 23 * 60 * 60_000, NOW)).toBe(
      "about 23 hours ago"
    );
  });

  it("returns 'about N days ago' beyond 24h", () => {
    expect(relativeTimeFromNow(NOW - 24 * 60 * 60_000, NOW)).toBe(
      "about 1 day ago"
    );
    expect(relativeTimeFromNow(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe(
      "about 3 days ago"
    );
  });

  it("treats future timestamps as 'just now' (clock skew tolerance)", () => {
    expect(relativeTimeFromNow(NOW + 5_000, NOW)).toBe("just now");
    expect(relativeTimeFromNow(NOW + 10 * 60_000, NOW)).toBe("just now");
  });

  it("treats NaN / null / undefined / unparseable strings as 'just now'", () => {
    expect(relativeTimeFromNow(NaN, NOW)).toBe("just now");
    expect(relativeTimeFromNow(null, NOW)).toBe("just now");
    expect(relativeTimeFromNow(undefined, NOW)).toBe("just now");
    expect(relativeTimeFromNow("not a date", NOW)).toBe("just now");
  });

  it("accepts ISO strings + Date instances", () => {
    expect(
      relativeTimeFromNow(new Date(NOW - 2 * 60_000).toISOString(), NOW)
    ).toBe("about 2 minutes ago");
    expect(relativeTimeFromNow(new Date(NOW - 60 * 60_000), NOW)).toBe(
      "about 1 hour ago"
    );
  });
});

describe("Block M1 — landing route integration", () => {
  // 2026-06-10: GET / now serves the self-contained Landing2030Page;
  // the legacy LandingPage (and its Live-now block, covered above at the
  // component level) no longer renders on the home route. The route
  // integration contract is therefore: / responds 200 with the 2030 hero.
  it("GET / renders the 2030 landing page", async () => {
    setLiveFeedStubs({
      queued: [
        {
          repo: "todo-api",
          number: 42,
          title: "Add JSON export",
          createdAt: new Date(),
        },
      ],
      merges: [],
      reviews: [],
      reviewCount: 12,
      feed: [],
    });
    const app = (await import("../app")).default;
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hero-actions");
    expect(body).toContain('href="/register"');
  });
});
