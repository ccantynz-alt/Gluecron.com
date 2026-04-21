/**
 * Tests for src/lib/spec-git.ts. These exercise the early-return paths
 * (missing repo, bad path, empty edits) without touching the disk — the
 * function should refuse to proceed before shelling out to git.
 */
import { describe, it, expect } from "bun:test";
import { applyEditsToNewBranch } from "../lib/spec-git";

describe("applyEditsToNewBranch", () => {
  it("returns ok:false when repo path does not exist", async () => {
    const result = await applyEditsToNewBranch({
      repoDiskPath: "/tmp/gluecron-spec-git-nonexistent-" + Date.now(),
      baseRef: "main",
      edits: [{ action: "create", path: "hello.txt", content: "hi" }],
      branchName: "spec/hello",
      commitMessage: "add hello",
      authorName: "Tester",
      authorEmail: "tester@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("rejects path traversal", async () => {
    const result = await applyEditsToNewBranch({
      repoDiskPath: "/tmp/does-not-matter",
      baseRef: "main",
      edits: [
        { action: "create", path: "../../etc/passwd", content: "pwn" },
      ],
      branchName: "spec/traversal",
      commitMessage: "bad",
      authorName: "Tester",
      authorEmail: "tester@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("..");
    }
  });

  it("rejects empty edits array with ok:false", async () => {
    const result = await applyEditsToNewBranch({
      repoDiskPath: "/tmp/does-not-matter",
      baseRef: "main",
      edits: [],
      branchName: "spec/empty",
      commitMessage: "nothing",
      authorName: "Tester",
      authorEmail: "tester@example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no edits|empty/i);
    }
  });
});
