/**
 * Block J24 — Branch rename.
 *
 * Pure helpers for validating + planning a branch rename. The actual git
 * work + the DB cascades (pull_requests, branch_protection, merge_queue,
 * default branch) live in the route — this file has no IO and is safe to
 * unit test.
 *
 * Validation follows `git-check-ref-format(1)`. Rules (strict):
 *
 *   - must be non-empty, at most `MAX_BRANCH_NAME_LENGTH` chars
 *   - can't start or end with `/`
 *   - can't contain `//`
 *   - can't contain `..`, `@{`, a bare `@`, or any of ``` ~^:?*[\ ```
 *   - can't contain ASCII control chars (0x00–0x1F, DEL)
 *   - can't start with `-` or `.`
 *   - can't end with `.` or `.lock`
 *   - each slash-separated component must be non-empty, can't begin or end
 *     with `.`, and can't end with `.lock`
 *
 * These mirror what `git check-ref-format --branch` rejects. We do NOT
 * allow a single `@` (git's own rule).
 */

export const MAX_BRANCH_NAME_LENGTH = 250;

export type ValidateBranchResult =
  | { ok: true }
  | { ok: false; reason: BranchValidationReason };

export type BranchValidationReason =
  | "not_string"
  | "empty"
  | "too_long"
  | "slash_boundary"
  | "leading_dash"
  | "dot_boundary"
  | "consecutive_slashes"
  | "double_dot"
  | "at_brace"
  | "only_at"
  | "lock_suffix"
  | "forbidden_char"
  | "control_char"
  | "empty_component"
  | "dot_component"
  | "lock_component";

const FORBIDDEN_RE = /[\s~^:?*\[\\\x7f]/;
const CONTROL_RE = /[\x00-\x1f]/;

export function validateBranchName(name: unknown): ValidateBranchResult {
  if (typeof name !== "string") return { ok: false, reason: "not_string" };
  const n = name;
  if (n.length === 0) return { ok: false, reason: "empty" };
  if (n.length > MAX_BRANCH_NAME_LENGTH)
    return { ok: false, reason: "too_long" };
  if (n === "@") return { ok: false, reason: "only_at" };
  if (n.startsWith("/") || n.endsWith("/"))
    return { ok: false, reason: "slash_boundary" };
  if (n.startsWith("-")) return { ok: false, reason: "leading_dash" };
  if (n.startsWith(".") || n.endsWith("."))
    return { ok: false, reason: "dot_boundary" };
  if (n.includes("//")) return { ok: false, reason: "consecutive_slashes" };
  if (n.includes("..")) return { ok: false, reason: "double_dot" };
  if (n.includes("@{")) return { ok: false, reason: "at_brace" };
  if (n.endsWith(".lock")) return { ok: false, reason: "lock_suffix" };
  if (CONTROL_RE.test(n)) return { ok: false, reason: "control_char" };
  if (FORBIDDEN_RE.test(n)) return { ok: false, reason: "forbidden_char" };

  const parts = n.split("/");
  for (const p of parts) {
    if (p.length === 0) return { ok: false, reason: "empty_component" };
    if (p.startsWith(".") || p.endsWith("."))
      return { ok: false, reason: "dot_component" };
    if (p.endsWith(".lock")) return { ok: false, reason: "lock_component" };
  }
  return { ok: true };
}

export function branchValidationMessage(
  r: BranchValidationReason
): string {
  switch (r) {
    case "not_string":
    case "empty":
      return "Branch name is required.";
    case "too_long":
      return `Branch name must be ${MAX_BRANCH_NAME_LENGTH} characters or fewer.`;
    case "slash_boundary":
      return "Branch name cannot start or end with '/'.";
    case "leading_dash":
      return "Branch name cannot start with '-'.";
    case "dot_boundary":
      return "Branch name cannot start or end with '.'.";
    case "consecutive_slashes":
      return "Branch name cannot contain '//'.";
    case "double_dot":
      return "Branch name cannot contain '..'.";
    case "at_brace":
      return "Branch name cannot contain '@{'.";
    case "only_at":
      return "Branch name cannot be '@'.";
    case "lock_suffix":
    case "lock_component":
      return "Branch name components cannot end with '.lock'.";
    case "forbidden_char":
      return "Branch name cannot contain whitespace or any of ~ ^ : ? * [ \\.";
    case "control_char":
      return "Branch name cannot contain control characters.";
    case "empty_component":
      return "Branch name cannot contain an empty path component.";
    case "dot_component":
      return "Branch name components cannot start or end with '.'.";
  }
}

export interface PlanRenameInput {
  from: string;
  to: string;
  existingBranches: readonly string[];
  defaultBranch: string | null;
}

export type PlanRenameResult =
  | {
      ok: true;
      from: string;
      to: string;
      /** True when renaming the repo's default branch. */
      updatesDefault: boolean;
    }
  | {
      ok: false;
      reason:
        | "same_name"
        | "invalid_from"
        | "invalid_to"
        | "from_missing"
        | "to_exists";
      detail?: BranchValidationReason;
    };

/**
 * Compute whether `from → to` is a legal rename given the current state.
 * Never performs IO. Case-sensitivity matches git (refs are
 * case-sensitive, so "Main" and "main" are different branches).
 */
export function planRename(input: PlanRenameInput): PlanRenameResult {
  const { from, to, existingBranches, defaultBranch } = input;

  const vFrom = validateBranchName(from);
  if (!vFrom.ok)
    return { ok: false, reason: "invalid_from", detail: vFrom.reason };
  const vTo = validateBranchName(to);
  if (!vTo.ok)
    return { ok: false, reason: "invalid_to", detail: vTo.reason };

  if (from === to) return { ok: false, reason: "same_name" };

  const existing = new Set(existingBranches);
  if (!existing.has(from)) return { ok: false, reason: "from_missing" };
  if (existing.has(to)) return { ok: false, reason: "to_exists" };

  return {
    ok: true,
    from,
    to,
    updatesDefault: defaultBranch === from,
  };
}

/**
 * Given a glob/exact branch-protection pattern and the rename, decide
 * whether the pattern itself should be updated. Only exact (non-glob)
 * matches are rewritten — globs like `release/*` are left alone because
 * the rename doesn't change how they match the namespace.
 */
export function shouldRewriteProtectionPattern(
  pattern: string,
  from: string
): boolean {
  if (pattern !== from) return false;
  // Conservative: only exact matches, no glob characters present.
  if (/[*?\[]/.test(pattern)) return false;
  return true;
}

export const __internal = {
  MAX_BRANCH_NAME_LENGTH,
  FORBIDDEN_RE,
  CONTROL_RE,
  validateBranchName,
  branchValidationMessage,
  planRename,
  shouldRewriteProtectionPattern,
};
