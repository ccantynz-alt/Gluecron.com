/**
 * Block K7 — deploy-watcher tests.
 *
 * Same shape as heal-bot.test.ts + fix-agent.test.ts: pure helpers exhaustively,
 * entry-point arg validation, graceful-degradation when DB/Crontech offline.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  DEPLOY_WATCHER_BOT_USERNAME,
  DEPLOY_WATCHER_COST_CENTS,
  DEPLOY_WATCHER_ERROR_THRESHOLD,
  DEPLOY_WATCHER_SLUG,
  DEPLOY_WATCHER_WINDOW_MS,
  buildDeployWatcherSummary,
  renderIncidentIssueBody,
  runDeployWatcher,
  shouldRollback,
} from "../../lib/agents/deploy-watcher";
import type { DeployWatchResult } from "../../lib/crontech-client";

const ENV_KEYS = ["CRONTECH_API_KEY", "CRONTECH_BASE_URL"] as const;

let savedEnv: Record<string, string | undefined> = {};
let savedFetch: typeof fetch;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.fetch = savedFetch;
});

// ---------------------------------------------------------------------------
// Identity + constants
// ---------------------------------------------------------------------------

describe("deploy-watcher — identity constants", () => {
  it("uses the agent- prefixed slug", () => {
    expect(DEPLOY_WATCHER_SLUG).toBe("agent-deploy-watcher");
  });
  it("uses the [bot] suffixed username", () => {
    expect(DEPLOY_WATCHER_BOT_USERNAME).toBe("agent-deploy-watcher[bot]");
    expect(DEPLOY_WATCHER_BOT_USERNAME.endsWith("[bot]")).toBe(true);
  });
  it("cost is flat 2¢", () => {
    expect(DEPLOY_WATCHER_COST_CENTS).toBe(2);
  });
  it("error threshold defaults to 5", () => {
    expect(DEPLOY_WATCHER_ERROR_THRESHOLD).toBe(5);
  });
  it("watch window is 15 minutes", () => {
    expect(DEPLOY_WATCHER_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// shouldRollback
// ---------------------------------------------------------------------------

function mkWatch(status: DeployWatchResult["finalStatus"]): DeployWatchResult {
  return {
    deployId: "d1",
    finalStatus: status,
    errors: [],
    watchedForMs: 60_000,
    offline: false,
  };
}

describe("deploy-watcher — shouldRollback", () => {
  it("rolls back when deploy finalStatus=failed", () => {
    const r = shouldRollback({
      watchResult: mkWatch("failed"),
      errorSignalCount: 0,
      threshold: 5,
    });
    expect(r.rollback).toBe(true);
    expect(r.reason).toContain("status=failed");
  });

  it("does NOT roll back when already rolled_back", () => {
    const r = shouldRollback({
      watchResult: mkWatch("rolled_back"),
      errorSignalCount: 99,
      threshold: 5,
    });
    expect(r.rollback).toBe(false);
    expect(r.reason).toContain("already rolled back");
  });

  it("rolls back when error signals ≥ threshold on a live deploy", () => {
    const r = shouldRollback({
      watchResult: mkWatch("live"),
      errorSignalCount: 7,
      threshold: 5,
    });
    expect(r.rollback).toBe(true);
    expect(r.reason).toContain("7 error signals");
    expect(r.reason).toContain("threshold 5");
  });

  it("rolls back when signals exactly equal threshold", () => {
    const r = shouldRollback({
      watchResult: mkWatch("live"),
      errorSignalCount: 5,
      threshold: 5,
    });
    expect(r.rollback).toBe(true);
  });

  it("declares healthy when deploy live + signals below threshold", () => {
    const r = shouldRollback({
      watchResult: mkWatch("live"),
      errorSignalCount: 2,
      threshold: 5,
    });
    expect(r.rollback).toBe(false);
    expect(r.reason).toBe("deploy healthy");
  });

  it("healthy when deploy pending + no signals", () => {
    const r = shouldRollback({
      watchResult: mkWatch("pending"),
      errorSignalCount: 0,
      threshold: 5,
    });
    expect(r.rollback).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderIncidentIssueBody
// ---------------------------------------------------------------------------

describe("deploy-watcher — renderIncidentIssueBody", () => {
  it("includes commit link, deploy id, reason, and top errors table", () => {
    const body = renderIncidentIssueBody({
      commitSha: "abcdef1234567890",
      ownerUsername: "alice",
      repoName: "web",
      deployId: "dpl_xyz",
      reason: "7 error signals ≥ threshold 5",
      topErrors: [
        { hash: "aaaaaaaaaaaaaaaa", message: "Cannot read null", count: 12 },
        { hash: "bbbbbbbbbbbbbbbb", message: "Timeout", count: 3 },
      ],
    });
    expect(body).toContain("/alice/web/commit/abcdef1234567890");
    expect(body).toContain("`abcdef1`");
    expect(body).toContain("dpl_xyz");
    expect(body).toContain("7 error signals");
    expect(body).toContain("aaaaaaaaaaaaaaaa");
    expect(body).toContain("| 12 |");
    expect(body).toContain("Cannot read null");
    expect(body).toContain(DEPLOY_WATCHER_BOT_USERNAME);
  });

  it("escapes pipe chars in error messages", () => {
    const body = renderIncidentIssueBody({
      commitSha: "deadbeefcafebabe",
      ownerUsername: "o",
      repoName: "r",
      deployId: "d",
      reason: "x",
      topErrors: [
        { hash: "h", message: "pipe | inside | message", count: 1 },
      ],
    });
    expect(body).toContain("pipe \\| inside \\| message");
  });

  it("truncates long messages to ~120 chars in the table", () => {
    const longMsg = "x".repeat(500);
    const body = renderIncidentIssueBody({
      commitSha: "1234567",
      ownerUsername: "o",
      repoName: "r",
      deployId: "d",
      reason: "x",
      topErrors: [{ hash: "h", message: longMsg, count: 1 }],
    });
    // The row line contains at most 120 x's between the pipes.
    const match = body.match(/\| `h` \| 1 \| (x+) \|/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(120);
  });

  it("omits the errors table when topErrors is empty", () => {
    const body = renderIncidentIssueBody({
      commitSha: "1234567",
      ownerUsername: "o",
      repoName: "r",
      deployId: "d",
      reason: "deploy status=failed",
      topErrors: [],
    });
    expect(body).not.toContain("Top errors");
  });
});

// ---------------------------------------------------------------------------
// buildDeployWatcherSummary
// ---------------------------------------------------------------------------

describe("deploy-watcher — buildDeployWatcherSummary", () => {
  it("offline message when crontech offline", () => {
    expect(
      buildDeployWatcherSummary({
        offline: true,
        rolledBack: false,
        reason: "",
        incidentIssueNumber: null,
        watchedForMs: 0,
        errorSignalCount: 0,
      })
    ).toBe("crontech offline; watch skipped");
  });

  it("healthy deploy summary with seconds watched + signal count", () => {
    const s = buildDeployWatcherSummary({
      offline: false,
      rolledBack: false,
      reason: "deploy healthy",
      incidentIssueNumber: null,
      watchedForMs: 125_000,
      errorSignalCount: 3,
    });
    expect(s).toContain("healthy");
    expect(s).toContain("125s");
    expect(s).toContain("3 signal");
  });

  it("rolled-back summary embeds reason + incident issue number", () => {
    const s = buildDeployWatcherSummary({
      offline: false,
      rolledBack: true,
      reason: "7 error signals ≥ threshold 5",
      incidentIssueNumber: 42,
      watchedForMs: 300_000,
      errorSignalCount: 7,
    });
    expect(s).toContain("ROLLED BACK");
    expect(s).toContain("threshold");
    expect(s).toContain("#42");
  });

  it("handles missing incident issue number on rollback", () => {
    const s = buildDeployWatcherSummary({
      offline: false,
      rolledBack: true,
      reason: "deploy reported status=failed",
      incidentIssueNumber: null,
      watchedForMs: 10_000,
      errorSignalCount: 0,
    });
    expect(s).toContain("ROLLED BACK");
    expect(s).toContain("(unknown issue)");
  });
});

// ---------------------------------------------------------------------------
// runDeployWatcher — arg validation + graceful degradation
// ---------------------------------------------------------------------------

describe("deploy-watcher — runDeployWatcher", () => {
  it("rejects empty repositoryId", async () => {
    const r = await runDeployWatcher({
      repositoryId: "",
      deployId: "d1",
      commitSha: "abcdef1234567",
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(r.summary.toLowerCase()).toContain("invalid args");
  });

  it("rejects empty deployId", async () => {
    const r = await runDeployWatcher({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      deployId: "",
      commitSha: "abcdef1234567",
    });
    expect(r.ok).toBe(false);
    expect(r.summary.toLowerCase()).toContain("invalid args");
  });

  it("rejects empty commitSha", async () => {
    const r = await runDeployWatcher({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      deployId: "d1",
      commitSha: "",
    });
    expect(r.ok).toBe(false);
    expect(r.summary.toLowerCase()).toContain("invalid args");
  });

  it("returns documented failure when DB cannot open a run", async () => {
    globalThis.fetch = (() => {
      throw new Error("fetch must not be called when run cannot be opened");
    }) as unknown as typeof fetch;
    const r = await runDeployWatcher({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      deployId: "d1",
      commitSha: "abcdef1234567",
    });
    expect(r.ok).toBe(false);
    expect(r.runId).toBeNull();
    expect(r.rolledBack).toBe(false);
    expect(r.incidentIssueNumber).toBeNull();
  });
});
