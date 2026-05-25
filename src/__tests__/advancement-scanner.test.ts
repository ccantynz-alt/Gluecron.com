/**
 * Tests for src/lib/advancement-scanner.ts.
 *
 * Uses the dependency-injection seams on `runAdvancementScan` so we
 * never hit the DB or the Anthropic API. The Claude call is mocked
 * with canned findings; the issue-create + dedupe + audit side-effects
 * are observed via spy fakes.
 *
 * Coverage:
 *   - Public surface exports
 *   - dedupe key + body marker
 *   - Pure model-suggestion logic (newer / cheaper variants)
 *   - Issue creation for canned Claude findings
 *   - Dedupe (same sha256 title) skips re-filing within 30d
 *   - Stack bumps route to the migration-assistant kickoff, not openIssue
 *   - Per-finding errors are isolated
 *   - Hard cap on findings per scan
 *   - audit_log gets the scan-complete row
 *
 * DB-touching paths (the defaults) are gated behind HAS_DB so the
 * suite stays green on machines without Postgres.
 */

import { describe, it, expect } from "bun:test";
import {
  ADVANCEMENT_AUDIT_ACTION,
  ADVANCEMENT_DEDUPE_DAYS,
  ADVANCEMENT_DEDUPE_MARKER_PREFIX,
  ADVANCEMENT_LABEL_NAME,
  ADVANCEMENT_SCAN_COMPLETE_ACTION,
  KNOWN_CLAUDE_MODELS,
  MAX_ADVANCEMENT_FINDINGS_PER_SCAN,
  STACK_KEYSTONE_DEPS,
  TRENDING_FEATURE_CATALOGUE,
  __test as scannerInternals,
  advancementDedupeKey,
  renderAdvancementBody,
  runAdvancementScan,
  suggestModelUpgrades,
  type AdvancementFinding,
  type ClaudeModelEntry,
} from "../lib/advancement-scanner";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const REPO = {
  repositoryId: "repo-self",
  ownerId: "owner-1",
  ownerName: "ccantynz",
  repoName: "Gluecron.com",
  defaultBranch: "main",
};

