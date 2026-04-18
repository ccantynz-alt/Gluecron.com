/**
 * Namespace resolution (Block B2).
 *
 * The URL path `/:slug` can resolve to either a user or an organization.
 * Usernames and org slugs occupy the same routing namespace; at creation
 * time we refuse an org slug that collides with a username (and vice-versa
 * at register time — see `routes/auth.tsx`).
 *
 * Helpers here are read-only and swallow DB errors: they return `null` on
 * failure so page handlers can fall through to 404 instead of 500.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { users, organizations, repositories } from "../db/schema";

export type Namespace =
  | { kind: "user"; id: string; slug: string }
  | { kind: "org"; id: string; slug: string };

/**
 * Resolve a URL slug to either a user or an org. User lookups win first
 * (usernames are the legacy, most-used namespace). Returns `null` if neither
 * exists or the DB is unreachable.
 */
export async function resolveNamespace(
  slug: string
): Promise<Namespace | null> {
  if (!slug) return null;
  try {
    const [u] = await db
      .select({ id: users.id, slug: users.username })
      .from(users)
      .where(eq(users.username, slug))
      .limit(1);
    if (u) return { kind: "user", id: u.id, slug: u.slug };

    const [o] = await db
      .select({ id: organizations.id, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    if (o) return { kind: "org", id: o.id, slug: o.slug };

    return null;
  } catch (err) {
    console.error("[namespace] resolveNamespace:", err);
    return null;
  }
}

/**
 * Load a repo by its URL path `:owner/:repo`. Works for both user-owned
 * and org-owned repos.
 */
export async function loadRepoByPath(
  ownerSlug: string,
  repoName: string
): Promise<typeof repositories.$inferSelect | null> {
  const ns = await resolveNamespace(ownerSlug);
  if (!ns) return null;
  try {
    if (ns.kind === "user") {
      const [r] = await db
        .select()
        .from(repositories)
        .where(
          and(
            eq(repositories.ownerId, ns.id),
            eq(repositories.name, repoName),
            isNull(repositories.orgId)
          )
        )
        .limit(1);
      return r || null;
    }
    const [r] = await db
      .select()
      .from(repositories)
      .where(
        and(eq(repositories.orgId, ns.id), eq(repositories.name, repoName))
      )
      .limit(1);
    return r || null;
  } catch (err) {
    console.error("[namespace] loadRepoByPath:", err);
    return null;
  }
}

/**
 * List all repos (user or org) for a URL slug. Used by the profile page
 * to render a unified "repos owned by X" list.
 */
export async function listReposForNamespace(ns: Namespace) {
  try {
    if (ns.kind === "user") {
      return await db
        .select()
        .from(repositories)
        .where(
          and(eq(repositories.ownerId, ns.id), isNull(repositories.orgId))
        );
    }
    return await db
      .select()
      .from(repositories)
      .where(eq(repositories.orgId, ns.id));
  } catch (err) {
    console.error("[namespace] listReposForNamespace:", err);
    return [];
  }
}
