/**
 * Per-repo automation settings tests (migration 0106).
 *
 * Covers the contract in src/lib/automation-settings.ts:
 *   - defaults when no row exists / when the DB lookup fails (fail-open)
 *   - pure mode resolution: normalizeMode, resolveEffectiveMode (env
 *     kill-switches stay supreme), isAutomationOn, settingsFromRow
 *   - dispatch-site gating with mocked settings via the same DI seams the
 *     auto-merge / ci-autofix suites use:
 *       * evaluateAutoMerge respects 'off' / 'suggest' (no DB touched)
 *       * the other dispatch sites are pinned with the readFileSync source
 *         wiring technique used by repair-flywheel-wiring.test.ts
 *
 * No DB, git, or Anthropic calls are made anywhere in this suite.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTOMATION_DEFAULTS,
  getAutomationSettings,
  isAutomationOn,
  normalizeMode,
  resolveEffectiveMode,
  settingsFromRow,
  type AutomationSettings,
  type AutomationSettingsLoader,
} from "../lib/automation-settings";
import { evaluateAutoMerge } from "../lib/auto-merge";

const REPO_ID = "11111111-2222-3333-4444-555555555555";

function makeSettings(
  overrides: Partial<AutomationSettings> = {}
): AutomationSettings {
  return { ...AUTOMATION_DEFAULTS, ...overrides };
}

/** Loader stub that records calls — the DI seam every dispatch site accepts. */
function makeLoader(settings: AutomationSettings): {
  loader: AutomationSettingsLoader;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    loader: async (repositoryId: string) => {
      calls.push(repositoryId);
      return settings;
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("AUTOMATION_DEFAULTS — match pre-0106 behavior", () => {
  it("advisory features default to 'suggest'", () => {
    expect(AUTOMATION_DEFAULTS.aiReviewMode).toBe("suggest");
    expect(AUTOMATION_DEFAULTS.prTriageMode).toBe("suggest");
    expect(AUTOMATION_DEFAULTS.issueTriageMode).toBe("suggest");
    expect(AUTOMATION_DEFAULTS.ciAutofixMode).toBe("suggest");
  });

  it("auto-merge defaults to 'auto' (K2/K3 already merged automatically)", () => {
    expect(AUTOMATION_DEFAULTS.autoMergeMode).toBe("auto");
  });
});

describe("getAutomationSettings — fail-open to defaults", () => {
  it("returns the defaults when the DB is unavailable (no row, no env)", async () => {
    // The test runner has no DATABASE_URL, so the lazy DB proxy throws on
    // first access — getAutomationSettings must swallow that and return
    // the defaults rather than letting the error change behavior.
    const settings = await getAutomationSettings(REPO_ID);
    expect(settings).toEqual({ ...AUTOMATION_DEFAULTS });
  });
});

// ---------------------------------------------------------------------------
// Pure mode resolution
// ---------------------------------------------------------------------------

describe("normalizeMode", () => {
  it("passes through the three valid modes", () => {
    expect(normalizeMode("off", "suggest")).toBe("off");
    expect(normalizeMode("suggest", "off")).toBe("suggest");
    expect(normalizeMode("auto", "off")).toBe("auto");
  });

  it("falls back on garbage, undefined, and non-strings", () => {
    expect(normalizeMode("ON", "suggest")).toBe("suggest");
    expect(normalizeMode(undefined, "auto")).toBe("auto");
    expect(normalizeMode(null, "off")).toBe("off");
    expect(normalizeMode(1, "suggest")).toBe("suggest");
    expect(normalizeMode("", "suggest")).toBe("suggest");
  });
});

describe("resolveEffectiveMode — env kill-switches stay supreme", () => {
  it("env off forces 'off' regardless of the repo mode", () => {
    expect(resolveEffectiveMode("auto", false)).toBe("off");
    expect(resolveEffectiveMode("suggest", false)).toBe("off");
    expect(resolveEffectiveMode("off", false)).toBe("off");
  });

  it("env on yields the repo mode unchanged (repo can only narrow)", () => {
    expect(resolveEffectiveMode("auto", true)).toBe("auto");
    expect(resolveEffectiveMode("suggest", true)).toBe("suggest");
    expect(resolveEffectiveMode("off", true)).toBe("off");
  });
});

describe("isAutomationOn — 'suggest' and 'auto' both count as on", () => {
  it("only 'off' is off", () => {
    expect(isAutomationOn("off")).toBe(false);
    expect(isAutomationOn("suggest")).toBe(true);
    expect(isAutomationOn("auto")).toBe(true);
  });
});

describe("settingsFromRow", () => {
  it("null/undefined row → defaults", () => {
    expect(settingsFromRow(null)).toEqual({ ...AUTOMATION_DEFAULTS });
    expect(settingsFromRow(undefined)).toEqual({ ...AUTOMATION_DEFAULTS });
  });

  it("valid row values pass through", () => {
    const out = settingsFromRow({
      aiReviewMode: "off",
      prTriageMode: "off",
      issueTriageMode: "suggest",
      autoMergeMode: "suggest",
      ciAutofixMode: "auto",
    });
    expect(out.aiReviewMode).toBe("off");
    expect(out.prTriageMode).toBe("off");
    expect(out.issueTriageMode).toBe("suggest");
    expect(out.autoMergeMode).toBe("suggest");
    expect(out.ciAutofixMode).toBe("auto");
  });

  it("corrupt per-field values fall back per-field to the defaults", () => {
    const out = settingsFromRow({
      aiReviewMode: "banana",
      autoMergeMode: "off",
    });
    expect(out.aiReviewMode).toBe("suggest"); // default
    expect(out.autoMergeMode).toBe("off"); // valid value kept
    expect(out.ciAutofixMode).toBe("suggest"); // missing → default
  });
});

// ---------------------------------------------------------------------------
// Dispatch-site gating — auto-merge (behavioral, via the DI seam)
// ---------------------------------------------------------------------------

describe("evaluateAutoMerge — per-repo automation gate", () => {
  const ctx = {
    pullRequestId: "pr-1",
    repositoryId: REPO_ID,
    baseBranch: "main",
    isDraft: false,
    authorUserId: "user-1",
  };

  it("'off' blocks the merge before any DB work", async () => {
    const { loader, calls } = makeLoader(makeSettings({ autoMergeMode: "off" }));
    const decision = await evaluateAutoMerge(ctx, {
      loadAutomationSettings: loader,
    });
    expect(decision.merge).toBe(false);
    expect(decision.reason).toContain("turned off");
    expect(decision.blocking?.length).toBe(1);
    expect(calls).toEqual([REPO_ID]);
  });

  it("'suggest' evaluates to merge:false with a human-handoff reason", async () => {
    const { loader } = makeLoader(makeSettings({ autoMergeMode: "suggest" }));
    const decision = await evaluateAutoMerge(ctx, {
      loadAutomationSettings: loader,
    });
    expect(decision.merge).toBe(false);
    expect(decision.reason).toContain("suggest");
    expect(decision.reason).toContain("merge left to a human");
  });

  it("'auto' proceeds past the gate into the K2 evaluation", async () => {
    const { loader, calls } = makeLoader(makeSettings({ autoMergeMode: "auto" }));
    // With no DATABASE_URL the downstream matchProtection lookup fails;
    // the contract here is only that the gate did NOT short-circuit —
    // i.e. the loader was consulted and the decision (whatever the DB
    // state yields) is not the automation-settings refusal.
    let decision: { merge: boolean; reason: string } | null = null;
    try {
      decision = await evaluateAutoMerge(ctx, {
        loadAutomationSettings: loader,
      });
    } catch {
      // Downstream DB failure is acceptable in this DB-less environment.
    }
    expect(calls).toEqual([REPO_ID]);
    if (decision) {
      expect(decision.reason).not.toContain("automation settings");
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch-site gating — source wiring pins for the fire-and-forget paths
// (same readFileSync technique as repair-flywheel-wiring.test.ts; these
// functions swallow every error by contract, so source pins are the
// reliable way to assert the gate exists and sits on the live path).
// ---------------------------------------------------------------------------

describe("dispatch-site source wiring", () => {
  const read = (rel: string) =>
    readFileSync(join(import.meta.dir, rel), "utf8");

  it("ai-review: triggerAiReview consults the per-repo setting and skips on 'off'", () => {
    const src = read("../lib/ai-review.ts");
    expect(src).toContain('from "./automation-settings"');
    expect(src).toContain("options.loadSettings ?? getAutomationSettings");
    expect(src).toContain('if (automation.aiReviewMode === "off") return;');
  });

  it("pr-triage: triggerPrTriage consults the per-repo setting and skips on 'off'", () => {
    const src = read("../lib/pr-triage.ts");
    expect(src).toContain('from "./automation-settings"');
    expect(src).toContain('if (automation.prTriageMode === "off") return;');
  });

  it("issue-triage: triggerIssueTriage consults the per-repo setting and skips on 'off'", () => {
    const src = read("../lib/issue-triage.ts");
    expect(src).toContain('from "./automation-settings"');
    expect(src).toContain('if (automation.issueTriageMode === "off") return;');
  });

  it("ci-autofix: _runAutofix skips on 'off' and auto-applies on 'auto'", () => {
    const src = read("../lib/ci-autofix.ts");
    expect(src).toContain('from "./automation-settings"');
    expect(src).toContain('if (automation.ciAutofixMode === "off") return;');
    expect(src).toContain('automation.ciAutofixMode === "auto"');
    expect(src).toContain("applyAutofix(posted.id, repoRow.ownerId, deps)");
  });

  it("env guards stay supreme at the triage/review dispatch sites", () => {
    // The per-repo gate must sit BEHIND the existing env kill-switches so
    // a repo setting can never widen what the environment allows.
    for (const rel of ["../lib/pr-triage.ts", "../lib/issue-triage.ts"]) {
      const src = read(rel);
      const envIdx = src.indexOf("if (!isAiAvailable()) return;");
      const gateIdx = src.indexOf("options.loadSettings ?? getAutomationSettings");
      expect(envIdx).toBeGreaterThan(-1);
      expect(gateIdx).toBeGreaterThan(envIdx);
    }
    const review = read("../lib/ai-review.ts");
    const envIdx = review.indexOf("if (!isAiReviewEnabled()) return;");
    const gateIdx = review.indexOf("options.loadSettings ?? getAutomationSettings");
    expect(envIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(envIdx);
  });
});
