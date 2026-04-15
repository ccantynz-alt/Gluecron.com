/**
 * Block J6 — Repository rulesets.
 *
 * A ruleset groups N rules under a named policy at enforcement level active /
 * evaluate / disabled. The evaluator is pure — callers (push hook, PR
 * merger, web editor) pass a PushContext describing what they're about to
 * do, and get back either an allow or the list of violations.
 *
 * Supported rule types in V1:
 *   - commit_message_pattern : { pattern: string, flags?: "i", require?: bool }
 *   - branch_name_pattern    : { pattern: string, require?: bool }
 *   - tag_name_pattern       : { pattern: string, require?: bool }
 *   - blocked_file_paths     : { paths: string[] }   (glob-lite: *, /)
 *   - max_file_size          : { bytes: number }
 *   - forbid_force_push      : {}
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  repoRulesets,
  rulesetRules,
  type RepoRuleset,
  type RulesetRule,
} from "../db/schema";

export type RuleType =
  | "commit_message_pattern"
  | "branch_name_pattern"
  | "tag_name_pattern"
  | "blocked_file_paths"
  | "max_file_size"
  | "forbid_force_push";

export const RULE_TYPES: RuleType[] = [
  "commit_message_pattern",
  "branch_name_pattern",
  "tag_name_pattern",
  "blocked_file_paths",
  "max_file_size",
  "forbid_force_push",
];

export interface CommitLike {
  sha?: string;
  message: string;
  changedPaths?: string[];
  maxBlobSize?: number;
}

export interface PushContext {
  kind: "push";
  refType: "branch" | "tag";
  refName: string;
  commits: CommitLike[];
  forcePush?: boolean;
}

export interface Violation {
  rulesetId: string;
  rulesetName: string;
  enforcement: "active" | "evaluate" | "disabled";
  ruleType: RuleType;
  message: string;
}

export interface EvalResult {
  allowed: boolean;
  violations: Violation[];
}

// ----------------------------------------------------------------------------
// Pure rule helpers
// ----------------------------------------------------------------------------

/** glob-lite → RegExp. Supports `*` (non-slash) and `**` (anything). */
export function globToRegex(glob: string): RegExp {
  const parts: string[] = [];
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        parts.push(".*");
        i += 2;
      } else {
        parts.push("[^/]*");
        i += 1;
      }
    } else if (/[.+?^${}()|[\]\\]/.test(ch)) {
      parts.push("\\" + ch);
      i += 1;
    } else {
      parts.push(ch);
      i += 1;
    }
  }
  return new RegExp("^" + parts.join("") + "$");
}

export function parseParams(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function evalRule(
  rule: RulesetRule,
  ctx: PushContext
): string[] {
  const params = parseParams(rule.params);
  const out: string[] = [];
  switch (rule.ruleType as RuleType) {
    case "commit_message_pattern": {
      const pattern = String(params.pattern || "");
      const flags = String(params.flags || "") || undefined;
      const require = params.require !== false;
      if (!pattern) return out;
      let re: RegExp;
      try {
        re = new RegExp(pattern, flags);
      } catch {
        return out;
      }
      for (const c of ctx.commits) {
        const matches = re.test(c.message);
        if (require && !matches) {
          out.push(
            `commit ${c.sha?.slice(0, 7) || "?"} message does not match /${pattern}/`
          );
        } else if (!require && matches) {
          out.push(
            `commit ${c.sha?.slice(0, 7) || "?"} message matches forbidden /${pattern}/`
          );
        }
      }
      return out;
    }
    case "branch_name_pattern": {
      if (ctx.refType !== "branch") return out;
      const pattern = String(params.pattern || "");
      const require = params.require !== false;
      if (!pattern) return out;
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return out;
      }
      const ok = re.test(ctx.refName);
      if (require && !ok) {
        out.push(`branch "${ctx.refName}" does not match /${pattern}/`);
      } else if (!require && ok) {
        out.push(`branch "${ctx.refName}" matches forbidden /${pattern}/`);
      }
      return out;
    }
    case "tag_name_pattern": {
      if (ctx.refType !== "tag") return out;
      const pattern = String(params.pattern || "");
      const require = params.require !== false;
      if (!pattern) return out;
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return out;
      }
      const ok = re.test(ctx.refName);
      if (require && !ok) {
        out.push(`tag "${ctx.refName}" does not match /${pattern}/`);
      } else if (!require && ok) {
        out.push(`tag "${ctx.refName}" matches forbidden /${pattern}/`);
      }
      return out;
    }
    case "blocked_file_paths": {
      const globs = Array.isArray(params.paths)
        ? (params.paths as string[])
        : [];
      if (!globs.length) return out;
      const res = globs.map((g) => globToRegex(g));
      for (const c of ctx.commits) {
        for (const p of c.changedPaths || []) {
          for (let i = 0; i < res.length; i++) {
            if (res[i].test(p)) {
              out.push(
                `commit ${c.sha?.slice(0, 7) || "?"} modifies blocked path "${p}" (${globs[i]})`
              );
            }
          }
        }
      }
      return out;
    }
    case "max_file_size": {
      const bytes = Number(params.bytes || 0);
      if (!bytes) return out;
      for (const c of ctx.commits) {
        if (typeof c.maxBlobSize === "number" && c.maxBlobSize > bytes) {
          out.push(
            `commit ${c.sha?.slice(0, 7) || "?"} has a blob ${c.maxBlobSize}B > ${bytes}B`
          );
        }
      }
      return out;
    }
    case "forbid_force_push": {
      if (ctx.forcePush) {
        out.push("force push is forbidden by ruleset");
      }
      return out;
    }
    default:
      return out;
  }
}

