/**
 * Tests for src/lib/ai-cost-tracker.ts.
 *
 * Layered:
 *   1. Pure pricing arithmetic — known inputs → exact cents.
 *   2. Summary aggregation — synthetic in-memory rows → expected rollups.
 *   3. Dashboard helpers (projections, day-bucketing).
 *   4. DB-backed recording flow — gated on HAS_DB; uses a real user row.
 */

import { describe, it, expect } from "bun:test";

import {
  MODEL_PRICING,
  DEFAULT_PRICING,
  aggregateEvents,
  computeCentsForCall,
  dailyAverageCents,
  extractUsage,
  formatCents,
  formatTokens,
  projectMonthEndCents,
  recordAiCost,
  startOfUtcMonth,
  toUtcDayKey,
  summarizeCostsForUser,
} from "../lib/ai-cost-tracker";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ─── 1. Pricing arithmetic ───────────────────────────────────────────────

describe("computeCentsForCall — pricing arithmetic", () => {
  it("returns 0 for an all-zero call", () => {
    expect(computeCentsForCall("claude-sonnet-4-20250514", 0, 0)).toBe(0);
  });

  it("uses the Sonnet rate card: 10k in + 5k out → 10k·0.3¢ + 5k·1.5¢ = 10.5¢ → 11¢", () => {
    const got = computeCentsForCall("claude-sonnet-4-20250514", 10_000, 5_000);
    expect(got).toBe(11);
  });

  it("uses the Haiku rate card: 1M in + 0 out → 100¢ ($1)", () => {
    const got = computeCentsForCall("claude-haiku-4-5", 1_000_000, 0);
    expect(got).toBe(100);
  });

  it("uses the Opus rate card: 1k in + 1k out → ceil(1.5+7.5)=9¢", () => {
    const got = computeCentsForCall("claude-opus-4", 1000, 1000);
    expect(got).toBe(9);
  });

  it("falls back to DEFAULT_PRICING for an unknown model", () => {
    const got = computeCentsForCall("claude-future-9001", 10_000, 5_000);
    const expected = Math.ceil(
      (10_000 / 1000) * DEFAULT_PRICING.inputCentsPer1k +
        (5_000 / 1000) * DEFAULT_PRICING.outputCentsPer1k
    );
    expect(got).toBe(expected);
  });

  it("never returns a negative value, even with negative inputs", () => {
    expect(computeCentsForCall("claude-sonnet-4-20250514", -5, -10)).toBe(0);
  });

  it("never under-counts a real but tiny call to 0¢", () => {
    // 1 token in, 1 token out → fractional cents → must round UP to 1¢.
    const got = computeCentsForCall("claude-sonnet-4-20250514", 1, 1);
    expect(got).toBe(1);
  });

  it("pricing table covers every model id our codebase passes to client.messages.create", () => {
    // Source-of-truth list (kept in sync with ai-client.ts + ai-review.ts).
    const referenced = [
      "claude-sonnet-4-20250514",
      "claude-haiku-4-5-20251001",
    ];
    for (const model of referenced) {
      expect(MODEL_PRICING[model]).toBeDefined();
    }
  });
});

// ─── 2. extractUsage / extractor robustness ─────────────────────────────

describe("extractUsage — Anthropic response shape", () => {
  it("returns zeros for null / non-object input", () => {
    expect(extractUsage(null)).toEqual({ input: 0, output: 0 });
    expect(extractUsage(undefined)).toEqual({ input: 0, output: 0 });
    expect(extractUsage("oops")).toEqual({ input: 0, output: 0 });
  });

  it("reads .usage.input_tokens / .usage.output_tokens", () => {
    const fake = { usage: { input_tokens: 42, output_tokens: 7 } };
    expect(extractUsage(fake)).toEqual({ input: 42, output: 7 });
  });

  it("tolerates missing fields", () => {
    const fake = { usage: { input_tokens: 5 } };
    expect(extractUsage(fake)).toEqual({ input: 5, output: 0 });
  });

  it("ignores non-number fields", () => {
    const fake = { usage: { input_tokens: "5", output_tokens: null } };
    expect(extractUsage(fake)).toEqual({ input: 0, output: 0 });
  });
});

// ─── 3. aggregateEvents — summary rollups ───────────────────────────────

