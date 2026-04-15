/**
 * Block J24 — Branch rename. Pure validation + plan tests.
 */

import { describe, it, expect } from "bun:test";
import {
  MAX_BRANCH_NAME_LENGTH,
  validateBranchName,
  branchValidationMessage,
  planRename,
  shouldRewriteProtectionPattern,
  __internal,
} from "../lib/branch-rename";

describe("branch-rename — validateBranchName (valid cases)", () => {
  it("accepts simple names", () => {
    expect(validateBranchName("main").ok).toBe(true);
    expect(validateBranchName("develop").ok).toBe(true);
    expect(validateBranchName("release").ok).toBe(true);
  });

  it("accepts slash-separated components", () => {
    expect(validateBranchName("feat/login").ok).toBe(true);
    expect(validateBranchName("release/v1.0").ok).toBe(true);
    expect(validateBranchName("release/v1.0.0-rc.1").ok).toBe(true);
  });

  it("accepts numeric + underscore + hyphen", () => {
    expect(validateBranchName("123abc").ok).toBe(true);
    expect(validateBranchName("snake_case_branch").ok).toBe(true);
    expect(validateBranchName("kebab-case-branch").ok).toBe(true);
  });

  it("accepts names up to MAX_BRANCH_NAME_LENGTH", () => {
    const maxName = "a".repeat(MAX_BRANCH_NAME_LENGTH);
    expect(validateBranchName(maxName).ok).toBe(true);
  });

  it("accepts single dots inside components", () => {
    expect(validateBranchName("v1.0.0").ok).toBe(true);
  });
});

