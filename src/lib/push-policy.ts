/**
 * Push-policy enforcement — runs at the HTTP layer before git-receive-pack
 * actually accepts the pack.
 *
 * Until now Gluecron's protected-tag and ruleset surfaces were advisory:
 * `src/hooks/post-receive.ts` would log audit entries after the push had
 * already landed. This module flips them to truly blocking by evaluating
 * a list of refs at receive time and returning {allowed:false, violations}
 * so the route can short-circuit with a 403.
 *
 * Refs evaluable from name+sha alone (no pack inspection):
 *   - protected_tags                  — tag pushes must come from owner/bypass
 *   - ruleset.tag_name_pattern        — disallow tag names matching pattern
 *   - ruleset.branch_name_pattern     — disallow branch names matching pattern
 *   - ruleset.forbid_force_push       — heuristic: detected when oldSha was
 *                                       not the zero-SHA and newSha differs.
 *                                       True force-push detection requires a
 *                                       reachability check we don't run here;
 *                                       the existing `forcePush` boolean on
 *                                       PushContext is wired to false unless
 *                                       a smarter caller fills it in.
 *
 * Pure helpers + DB callers; never throws into the request path. On any
 * unexpected failure we return {allowed:true} (fail-open) to preserve the
 * existing no-policy behaviour rather than wedging legitimate pushes when
 * Postgres hiccups.
 */

import {
  matchProtectedTag,
  canBypassProtectedTag,
} from "./protected-tags";
import {
  listRulesetsForRepo,
  evaluatePush,
  type PushContext,
} from "./rulesets";

export type RefUpdate = {
  oldSha: string;
  newSha: string;
  refName: string;
};

export type PushPolicyArgs = {
  repositoryId: string;
  refs: RefUpdate[];
  pusherUserId: string | null;
};

export type PushPolicyResult = {
  allowed: boolean;
  violations: string[];
};

/** "0000000000000000000000000000000000000000" — 40 zeros. */
export const ZERO_SHA = "0".repeat(40);

const ALLOW: PushPolicyResult = { allowed: true, violations: [] };

/**
 * Classify a ref name into "branch" / "tag" for the ruleset evaluator.
 * Heads = branch, tags = tag, anything else (e.g. `refs/notes/*`) we treat
 * as a branch since the evaluator's tag-only rules will gracefully no-op.
 */
function refType(refName: string): "branch" | "tag" {
  return refName.startsWith("refs/tags/") ? "tag" : "branch";
}

/**
 * Evaluate every ref in `refs` against the repo's protected-tags + rulesets
 * and return the aggregated decision. Multiple violations across refs are
 * concatenated so the user sees every problem in one push attempt rather
 * than one-at-a-time.
 */
export async function evaluatePushPolicy(
  args: PushPolicyArgs
): Promise<PushPolicyResult> {
  const { repositoryId, refs, pusherUserId } = args;
  if (!repositoryId || !refs || refs.length === 0) return ALLOW;

  const violations: string[] = [];

  // Protected tags — runs once per ref, only fires for tag refs.
  for (const ref of refs) {
    if (!ref.refName.startsWith("refs/tags/")) continue;
    const tagName = ref.refName.slice("refs/tags/".length);
    let protectedRule: Awaited<ReturnType<typeof matchProtectedTag>> = null;
    try {
      protectedRule = await matchProtectedTag(repositoryId, tagName);
    } catch {
      protectedRule = null;
    }
    if (!protectedRule) continue;

    // Anonymous pusher → never bypasses. Authenticated pusher must be the
    // owner (or future tag-admin) for this repo.
    let canBypass = false;
    try {
      canBypass = await canBypassProtectedTag(repositoryId, pusherUserId);
    } catch {
      canBypass = false;
    }
    if (canBypass) continue;

    const action =
      ref.newSha === ZERO_SHA
        ? "delete"
        : ref.oldSha === ZERO_SHA
        ? "create"
        : "update";
    violations.push(
      `tag "${tagName}" is protected (pattern: ${protectedRule.pattern}); ${action} requires bypass`
    );
  }

  // Rulesets — single DB call, evaluator runs purely on names.
  let rulesets: Awaited<ReturnType<typeof listRulesetsForRepo>> = [];
  try {
    rulesets = await listRulesetsForRepo(repositoryId);
  } catch {
    rulesets = [];
  }

  if (rulesets && rulesets.length > 0) {
    for (const ref of refs) {
      const ctx: PushContext = {
        kind: "push",
        refType: refType(ref.refName),
        refName: ref.refName,
        commits: [],
        // forcePush is left false — true detection requires a reachability
        // check on the new commit, which is in the pack we haven't unpacked.
        forcePush: false,
      };
      let result;
      try {
        result = evaluatePush(rulesets, ctx);
      } catch {
        result = { allowed: true, violations: [] as Array<{ rulesetName: string; ruleType: string; message: string; enforcement: string }> };
      }
      if (!result.allowed && result.violations.length > 0) {
        for (const v of result.violations) {
          // Only "active" enforcement blocks; "evaluate" is dry-run.
          if (v.enforcement !== "active") continue;
          violations.push(
            `ruleset "${v.rulesetName}" rule ${v.ruleType}: ${v.message} (ref ${ref.refName})`
          );
        }
      }
    }
  }

  return violations.length === 0
    ? ALLOW
    : { allowed: false, violations };
}

/** Build a human-readable error body for the 403 response. */
export function formatPolicyError(violations: string[]): string {
  if (!violations || violations.length === 0) {
    return "Push rejected by Gluecron policy.";
  }
  const lines = violations.map((v) => ` - ${v}`);
  return `Push rejected by Gluecron policy:\n${lines.join("\n")}\n`;
}
