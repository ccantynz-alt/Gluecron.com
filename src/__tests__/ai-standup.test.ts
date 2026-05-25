/**
 * AI Standup tests.
 *
 * Pure-helper coverage runs unconditionally. The DB-backed branch
 * (notification insertion + same-day dedupe) is gated on DATABASE_URL
 * matching the project convention — see api-tokens.test.ts and friends.
 */

import { describe, it, expect } from "bun:test";
import {
  __test,
  classifyMaterial,
  deliverStandup,
  generateStandup,
  hasStandupForToday,
  utcDayKey,
} from "../lib/ai-standup";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure helpers — no DB, no AI client.
// ---------------------------------------------------------------------------

describe("ai-standup — utcDayKey", () => {
  it("returns YYYY-MM-DD for a Date", () => {
    expect(utcDayKey(new Date("2026-05-25T08:00:00.000Z"))).toBe(
      "2026-05-25"
    );
  });
  it("buckets two timestamps on the same UTC day to the same key", () => {
    const a = new Date("2026-05-25T01:00:00.000Z");
    const b = new Date("2026-05-25T23:59:59.000Z");
    expect(utcDayKey(a)).toBe(utcDayKey(b));
  });
});

describe("ai-standup — classifyMaterial", () => {
  const now = new Date("2026-05-25T09:00:00.000Z");
  const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  it("buckets merged PRs as shipped", () => {
    const out = classifyMaterial({
      now,
      deploys: [],
      issues: [],
      prs: [
        {
          id: "p1",
          number: 12,
          title: "Add /metrics",
          state: "merged",
          isAiBuilt: false,
          mergedAt: oneHourAgo,
          updatedAt: oneHourAgo,
          createdAt: oneHourAgo,
          repo: "demo/repo",
        },
      ],
    });
    expect(out.shipped.length).toBe(1);
    expect(out.shipped[0]).toContain("Merged");
    expect(out.inFlight.length).toBe(0);
    expect(out.atRisk.length).toBe(0);
  });

  it("flags open PRs older than 3 days as at-risk", () => {
    const out = classifyMaterial({
      now,
      deploys: [],
      issues: [],
      prs: [
        {
          id: "p1",
          number: 7,
          title: "WIP refactor",
          state: "open",
          isAiBuilt: false,
          mergedAt: null,
          updatedAt: fourDaysAgo,
          createdAt: fourDaysAgo,
          repo: "demo/repo",
        },
      ],
    });
    expect(out.atRisk.length).toBe(1);
    expect(out.atRisk[0]).toContain("Stale");
    expect(out.inFlight.length).toBe(0);
  });

  it("surfaces ai:build PRs in the aiHighlights bucket", () => {
    const out = classifyMaterial({
      now,
      deploys: [],
      issues: [],
      prs: [
        {
          id: "p1",
          number: 1,
          title: "ai:build add tests for /standups",
          state: "merged",
          isAiBuilt: true,
          mergedAt: oneHourAgo,
          updatedAt: oneHourAgo,
          createdAt: oneHourAgo,
          repo: "demo/repo",
        },
      ],
    });
    expect(out.aiHighlights.length).toBe(1);
  });

  it("counts failed deploys as at-risk and succeeded as shipped", () => {
    const out = classifyMaterial({
      now,
      issues: [],
      prs: [],
      deploys: [
        {
          runId: "r1",
          sha: "deadbeefdeadbeef",
          status: "succeeded",
          startedAt: oneHourAgo,
          finishedAt: oneHourAgo,
        },
        {
          runId: "r2",
          sha: "abcdefabcdefabcd",
          status: "failed",
          startedAt: oneHourAgo,
          finishedAt: oneHourAgo,
        },
      ],
    });
    expect(out.shipped.some((s) => s.includes("succeeded"))).toBe(true);
    expect(out.atRisk.some((s) => s.includes("failed"))).toBe(true);
  });
});

describe("ai-standup — renderFallbackSummary", () => {
  it("renders all three sections when material is empty", () => {
    const out = __test.renderFallbackSummary("daily", {
      shipped: [],
      inFlight: [],
      atRisk: [],
      aiHighlights: [],
    });
    expect(out).toContain("Daily standup");
    expect(out).toContain("Shipped");
    expect(out).toContain("In flight");
    expect(out).toContain("At risk");
  });

  it("includes the AI section only when highlights exist", () => {
    const empty = __test.renderFallbackSummary("daily", {
      shipped: ["one"],
      inFlight: [],
      atRisk: [],
      aiHighlights: [],
    });
    expect(empty).not.toContain("AI-driven changes");
    const filled = __test.renderFallbackSummary("daily", {
      shipped: [],
      inFlight: [],
      atRisk: [],
      aiHighlights: ["AI-authored PR #1"],
    });
    expect(filled).toContain("AI-driven changes");
  });
});