describe("branch-rename — validateBranchName (invalid cases)", () => {
  it("rejects non-string", () => {
    expect(validateBranchName(null).ok).toBe(false);
    expect(validateBranchName(undefined).ok).toBe(false);
    expect(validateBranchName(123).ok).toBe(false);
  });

  it("rejects empty string", () => {
    const r = validateBranchName("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("rejects too-long names", () => {
    const r = validateBranchName("a".repeat(MAX_BRANCH_NAME_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_long");
  });

  it("rejects a bare '@'", () => {
    const r = validateBranchName("@");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("only_at");
  });

  it("rejects '@{'", () => {
    const r = validateBranchName("foo@{1}");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("at_brace");
  });

  it("rejects leading or trailing '/'", () => {
    expect(validateBranchName("/foo").ok).toBe(false);
    expect(validateBranchName("foo/").ok).toBe(false);
  });

  it("rejects '//' anywhere", () => {
    expect(validateBranchName("foo//bar").ok).toBe(false);
  });

  it("rejects leading '-'", () => {
    const r = validateBranchName("-no");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("leading_dash");
  });

  it("rejects leading or trailing '.'", () => {
    expect(validateBranchName(".foo").ok).toBe(false);
    expect(validateBranchName("foo.").ok).toBe(false);
  });

  it("rejects '..'", () => {
    const r = validateBranchName("foo..bar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("double_dot");
  });

  it("rejects '.lock' suffix", () => {
    expect(validateBranchName("foo.lock").ok).toBe(false);
  });

  it("rejects '.lock' on a component", () => {
    const r = validateBranchName("release/v1.lock");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // either `lock_suffix` (whole name) or `lock_component` — both valid
      expect(["lock_suffix", "lock_component"]).toContain(r.reason);
    }
  });

  it("rejects whitespace", () => {
    expect(validateBranchName("has space").ok).toBe(false);
    expect(validateBranchName("has\ttab").ok).toBe(false);
  });

  it("rejects forbidden characters", () => {
    for (const ch of ["~", "^", ":", "?", "*", "[", "\\"]) {
      expect(validateBranchName(`foo${ch}bar`).ok).toBe(false);
    }
  });

  it("rejects control characters", () => {
    expect(validateBranchName("foo\u0001bar").ok).toBe(false);
    expect(validateBranchName("foo\u001fbar").ok).toBe(false);
    expect(validateBranchName("foo\u007fbar").ok).toBe(false);
  });

  it("rejects component starting or ending with '.'", () => {
    expect(validateBranchName("release/.hidden").ok).toBe(false);
    expect(validateBranchName("release/trailing.").ok).toBe(false);
  });
});

describe("branch-rename — branchValidationMessage", () => {
  it("returns non-empty strings for every reason code", () => {
    const reasons = [
      "not_string",
      "empty",
      "too_long",
      "slash_boundary",
      "leading_dash",
      "dot_boundary",
      "consecutive_slashes",
      "double_dot",
      "at_brace",
      "only_at",
      "lock_suffix",
      "forbidden_char",
      "control_char",
      "empty_component",
      "dot_component",
      "lock_component",
    ] as const;
    for (const r of reasons) {
      const msg = branchValidationMessage(r);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});

describe("branch-rename — planRename", () => {
  const existing = ["main", "develop", "feat/login"];

  it("approves a valid rename", () => {
    const r = planRename({
      from: "feat/login",
      to: "feat/auth",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from).toBe("feat/login");
      expect(r.to).toBe("feat/auth");
      expect(r.updatesDefault).toBe(false);
    }
  });

  it("flags rename of the default branch", () => {
    const r = planRename({
      from: "main",
      to: "trunk",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updatesDefault).toBe(true);
  });

  it("rejects same-name rename", () => {
    const r = planRename({
      from: "main",
      to: "main",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("same_name");
  });

  it("rejects missing source branch", () => {
    const r = planRename({
      from: "ghost",
      to: "new",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("from_missing");
  });

  it("rejects when destination already exists", () => {
    const r = planRename({
      from: "feat/login",
      to: "develop",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("to_exists");
  });

  it("rejects invalid source name", () => {
    const r = planRename({
      from: "bad..name",
      to: "ok",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_from");
      expect(r.detail).toBe("double_dot");
    }
  });

  it("rejects invalid destination name", () => {
    const r = planRename({
      from: "main",
      to: "has space",
      existingBranches: existing,
      defaultBranch: "main",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid_to");
      expect(r.detail).toBe("forbidden_char");
    }
  });

  it("is case-sensitive ('Main' and 'main' are different)", () => {
    const r = planRename({
      from: "main",
      to: "Main",
      existingBranches: ["main"],
      defaultBranch: "main",
    });
    expect(r.ok).toBe(true);
  });

  it("handles empty existingBranches", () => {
    const r = planRename({
      from: "main",
      to: "trunk",
      existingBranches: [],
      defaultBranch: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("from_missing");
  });

  it("does not mark updatesDefault when defaultBranch is null", () => {
    const r = planRename({
      from: "main",
      to: "trunk",
      existingBranches: ["main"],
      defaultBranch: null,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updatesDefault).toBe(false);
  });
});

describe("branch-rename — shouldRewriteProtectionPattern", () => {
  it("rewrites an exact match", () => {
    expect(shouldRewriteProtectionPattern("main", "main")).toBe(true);
  });

  it("does not rewrite a different exact", () => {
    expect(shouldRewriteProtectionPattern("main", "develop")).toBe(false);
  });

  it("does not rewrite globs even if they match", () => {
    expect(shouldRewriteProtectionPattern("release/*", "release/*")).toBe(
      false
    );
  });

  it("does not rewrite ? or [ globs", () => {
    expect(shouldRewriteProtectionPattern("feat/?", "feat/?")).toBe(false);
    expect(shouldRewriteProtectionPattern("feat/[abc]", "feat/[abc]")).toBe(
      false
    );
  });
});

describe("branch-rename — routes", () => {
  it("GET /settings/branches redirects unauthenticated users", async () => {
    const { default: app } = await import("../app");
    const res = await app.request("/alice/repo/settings/branches");
    expect([302, 401, 403, 404]).toContain(res.status);
  });

  it("POST rename redirects unauthenticated users", async () => {
    const { default: app } = await import("../app");
    const form = new FormData();
    form.append("from", "main");
    form.append("to", "trunk");
    const res = await app.request(
      "/alice/repo/settings/branches/rename",
      { method: "POST", body: form }
    );
    expect([302, 401, 403, 404]).toContain(res.status);
  });
});

describe("branch-rename — __internal parity", () => {
  it("re-exports helpers", () => {
    expect(__internal.validateBranchName).toBe(validateBranchName);
    expect(__internal.planRename).toBe(planRename);
    expect(__internal.branchValidationMessage).toBe(branchValidationMessage);
    expect(__internal.shouldRewriteProtectionPattern).toBe(
      shouldRewriteProtectionPattern
    );
    expect(__internal.MAX_BRANCH_NAME_LENGTH).toBe(MAX_BRANCH_NAME_LENGTH);
  });
});
