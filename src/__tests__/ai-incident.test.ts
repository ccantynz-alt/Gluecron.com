/**
 * Block D4 — AI Incident Responder tests.
 *
 * These tests exercise the pure helper (no I/O) and confirm that
 * `onDeployFailure` degrades gracefully when the repository does not exist
 * (or the DB is unavailable) without ever throwing.
 */

import { describe, it, expect } from "bun:test";
import {
  onDeployFailure,
  summariseCommitsForIncident,
} from "../lib/ai-incident";

describe("lib/ai-incident — module shape", () => {
  it("imports cleanly and exports the expected functions", () => {
    expect(typeof summariseCommitsForIncident).toBe("function");
    expect(typeof onDeployFailure).toBe("function");
  });
});

describe("lib/ai-incident — summariseCommitsForIncident", () => {
  it("formats each commit as `- <sha7> <subject> — <author>`", () => {
    const out = summariseCommitsForIncident([
      { sha: "abcdef1234567890", message: "fix: handle null", author: "alice" },
      { sha: "fedcba0987654321", message: "feat: new thing", author: "bob" },
    ]);
    expect(out).toBe(
      "- abcdef1 fix: handle null — alice\n" +
        "- fedcba0 feat: new thing — bob"
    );
  });

  it("keeps only the first line of multi-line commit messages", () => {
    const out = summariseCommitsForIncident([
      {
        sha: "1111111aaaaaaa",
        message: "first line\n\nbody goes here",
        author: "carol",
      },
    ]);
    expect(out).toBe("- 1111111 first line — carol");
  });

  it("handles an empty list as an empty string", () => {
    expect(summariseCommitsForIncident([])).toBe("");
  });

  it("tolerates missing fields without throwing", () => {
    const out = summariseCommitsForIncident([
      { sha: "", message: "", author: "" },
    ]);
    // Expect a renderable line even when fields are blank.
    expect(out).toContain(" — ");
  });
});

describe("lib/ai-incident — onDeployFailure", () => {
  it("returns { issueNumber: null, reason: <non-empty> } for an unknown repositoryId without throwing", async () => {
    const result = await onDeployFailure({
      repositoryId: "00000000-0000-0000-0000-000000000000",
      deploymentId: "00000000-0000-0000-0000-000000000000",
      ref: "refs/heads/main",
      commitSha: "0".repeat(40),
      target: "crontech",
      errorMessage: "HTTP 500",
    });
    expect(result).toBeDefined();
    expect(result.issueNumber).toBeNull();
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("never throws even when all optional fields are missing", async () => {
    await expect(
      onDeployFailure({
        repositoryId: "00000000-0000-0000-0000-000000000000",
        deploymentId: "00000000-0000-0000-0000-000000000000",
      })
    ).resolves.toBeDefined();
  });
});
