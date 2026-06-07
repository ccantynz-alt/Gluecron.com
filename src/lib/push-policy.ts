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

import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  matchProtectedTag,
  canBypassProtectedTag,
} from "./protected-tags";
import {
  listRulesetsForRepo,
  evaluatePush,
  parseParams,
  type PushContext,
} from "./rulesets";
import type { RulesetRule, RepoRuleset } from "../db/schema";

export type RefUpdate = {
  oldSha: string;
  newSha: string;
  refName: string;
};

export type PushPolicyArgs = {
  repositoryId: string;
  refs: RefUpdate[];
  pusherUserId: string | null;
  /** Absolute path to the bare repo dir; enables pack-content inspection. */
  repoPath?: string;
};

export type PushPolicyResult = {
  allowed: boolean;
  violations: string[];
};

/** "0000000000000000000000000000000000000000" — 40 zeros. */
export const ZERO_SHA = "0".repeat(40);

// ----------------------------------------------------------------------------
// Pack-content inspection via pre-receive hook
// ----------------------------------------------------------------------------

type ActiveRuleset = RepoRuleset & { rules: RulesetRule[] };

/**
 * JS source for the per-push evaluator that the pre-receive hook calls once
 * per ref.  Receives three file-path arguments:
 *   argv[1] = rules.json path
 *   argv[2] = commits file  (lines: "<sha> <subject>")
 *   argv[3] = sizes file    (lines: "<bytes> <path>")
 *
 * Writes one line per violation to stdout: "<enforcement>\x00<message>".
 * Exits 0 always — the shell hook interprets the output.
 */
function buildEvalScript(): string {
  // Written as a plain JS string so no TypeScript template interpolation occurs.
  // Uses only Node/Bun built-ins; no imports from the Gluecron codebase.
  return [
    "import { readFileSync } from 'fs';",
    "const rules   = JSON.parse(readFileSync(process.argv[2], 'utf8'));",
    "const commits = readFileSync(process.argv[3], 'utf8').split('\\n').filter(Boolean);",
    "const sizes   = readFileSync(process.argv[4], 'utf8').split('\\n').filter(Boolean);",
    "const SEP = '\\t';",
    "const out = [];",
    "for (const line of commits) {",
    "  const sp = line.indexOf(' ');",
    "  if (sp < 0) continue;",
    "  const sha = line.slice(0, sp);",
    "  const msg = line.slice(sp + 1);",
    "  for (const r of rules.commitMsgRules) {",
    "    const pattern = String(r.params.pattern || '');",
    "    if (!pattern) continue;",
    "    let re;",
    "    try { re = new RegExp(pattern, String(r.params.flags || '') || undefined); } catch { continue; }",
    "    const req = r.params.require !== false;",
    "    const ok  = re.test(msg);",
    "    if (req && !ok)  out.push(r.enforcement + SEP + 'ruleset \"' + r.rulesetName + '\" commit ' + sha.slice(0,7) + ' message does not match /' + pattern + '/');",
    "    if (!req && ok)  out.push(r.enforcement + SEP + 'ruleset \"' + r.rulesetName + '\" commit ' + sha.slice(0,7) + ' message matches forbidden /' + pattern + '/');",
    "  }",
    "}",
    "for (const line of sizes) {",
    "  const sp = line.indexOf(' ');",
    "  if (sp < 0) continue;",
    "  const sz = Number(line.slice(0, sp));",
    "  const fp = line.slice(sp + 1);",
    "  for (const r of rules.blockedPathRules) {",
    "    const globs = Array.isArray(r.params.paths) ? r.params.paths : [];",
    "    for (const g of globs) {",
    "      const parts = [];",
    "      let i = 0;",
    "      while (i < g.length) {",
    "        const ch = g[i];",
    "        if (ch === '*') {",
    "          if (g[i+1] === '*') { parts.push('.*'); i += 2; }",
    "          else { parts.push('[^/]*'); i++; }",
    "        } else if (/[.+?^${}()|[\\]\\\\]/.test(ch)) {",
    "          parts.push('\\\\' + ch); i++;",
    "        } else { parts.push(ch); i++; }",
    "      }",
    "      const re = new RegExp('^' + parts.join('') + '$');",
    "      if (re.test(fp)) out.push(r.enforcement + SEP + 'ruleset \"' + r.rulesetName + '\" modifies blocked path \"' + fp + '\" (' + g + ')');",
    "    }",
    "  }",
    "  for (const r of rules.maxSizeRules) {",
    "    const limit = Number(r.params.bytes || 0);",
    "    if (limit && sz > limit)",
    "      out.push(r.enforcement + SEP + 'ruleset \"' + r.rulesetName + '\" file \"' + fp + '\" is ' + sz + 'B > limit ' + limit + 'B');",
    "  }",
    "}",
    "process.stdout.write(out.join('\\n'));",
  ].join("\n") + "\n";
}

/**
 * Generate a bash pre-receive hook that calls the companion eval.js once per
 * pushed ref.  Both file paths are embedded literals so the script is
 * fully self-contained.
 */