describe("aggregateEvents — summary rollups", () => {
  const synth = [
    {
      occurredAt: new Date("2026-05-01T10:00:00Z"),
      model: "claude-sonnet-4-20250514",
      category: "ai_review",
      repositoryId: "repo-1",
      agentSessionId: "agent-A",
      centsEstimate: 4,
      inputTokens: 1000,
      outputTokens: 200,
    },
    {
      occurredAt: new Date("2026-05-01T11:00:00Z"),
      model: "claude-sonnet-4-20250514",
      category: "ci_healer",
      repositoryId: "repo-1",
      agentSessionId: null,
      centsEstimate: 2,
      inputTokens: 500,
      outputTokens: 100,
    },
    {
      occurredAt: new Date("2026-05-02T11:00:00Z"),
      model: "claude-haiku-4-5",
      category: "ai_review",
      repositoryId: "repo-2",
      agentSessionId: "agent-A",
      centsEstimate: 1,
      inputTokens: 800,
      outputTokens: 50,
    },
  ];

  const summary = aggregateEvents(synth);

  it("rolls up total cents + token totals correctly", () => {
    expect(summary.totalCents).toBe(7);
    expect(summary.totalInputTokens).toBe(2300);
    expect(summary.totalOutputTokens).toBe(350);
  });

  it("buckets by category, sorted by cents DESC", () => {
    expect(summary.byCategory.map((c) => c.category)).toEqual([
      "ai_review",
      "ci_healer",
    ]);
    expect(summary.byCategory[0].cents).toBe(5);
    expect(summary.byCategory[1].cents).toBe(2);
  });

  it("buckets by model", () => {
    const sonnet = summary.byModel.find(
      (m) => m.model === "claude-sonnet-4-20250514"
    );
    const haiku = summary.byModel.find((m) => m.model === "claude-haiku-4-5");
    expect(sonnet?.cents).toBe(6);
    expect(haiku?.cents).toBe(1);
  });

  it("buckets by repository_id", () => {
    const repo1 = summary.byRepo.find((r) => r.repositoryId === "repo-1");
    const repo2 = summary.byRepo.find((r) => r.repositoryId === "repo-2");
    expect(repo1?.cents).toBe(6);
    expect(repo2?.cents).toBe(1);
  });

  it("buckets by agent_session_id (incl. null bucket)", () => {
    const agentA = summary.byAgent.find((a) => a.agentSessionId === "agent-A");
    const noAgent = summary.byAgent.find((a) => a.agentSessionId === null);
    expect(agentA?.cents).toBe(5);
    expect(noAgent?.cents).toBe(2);
  });

  it("buckets by UTC day, sorted ascending", () => {
    expect(summary.byDay).toEqual([
      { day: "2026-05-01", cents: 6 },
      { day: "2026-05-02", cents: 1 },
    ]);
  });

  it("returns zeros on an empty row set", () => {
    const empty = aggregateEvents([]);
    expect(empty.totalCents).toBe(0);
    expect(empty.byCategory).toHaveLength(0);
    expect(empty.byDay).toHaveLength(0);
  });
});

// ─── 4. Projection + formatting helpers ─────────────────────────────────

describe("projection + formatting helpers", () => {
  it("startOfUtcMonth pins to day 1 at 00:00Z", () => {
    const d = new Date("2026-05-25T18:34:00Z");
    expect(startOfUtcMonth(d).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("projectMonthEndCents linearly extrapolates from elapsed time", () => {
    // 31-day month (May). Halfway through (May 16 UTC noon-ish) →
    // projected ≈ 2x cents so far. Allow 10% slack for ms-precision drift.
    const now = new Date("2026-05-16T00:00:00Z");
    const projected = projectMonthEndCents(100, now);
    expect(projected).toBeGreaterThan(180);
    expect(projected).toBeLessThan(225);
  });

  it("projectMonthEndCents returns the same number on the last day", () => {
    const now = new Date("2026-05-31T23:59:59Z");
    const projected = projectMonthEndCents(500, now);
    expect(projected).toBeGreaterThanOrEqual(500);
    // Should not balloon by more than a fraction of a percent.
    expect(projected).toBeLessThan(502);
  });

  it("dailyAverageCents divides cents-so-far by elapsed days", () => {
    // May 10 UTC → day 10 of the month elapsed → avg = 100¢ / 10 = 10¢.
    const now = new Date("2026-05-10T12:00:00Z");
    expect(dailyAverageCents(100, now)).toBe(10);
  });

  it("formatCents renders cents → $X.YY", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(7)).toBe("$0.07");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(123456)).toBe("$1,234.56");
  });

  it("formatTokens groups thousands", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234)).toBe("1,234");
    expect(formatTokens(1_234_567)).toBe("1,234,567");
  });

  it("toUtcDayKey is stable across timezones", () => {
    expect(toUtcDayKey(new Date("2026-05-25T23:59:59Z"))).toBe("2026-05-25");
    expect(toUtcDayKey(new Date("2026-05-25T00:00:01Z"))).toBe("2026-05-25");
  });
});

// ─── 5. DB-backed recordAiCost — gated on HAS_DB ────────────────────────

describe.skipIf(!HAS_DB)("recordAiCost — DB-backed", () => {
  it.skipIf(!HAS_DB)(
    "inserts a row that summarizeCostsForUser can find",
    async () => {
      const { db } = await import("../db");
      const { users } = await import("../db/schema");
      // Mint a throwaway user.
      const [u] = await db
        .insert(users)
        .values({
          username: `cost-test-${Date.now()}`,
          email: `cost-${Date.now()}@example.invalid`,
          passwordHash: "$2a$10$" + "x".repeat(53),
        })
        .returning();

      await recordAiCost({
        ownerUserId: u.id,
        model: "claude-sonnet-4-20250514",
        inputTokens: 10_000,
        outputTokens: 5_000,
        category: "ai_review",
        sourceKind: "pull_request",
      });
      await recordAiCost({
        ownerUserId: u.id,
        model: "claude-haiku-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
        category: "other",
        sourceKind: "commit_message",
      });

      const summary = await summarizeCostsForUser(u.id);
      // Sonnet row → 11¢ ; Haiku row → 100¢.
      expect(summary.totalCents).toBe(111);
      const cats = summary.byCategory.map((c) => c.category).sort();
      expect(cats).toEqual(["ai_review", "other"]);
      // byModel should split correctly too.
      const sonnet = summary.byModel.find(
        (m) => m.model === "claude-sonnet-4-20250514"
      );
      expect(sonnet?.inputTokens).toBe(10_000);
      expect(sonnet?.outputTokens).toBe(5_000);
    }
  );

  it.skipIf(!HAS_DB)(
    "never throws on bad input — swallows DB errors",
    async () => {
      await expect(
        recordAiCost({
          ownerUserId: "not-a-uuid",
          model: "x",
          inputTokens: 1,
          outputTokens: 1,
          category: "ai_review",
        })
      ).resolves.toBeUndefined();
    }
  );
});
