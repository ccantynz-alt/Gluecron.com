/**
 * Block K1 — Agent runtime unit tests.
 *
 * Covers the pure helpers (state machine + log truncation) plus the
 * runSandboxed primitive via real subprocesses. DB helpers are intentionally
 * not tested here — they hit Neon and are covered by integration flow.
 */

import { describe, it, expect } from "bun:test";
import {
  type AgentRunStatus,
  canTransition,
  isTerminalStatus,
  runSandboxed,
  truncateError,
  truncateLog,
  __internal,
} from "../lib/agent-runtime";

const ALL_STATUSES: AgentRunStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "killed",
  "timeout",
];

describe("agent-runtime — isTerminalStatus", () => {
  it("treats queued + running as non-terminal", () => {
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("treats succeeded / failed / killed / timeout as terminal", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("killed")).toBe(true);
    expect(isTerminalStatus("timeout")).toBe(true);
  });

  it("is exhaustive over AgentRunStatus", () => {
    // Every status value must have a defined answer (no undefined bubbling).
    for (const s of ALL_STATUSES) {
      expect(typeof isTerminalStatus(s)).toBe("boolean");
    }
  });
});

describe("agent-runtime — canTransition", () => {
  it("allows the happy path queued → running → succeeded", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "succeeded")).toBe(true);
  });

  it("allows running → failed | timeout | killed", () => {
    expect(canTransition("running", "failed")).toBe(true);
    expect(canTransition("running", "timeout")).toBe(true);
    expect(canTransition("running", "killed")).toBe(true);
  });

  it("allows queued → killed (operator cancel before start)", () => {
    expect(canTransition("queued", "killed")).toBe(true);
  });

  it("forbids going backward from any terminal state", () => {
    for (const terminal of ["succeeded", "failed", "killed", "timeout"] as const) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("forbids self-transitions", () => {
    for (const s of ALL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("forbids skipping running (queued → succeeded/failed/timeout)", () => {
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("queued", "failed")).toBe(false);
    expect(canTransition("queued", "timeout")).toBe(false);
  });

  it("forbids running → queued (no re-queue)", () => {
    expect(canTransition("running", "queued")).toBe(false);
  });
});

describe("agent-runtime — truncateLog", () => {
  it("returns a concatenation when well under the cap", () => {
    const out = truncateLog("abc", "def", 1024);
    expect(out).toBe("abcdef");
  });

  it("returns exactly the combined string at the cap boundary", () => {
    const existing = "a".repeat(500);
    const addition = "b".repeat(500);
    const out = truncateLog(existing, addition, 1000);
    expect(out.length).toBe(1000);
    expect(out).toBe(existing + addition);
  });

  it("prepends the sentinel and keeps the last maxBytes when over the cap", () => {
    const existing = "x".repeat(2000);
    const addition = "y".repeat(500);
    const out = truncateLog(existing, addition, 1000);
    expect(out.startsWith(__internal.LOG_TRUNCATED_SENTINEL)).toBe(true);
    // Tail length == maxBytes; we keep the rightmost characters of existing+addition.
    const tail = out.slice(__internal.LOG_TRUNCATED_SENTINEL.length);
    expect(tail.length).toBe(1000);
    // Since addition ('y'*500) sits at the very end, the last 500 chars must be 'y'.
    expect(tail.endsWith("y".repeat(500))).toBe(true);
    // And the middle should be the tail of the 'x' run.
    expect(tail.startsWith("x".repeat(500))).toBe(true);
  });

  it("does not double the sentinel on subsequent truncations", () => {
    // First truncation.
    const first = truncateLog("x".repeat(2000), "", 1000);
    expect(first.startsWith(__internal.LOG_TRUNCATED_SENTINEL)).toBe(true);
    // Feed the already-truncated log back in with more content that forces
    // another truncation.
    const second = truncateLog(first, "z".repeat(1500), 1000);
    expect(second.startsWith(__internal.LOG_TRUNCATED_SENTINEL)).toBe(true);
    // Only one sentinel should appear in total.
    const occurrences = second.split(__internal.LOG_TRUNCATED_SENTINEL).length - 1;
    expect(occurrences).toBe(1);
    // Most of the tail should be 'z'.
    expect(second.endsWith("z".repeat(500))).toBe(true);
  });

  it("handles empty existing and empty addition safely", () => {
    expect(truncateLog("", "", 100)).toBe("");
    expect(truncateLog("", "hi", 100)).toBe("hi");
    expect(truncateLog("hi", "", 100)).toBe("hi");
  });
});

describe("agent-runtime — truncateError", () => {
  it("leaves short strings alone", () => {
    expect(truncateError("boom")).toBe("boom");
  });

  it("trims long strings and appends a marker", () => {
    const long = "e".repeat(10_000);
    const out = truncateError(long, 4096);
    expect(out.length).toBeLessThanOrEqual(4096 + 32); // body + marker
    expect(out.startsWith("e".repeat(4096))).toBe(true);
    expect(out).toContain("truncated");
  });

  it("handles empty / null-ish input", () => {
    expect(truncateError("")).toBe("");
    // @ts-expect-error — runtime guard against null callers.
    expect(truncateError(null)).toBe("");
  });
});

describe("agent-runtime — runSandboxed", () => {
  it("runs a successful command and captures stdout", async () => {
    const res = await runSandboxed("/bin/echo", ["hello world"], {
      cwd: "/tmp",
      timeoutMs: 2000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout).toContain("hello world");
    expect(res.stderr).toBe("");
  });

  it("returns a non-zero exit code for failing commands", async () => {
    // `false` always exits 1.
    const res = await runSandboxed("/bin/sh", ["-c", "exit 7"], {
      cwd: "/tmp",
      timeoutMs: 2000,
    });
    expect(res.exitCode).toBe(7);
    expect(res.timedOut).toBe(false);
  });

  it("kills long-running processes on timeout", async () => {
    const started = Date.now();
    const res = await runSandboxed("/bin/sleep", ["10"], {
      cwd: "/tmp",
      timeoutMs: 200,
    });
    const elapsed = Date.now() - started;
    expect(res.timedOut).toBe(true);
    // 200ms timeout + up to 5s SIGTERM grace before SIGKILL; sleep(1) responds
    // to SIGTERM immediately so in practice well under a second.
    expect(elapsed).toBeLessThan(6000);
    expect(res.stderr).toContain("timeout");
  }, 10_000);

  it("caps stdout at the configured stream cap", async () => {
    // Write ~200 KB of 'a's to stdout via a tiny python-free shell loop.
    // `yes` is simpler: it spams a string forever. Combined with head
    // we get deterministic size without relying on Python/Node.
    const res = await runSandboxed(
      "/bin/sh",
      ["-c", "yes aaaaaaaaaa | head -c 204800"],
      { cwd: "/tmp", timeoutMs: 5000, stdoutCapBytes: 64 * 1024 }
    );
    expect(res.exitCode).toBe(0);
    // Capped stream = 64 KB content + '\n[... truncated ...]' suffix.
    expect(res.stdout.length).toBeGreaterThanOrEqual(64 * 1024);
    expect(res.stdout.length).toBeLessThan(64 * 1024 + 64);
    expect(res.stdout).toContain("truncated");
  }, 10_000);

  it("reports spawn failure without throwing", async () => {
    const res = await runSandboxed(
      "/nonexistent/definitely-not-a-real-binary-xyz",
      [],
      { cwd: "/tmp", timeoutMs: 1000 }
    );
    // Bun either returns exitCode=null + stderr message, or exit!=0 — both
    // are acceptable "failure surfaced" outcomes. What must NOT happen is a
    // throw. Assert the call resolved and returned a result object.
    expect(typeof res.timedOut).toBe("boolean");
    expect(res.exitCode === null || res.exitCode !== 0).toBe(true);
  });

  it("passes a minimal env by default (no process.env leakage)", async () => {
    // Set a secret-looking var in the parent process and ensure it does NOT
    // leak into the sandbox's environment when the caller passes no env.
    process.env.GLUECRON_TEST_SECRET = "leak-me-please";
    const res = await runSandboxed(
      "/bin/sh",
      ["-c", "echo \"S=${GLUECRON_TEST_SECRET:-unset}\""],
      { cwd: "/tmp", timeoutMs: 2000 }
    );
    delete process.env.GLUECRON_TEST_SECRET;
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("S=unset");
  });

  it("honours a caller-supplied env verbatim", async () => {
    const res = await runSandboxed(
      "/bin/sh",
      ["-c", "echo \"V=$FOO\""],
      {
        cwd: "/tmp",
        timeoutMs: 2000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", FOO: "bar" },
      }
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("V=bar");
  });
});
