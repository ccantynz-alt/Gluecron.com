/**
 * Tests for the AI Proactive Monitor (`src/lib/ai-proactive-monitor.ts`).
 *
 * Uses the dependency-injection seams on `aiProactiveMonitorTick` so we
 * never touch the DB or the Anthropic API. The Claude call is mocked
 * with canned findings; the issue-create + dedupe + audit side-effects
 * are observed via spy fakes.
 *
 * Covers:
 *   - No-op when AI is unavailable.
 *   - Info-severity findings are filtered out before issue creation.
 *   - Warning + critical findings open issues with the proactive label.
 *   - Dedupe (sha256 of title) skips repeat findings within 24h.
 *   - Audit row is recorded for every considered finding.
 *   - Per-finding errors are isolated (one bad finding doesn't wedge the rest).
 *   - Hard cap on findings per tick (runaway protection).
 *   - Body renderer embeds the dedupe marker so the lookup query can match.
 */

import { describe, it, expect } from "bun:test";
import {
  aiProactiveMonitorTick,
  dedupeKeyForTitle,
  renderFindingBody,
  PROACTIVE_LABEL_NAME,
  PROACTIVE_LOOKBACK_HOURS,
  PROACTIVE_DEDUPE_MARKER_PREFIX,
  __test as monitorInternals,
  type ProactiveFinding,
  type ProactiveTelemetry,
} from "../lib/ai-proactive-monitor";

const EMPTY_TELEMETRY: ProactiveTelemetry = {
  auditLog: [],
  platformDeploys: [],
  workflowRuns: [],
};

const REPO = { repositoryId: "repo-self", ownerId: "owner-1" };

function finding(
  partial: Partial<ProactiveFinding> = {}
): ProactiveFinding {
  return {
    title: "Default finding",
    severity: "warning",
    body_markdown: "Something looks off.",
    target_url: null,
    ...partial,
  };
}

describe("ai-proactive-monitor — module surface", () => {
  it("exports the expected public functions + constants", () => {
    expect(typeof aiProactiveMonitorTick).toBe("function");
    expect(typeof dedupeKeyForTitle).toBe("function");
    expect(typeof renderFindingBody).toBe("function");
    expect(PROACTIVE_LABEL_NAME).toBe("ai:proactive-finding");
    expect(PROACTIVE_LOOKBACK_HOURS).toBe(24);
  });
});

describe("dedupeKeyForTitle", () => {
  it("produces a deterministic 32-char hex digest", () => {
    const k1 = dedupeKeyForTitle("memory growth on workflow-runner");
    const k2 = dedupeKeyForTitle("memory growth on workflow-runner");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is case-insensitive and trimmed", () => {
    expect(dedupeKeyForTitle("  Memory Growth  ")).toBe(
      dedupeKeyForTitle("memory growth")
    );
  });

  it("differs for different titles", () => {
    expect(dedupeKeyForTitle("a")).not.toBe(dedupeKeyForTitle("b"));
  });
});

describe("renderFindingBody", () => {
  it("embeds the dedupe marker so the LIKE lookup matches", () => {
    const f = finding({ title: "deploy times creeping up" });
    const key = dedupeKeyForTitle(f.title);
    const body = renderFindingBody(f, key);
    expect(body).toContain(`${PROACTIVE_DEDUPE_MARKER_PREFIX}${key}`);
    expect(body).toContain("warning");
    expect(body).toContain("Something looks off.");
  });

  it("uses the critical badge for critical findings", () => {
    const f = finding({ severity: "critical" });
    const body = renderFindingBody(f, "k");
    expect(body).toContain("critical");
  });

  it("includes the target URL when provided", () => {
    const f = finding({ target_url: "https://gluecron.com/admin/deploys" });
    const body = renderFindingBody(f, "k");
    expect(body).toContain("https://gluecron.com/admin/deploys");
  });
});

