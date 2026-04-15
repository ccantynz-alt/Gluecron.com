/**
 * Block H — App marketplace + bot identities.
 *
 * Known permission names. These are the vocabulary that apps declare and
 * installers grant. Permissions are string-matched at request time — for v1,
 * handlers that consume app tokens call `hasPermission(token, "issues:write")`
 * and fail closed when absent.
 *
 * Higher-level permissions imply lower ones (write implies read) so the UI
 * only presents one level at a time.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  apps,
  appBots,
  appInstallations,
  appInstallTokens,
  appEvents,
  users,
  type App,
  type AppInstallation,
} from "../db/schema";

export const KNOWN_PERMISSIONS = [
  "contents:read",
  "contents:write",
  "issues:read",
  "issues:write",
  "pulls:read",
  "pulls:write",
  "checks:read",
  "checks:write",
  "deployments:read",
  "deployments:write",
  "metadata:read",
] as const;

export type Permission = (typeof KNOWN_PERMISSIONS)[number];

export const KNOWN_EVENTS = [
  "push",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "check_run",
  "deployment",
  "release",
] as const;

export type EventName = (typeof KNOWN_EVENTS)[number];

// ---------- Pure helpers ----------

/**
 * Slugify an app name — lowercase alphanumeric + dashes, trim leading/trailing
 * dashes, cap at 40 chars.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Bot usernames are always `<slug>[bot]`. */
export function botUsername(slug: string): string {
  return `${slug}[bot]`;
}

/** Is `granted` a subset of `requested`? Used when validating install forms. */
export function permissionsSubset(
  granted: readonly string[],
  requested: readonly string[]
): boolean {
  const req = new Set(requested);
  return granted.every((g) => req.has(g));
}

/** Normalise + de-dup permissions. Drops unknown values. */
export function normalisePermissions(input: readonly string[]): Permission[] {
  const seen = new Set<string>();
  const out: Permission[] = [];
  for (const p of input) {
    if ((KNOWN_PERMISSIONS as readonly string[]).includes(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p as Permission);
    }
  }
  return out;
}

/** Parse a JSON permission list out of the DB column. */
export function parsePermissions(raw: string | null | undefined): Permission[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalisePermissions(parsed);
  } catch {
    return [];
  }
}

/** write:* implies read:* on the same resource family. */
export function hasPermission(
  granted: readonly string[],
  required: string
): boolean {
  if (granted.includes(required)) return true;
  // write implies read
  if (required.endsWith(":read")) {
    const writeEquivalent = required.replace(":read", ":write");
    return granted.includes(writeEquivalent);
  }
  return false;
}