describe("ai-standup — buildPrompt", () => {
  it("includes scope-specific wording", () => {
    const daily = __test.buildPrompt("daily", {
      shipped: [],
      inFlight: [],
      atRisk: [],
      aiHighlights: [],
    });
    expect(daily).toContain("last 24 hours");
    const weekly = __test.buildPrompt("weekly", {
      shipped: [],
      inFlight: [],
      atRisk: [],
      aiHighlights: [],
    });
    expect(weekly).toContain("last 7 days");
  });
});

describe("ai-standup — deliverStandup (canned generator, DI'd)", () => {
  it("dedupes when alreadyDelivered returns true", async () => {
    let generated = 0;
    const res = await deliverStandup({
      userId: "u-1",
      scope: "daily",
      alreadyDelivered: async () => true,
      generate: async () => {
        generated += 1;
        return {
          summary: "should not be called",
          shippedItems: [],
          blockedItems: [],
          atRiskItems: [],
          windowStart: new Date(),
          windowEnd: new Date(),
          aiAvailable: false,
        };
      },
    });
    expect(generated).toBe(0);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("already");
    expect(res.notified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-backed: insert a standup, then confirm the notification + dedupe.
// ---------------------------------------------------------------------------

describe("ai-standup — DB-backed delivery", () => {
  it.skipIf(!HAS_DB)(
    "creates a notification + dedupes on the same UTC day",
    async () => {
      const { db } = await import("../db");
      const { users, notifications } = await import("../db/schema");
      const { aiStandups, userStandupPrefs } = await import(
        "../db/schema-standup"
      );
      const { eq } = await import("drizzle-orm");

      const uname = "stand-" + Math.random().toString(36).slice(2, 10);
      const [user] = await db
        .insert(users)
        .values({
          username: uname,
          email: `${uname}@example.com`,
          passwordHash: "x",
        })
        .returning();

      try {
        const cannedGen = async () => ({
          summary: "## 🚀 Shipped\n- demo\n\n## 🚧 In flight\n- nothing\n\n## ⚠️ At risk\n- nothing",
          shippedItems: ["demo PR"],
          blockedItems: [],
          atRiskItems: [],
          windowStart: new Date(Date.now() - 24 * 3600 * 1000),
          windowEnd: new Date(),
          aiAvailable: true,
        });

        // First call should insert + notify.
        const first = await deliverStandup({
          userId: user.id,
          scope: "daily",
          generate: cannedGen,
        });
        expect(first.ok).toBe(true);
        expect(first.notified).toBe(true);
        expect(first.standupId).toBeTruthy();

        // The notification row should exist with the standup body and a
        // /standups URL.
        const notifs = await db
          .select()
          .from(notifications)
          .where(eq(notifications.userId, user.id));
        expect(notifs.length).toBeGreaterThanOrEqual(1);
        const standupNotif = notifs.find((n) =>
          (n.url || "").startsWith("/standups")
        );
        expect(standupNotif).toBeTruthy();
        expect(standupNotif?.body || "").toContain("Shipped");

        // Second call on the same UTC day should be deduped.
        const second = await deliverStandup({
          userId: user.id,
          scope: "daily",
          generate: cannedGen,
        });
        expect(second.ok).toBe(false);
        expect(second.reason).toContain("already");

        // hasStandupForToday should also report true.
        const dupe = await hasStandupForToday(user.id, "daily", new Date());
        expect(dupe).toBe(true);
      } finally {
        // Clean up rows we created — best-effort.
        try {
          await db
            .delete(aiStandups)
            .where(eq(aiStandups.userId, user.id));
        } catch {
          /* ignore */
        }
        try {
          await db
            .delete(userStandupPrefs)
            .where(eq(userStandupPrefs.userId, user.id));
        } catch {
          /* ignore */
        }
        try {
          await db
            .delete(notifications)
            .where(eq(notifications.userId, user.id));
        } catch {
          /* ignore */
        }
        try {
          await db.delete(users).where(eq(users.id, user.id));
        } catch {
          /* ignore */
        }
      }
    }
  );

  it.skipIf(!HAS_DB)(
    "generateStandup returns a fallback body when AI key is absent",
    async () => {
      // Save and clear the key for this single assertion.
      const prev = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const { db } = await import("../db");
        const { users } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");

        const uname = "stand2-" + Math.random().toString(36).slice(2, 10);
        const [user] = await db
          .insert(users)
          .values({
            username: uname,
            email: `${uname}@example.com`,
            passwordHash: "x",
          })
          .returning();
        try {
          const res = await generateStandup({
            userId: user.id,
            scope: "daily",
          });
          expect(typeof res.summary).toBe("string");
          expect(res.summary.length).toBeGreaterThan(0);
          expect(res.aiAvailable).toBe(false);
        } finally {
          try {
            await db.delete(users).where(eq(users.id, user.id));
          } catch {
            /* ignore */
          }
        }
      } finally {
        if (prev) process.env.ANTHROPIC_API_KEY = prev;
      }
    }
  );
});
