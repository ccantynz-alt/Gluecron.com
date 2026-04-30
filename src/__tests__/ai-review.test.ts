/**
 * Tests for src/lib/ai-review.ts.
 *
 * The Anthropic-calling path (reviewDiff) and the DB-touching paths
 * (triggerAiReview's idempotency probe + insert) require external
 * services we don't stand up in unit tests. We therefore cover the
 * pure invariants:
 *
 *   - The marker constant is stable so future searches keep working.
 *   - isAiReviewEnabled is a boolean reflecting config.anthropicApiKey.
 *   - triggerAiReview is a no-op (resolves cleanly) when the API key
 *     is absent — this is the documented graceful-degrade contract.
 *   - triggerAiReview never throws even when called with garbage.
 *   - The internal __test helpers are exported and shaped correctly.
 */

import { describe, it, expect } from "bun:test";
import {
  AI_REVIEW_MARKER,
  isAiReviewEnabled,
  triggerAiReview,
  __test,
} from "../lib/ai-review";

describe("AI_REVIEW_MARKER", () => {
  it("is the documented stable string", () => {
    // Important: any change to this string is a breaking change for
    // idempotency. New version → write a migration to back-fill old
    // markers so older AI summaries still suppress duplicates.
    expect(AI_REVIEW_MARKER).toBe("<!-- gluecron-ai-review:summary -->");
  });

  it("is an HTML comment so it doesn't render in markdown", () => {
    expect(AI_REVIEW_MARKER.startsWith("<!--")).toBe(true);
    expect(AI_REVIEW_MARKER.endsWith("-->")).toBe(true);
  });
});

describe("isAiReviewEnabled", () => {
  it("returns a boolean", () => {
    const v = isAiReviewEnabled();
    expect(typeof v).toBe("boolean");
  });
});

describe("triggerAiReview — graceful degrade + crash-free", () => {
  // Note: in the test sandbox ANTHROPIC_API_KEY is unset, so the
  // function should resolve immediately without touching the DB. We
  // also pass garbage repo names + nonexistent PR ids to confirm the
  // overall try/catch holds.
  it("resolves without throwing when API key is absent", async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await triggerAiReview(
        "alice",
        "demo",
        "00000000-0000-0000-0000-000000000000",
        "Test PR",
        "Body",
        "main",
        "feature"
      );
    } finally {
      if (before) process.env.ANTHROPIC_API_KEY = before;
    }
    expect(true).toBe(true);
  });

  it("never throws even with invalid inputs", async () => {
    let threw = false;
    try {
      await triggerAiReview(
        "",
        "",
        "not-a-uuid",
        "",
        "",
        "",
        ""
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("survives an unknown branch combination without throwing", async () => {
    let threw = false;
    try {
      await triggerAiReview(
        "definitely-not-a-real-owner",
        "definitely-not-a-real-repo",
        "00000000-0000-0000-0000-000000000000",
        "Title",
        "Body",
        "definitely-not-a-real-base",
        "definitely-not-a-real-head"
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("__test internals", () => {
  it("exports diffBetweenBranches and alreadyReviewed", () => {
    expect(typeof __test.diffBetweenBranches).toBe("function");
    expect(typeof __test.alreadyReviewed).toBe("function");
  });

  it("diffBetweenBranches returns '' for a nonexistent repo", async () => {
    const out = await __test.diffBetweenBranches(
      "definitely-not-a-real-owner",
      "definitely-not-a-real-repo",
      "main",
      "feature"
    );
    expect(out).toBe("");
  });

  it("alreadyReviewed returns false for an unknown PR id (fail-open)", async () => {
    const out = await __test.alreadyReviewed("00000000-0000-0000-0000-000000000000");
    expect(out).toBe(false);
  });
});
