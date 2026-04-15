/**
 * CODEOWNERS parser + sync.
 *
 * Parses a CODEOWNERS file (GitHub-compatible syntax):
 *     # comments allowed
 *     *            @alice
 *     src/api/**   @bob @carol
 *     /docs        @alice
 *     api/**       @acme/backend        # Block B3: team reference
 *
 * Ownership is resolved by last-matching rule (GitHub parity).
 *
 * Tokens containing a `/` are treated as team references of the form
 * `@orgSlug/teamSlug`. They are stored as-is and expanded to the team's
 * current membership at review-request time.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  codeOwners,
  organizations,
  teams,
  teamMembers,
  users,
} from "../db/schema";

export interface OwnerRule {
  pattern: string;
  /**
   * Owner tokens. Usernames are stored without the leading `@`;
   * team references are stored as `org/team` (also no `@`).
   * Use `isTeamToken(tok)` to distinguish.
   */
  owners: string[];
}

export function isTeamToken(token: string): boolean {
  return token.includes("/");
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
 * Resolve a single `org/team` token to the set of usernames currently on
 * the team. Returns `[]` on unknown org, unknown team, or DB error — never
 * throws. Pure helper; exported for unit tests.
 */
export async function expandTeamToken(token: string): Promise<string[]> {
  if (!isTeamToken(token)) return [];
  const [orgSlug, teamSlug] = token.split("/", 2);
  if (!orgSlug || !teamSlug) return [];
  try {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1);
    if (!org) return [];
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.slug, teamSlug)))
      .limit(1);
    if (!team) return [];
    const rows = await db
      .select({ username: users.username })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, team.id));
    return rows.map((r) => r.username);
  } catch (err) {
    console.error("[codeowners] expandTeamToken:", err);
    return [];
  }
}

/**
 * Expand a list of owner tokens to concrete usernames.
 * - Plain usernames pass through.
 * - `org/team` tokens are expanded to the team's current members.
 * - Unknown tokens are dropped.
 */
export async function expandOwnerTokens(tokens: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (!t) continue;
    if (isTeamToken(t)) {
      for (const u of await expandTeamToken(t)) out.add(u);
    } else {
      out.add(t);
    }
  }
  return [...out];
}

/**
 * Given a PR's changed file list, return all unique owner usernames to
 * auto-request review from. Team references are expanded.
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
    const tokens = new Set<string>();
    for (const p of paths) {
      for (const u of ownersForPath(p, parsed)) tokens.add(u);
    }
    return await expandOwnerTokens([...tokens]);
  } catch {
    return [];
  }
}