describe("aiProactiveMonitorTick — no-op paths", () => {
  it("returns zero summary when AI is unavailable", async () => {
    let askCalled = false;
    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => false,
      askClaude: async () => {
        askCalled = true;
        return [];
      },
    });
    expect(askCalled).toBe(false);
    expect(summary).toEqual({
      considered: 0,
      opened: 0,
      skippedDedupe: 0,
      skippedSeverity: 0,
      errors: 0,
    });
  });

  it("returns early when the self-host repo cannot be resolved", async () => {
    let askCalled = false;
    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => null,
      askClaude: async () => {
        askCalled = true;
        return [];
      },
    });
    expect(askCalled).toBe(false);
    expect(summary.opened).toBe(0);
  });

  it("returns a clean summary when Claude finds nothing", async () => {
    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [],
      isDuplicate: async () => false,
      createFindingIssue: async () => 1,
      recordAudit: async () => {},
    });
    expect(summary).toEqual({
      considered: 0,
      opened: 0,
      skippedDedupe: 0,
      skippedSeverity: 0,
      errors: 0,
    });
  });
});

describe("aiProactiveMonitorTick — issue creation", () => {
  it("opens an issue per warning/critical finding and skips info-severity", async () => {
    const created: Array<{ title: string; body: string }> = [];
    const audited: Array<{ title: string; issueNumber: number | null }> = [];

    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [
        finding({ title: "Memory growth on workflow-runner", severity: "critical" }),
        finding({ title: "Deploy times creeping up", severity: "warning" }),
        finding({ title: "Just FYI: nothing wrong", severity: "info" }),
      ],
      isDuplicate: async () => false,
      createFindingIssue: async (args) => {
        created.push({ title: args.title, body: args.body });
        return created.length; // 1, 2, ...
      },
      recordAudit: async (f, _repo, n) => {
        audited.push({ title: f.title, issueNumber: n });
      },
    });

    expect(summary.considered).toBe(3);
    expect(summary.opened).toBe(2);
    expect(summary.skippedSeverity).toBe(1);
    expect(summary.skippedDedupe).toBe(0);
    expect(summary.errors).toBe(0);
    expect(created.map((c) => c.title)).toEqual([
      "Memory growth on workflow-runner",
      "Deploy times creeping up",
    ]);
    // Each created body must carry the dedupe marker so future ticks dedupe.
    for (const c of created) {
      const key = dedupeKeyForTitle(c.title);
      expect(c.body).toContain(`${PROACTIVE_DEDUPE_MARKER_PREFIX}${key}`);
    }
    // Audit fires for the 2 non-info findings (the info one is skipped before audit).
    expect(audited.map((a) => a.title)).toEqual([
      "Memory growth on workflow-runner",
      "Deploy times creeping up",
    ]);
  });

  it("truncates over-long titles to 200 chars when inserting", async () => {
    const longTitle = "x".repeat(500);
    let receivedTitle = "";
    await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [finding({ title: longTitle, severity: "warning" })],
      isDuplicate: async () => false,
      createFindingIssue: async (args) => {
        receivedTitle = args.title;
        return 1;
      },
      recordAudit: async () => {},
    });
    expect(receivedTitle.length).toBe(200);
  });
});

describe("aiProactiveMonitorTick — dedupe", () => {
  it("does not double-fire on the same title", async () => {
    const created: string[] = [];
    let dedupeChecks = 0;

    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [
        finding({ title: "Memory growth on workflow-runner", severity: "warning" }),
      ],
      isDuplicate: async (_repoId, _key, _hours) => {
        dedupeChecks += 1;
        return true; // pretend we already filed it
      },
      createFindingIssue: async (args) => {
        created.push(args.title);
        return 1;
      },
      recordAudit: async () => {},
    });

    expect(dedupeChecks).toBe(1);
    expect(created).toEqual([]);
    expect(summary.skippedDedupe).toBe(1);
    expect(summary.opened).toBe(0);
  });

  it("uses the lookback window from the constant", async () => {
    let observedHours = -1;
    await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [finding({ severity: "warning" })],
      isDuplicate: async (_r, _k, hours) => {
        observedHours = hours;
        return true;
      },
      createFindingIssue: async () => 1,
      recordAudit: async () => {},
    });
    expect(observedHours).toBe(PROACTIVE_LOOKBACK_HOURS);
  });

  it("passes the sha256 dedupe key to the duplicate check", async () => {
    let observedKey = "";
    await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [
        finding({ title: "Suspicious admin pattern", severity: "critical" }),
      ],
      isDuplicate: async (_r, key) => {
        observedKey = key;
        return true;
      },
      createFindingIssue: async () => 1,
      recordAudit: async () => {},
    });
    expect(observedKey).toBe(dedupeKeyForTitle("Suspicious admin pattern"));
  });
});

