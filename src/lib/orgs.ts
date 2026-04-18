/**
 * Organization helpers (Block B1).
 *
 * Keeps slug validation + role math out of the route handler so they
 * can be unit-tested without touching the database.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  organizations,
  orgMembers,
  teams,
  teamMembers,
  users,
  type OrgRole,
  type TeamRole,
} from "../db/schema";

/**
 * Slug rules: 2–39 chars, [a-z0-9-], cannot start or end with a hyphen,
 * cannot contain consecutive hyphens. Same shape as GitHub org slugs.
 */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/;

/** Reserved slugs we never allow (collision with app routes). */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "auth",
  "login",
  "logout",
  "register",
  "settings",
  "dashboard",
  "explore",
  "search",
  "new",
  "notifications",
  "theme",
  "healthz",
  "readyz",
  "metrics",
  "orgs",
  "org",
  "team",
  "teams",
  "user",
  "users",
  "repo",
  "repos",
  "issues",
  "pulls",
  "releases",
  "shortcuts",
  "help",
  "docs",
  "ask",
  "about",
  "static",
  "assets",
]);

export function isValidSlug(s: string): boolean {
  if (!s || s.length < 2 || s.length > 39) return false;
  if (!SLUG_RE.test(s)) return false;
  if (s.includes("--")) return false;
  if (RESERVED_SLUGS.has(s)) return false;
  return true;
}

export function normalizeSlug(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Role comparisons. Higher rank beats lower.
 *   owner > admin > member
 */
const ORG_ROLE_RANK: Record<OrgRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};

export function orgRoleAtLeast(have: string, need: OrgRole): boolean {
  const h = ORG_ROLE_RANK[have as OrgRole] ?? 0;
  const n = ORG_ROLE_RANK[need];
  return h >= n;
}

export function isValidOrgRole(s: string): s is OrgRole {
  return s === "owner" || s === "admin" || s === "member";
}

export function isValidTeamRole(s: string): s is TeamRole {
  return s === "maintainer" || s === "member";
}

/** Fetch an org + the current user's role in it (if any). */
export async function loadOrgForUser(
  slug: string,
  userId: string | undefined
): Promise<{
  org: typeof organizations.$inferSelect | null;
  role: OrgRole | null;
}> {
  try {
    const [orgRow] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (!orgRow) return { org: null, role: null };
    if (!userId) return { org: orgRow, role: null };
    const [mem] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(
        and(eq(orgMembers.orgId, orgRow.id), eq(orgMembers.userId, userId))
      )
      .limit(1);
    return {
      org: orgRow,
      role: mem && isValidOrgRole(mem.role) ? mem.role : null,
    };
  } catch (err) {
    console.error("[orgs] loadOrgForUser:", err);
    return { org: null, role: null };
  }
}

export async function listOrgsForUser(userId: string) {
  try {
    const rows = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        description: organizations.description,
        avatarUrl: organizations.avatarUrl,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, userId));
    return rows;
  } catch (err) {
    console.error("[orgs] listOrgsForUser:", err);
    return [];
  }
}

export async function listOrgMembers(orgId: string) {
  try {
    return await db
      .select({
        userId: orgMembers.userId,
        role: orgMembers.role,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, orgId));
  } catch (err) {
    console.error("[orgs] listOrgMembers:", err);
    return [];
  }
}

export async function listTeamsForOrg(orgId: string) {
  try {
    return await db.select().from(teams).where(eq(teams.orgId, orgId));
  } catch (err) {
    console.error("[orgs] listTeamsForOrg:", err);
    return [];
  }
}

export async function listTeamMembers(teamId: string) {
  try {
    return await db
      .select({
        userId: teamMembers.userId,
        role: teamMembers.role,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, teamId));
  } catch (err) {
    console.error("[orgs] listTeamMembers:", err);
    return [];
  }
}

/**
 * Exported for unit tests.
 */
export const __test = {
  ORG_ROLE_RANK,
  RESERVED_SLUGS,
  SLUG_RE,
};