function finding(
  partial: Partial<AdvancementFinding> = {}
): AdvancementFinding {
  return {
    kind: "self_improvement",
    title: "Default finding",
    urgency: "medium",
    suggested_action: "Do the thing.",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

describe("advancement-scanner — module surface", () => {
  it("exports the expected public functions + constants", () => {
    expect(typeof runAdvancementScan).toBe("function");
    expect(typeof advancementDedupeKey).toBe("function");
    expect(typeof renderAdvancementBody).toBe("function");
    expect(typeof suggestModelUpgrades).toBe("function");
    expect(ADVANCEMENT_LABEL_NAME).toBe("ai:advancement");
    expect(ADVANCEMENT_AUDIT_ACTION).toBe("ai.advancement.finding");
    expect(ADVANCEMENT_SCAN_COMPLETE_ACTION).toBe(
      "ai.advancement.scan_complete"
    );
    expect(ADVANCEMENT_DEDUPE_DAYS).toBe(30);
    expect(MAX_ADVANCEMENT_FINDINGS_PER_SCAN).toBeGreaterThan(0);
    expect(STACK_KEYSTONE_DEPS).toContain("hono");
    expect(STACK_KEYSTONE_DEPS).toContain("drizzle-orm");
    expect(STACK_KEYSTONE_DEPS).toContain("@anthropic-ai/sdk");
    expect(TRENDING_FEATURE_CATALOGUE.length).toBeGreaterThan(0);
    expect(KNOWN_CLAUDE_MODELS.length).toBeGreaterThan(0);
  });
});

describe("advancementDedupeKey", () => {
  it("produces a deterministic 32-char hex digest", () => {
    const k1 = advancementDedupeKey("Bump hono 4 → 5");
    const k2 = advancementDedupeKey("Bump hono 4 → 5");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is case-insensitive + trimmed", () => {
    expect(advancementDedupeKey("  Bump HONO  ")).toBe(
      advancementDedupeKey("bump hono")
    );
  });

  it("differs across distinct titles", () => {
    expect(advancementDedupeKey("a")).not.toBe(advancementDedupeKey("b"));
  });
});

describe("renderAdvancementBody", () => {
  it("embeds the dedupe marker so LIKE lookup matches", () => {
    const f = finding({ title: "Upgrade Sonnet 4 → 4.7" });
    const key = advancementDedupeKey(f.title);
    const body = renderAdvancementBody(f, key);
    expect(body).toContain(`${ADVANCEMENT_DEDUPE_MARKER_PREFIX}${key}`);
    expect(body).toContain("Suggested action");
    expect(body).toContain(f.suggested_action);
  });

  it("uses a high-urgency badge for high findings", () => {
    const body = renderAdvancementBody(finding({ urgency: "high" }), "k");
    expect(body).toContain("high");
  });

  it("labels each kind correctly", () => {
    expect(
      renderAdvancementBody(finding({ kind: "model_release" }), "k")
    ).toContain("Model release");
    expect(
      renderAdvancementBody(finding({ kind: "stack_bump" }), "k")
    ).toContain("Stack version bump");
    expect(
      renderAdvancementBody(finding({ kind: "trending_feature" }), "k")
    ).toContain("Trending feature");
  });
});

// ---------------------------------------------------------------------------
// suggestModelUpgrades — pure
// ---------------------------------------------------------------------------

describe("suggestModelUpgrades", () => {
  const fixture: ClaudeModelEntry[] = [
    { id: "sonnet-old", family: "sonnet", generation: 4, capability: 80, cost: 30, label: "Sonnet old" },
    { id: "sonnet-new", family: "sonnet", generation: 4.7, capability: 92, cost: 30, label: "Sonnet new" },
    { id: "sonnet-cheap-better", family: "sonnet", generation: 4.7, capability: 92, cost: 20, label: "Sonnet cheap" },
    { id: "haiku-old", family: "haiku", generation: 4.5, capability: 60, cost: 10, label: "Haiku old" },
  ];

  it("suggests a newer same-family model when one exists", () => {
    const out = suggestModelUpgrades("sonnet-old", fixture);
    const titles = out.map((f) => f.title);
    expect(titles.some((t) => t.includes("→"))).toBe(true);
    expect(out.every((f) => f.kind === "model_release")).toBe(true);
  });

  it("suggests a cheaper-better variant when both exist", () => {
    const out = suggestModelUpgrades("sonnet-old", fixture);
    expect(out.some((f) => f.title.toLowerCase().includes("cost"))).toBe(true);
  });

  it("returns empty when configured model is already best in family", () => {
    // strip the cheaper variant so only one current-best exists.
    const trimmed = fixture.filter((m) => m.id !== "sonnet-cheap-better");
    const out = suggestModelUpgrades("sonnet-new", trimmed);
    expect(out).toEqual([]);
  });

  it("falls back to best-in-family when configured id is unknown", () => {
    const out = suggestModelUpgrades("sonnet-legacy-2024", fixture);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].kind).toBe("model_release");
  });

  it("returns empty when family can't be guessed", () => {
    const out = suggestModelUpgrades("unrecognized-model", fixture);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runAdvancementScan — issue creation
// ---------------------------------------------------------------------------

describe("runAdvancementScan — issue creation", () => {
  it("opens an issue per Claude finding and skips info-grade defaults", async () => {
    const created: Array<{ title: string; body: string }> = [];
    const audited: Array<{ title: string; issueNumber: number | null }> = [];

    const result = await runAdvancementScan({
      aiAvailable: () => true,
      // Force the model probe to be empty so the assertion below targets only the Claude finding.
      configuredModels: () => [],
      // No stack-bump probe.
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      askSelfImprovement: async () => [
        finding({ title: "Improve cold-start time", urgency: "high" }),
      ],
      askTrending: async () => [
        finding({
          kind: "trending_feature",
          title: "Add per-PR observability dashboard",
          urgency: "medium",
          suggested_action: "Plumb a per-PR dashboard the way Vercel does.",
        }),
      ],
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async (args) => {
        created.push({ title: args.title, body: args.body });
        return created.length;
      },
      recordAudit: async (f, _r, n) => {
        audited.push({ title: f.title, issueNumber: n });
      },
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });

    expect(result.openedIssues).toBe(2);
    expect(result.openedPrs).toBe(0);
    expect(result.skippedDedupe).toBe(0);
    expect(result.errors).toBe(0);
    expect(created.map((c) => c.title).sort()).toEqual(
      ["Add per-PR observability dashboard", "Improve cold-start time"].sort()
    );
    for (const c of created) {
      const key = advancementDedupeKey(c.title);
      expect(c.body).toContain(`${ADVANCEMENT_DEDUPE_MARKER_PREFIX}${key}`);
    }
    expect(audited).toHaveLength(2);
  });

  it("creates an issue for each model-release suggestion", async () => {
    const created: string[] = [];
    const result = await runAdvancementScan({
      aiAvailable: () => false, // Skip Claude probes.
      configuredModels: () => [KNOWN_CLAUDE_MODELS[0]!.id],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async (args) => {
        created.push(args.title);
        return created.length;
      },
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });
    // The curated catalogue has newer/cheaper entries vs the first model,
    // so we expect at least one issue.
    expect(result.openedIssues).toBeGreaterThan(0);
    expect(created.every((t) => t.toLowerCase().includes("sonnet") || t.toLowerCase().includes("upgrade") || t.toLowerCase().includes("save"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe("runAdvancementScan — dedupe", () => {
  it("does not double-fire when isDuplicate returns true", async () => {
    const created: string[] = [];
    let dedupeChecks = 0;

    const result = await runAdvancementScan({
      aiAvailable: () => true,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      askSelfImprovement: async () => [
        finding({ title: "Improve cold-start", urgency: "high" }),
      ],
      askTrending: async () => [],
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => {
        dedupeChecks += 1;
        return true;
      },
      openIssue: async (args) => {
        created.push(args.title);
        return 1;
      },
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });

    expect(dedupeChecks).toBe(1);
    expect(created).toEqual([]);
    expect(result.skippedDedupe).toBe(1);
    expect(result.openedIssues).toBe(0);
  });

  it("passes the 30-day window to the duplicate lookup", async () => {
    let observed = -1;
    await runAdvancementScan({
      aiAvailable: () => true,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      askSelfImprovement: async () => [finding({ urgency: "high" })],
      askTrending: async () => [],
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async (_r, _k, days) => {
        observed = days;
        return true;
      },
      openIssue: async () => 1,
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });
    expect(observed).toBe(ADVANCEMENT_DEDUPE_DAYS);
  });

  it("passes the sha256 dedupe key to the duplicate check", async () => {
    let observed = "";
    await runAdvancementScan({
      aiAvailable: () => true,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      askSelfImprovement: async () => [
        finding({ title: "Improve cold-start time" }),
      ],
      askTrending: async () => [],
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async (_r, key) => {
        observed = key;
        return true;
      },
      openIssue: async () => 1,
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });
    expect(observed).toBe(advancementDedupeKey("Improve cold-start time"));
  });
});

// ---------------------------------------------------------------------------
// Stack bumps route to the migration assistant
// ---------------------------------------------------------------------------

describe("runAdvancementScan — stack bumps", () => {
  it("hands a major-version bump to the migration assistant instead of opening an issue", async () => {
    const bumps: Array<{ dep: string; from: string; to: string }> = [];
    const issues: string[] = [];

    const result = await runAdvancementScan({
      aiAvailable: () => false,
      configuredModels: () => [],
      loadPackageJson: async () =>
        JSON.stringify({
          dependencies: { hono: "^3.0.0" },
        }),
      fetchLatestVersion: async (name) => (name === "hono" ? "4.5.0" : null),
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async (args) => {
        issues.push(args.title);
        return issues.length;
      },
      recordAudit: async () => {},
      proposeBumpPr: async (args) => {
        bumps.push({
          dep: args.dependency,
          from: args.fromVersion,
          to: args.toVersion,
        });
        return { branch: "ai-migration/hono", prNumber: 7 };
      },
      resolveBaseSha: async () => "deadbeefcafefeedfacefeeddeadbeefcafefeed",
      recordScanComplete: async () => {},
    });

    expect(bumps).toEqual([
      { dep: "hono", from: "^3.0.0", to: "4.5.0" },
    ]);
    // Migration assistant accepted -> no fallback issue.
    expect(issues).toEqual([]);
    expect(result.openedPrs).toBe(1);
    expect(result.openedIssues).toBe(0);
  });

  it("falls back to an issue when the migration assistant declines", async () => {
    const issues: string[] = [];
    const result = await runAdvancementScan({
      aiAvailable: () => false,
      configuredModels: () => [],
      loadPackageJson: async () =>
        JSON.stringify({ dependencies: { hono: "^3.0.0" } }),
      fetchLatestVersion: async () => "4.5.0",
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async (args) => {
        issues.push(args.title);
        return issues.length;
      },
      recordAudit: async () => {},
      proposeBumpPr: async () => null, // decline
      resolveBaseSha: async () => "deadbeefcafefeedfacefeeddeadbeefcafefeed",
      recordScanComplete: async () => {},
    });
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("Bump hono");
    expect(result.openedIssues).toBe(1);
    expect(result.openedPrs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("runAdvancementScan — robustness", () => {
  it("isolates per-finding failures — one bad issue insert does not stop the rest", async () => {
    const created: string[] = [];

    const result = await runAdvancementScan({
      aiAvailable: () => true,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      askSelfImprovement: async () => [
        finding({ title: "first", urgency: "high" }),
        finding({ title: "second", urgency: "high" }),
      ],
      askTrending: async () => [],
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async (args) => {
        if (args.title === "first") throw new Error("DB blew up");
        created.push(args.title);
        return created.length;
      },
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });

    expect(created).toEqual(["second"]);
    expect(result.openedIssues).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("returns a clean summary when AI is unavailable", async () => {
    const result = await runAdvancementScan({
      aiAvailable: () => false,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async () => null,
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });
    expect(result.findings).toEqual([]);
    expect(result.openedIssues).toBe(0);
    expect(result.openedPrs).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("caps total findings persisted per scan", async () => {
    const created: string[] = [];
    const tooMany: AdvancementFinding[] = [];
    for (let i = 0; i < 20; i++) {
      tooMany.push(finding({ title: `finding-${i}`, urgency: "high" }));
    }
    const result = await runAdvancementScan({
      aiAvailable: () => true,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      askSelfImprovement: async () => tooMany,
      askTrending: async () => [],
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async (args) => {
        created.push(args.title);
        return created.length;
      },
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
      maxFindings: 4,
    });
    expect(created.length).toBe(4);
    expect(result.openedIssues).toBe(4);
    expect(result.findings.length).toBe(4);
  });

  it("records a scan-complete audit row at the end", async () => {
    let scanCompleteCalled = false;
    await runAdvancementScan({
      aiAvailable: () => false,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      resolveSelfHostRepo: async () => REPO,
      isDuplicate: async () => false,
      openIssue: async () => 1,
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {
        scanCompleteCalled = true;
      },
    });
    expect(scanCompleteCalled).toBe(true);
  });

  it("does not crash when the self-host repo is missing", async () => {
    const result = await runAdvancementScan({
      aiAvailable: () => false,
      configuredModels: () => [KNOWN_CLAUDE_MODELS[0]!.id],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      resolveSelfHostRepo: async () => null,
      isDuplicate: async () => false,
      openIssue: async () => 1,
      recordAudit: async () => {},
      proposeBumpPr: async () => null,
      recordScanComplete: async () => {},
    });
    // Model-release findings still surface in the result, but no issues
    // are opened because the repo couldn't be resolved.
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.openedIssues).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

describe("internal helpers", () => {
  it("countByKind tallies findings", () => {
    const out = scannerInternals.countByKind([
      finding({ kind: "model_release" }),
      finding({ kind: "model_release" }),
      finding({ kind: "trending_feature" }),
    ]);
    expect(out.model_release).toBe(2);
    expect(out.trending_feature).toBe(1);
    expect(out.stack_bump).toBe(0);
  });

  it("isPlausibleClaudeFinding rejects malformed rows", () => {
    expect(scannerInternals.isPlausibleClaudeFinding({})).toBe(false);
    expect(
      scannerInternals.isPlausibleClaudeFinding({
        title: "",
        urgency: "high",
        suggested_action: "x",
      })
    ).toBe(false);
    expect(
      scannerInternals.isPlausibleClaudeFinding({
        title: "ok",
        urgency: "spicy",
        suggested_action: "x",
      })
    ).toBe(false);
    expect(
      scannerInternals.isPlausibleClaudeFinding({
        title: "ok",
        urgency: "high",
        suggested_action: "x",
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB-backed smoke (only runs when DATABASE_URL is set)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("runAdvancementScan — DB-backed smoke", () => {
  it("calls the default recordAudit/openIssue when no overrides given", async () => {
    // Just verifies the wiring — uses an unresolved repo so nothing
    // actually inserts. Confirms the lib doesn't throw when default deps
    // hit the live DB.
    const result = await runAdvancementScan({
      aiAvailable: () => false,
      configuredModels: () => [],
      loadPackageJson: async () => null,
      fetchLatestVersion: async () => null,
      resolveSelfHostRepo: async () => null,
    });
    expect(result.errors).toBeLessThanOrEqual(1);
  });
});