describe("aiProactiveMonitorTick — robustness", () => {
  it("isolates per-finding failures — one bad issue insert does not stop the rest", async () => {
    let attempts = 0;
    const created: string[] = [];

    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => [
        finding({ title: "first", severity: "warning" }),
        finding({ title: "second", severity: "critical" }),
      ],
      isDuplicate: async () => false,
      createFindingIssue: async (args) => {
        attempts += 1;
        if (args.title === "first") {
          throw new Error("DB blew up");
        }
        created.push(args.title);
        return attempts;
      },
      recordAudit: async () => {},
    });

    expect(attempts).toBe(2);
    expect(created).toEqual(["second"]);
    expect(summary.opened).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it("returns errors=1 when askClaude throws (does not propagate)", async () => {
    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => {
        throw new Error("anthropic 500");
      },
    });
    expect(summary.errors).toBe(1);
    expect(summary.opened).toBe(0);
  });

  it("returns errors=1 when loadTelemetry throws (does not propagate)", async () => {
    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => {
        throw new Error("DB down");
      },
      askClaude: async () => [],
    });
    expect(summary.errors).toBe(1);
  });

  it("caps the number of findings opened per tick", async () => {
    const created: string[] = [];
    const tooMany: ProactiveFinding[] = [];
    for (let i = 0; i < 10; i++) {
      tooMany.push(finding({ title: `finding-${i}`, severity: "warning" }));
    }
    const summary = await aiProactiveMonitorTick({
      aiAvailable: () => true,
      resolveSelfHostRepo: async () => REPO,
      loadTelemetry: async () => EMPTY_TELEMETRY,
      askClaude: async () => tooMany,
      isDuplicate: async () => false,
      createFindingIssue: async (args) => {
        created.push(args.title);
        return created.length;
      },
      recordAudit: async () => {},
      maxFindings: 3,
    });
    expect(created.length).toBe(3);
    expect(summary.opened).toBe(3);
    expect(summary.considered).toBe(3);
    // The 7 we didn't even look at are counted in the skipped overflow.
    expect(summary.skippedSeverity).toBe(7);
  });
});

describe("ai-proactive-monitor — prompt summary helper", () => {
  it("renders an empty telemetry block without throwing", () => {
    const out = monitorInternals.summariseTelemetryForPrompt(EMPTY_TELEMETRY);
    expect(out).toContain("Audit log");
    expect(out).toContain("Platform deploys");
    expect(out).toContain("Workflow runs");
  });

  it("groups audit rows by action and counts them", () => {
    const out = monitorInternals.summariseTelemetryForPrompt({
      ...EMPTY_TELEMETRY,
      auditLog: [
        {
          action: "repo.create",
          targetType: null,
          targetId: null,
          userId: null,
          repositoryId: null,
          createdAt: new Date(),
        },
        {
          action: "repo.create",
          targetType: null,
          targetId: null,
          userId: null,
          repositoryId: null,
          createdAt: new Date(),
        },
        {
          action: "auto_merge.merged",
          targetType: null,
          targetId: null,
          userId: null,
          repositoryId: null,
          createdAt: new Date(),
        },
      ],
    });
    expect(out).toContain("repo.create: 2");
    expect(out).toContain("auto_merge.merged: 1");
  });
});
