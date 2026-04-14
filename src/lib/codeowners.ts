/**
 * CODEOWNERS parser + sync.
 *
 * Parses a CODEOWNERS file (GitHub-compatible syntax):
 *     # comments allowed
 *     *            @alice
 *     src/api/**   @bob @carol
 *     /docs        @alice
 *
 * Ownership is resolved by last-matching rule (that's how GitHub does it).
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { codeOwners } from "../db/schema";

export interface OwnerRule {
  pattern: string;
  owners: string[]; // usernames, stripped of leading @
}

export function parseCodeowners(content: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const owners = parts
      .slice(1)
      .map((o) => o.replace(/^@/, "").trim())
      .filter(Boolean);
    if (owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Glob-to-regex for CODEOWNERS patterns. Supports `*` and `**`.
 * Patterns anchored at the repo root if they start with `/`.
 */
function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  let p = anchored ? pattern.slice(1) : pattern;
  // Escape regex metacharacters except * and /
  p = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/\*\*/g, "__DOUBLEGLOB__");
  p = p.replace(/\*/g, "[^/]*");
  p = p.replace(/__DOUBLEGLOB__/g, ".*");
  const prefix = anchored ? "^" : "^(?:.*/)?";
  const suffix = p.endsWith("/") ? ".*$" : "(?:/.*)?$";
  return new RegExp(prefix + p + suffix);
}

/**
 * Return owner usernames for a given file path. Last matching rule wins.
 */
export function ownersForPath(
  path: string,
  rules: OwnerRule[]
): string[] {
  let matched: string[] = [];
  for (const r of rules) {
    if (patternToRegex(r.pattern).test(path)) {
      matched = r.owners;
    }
  }
  return matched;
}

/**
 * Replace all rules for a repo in the DB.
 */
export async function syncCodeowners(
  repositoryId: string,
  rules: OwnerRule[]
): Promise<void> {
  try {
    await db.delete(codeOwners).where(eq(codeOwners.repositoryId, repositoryId));
    if (rules.length === 0) return;
    await db.insert(codeOwners).values(
      rules.map((r) => ({
        repositoryId,
        pathPattern: r.pattern,
        ownerUsernames: r.owners.join(","),
      }))
    );
  } catch (err) {
    console.error("[codeowners] sync failed:", err);
  }
}

/**
 * Given a PR's changed file list, return all unique owner usernames to
 * auto-request review from.
 */
export async function reviewersForChangedFiles(
  repositoryId: string,
  paths: string[]
): Promise<string[]> {
  try {
    const rules = await db
      .select()
      .from(codeOwners)
      .where(eq(codeOwners.repositoryId, repositoryId));
    const parsed: OwnerRule[] = rules.map((r) => ({
      pattern: r.pathPattern,
      owners: r.ownerUsernames.split(",").filter(Boolean),
    }));
    const result = new Set<string>();
    for (const p of paths) {
      for (const u of ownersForPath(p, parsed)) result.add(u);
    }
    return [...result];
  } catch {
    return [];
  }
}