export function generateBearerToken(): { token: string; hash: string } {
  const token = "ghi_" + randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

export function hashBearer(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------- DB helpers ----------

export async function listPublicApps(query = ""): Promise<App[]> {
  try {
    const rows = await db
      .select()
      .from(apps)
      .where(
        query
          ? and(
              eq(apps.isPublic, true),
              or(
                ilike(apps.name, `%${query}%`),
                ilike(apps.description, `%${query}%`),
                ilike(apps.slug, `%${query}%`)
              )!
            )
          : eq(apps.isPublic, true)
      )
      .orderBy(desc(apps.createdAt))
      .limit(100);
    return rows;
  } catch {
    return [];
  }
}

export async function getAppBySlug(slug: string): Promise<App | null> {
  try {
    const [r] = await db
      .select()
      .from(apps)
      .where(eq(apps.slug, slug))
      .limit(1);
    return r || null;
  } catch {
    return null;
  }
}

export interface CreateAppArgs {
  name: string;
  description?: string;
  iconUrl?: string;
  homepageUrl?: string;
  webhookUrl?: string;
  creatorId: string;
  permissions: readonly string[];
  defaultEvents?: readonly string[];
  isPublic?: boolean;
}

/** Create an app + matching bot. Slug is derived from name; retries on collision. */
export async function createApp(args: CreateAppArgs): Promise<App | null> {
  const baseSlug = slugify(args.name) || "app";
  for (let attempt = 0; attempt < 6; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(2).toString("hex")}`;
    const webhookSecret = randomBytes(24).toString("hex");
    try {
      const [row] = await db
        .insert(apps)
        .values({
          slug,
          name: args.name,
          description: args.description || "",
          iconUrl: args.iconUrl,
          homepageUrl: args.homepageUrl,
          webhookUrl: args.webhookUrl,
          webhookSecret,
          creatorId: args.creatorId,
          permissions: JSON.stringify(normalisePermissions(args.permissions)),
          defaultEvents: JSON.stringify(
            (args.defaultEvents || []).filter((e) =>
              (KNOWN_EVENTS as readonly string[]).includes(e)
            )
          ),
          isPublic: args.isPublic ?? true,
        })
        .returning();
      if (!row) return null;
      // Create matching bot account
      await db.insert(appBots).values({
        appId: row.id,
        username: botUsername(slug),
        displayName: `${args.name} (bot)`,
        avatarUrl: args.iconUrl,
      });
      return row;
    } catch (err: any) {
      if (String(err?.message || "").includes("duplicate")) continue;
      console.error("[marketplace] createApp:", err);
      return null;
    }
  }
  return null;
}

export async function listInstallationsForApp(
  appId: string
): Promise<AppInstallation[]> {
  try {
    return await db
      .select()
      .from(appInstallations)
      .where(
        and(eq(appInstallations.appId, appId), isNull(appInstallations.uninstalledAt))
      )
      .orderBy(desc(appInstallations.createdAt));
  } catch {
    return [];
  }
}

export async function listInstallationsForTarget(
  targetType: "user" | "org" | "repository",
  targetId: string
): Promise<Array<AppInstallation & { app: App | null }>> {
  try {
    const rows = await db
      .select({
        install: appInstallations,
        app: apps,
      })
      .from(appInstallations)
      .leftJoin(apps, eq(appInstallations.appId, apps.id))
      .where(
        and(
          eq(appInstallations.targetType, targetType),
          eq(appInstallations.targetId, targetId),
          isNull(appInstallations.uninstalledAt)
        )
      )
      .orderBy(desc(appInstallations.createdAt));
    return rows.map((r) => ({ ...r.install, app: r.app }));
  } catch {
    return [];
  }
}

export interface InstallArgs {
  appId: string;
  installedBy: string;
  targetType: "user" | "org" | "repository";
  targetId: string;
  grantedPermissions: readonly string[];
}

export async function installApp(
  args: InstallArgs
): Promise<AppInstallation | null> {
  try {
    // Find the app to validate permissions
    const [app] = await db
      .select()
      .from(apps)
      .where(eq(apps.id, args.appId))
      .limit(1);
    if (!app) return null;
    const appPerms = parsePermissions(app.permissions);
    const granted = normalisePermissions(args.grantedPermissions);
    // Only allow granting what the app actually requests
    const filtered = granted.filter((p) => appPerms.includes(p));
    // If a non-uninstalled row exists, soft-update it (idempotent)
    const [existing] = await db
      .select()
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.appId, args.appId),
          eq(appInstallations.targetType, args.targetType),
          eq(appInstallations.targetId, args.targetId),
          isNull(appInstallations.uninstalledAt)
        )
      )
      .limit(1);
    if (existing) {
      await db
        .update(appInstallations)
        .set({ grantedPermissions: JSON.stringify(filtered) })
        .where(eq(appInstallations.id, existing.id));
      await db.insert(appEvents).values({
        appId: args.appId,
        installationId: existing.id,
        kind: "installed",
        payload: JSON.stringify({ updated: true }),
      });
      return existing;
    }
    const [row] = await db
      .insert(appInstallations)
      .values({
        appId: args.appId,
        installedBy: args.installedBy,
        targetType: args.targetType,
        targetId: args.targetId,
        grantedPermissions: JSON.stringify(filtered),
      })
      .returning();
    if (row) {
      await db.insert(appEvents).values({
        appId: args.appId,
        installationId: row.id,
        kind: "installed",
        payload: JSON.stringify({
          targetType: args.targetType,
          targetId: args.targetId,
        }),
      });
    }
    return row || null;
  } catch (err) {
    console.error("[marketplace] installApp:", err);
    return null;
  }
}

export async function uninstallApp(installationId: string): Promise<boolean> {
  try {
    const [row] = await db
      .update(appInstallations)
      .set({ uninstalledAt: new Date() })
      .where(
        and(
          eq(appInstallations.id, installationId),
          isNull(appInstallations.uninstalledAt)
        )
      )
      .returning();
    if (row) {
      await db.insert(appEvents).values({
        appId: row.appId,
        installationId: row.id,
        kind: "uninstalled",
      });
      // Revoke all tokens
      await db
        .update(appInstallTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(appInstallTokens.installationId, installationId),
            isNull(appInstallTokens.revokedAt)
          )
        );
      return true;
    }
    return false;
  } catch (err) {
    console.error("[marketplace] uninstallApp:", err);
    return false;
  }
}

/** Issue a bearer token scoped to a single installation. Default TTL: 1h. */
export async function issueInstallToken(
  installationId: string,
  ttlSeconds = 3600
): Promise<{ token: string; expiresAt: Date } | null> {
  try {
    const { token, hash } = generateBearerToken();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await db
      .insert(appInstallTokens)
      .values({ installationId, tokenHash: hash, expiresAt });
    return { token, expiresAt };
  } catch (err) {
    console.error("[marketplace] issueInstallToken:", err);
    return null;
  }
}

/**
 * Verify a bearer and return the matched installation + permissions. Returns
 * null when the token is unknown, revoked, or expired.
 */
export async function verifyInstallToken(
  token: string
): Promise<{
  installation: AppInstallation;
  app: App;
  botUsername: string;
  permissions: Permission[];
} | null> {
  if (!token || !token.startsWith("ghi_")) return null;
  const hash = hashBearer(token);
  try {
    const [row] = await db
      .select({
        inst: appInstallations,
        app: apps,
        tok: appInstallTokens,
      })
      .from(appInstallTokens)
      .innerJoin(
        appInstallations,
        eq(appInstallTokens.installationId, appInstallations.id)
      )
      .innerJoin(apps, eq(appInstallations.appId, apps.id))
      .where(eq(appInstallTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.tok.revokedAt) return null;
    if (row.tok.expiresAt < new Date()) return null;
    if (row.inst.uninstalledAt) return null;
    if (row.inst.suspendedAt) return null;
    const perms = parsePermissions(row.inst.grantedPermissions);
    const slug = row.app.slug;
    return {
      installation: row.inst,
      app: row.app,
      botUsername: botUsername(slug),
      permissions: perms,
    };
  } catch {
    return null;
  }
}

/** Admin-ish listing of an app's recent event log. */
export async function listEventsForApp(
  appId: string,
  limit = 50
): Promise<Array<typeof appEvents.$inferSelect>> {
  try {
    return await db
      .select()
      .from(appEvents)
      .where(eq(appEvents.appId, appId))
      .orderBy(desc(appEvents.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/** Count live installs — for app detail page. */
export async function countInstalls(appId: string): Promise<number> {
  try {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.appId, appId),
          isNull(appInstallations.uninstalledAt)
        )
      );
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}
