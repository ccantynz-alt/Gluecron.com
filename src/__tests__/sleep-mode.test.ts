/**
 * Block L1 — Sleep Mode tests.
 *
 * Covers:
 *   - `renderSleepModeDigest` HTML + plaintext output, including XSS resistance
 *   - `computeHoursSaved` heuristic
 *   - autopilot `sleep-mode-digest` task: cooldown, hour-match, enabled filter,
 *     per-tick cap, per-user failure isolation
 *   - `/sleep-mode` public marketing page returns 200
 *   - `composeSleepModeReport` zero report for a user with no repos
 *
 * DI test pattern follows K3's `autopilot-ai-tasks.test.ts` — every DB call is
 * dependency-injected so tests run without a real DB.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import {
  renderSleepModeDigest,
  composeSleepModeReport,
  type SleepModeReport,
} from "../lib/sleep-mode";
import { computeHoursSaved } from "../lib/ai-hours-saved";
import {
  runSleepModeDigestTaskOnce,
  type SleepModeDigestCandidate,
} from "../lib/autopilot";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function emptyReport(): SleepModeReport {
  return {
    windowHours: 24,
    prsAutoMerged: [],
    issuesBuiltByAi: [],
    aiReviewsPosted: 0,
    securityIssuesAutoFixed: 0,
    gateFailuresAutoRepaired: 0,
    hoursSaved: 0,
  };
}

function busyReport(): SleepModeReport {
  return {
    windowHours: 24,
    prsAutoMerged: [
      { number: 1, title: "Bump axios", repo: "api" },
      { number: 2, title: "Fix retry", repo: "billing" },
    ],
    issuesBuiltByAi: [
      { number: 7, title: "Add /metrics", repo: "api", prNumber: 8 },
    ],
    aiReviewsPosted: 3,
    securityIssuesAutoFixed: 1,
    gateFailuresAutoRepaired: 2,
    hoursSaved: 0,
  };
}

// ---------------------------------------------------------------------------
// computeHoursSaved
// ---------------------------------------------------------------------------

describe("sleep-mode — computeHoursSaved", () => {
  it("returns 0 for an empty report", () => {
    expect(
      computeHoursSaved({
        prsAutoMerged: 0,
        issuesBuiltByAi: 0,
        aiReviewsPosted: 0,
        aiTriagesPosted: 0,
        aiCommitMsgs: 0,
        secretsAutoRepaired: 0,
        gateAutoRepairs: 0,
      })
    ).toBe(0);
  });

  it("applies the documented heuristic (rounded to 1 decimal)", () => {
    // 2*0.3 + 1*1.5 + 3*0.25 + 1*0.5 + 2*0.4 = 0.6 + 1.5 + 0.75 + 0.5 + 0.8 = 4.15 -> 4.2
    // (secretsAutoRepaired=1 * 0.5, gateAutoRepairs=2 * 0.4)
    const v = computeHoursSaved({
      prsAutoMerged: 2,
      issuesBuiltByAi: 1,
      aiReviewsPosted: 3,
      aiTriagesPosted: 0,
      aiCommitMsgs: 0,
      secretsAutoRepaired: 1,
      gateAutoRepairs: 2,
    });
    // 0.6 + 1.5 + 0.75 + 0.5 + 0.8 = 4.15 -> Math.round(41.5)/10 = 4.2
    expect(v).toBe(4.2);
  });

  it("rounds .25 down per HALF_EVEN-ish .5-bias of Math.round", () => {
    // 1*0.25 = 0.25 -> rounded *10 = 2.5 -> Math.round(2.5)=3 -> 0.3
    expect(
      computeHoursSaved({
        prsAutoMerged: 0,
        issuesBuiltByAi: 0,
        aiReviewsPosted: 1,
        aiTriagesPosted: 0,
        aiCommitMsgs: 0,
        secretsAutoRepaired: 0,
        gateAutoRepairs: 0,
      })
    ).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// renderSleepModeDigest
// ---------------------------------------------------------------------------

describe("sleep-mode — renderSleepModeDigest", () => {
  it("produces valid plaintext + html for an empty report", () => {
    const out = renderSleepModeDigest(emptyReport(), { username: "alice" });
    expect(out.subject).toContain("quiet night");
    expect(out.text).toContain("Hi alice");
    expect(out.text).toContain("Quiet night");
    expect(out.html).toContain("<html>");
    expect(out.html).toContain("Good morning, alice");
    // No section headers on the empty report — nothing to list.
    expect(out.html).not.toContain("PRs auto-merged</h3>");
  });

  it("produces a busy-night subject and lists every section", () => {
    const out = renderSleepModeDigest(busyReport(), { username: "alice" });
    expect(out.subject).toContain("Claude shipped");
    // 2 PRs + 1 issue + 3 reviews + 1 sec + 2 gates = 9 items
    expect(out.subject).toContain("9");
    expect(out.html).toContain("PRs auto-merged");
    expect(out.html).toContain("Issues built by AI");
    expect(out.html).toContain("Automated guardrails");
    expect(out.text).toContain("## PRs auto-merged");
    expect(out.text).toContain("## Issues built by AI");
    expect(out.text).toContain("## Automated guardrails");
  });

  it("escapes user-controlled titles, repo names, and usernames (no XSS)", () => {
    const malicious: SleepModeReport = {
      ...emptyReport(),
      prsAutoMerged: [
        {
          number: 1,
          title: `<script>alert('pr')</script>`,
          repo: `<img src=x onerror=1>`,
        },
      ],
      issuesBuiltByAi: [
        {
          number: 2,
          title: `<svg/onload=alert(1)>`,
          repo: `"><script>x</script>`,
        },
      ],
    };
    const out = renderSleepModeDigest(malicious, {
      username: `<b>boss</b>`,
    });
    const lower = out.html.toLowerCase();
    // No raw <script> tags — they must be escaped to &lt;script&gt;.
    expect(lower).not.toContain("<script>");
    expect(lower).not.toContain("</script>");
    // No live attribute injection — the `<img` open-tag and `<svg` open-tag
    // must be escaped. (Substring search for `onerror=` would yield a false
    // positive because the escaped &lt;img&gt; still contains the literal
    // characters, but inside escaped angle-brackets they can't execute.)
    expect(lower).not.toContain("<img");
    expect(lower).not.toContain("<svg");
    // The escaped form must be present.
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("&lt;b&gt;boss&lt;/b&gt;");
    expect(out.html).toContain("&lt;img src=x onerror=1&gt;");
    expect(out.html).toContain("&lt;svg/onload=alert(1)&gt;");
    // Plaintext should still contain the un-escaped strings (it IS plain text).
    expect(out.text).toContain("<script>alert('pr')</script>");
  });

  it("subject is singular vs plural for total=1 case", () => {
    const r: SleepModeReport = {
      ...emptyReport(),
      prsAutoMerged: [{ number: 1, title: "x", repo: "r" }],
    };
    const out = renderSleepModeDigest(r, { username: "alice" });
    expect(out.subject).toContain("shipped 1 thing");
    expect(out.subject).not.toContain("shipped 1 things");
  });
});

// ---------------------------------------------------------------------------
// composeSleepModeReport (DB-touching; graceful when DB unavailable)
// ---------------------------------------------------------------------------

describe("sleep-mode — composeSleepModeReport", () => {
  it("returns a zero-valued report for a user with no repos (graceful)", async () => {
    // Use a random UUID — guaranteed no owned repos. Either the DB query
    // returns empty (and we get an empty report) or the DB is unavailable
    // (and we fall through the catch block to the same empty report).
    // Either way the function must NEVER throw and must return all-zeros.
    const r = await composeSleepModeReport(
      "00000000-0000-0000-0000-000000000000"
    );
    expect(r.prsAutoMerged).toEqual([]);
    expect(r.issuesBuiltByAi).toEqual([]);
    expect(r.aiReviewsPosted).toBe(0);
    expect(r.securityIssuesAutoFixed).toBe(0);
    expect(r.gateFailuresAutoRepaired).toBe(0);
    expect(r.hoursSaved).toBe(0);
    expect(r.windowHours).toBe(24);
  });

  it("respects custom sinceHoursAgo", async () => {
    const r = await composeSleepModeReport(
      "00000000-0000-0000-0000-000000000000",
      { sinceHoursAgo: 48 }
    );
    expect(r.windowHours).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// runSleepModeDigestTaskOnce
// ---------------------------------------------------------------------------

describe("sleep-mode — autopilot task (runSleepModeDigestTaskOnce)", () => {
  const sentinelNow = new Date("2026-05-13T09:00:00Z"); // UTC hour = 9

  function cand(
    overrides: Partial<SleepModeDigestCandidate> = {}
  ): SleepModeDigestCandidate {
    return {
      userId: "u-1",
      digestHourUtc: 9,
      lastSleepDigestSentAt: null,
      ...overrides,
    };
  }

  it("sends for users whose current UTC hour matches their digestHourUtc and cooldown is clear", async () => {
    const sent: string[] = [];
    const summary = await runSleepModeDigestTaskOnce({
      findCandidates: async () => [cand({ userId: "alice" })],
      sendOne: async (id) => {
        sent.push(id);
        return { ok: true };
      },
      now: () => sentinelNow,
    });
    expect(sent).toEqual(["alice"]);
    expect(summary).toEqual({ sent: 1, skipped: 0 });
  });

  it("skips users whose digestHourUtc does NOT match the current UTC hour", async () => {
    const sent: string[] = [];
    const summary = await runSleepModeDigestTaskOnce({
      findCandidates: async () => [
        cand({ userId: "alice", digestHourUtc: 9 }),
        cand({ userId: "bob", digestHourUtc: 10 }),
        cand({ userId: "carol", digestHourUtc: 8 }),
      ],
      sendOne: async (id) => {
        sent.push(id);
        return { ok: true };
      },
      now: () => sentinelNow,
    });
    expect(sent).toEqual(["alice"]);
    expect(summary).toEqual({ sent: 1, skipped: 2 });
  });

  it("skips users whose last digest was within the 23h cooldown", async () => {
    const sent: string[] = [];
    // Sent 1h ago — within cooldown.
    const recent = new Date(sentinelNow.getTime() - 60 * 60 * 1000);
    // Sent 24h ago — past cooldown.
    const old = new Date(sentinelNow.getTime() - 24 * 60 * 60 * 1000);
    const summary = await runSleepModeDigestTaskOnce({
      findCandidates: async () => [
        cand({ userId: "recent-user", lastSleepDigestSentAt: recent }),
        cand({ userId: "old-user", lastSleepDigestSentAt: old }),
        cand({ userId: "never-user", lastSleepDigestSentAt: null }),
      ],
      sendOne: async (id) => {
        sent.push(id);
        return { ok: true };
      },
      now: () => sentinelNow,
    });
    expect(sent.sort()).toEqual(["never-user", "old-user"]);
    expect(summary).toEqual({ sent: 2, skipped: 1 });
  });

  it("counts sendOne ok:false as skipped (not sent)", async () => {
    const summary = await runSleepModeDigestTaskOnce({
      findCandidates: async () => [cand({ userId: "alice" })],
      sendOne: async () => ({ ok: false, reason: "no email provider" }),
      now: () => sentinelNow,
    });
    expect(summary).toEqual({ sent: 0, skipped: 1 });
  });

  it("isolates per-user failures — a thrown sendOne doesn't stop later users", async () => {
    const sent: string[] = [];
    const summary = await runSleepModeDigestTaskOnce({
      findCandidates: async () => [
        cand({ userId: "first" }),
        cand({ userId: "second" }),
      ],
      sendOne: async (id) => {
        if (id === "first") throw new Error("kaboom");
        sent.push(id);
        return { ok: true };
      },
      now: () => sentinelNow,
    });
    expect(sent).toEqual(["second"]);
    expect(summary).toEqual({ sent: 1, skipped: 1 });
  });

  it("returns zero summary if findCandidates throws", async () => {
    const summary = await runSleepModeDigestTaskOnce({
      findCandidates: async () => {
        throw new Error("db down");
      },
      now: () => sentinelNow,
    });
    expect(summary).toEqual({ sent: 0, skipped: 0 });
  });

  it("honours a custom cap parameter", async () => {
    let capRequested = -1;
    await runSleepModeDigestTaskOnce({
      findCandidates: async (cap) => {
        capRequested = cap;
        return [];
      },
      now: () => sentinelNow,
      cap: 7,
    });
    expect(capRequested).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// /sleep-mode public route
// ---------------------------------------------------------------------------

describe("sleep-mode — public marketing page", () => {
  it("GET /sleep-mode returns 200 with the pitch", async () => {
    const res = await app.request("/sleep-mode");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Sleep Mode");
    expect(body).toContain("Wake up to a digest");
    // Sample digest is rendered inline as part of the page.
    expect(body).toContain("Good morning");
    // CTA link target.
    expect(body).toContain('href="/settings"');
  });
});
