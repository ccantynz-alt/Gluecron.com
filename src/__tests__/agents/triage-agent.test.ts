/**
 * Block K4 — Triage agent tests.
 *
 * Pure-side tests only. We never touch Claude here — the happy path exercises
 * the deterministic "no AI backend" branch by clearing ANTHROPIC_API_KEY in
 * beforeEach, mirroring the style of src/__tests__/prod-signals.test.ts and
 * src/__tests__/copilot.test.ts.
 *
 * The triage agent's DB writes degrade gracefully (it calls `startAgentRun`
 * which catches exceptions and returns null), so running these tests without
 * a live DB still yields a well-shaped result object — just with runId null.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  runTriageAgent,
  normaliseTriagePayload,
  validateTriageArgs,
  estimateHaikuCents,
  renderTriageComment,
  buildRunSummary,
  type TriageClassification,
} from "../../lib/agents/triage-agent";

const hadKey = !!process.env.ANTHROPIC_API_KEY;
const originalKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  // Force the deterministic (no-AI) path. Individual tests that want to
  // simulate a key can set it locally and restore before returning.
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (hadKey) {
    process.env.ANTHROPIC_API_KEY = originalKey;
  } else {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// validateTriageArgs — pure
// ---------------------------------------------------------------------------

describe("triage-agent — validateTriageArgs", () => {
  const base = {
    kind: "issue" as const,
    repositoryId: "00000000-0000-0000-0000-000000000000",
    itemId: "00000000-0000-0000-0000-000000000001",
    itemNumber: 1,
    title: "Something is broken",
    body: "Details here.",
  };

  it("accepts a well-formed issue", () => {
    expect(validateTriageArgs(base)).toEqual({ ok: true });
  });

  it("accepts a well-formed PR", () => {
    expect(validateTriageArgs({ ...base, kind: "pr" })).toEqual({ ok: true });
  });

  it("rejects an empty title", () => {
    const r = validateTriageArgs({ ...base, title: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty title/i);
  });

  it("rejects a missing title", () => {
    const r = validateTriageArgs({ ...base, title: undefined as unknown as string });
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid kind", () => {
    const r = validateTriageArgs({
      ...base,
      kind: "wat" as unknown as "issue",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/kind/);
  });

  it("rejects a missing repositoryId", () => {
    const r = validateTriageArgs({ ...base, repositoryId: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-finite itemNumber", () => {
    const r = validateTriageArgs({ ...base, itemNumber: NaN });
    expect(r.ok).toBe(false);
  });

  it("rejects a zero / negative itemNumber", () => {
    expect(validateTriageArgs({ ...base, itemNumber: 0 }).ok).toBe(false);
    expect(validateTriageArgs({ ...base, itemNumber: -7 }).ok).toBe(false);
  });

  it("accepts an empty body (body is not required content-wise)", () => {
    // A bare title with no body should still be triage-able.
    expect(validateTriageArgs({ ...base, body: "" })).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// normaliseTriagePayload — pure JSON coercion
// ---------------------------------------------------------------------------

describe("triage-agent — normaliseTriagePayload", () => {
  it("returns default classification for non-object input", () => {
    const out = normaliseTriagePayload(null);
    expect(out.category).toBe("chore");
    expect(out.complexity).toBe("unknown");
    expect(out.priority).toBe("unknown");
    expect(out.labels).toEqual([]);
    expect(out.suggestedReviewers).toEqual([]);
  });

  it("accepts a fully-valid blob untouched (modulo trimming)", () => {
    const out = normaliseTriagePayload({
      category: "bug",
      labels: ["auth", "regression"],
      complexity: "medium",
      priority: "high",
      riskArea: "session handling",
      reasoning: "Race between session revoke and cookie set.",
      suggestedReviewers: ["alice"],
    });
    expect(out.category).toBe("bug");
    expect(out.complexity).toBe("medium");
    expect(out.priority).toBe("high");
    expect(out.labels).toEqual(["auth", "regression"]);
    expect(out.suggestedReviewers).toEqual(["alice"]);
    expect(out.riskArea).toBe("session handling");
  });

  it("coerces out-of-vocab category/complexity/priority to defaults", () => {
    const out = normaliseTriagePayload({
      category: "rocketship",
      complexity: "XXL",
      priority: "blocker",
      reasoning: "nope",
    });
    expect(out.category).toBe("chore");
    expect(out.complexity).toBe("unknown");
    expect(out.priority).toBe("unknown");
  });

  it("drops unknown keys and non-string labels, dedupes + caps labels", () => {
    const many = Array.from({ length: 30 }, (_, i) => `label-${i}`);
    const out = normaliseTriagePayload({
      category: "feature",
      labels: [...many, "label-0", 42, null, "VALID-Label"],
      bogus: "ignored",
      complexity: "small",
      priority: "low",
      reasoning: "ok",
      suggestedReviewers: ["bob", "bob", 9, "carol", "dave", "eve"],
    });
    // Caps at 6, lower-cased, deduped.
    expect(out.labels.length).toBeLessThanOrEqual(6);
    expect(new Set(out.labels).size).toBe(out.labels.length);
    for (const l of out.labels) {
      expect(l).toBe(l.toLowerCase());
    }
    // Reviewers: deduped, cap 3.
    expect(out.suggestedReviewers.length).toBeLessThanOrEqual(3);
    expect(new Set(out.suggestedReviewers).size).toBe(
      out.suggestedReviewers.length
    );
  });

  it("caps reasoning and riskArea length", () => {
    const out = normaliseTriagePayload({
      category: "docs",
      reasoning: "x".repeat(5000),
      riskArea: "y".repeat(500),
    });
    expect(out.reasoning.length).toBeLessThanOrEqual(1200);
    expect(out.riskArea.length).toBeLessThanOrEqual(80);
  });

  it("falls back to a sentinel reasoning when the model omits one", () => {
    const out = normaliseTriagePayload({ category: "bug" });
    expect(out.reasoning).toMatch(/no reasoning/i);
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("triage-agent — estimateHaikuCents", () => {
  it("returns 0 for zero tokens", () => {
    expect(estimateHaikuCents(0, 0)).toBe(0);
  });

  it("is monotone in both inputs", () => {
    const a = estimateHaikuCents(1000, 200);
    const b = estimateHaikuCents(2000, 200);
    const c = estimateHaikuCents(1000, 400);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(c).toBeGreaterThanOrEqual(a);
  });

  it("rounds up so any positive usage is at least 1 cent", () => {
    expect(estimateHaikuCents(1, 1)).toBe(1);
  });

  it("computes a reasonable value for a typical triage call (~2k in, ~200 out)", () => {
    // (2000 * 0.25 + 200 * 1.25) / 1e6 * 100 = 0.075 cents → ceil to 1.
    expect(estimateHaikuCents(2000, 200)).toBe(1);
  });

  it("ignores negative / non-finite inputs", () => {
    expect(estimateHaikuCents(-100, -50)).toBe(0);
    expect(estimateHaikuCents(Number.NaN, Number.NaN)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("triage-agent — renderTriageComment", () => {
  const sample: TriageClassification = {
    category: "bug",
    labels: ["auth", "regression"],
    complexity: "medium",
    priority: "high",
    riskArea: "session handling",
    reasoning: "Race between revoke and set.",
    suggestedReviewers: ["alice", "bob"],
  };

  it("begins with the ## Triage heading (required for the dedupe check)", () => {
    const out = renderTriageComment("issue", sample, true);
    expect(out.startsWith("## Triage")).toBe(true);
  });

  it("mentions that no AI backend is configured when aiAvailable=false", () => {
    const out = renderTriageComment("issue", sample, false);
    expect(out.toLowerCase()).toContain("no ai backend");
    expect(out.toLowerCase()).toContain("manual triage");
  });

  it("omits suggested-reviewers section for issues even if classification has them", () => {
    const out = renderTriageComment("issue", sample, true);
    expect(out).not.toMatch(/Suggested reviewers/i);
  });

  it("includes suggested-reviewers section for PRs", () => {
    const out = renderTriageComment("pr", sample, true);
    expect(out).toMatch(/Suggested reviewers/i);
    expect(out).toContain("@alice");
  });

  it("always includes the non-destructive disclaimer footer", () => {
    const out = renderTriageComment("pr", sample, true);
    expect(out).toMatch(/non-destructive suggestion/i);
  });
});

// ---------------------------------------------------------------------------
// buildRunSummary
// ---------------------------------------------------------------------------

describe("triage-agent — buildRunSummary", () => {
  it("references 'no AI backend' when aiAvailable=false", () => {
    const s = buildRunSummary(
      {
        category: "bug",
        labels: [],
        complexity: "small",
        priority: "low",
        riskArea: "x",
        reasoning: "y",
        suggestedReviewers: [],
      },
      false
    );
    expect(s.toLowerCase()).toContain("no ai backend");
  });

  it("mentions category + complexity when AI ran", () => {
    const s = buildRunSummary(
      {
        category: "feature",
        labels: [],
        complexity: "large",
        priority: "medium",
        riskArea: "x",
        reasoning: "y",
        suggestedReviewers: [],
      },
      true
    );
    expect(s).toContain("feature");
    expect(s).toContain("large");
  });
});

// ---------------------------------------------------------------------------
// runTriageAgent — integration-lite
//
// Without ANTHROPIC_API_KEY (forced by beforeEach) the agent hits the
// deterministic path. We can't verify DB side-effects without a live Postgres,
// but we CAN verify:
//   - it never throws
//   - it returns a well-shaped object
//   - the summary references the no-AI path when the DB is absent (in which
//     case startAgentRun returns null and runTriageAgent gives up cleanly).
// ---------------------------------------------------------------------------

describe("triage-agent — runTriageAgent graceful degradation", () => {
  const base = {
    kind: "issue" as const,
    repositoryId: "00000000-0000-0000-0000-000000000000",
    itemId: "00000000-0000-0000-0000-000000000001",
    itemNumber: 1,
    title: "Sample bug",
    body: "Something went wrong.",
  };

  it("returns { ok: false, runId: null } for invalid args, no throw", async () => {
    const r = await runTriageAgent({ ...base, title: "" });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(typeof r.summary).toBe("string");
    expect(r.summary).toMatch(/invalid args/i);
  });

  it("returns a well-shaped result even when the DB is unavailable", async () => {
    // startAgentRun catches DB failures and returns null; runTriageAgent
    // propagates that as {ok:false, summary:'could not open agent_runs row'}.
    // If a live DB IS connected, we instead get ok:true and a non-null runId.
    // Either way the function resolves.
    const r = await runTriageAgent(base);
    expect(r).toBeDefined();
    expect(typeof r.ok).toBe("boolean");
    expect(typeof r.summary).toBe("string");
    expect(r.summary.length).toBeGreaterThan(0);
  });

  it("never throws for a PR with an empty body", async () => {
    await expect(
      runTriageAgent({ ...base, kind: "pr", body: "" })
    ).resolves.toBeDefined();
  });

  it("never throws for a PR whose body is missing entirely", async () => {
    await expect(
      runTriageAgent({
        ...base,
        kind: "pr",
        body: undefined as unknown as string,
      })
    ).resolves.toBeDefined();
  });

  it("rejects kind='neither' without side effects", async () => {
    const r = await runTriageAgent({
      ...base,
      kind: "neither" as unknown as "issue",
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
  });
});