function buildPreReceiveScript(evalScriptPath: string, rulesJsonPath: string): string {
  const D = "$";
  return [
    "#!/bin/bash",
    "set -uo pipefail",
    `EVAL_SCRIPT='${evalScriptPath}'`,
    `RULES_JSON='${rulesJsonPath}'`,
    "FAILED=0",
    "",
    `while IFS=' ' read -r OLD NEW REF; do`,
    `  [[ "${D}NEW" =~ ^0+${D} ]] && continue`,
    `  if [[ "${D}OLD" =~ ^0+${D} ]]; then`,
    `    LOG_RANGE="${D}NEW"`,
    // Empty-tree SHA — safe diff base for new branches with no parent.
    `    DIFF_BASE=4b825dc642cb6eb9a060e54bf8d69288fbee4904`,
    `  else`,
    `    LOG_RANGE="${D}OLD..${D}NEW"`,
    `    DIFF_BASE="${D}OLD"`,
    `  fi`,
    "",
    `  COMMITS_TMP=$(mktemp)`,
    `  SIZES_TMP=$(mktemp)`,
    `  PATHS_TMP=$(mktemp)`,
    `  git log --format="%H %s" "${D}LOG_RANGE" 2>/dev/null > "${D}COMMITS_TMP" || true`,
    `  git diff --name-only "${D}DIFF_BASE" "${D}NEW" 2>/dev/null > "${D}PATHS_TMP" || true`,
    "",
    // Build sizes file: "<bytes> <path>" per changed file.
    `  while IFS= read -r FP; do`,
    `    [ -z "${D}FP" ] && continue`,
    `    BLOB=$(git ls-tree "${D}NEW" -- "${D}FP" 2>/dev/null | awk '{print ${D}3}')`,
    `    SZ=0`,
    `    [ -n "${D}BLOB" ] && SZ=$(git cat-file -s "${D}BLOB" 2>/dev/null || echo 0)`,
    `    printf '%s %s\\n' "${D}SZ" "${D}FP"`,
    `  done < "${D}PATHS_TMP" > "${D}SIZES_TMP"`,
    "",
    `  RESULT=$(bun run "${D}EVAL_SCRIPT" -- "${D}RULES_JSON" "${D}COMMITS_TMP" "${D}SIZES_TMP" 2>/dev/null || true)`,
    "",
    // Each output line is "<enforcement>\t<message>"; split on tab.
    `  while IFS=$'\\t' read -r ENFORCE MSG_OUT; do`,
    `    [ -z "${D}MSG_OUT" ] && continue`,
    `    echo "remote: ${D}MSG_OUT" >&2`,
    `    [ "${D}ENFORCE" = "active" ] && FAILED=1`,
    `  done <<< "${D}RESULT"`,
    "",
    `  rm -f "${D}COMMITS_TMP" "${D}PATHS_TMP" "${D}SIZES_TMP"`,
    `done`,
    "",
    `exit ${D}FAILED`,
  ].join("\n") + "\n";
}

/**
 * Write a pre-receive hook + companion rules JSON to a temp directory and
 * return the git env vars that redirect git to use that hooks dir, plus a
 * cleanup function.
 *
 * Callers must always invoke cleanup() — even on error — to remove the temp
 * directory.  Failure to set up the hook dir is non-fatal: we return null so
 * the caller can proceed without pack-content inspection rather than wedging
 * the push.
 */
export async function installPackInspectionHook(
  rulesets: ActiveRuleset[]
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> } | null> {
  // Collect pack-content rules from non-disabled rulesets.
  type RuleEntry = { rulesetName: string; enforcement: string; params: Record<string, unknown> };
  const commitMsgRules: RuleEntry[] = [];
  const blockedPathRules: RuleEntry[] = [];
  const maxSizeRules: RuleEntry[] = [];

  for (const rs of rulesets) {
    if (rs.enforcement === "disabled") continue;
    for (const r of rs.rules) {
      const p = parseParams(r.params);
      const entry: RuleEntry = { rulesetName: rs.name, enforcement: rs.enforcement, params: p };
      if (r.ruleType === "commit_message_pattern") commitMsgRules.push(entry);
      else if (r.ruleType === "blocked_file_paths") blockedPathRules.push(entry);
      else if (r.ruleType === "max_file_size") maxSizeRules.push(entry);
    }
  }

  // No pack-content rules → skip hook installation entirely.
  if (!commitMsgRules.length && !blockedPathRules.length && !maxSizeRules.length) {
    return null;
  }

  try {
    const dir = await mkdtemp(join(tmpdir(), "gluecron-hooks-"));
    const rulesJsonPath = join(dir, "rules.json");
    await writeFile(
      rulesJsonPath,
      JSON.stringify({ commitMsgRules, blockedPathRules, maxSizeRules }),
      { mode: 0o644 }
    );
    const evalScriptPath = join(dir, "eval.js");
    await writeFile(evalScriptPath, buildEvalScript(), { mode: 0o644 });
    const hookPath = join(dir, "pre-receive");
    await writeFile(hookPath, buildPreReceiveScript(evalScriptPath, rulesJsonPath), { mode: 0o755 });
    return {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: dir,
      },
      cleanup: async () => {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      },
    };
  } catch {
    return null;
  }
}

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

/**
 * Convenience wrapper: fetch rulesets for `repositoryId` from the DB and
 * call `installPackInspectionHook`.  Returns null on DB error or when there
 * are no pack-content rules to enforce.  Never throws.
 */
export async function installPackInspectionHookForRepo(
  repositoryId: string
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> } | null> {
  let rulesets: Awaited<ReturnType<typeof listRulesetsForRepo>> = [];
  try {
    rulesets = await listRulesetsForRepo(repositoryId);
  } catch {
    return null;
  }
  if (!rulesets.length) return null;
  return installPackInspectionHook(rulesets);
}

/** Build a human-readable error body for the 403 response. */
export function formatPolicyError(violations: string[]): string {
  if (!violations || violations.length === 0) {
    return "Push rejected by Gluecron policy.";
  }
  const lines = violations.map((v) => ` - ${v}`);
  return `Push rejected by Gluecron policy:\n${lines.join("\n")}\n`;
}