/** Pure evaluator — takes rulesets + rules + context, returns verdict. */
export function evaluatePush(
  rulesets: Array<RepoRuleset & { rules: RulesetRule[] }>,
  ctx: PushContext
): EvalResult {
  const violations: Violation[] = [];
  let blocked = false;
  for (const rs of rulesets) {
    if (rs.enforcement === "disabled") continue;
    for (const r of rs.rules) {
      const msgs = evalRule(r, ctx);
      for (const m of msgs) {
        violations.push({
          rulesetId: rs.id,
          rulesetName: rs.name,
          enforcement: rs.enforcement as "active" | "evaluate",
          ruleType: r.ruleType as RuleType,
          message: m,
        });
        if (rs.enforcement === "active") blocked = true;
      }
    }
  }
  return { allowed: !blocked, violations };
}

// ----------------------------------------------------------------------------
// DB access
// ----------------------------------------------------------------------------

export async function listRulesetsForRepo(
  repositoryId: string
): Promise<Array<RepoRuleset & { rules: RulesetRule[] }>> {
  const sets = await db
    .select()
    .from(repoRulesets)
    .where(eq(repoRulesets.repositoryId, repositoryId));
  if (sets.length === 0) return [];
  const allRules = await db
    .select()
    .from(rulesetRules);
  const byId = new Map<string, RulesetRule[]>();
  for (const r of allRules) {
    if (!byId.has(r.rulesetId)) byId.set(r.rulesetId, []);
    byId.get(r.rulesetId)!.push(r);
  }
  return sets.map((s) => ({ ...s, rules: byId.get(s.id) || [] }));
}

export async function getRuleset(
  rulesetId: string,
  repositoryId: string
): Promise<(RepoRuleset & { rules: RulesetRule[] }) | null> {
  const [row] = await db
    .select()
    .from(repoRulesets)
    .where(
      and(
        eq(repoRulesets.id, rulesetId),
        eq(repoRulesets.repositoryId, repositoryId)
      )
    )
    .limit(1);
  if (!row) return null;
  const rules = await db
    .select()
    .from(rulesetRules)
    .where(eq(rulesetRules.rulesetId, rulesetId));
  return { ...row, rules };
}

export async function createRuleset(params: {
  repositoryId: string;
  name: string;
  enforcement: "active" | "evaluate" | "disabled";
  createdBy: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = params.name.trim();
  if (!name) return { ok: false, error: "Name is required" };
  if (!["active", "evaluate", "disabled"].includes(params.enforcement)) {
    return { ok: false, error: "Invalid enforcement" };
  }
  try {
    const [row] = await db
      .insert(repoRulesets)
      .values({
        repositoryId: params.repositoryId,
        name,
        enforcement: params.enforcement,
        createdBy: params.createdBy,
      })
      .returning();
    return { ok: true, id: row.id };
  } catch (err: any) {
    const msg = String(err?.message || "");
    if (msg.includes("duplicate") || msg.includes("unique")) {
      return { ok: false, error: "A ruleset with that name already exists" };
    }
    return { ok: false, error: "Could not save ruleset" };
  }
}

export async function updateRulesetEnforcement(
  rulesetId: string,
  repositoryId: string,
  enforcement: "active" | "evaluate" | "disabled"
): Promise<boolean> {
  if (!["active", "evaluate", "disabled"].includes(enforcement)) return false;
  const rows = await db
    .update(repoRulesets)
    .set({ enforcement, updatedAt: new Date() })
    .where(
      and(
        eq(repoRulesets.id, rulesetId),
        eq(repoRulesets.repositoryId, repositoryId)
      )
    )
    .returning();
  return rows.length > 0;
}

export async function deleteRuleset(
  rulesetId: string,
  repositoryId: string
): Promise<boolean> {
  const rows = await db
    .delete(repoRulesets)
    .where(
      and(
        eq(repoRulesets.id, rulesetId),
        eq(repoRulesets.repositoryId, repositoryId)
      )
    )
    .returning();
  return rows.length > 0;
}

export async function addRule(params: {
  rulesetId: string;
  repositoryId: string;
  ruleType: RuleType;
  params: Record<string, unknown>;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!RULE_TYPES.includes(params.ruleType)) {
    return { ok: false, error: "Unknown rule type" };
  }
  // Ensure the ruleset belongs to this repo.
  const parent = await getRuleset(params.rulesetId, params.repositoryId);
  if (!parent) return { ok: false, error: "Ruleset not found" };
  try {
    const [row] = await db
      .insert(rulesetRules)
      .values({
        rulesetId: params.rulesetId,
        ruleType: params.ruleType,
        params: JSON.stringify(params.params || {}),
      })
      .returning();
    return { ok: true, id: row.id };
  } catch {
    return { ok: false, error: "Could not save rule" };
  }
}

export async function deleteRule(
  ruleId: string,
  rulesetId: string,
  repositoryId: string
): Promise<boolean> {
  const parent = await getRuleset(rulesetId, repositoryId);
  if (!parent) return false;
  const rows = await db
    .delete(rulesetRules)
    .where(
      and(eq(rulesetRules.id, ruleId), eq(rulesetRules.rulesetId, rulesetId))
    )
    .returning();
  return rows.length > 0;
}

// Test-only surface.
export const __internal = { evalRule, globToRegex, parseParams };
