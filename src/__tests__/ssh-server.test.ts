/**
 * Tests for Block SSH-1 — ssh-server.ts
 *
 * We test the pure helpers in isolation (no DB, no real SSH sockets):
 *   - parseGitCommand   — command string → {service, owner, repo}
 *   - computePushedRefs — before/after show-ref → PushRef[]
 *
 * resolveUserByKeyBlob is DB-dependent; we cover it with a DB-skip guard.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import {
  parseGitCommand,
  computePushedRefs,
  resolveUserByKeyBlob,
} from "../lib/ssh-server";

// ---------------------------------------------------------------------------
// parseGitCommand
// ---------------------------------------------------------------------------

describe("parseGitCommand", () => {
  test("upload-pack with leading slash", () => {
    const r = parseGitCommand("git-upload-pack '/alice/myrepo.git'");
    expect(r).toEqual({
      service: "git-upload-pack",
      owner: "alice",
      repo: "myrepo",
    });
  });

  test("receive-pack with leading slash", () => {
    const r = parseGitCommand("git-receive-pack '/bob/project.git'");
    expect(r).toEqual({
      service: "git-receive-pack",
      owner: "bob",
      repo: "project",
    });
  });

  test("upload-pack without leading slash (some clients omit it)", () => {
    const r = parseGitCommand("git-upload-pack 'alice/myrepo.git'");
    expect(r).toEqual({
      service: "git-upload-pack",
      owner: "alice",
      repo: "myrepo",
    });
  });

  test("upload-pack without quotes (rare but valid)", () => {
    const r = parseGitCommand("git-upload-pack /alice/myrepo.git");
    expect(r).toEqual({
      service: "git-upload-pack",
      owner: "alice",
      repo: "myrepo",
    });
  });

  test(".git suffix is stripped", () => {
    const r = parseGitCommand("git-upload-pack '/alice/myrepo.git'");
    expect(r?.repo).toBe("myrepo");
  });

  test("repo without .git suffix is accepted", () => {
    const r = parseGitCommand("git-upload-pack '/alice/myrepo'");
    expect(r?.repo).toBe("myrepo");
  });

  test("repo with dots and hyphens in name", () => {
    const r = parseGitCommand("git-upload-pack '/alice/my-repo.v2'");
    expect(r).toEqual({
      service: "git-upload-pack",
      owner: "alice",
      repo: "my-repo.v2",
    });
  });

  test("trailing whitespace is ignored", () => {
    const r = parseGitCommand("git-upload-pack '/alice/repo.git'  ");
    expect(r?.owner).toBe("alice");
  });

  test("unknown service returns null", () => {
    expect(parseGitCommand("bash -i")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseGitCommand("")).toBeNull();
  });

  test("missing owner/repo returns null", () => {
    expect(parseGitCommand("git-upload-pack")).toBeNull();
  });

  test("path traversal attempt returns null", () => {
    expect(
      parseGitCommand("git-upload-pack '/../../etc/passwd'")
    ).toBeNull();
  });

  test("shell injection attempt returns null", () => {
    expect(
      parseGitCommand("git-upload-pack '/alice/repo'; rm -rf /")
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computePushedRefs
// ---------------------------------------------------------------------------

describe("computePushedRefs", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const sha3 = "c".repeat(40);
  const ZERO = "0".repeat(40);

  test("new branch is reported with ZERO oldSha", () => {
    const refs = computePushedRefs(
      [],
      [{ sha: sha1, ref: "refs/heads/main" }]
    );
    expect(refs).toEqual([
      { oldSha: ZERO, newSha: sha1, refName: "refs/heads/main" },
    ]);
  });

  test("updated branch reports old and new sha", () => {
    const refs = computePushedRefs(
      [{ sha: sha1, ref: "refs/heads/main" }],
      [{ sha: sha2, ref: "refs/heads/main" }]
    );
    expect(refs).toEqual([
      { oldSha: sha1, newSha: sha2, refName: "refs/heads/main" },
    ]);
  });

  test("deleted branch is reported with ZERO newSha", () => {
    const refs = computePushedRefs(
      [{ sha: sha1, ref: "refs/heads/feature" }],
      []
    );
    expect(refs).toEqual([
      { oldSha: sha1, newSha: ZERO, refName: "refs/heads/feature" },
    ]);
  });

  test("unchanged refs are not reported", () => {
    const refs = computePushedRefs(
      [
        { sha: sha1, ref: "refs/heads/main" },
        { sha: sha2, ref: "refs/heads/stable" },
      ],
      [
        { sha: sha1, ref: "refs/heads/main" },
        { sha: sha2, ref: "refs/heads/stable" },
      ]
    );
    expect(refs).toHaveLength(0);
  });

  test("multiple changes in one push", () => {
    const refs = computePushedRefs(
      [
        { sha: sha1, ref: "refs/heads/main" },
        { sha: sha2, ref: "refs/heads/old" },
      ],
      [
        { sha: sha3, ref: "refs/heads/main" },
        { sha: sha1, ref: "refs/heads/new" },
      ]
    );
    // main updated, old deleted, new created
    expect(refs).toHaveLength(3);
    const main = refs.find((r) => r.refName === "refs/heads/main");
    expect(main).toEqual({
      oldSha: sha1,
      newSha: sha3,
      refName: "refs/heads/main",
    });
    const deleted = refs.find((r) => r.refName === "refs/heads/old");
    expect(deleted?.newSha).toBe(ZERO);
    const created = refs.find((r) => r.refName === "refs/heads/new");
    expect(created?.oldSha).toBe(ZERO);
  });

  test("empty before and after is empty", () => {
    expect(computePushedRefs([], [])).toHaveLength(0);
  });

  test("tag push is included", () => {
    const refs = computePushedRefs(
      [],
      [{ sha: sha1, ref: "refs/tags/v1.0.0" }]
    );
    expect(refs[0]?.refName).toBe("refs/tags/v1.0.0");
  });
});

// ---------------------------------------------------------------------------
// resolveUserByKeyBlob — DB-gated test
// ---------------------------------------------------------------------------

describe("resolveUserByKeyBlob", () => {
  test("returns null for an unknown key blob", async () => {
    const fakeBlob = Buffer.from("not-a-real-key-blob");
    // If DB is unreachable the function fails closed and returns null.
    const result = await resolveUserByKeyBlob(fakeBlob);
    expect(result).toBeNull();
  });
});
