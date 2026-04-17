/**
 * Block K2 — Agent identities + scoped permissions.
 *
 * Thin wrapper over Block H's marketplace.ts that lets the K-agent layer
 * spin up auditable "bot" apps per agent kind. Every K-agent runs as an
 * app with slug `agent-<kind>` and a matching `app_bots` row named
 * `agent-<kind>[bot]`. Installations are per-repository, permissions are
 * scoped at install time and revocable, and every token is minted through
 * marketplace.ts's `ghi_`-prefixed install-token issuer.
 *
 * No new tables — K2 reuses H1/H2's `apps`, `app_installations`, `app_bots`,
 * `app_install_tokens`, `app_events`.
 *
 * Design rules:
 *  - Do not duplicate primitives (hashing, token gen, bot username). Import
 *    from marketplace.ts.
 *  - Do not modify marketplace.ts. If we need extra vocabulary, layer it.
 *  - `AGENT_PERMISSIONS` is a superset of marketplace `KNOWN_PERMISSIONS`
 *    and adds `agent:invoke` so one agent can trigger another.
 *  - All DB helpers return null / false on error — never throw. This mirrors
 *    marketplace.ts's style and keeps callers out of try/catch ceremony.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  apps,
  appBots,
  appEvents,
  appInstallations,
  appInstallTokens,
  users,
  type App,
  type AppInstallation,
} from "../db/schema";
import {
  botUsername,
  hasPermission,
  hashBearer,
  issueInstallToken,
  KNOWN_PERMISSIONS,
  verifyInstallToken,
  type Permission,
} from "./marketplace";

// ---------------------------------------------------------------------------
// Permission vocabulary
// ---------------------------------------------------------------------------

/**
 * Vocabulary agents are allowed to request. Superset of marketplace
 * `KNOWN_PERMISSIONS` + the new `agent:invoke` which lets one K-agent spawn
 * another.
 *
 * Only the marketplace-known subset can be persisted through `createApp` /
 * `installApp`. `agent:invoke` is stored by writing straight to `apps.permissions`
 * / `app_installations.granted_permissions` via this module, bypassing the
 * `normalisePermissions` filter in marketplace.ts (which would drop unknowns).
 */
export const AGENT_PERMISSIONS = [
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
  "agent:invoke",
] as const;

export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/** Which of the agent perms are also understood by marketplace.ts. */
const MARKETPLACE_PERMS: ReadonlySet<string> = new Set(
  KNOWN_PERMISSIONS as readonly string[]
);

/** All agent slugs are prefixed with `agent-`. */
export const AGENT_SLUG_PREFIX = "agent-";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Is this string a valid agent permission in our vocabulary? */
export function isAgentPermission(p: string): p is AgentPermission {
  return (AGENT_PERMISSIONS as readonly string[]).includes(p);
}

/** Drop unknowns, de-duplicate, preserve order of first appearance. */
export function normaliseAgentPermissions(
  input: readonly string[]
): AgentPermission[] {
  const seen = new Set<string>();
  const out: AgentPermission[] = [];
  for (const p of input) {
    if (isAgentPermission(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Parse JSON permissions column, filtered to the agent vocabulary. */
export function parseAgentPermissions(
  raw: string | null | undefined
): AgentPermission[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normaliseAgentPermissions(parsed);
  } catch {
    return [];
  }
}

/** Derive the canonical agent slug for a kind (e.g. "reviewer" → "agent-reviewer"). */
export function agentSlug(kind: string): string {
  const trimmed = (kind || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const stripped = trimmed.replace(/^-+|-+$/g, "").slice(0, 32);
  const base = stripped || "unknown";
  return base.startsWith(AGENT_SLUG_PREFIX) ? base : AGENT_SLUG_PREFIX + base;
}

/** Guard: does this bot username belong to a K-agent? */
export function isAgentBotUsername(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.startsWith(AGENT_SLUG_PREFIX) && name.endsWith("[bot]");
}

// ---------------------------------------------------------------------------
// DB helpers — defensive, null-returning on error.
// ---------------------------------------------------------------------------

/** Pick the oldest user as "system" for creator_id bootstrapping. */
async function resolveSystemUserId(): Promise<string | null> {
  try {
    const [first] = await db
      .select({ id: users.id })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    return first?.id || null;
  } catch {
    return null;
  }
}

/**
 * Idempotent: ensure an app row with the given slug exists, plus its
 * `app_bots` row. Returns the app, or null on failure (e.g. no users yet).
 *
 * `slug` is rewritten to have the `agent-` prefix if missing. Permissions
 * are stored as the full agent vocabulary (including `agent:invoke`),
 * bypassing marketplace's filter.
 */
export async function ensureAgentApp(
  slug: string,
  displayName: string,
  permissions: readonly string[]
): Promise<App | null> {
  const finalSlug = slug.startsWith(AGENT_SLUG_PREFIX)
    ? slug
    : AGENT_SLUG_PREFIX + slug;
  const perms = normaliseAgentPermissions(permissions);
  try {
    const [existing] = await db
      .select()
      .from(apps)
      .where(eq(apps.slug, finalSlug))
      .limit(1);
    if (existing) return existing;
    const creatorId = await resolveSystemUserId();
    if (!creatorId) {
      console.error(
        "[agent-identity] ensureAgentApp: no users exist yet; cannot bootstrap"
      );
      return null;
    }
    const [row] = await db
      .insert(apps)
      .values({
        slug: finalSlug,
        name: displayName,
        description: `K-agent: ${displayName}`,
        creatorId,
        permissions: JSON.stringify(perms),
        defaultEvents: "[]",
        isPublic: false,
      })
      .returning();
    if (!row) return null;
    // Matching bot account — unique on username + appId.
    try {
      await db.insert(appBots).values({
        appId: row.id,
        username: botUsername(finalSlug),
        displayName: `${displayName} (agent bot)`,
      });
    } catch (err) {
      // Duplicate from a prior partial run is fine; anything else is logged.
      if (!String((err as Error)?.message || "").includes("duplicate")) {
        console.error("[agent-identity] ensureAgentApp bot insert:", err);
      }
    }
    return row;
  } catch (err) {
    console.error("[agent-identity] ensureAgentApp:", err);
    return null;
  }
}

/**
 * Install an agent for a single repository. Idempotent — if a non-uninstalled
 * installation exists, the granted permissions are overwritten to the new
 * set. Audit trail is recorded via `app_events`.
 *
 * `grantedPermissions` is filtered through the agent vocabulary AND against
 * the permissions the app originally declared — you cannot grant more than
 * the agent asked for. Returns the installation row, or null on failure.
 */
export async function installAgentForRepo(
  agentSlug: string,
  repoId: string,
  installerUserId: string,
  grantedPermissions: readonly string[]
): Promise<AppInstallation | null> {
  try {
    const [app] = await db
      .select()
      .from(apps)
      .where(eq(apps.slug, agentSlug))
      .limit(1);
    if (!app) return null;
    const appPerms = parseAgentPermissions(app.permissions);
    const requested = normaliseAgentPermissions(grantedPermissions);
    const filtered = requested.filter((p) => appPerms.includes(p));
    const [existing] = await db
      .select()
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.appId, app.id),
          eq(appInstallations.targetType, "repository"),
          eq(appInstallations.targetId, repoId),
          isNull(appInstallations.uninstalledAt)
        )
      )
      .limit(1);
    if (existing) {
      await db
        .update(appInstallations)
        .set({ grantedPermissions: JSON.stringify(filtered) })
        .where(eq(appInstallations.id, existing.id));
      try {
        await db.insert(appEvents).values({
          appId: app.id,
          installationId: existing.id,
          kind: "installed",
          payload: JSON.stringify({ updated: true, agent: agentSlug }),
        });
      } catch {
        /* audit best-effort */
      }
      return existing;
    }
    const [row] = await db
      .insert(appInstallations)
      .values({
        appId: app.id,
        installedBy: installerUserId,
        targetType: "repository",
        targetId: repoId,
        grantedPermissions: JSON.stringify(filtered),
      })
      .returning();
    if (row) {
      try {
        await db.insert(appEvents).values({
          appId: app.id,
          installationId: row.id,
          kind: "installed",
          payload: JSON.stringify({ agent: agentSlug, repoId }),
        });
      } catch {
        /* audit best-effort */
      }
    }
    return row || null;
  } catch (err) {
    console.error("[agent-identity] installAgentForRepo:", err);
    return null;
  }
}

/**
 * Mint a short-lived bearer for an agent scoped to a single repo.
 * Reuses marketplace.ts's `issueInstallToken` — we do not duplicate
 * token generation here.
 */
export async function issueAgentToken(
  agentSlug: string,
  repoId: string,
  ttlSeconds = 3600
): Promise<{ token: string; expiresAt: Date } | null> {
  try {
    const [app] = await db
      .select()
      .from(apps)
      .where(eq(apps.slug, agentSlug))
      .limit(1);
    if (!app) return null;
    const [install] = await db
      .select()
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.appId, app.id),
          eq(appInstallations.targetType, "repository"),
          eq(appInstallations.targetId, repoId),
          isNull(appInstallations.uninstalledAt)
        )
      )
      .limit(1);
    if (!install) return null;
    return await issueInstallToken(install.id, ttlSeconds);
  } catch (err) {
    console.error("[agent-identity] issueAgentToken:", err);
    return null;
  }
}

/** What `verifyAgentToken` returns when a token is valid + agent-shaped. */
export interface AgentTokenContext {
  agentSlug: string;
  repoId: string;
  botUsername: string;
  permissions: AgentPermission[];
  installationId: string;
}

/**
 * Verify a bearer. Returns null when:
 *  - the token is not `ghi_`-prefixed,
 *  - the underlying install-token is unknown / expired / revoked / uninstalled,
 *  - the bot behind the token is not an `agent-*` bot.
 */
export async function verifyAgentToken(
  token: string
): Promise<AgentTokenContext | null> {
  if (!token || !token.startsWith("ghi_")) return null;
  const ctx = await verifyInstallToken(token);
  if (!ctx) return null;
  if (!isAgentBotUsername(ctx.botUsername)) return null;
  if (ctx.installation.targetType !== "repository") return null;
  return {
    agentSlug: ctx.app.slug,
    repoId: ctx.installation.targetId,
    botUsername: ctx.botUsername,
    permissions: parseAgentPermissions(ctx.installation.grantedPermissions),
    installationId: ctx.installation.id,
  };
}

/**
 * Verify + assert a required permission. Returns the context on success,
 * throws `Error` on failure. Handlers should wrap with try/catch and map
 * to a 401 / 403 response.
 */
export async function requireAgentPermission(
  token: string,
  permission: AgentPermission | string
): Promise<AgentTokenContext> {
  const ctx = await verifyAgentToken(token);
  if (!ctx) throw new Error("agent token invalid or expired");
  if (!hasPermission(ctx.permissions as readonly string[], permission)) {
    throw new Error(`agent token missing permission: ${permission}`);
  }
  return ctx;
}

/** Revoke a single token by its stored hash. Idempotent. */
export async function revokeAgentToken(tokenHash: string): Promise<boolean> {
  if (!tokenHash) return false;
  try {
    const [row] = await db
      .update(appInstallTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(appInstallTokens.tokenHash, tokenHash),
          isNull(appInstallTokens.revokedAt)
        )
      )
      .returning();
    return !!row;
  } catch (err) {
    console.error("[agent-identity] revokeAgentToken:", err);
    return false;
  }
}

/** Convenience: hash + revoke in one go (when you only have the raw token). */
export async function revokeAgentTokenByRaw(token: string): Promise<boolean> {
  if (!token) return false;
  return revokeAgentToken(hashBearer(token));
}

/**
 * Soft-uninstall an agent for a repo. Sets `uninstalledAt` and revokes any
 * outstanding tokens for that installation. Idempotent — returns false if
 * no matching install was found.
 */
export async function uninstallAgent(
  agentSlug: string,
  repoId: string
): Promise<boolean> {
  try {
    const [app] = await db
      .select()
      .from(apps)
      .where(eq(apps.slug, agentSlug))
      .limit(1);
    if (!app) return false;
    const [updated] = await db
      .update(appInstallations)
      .set({ uninstalledAt: new Date() })
      .where(
        and(
          eq(appInstallations.appId, app.id),
          eq(appInstallations.targetType, "repository"),
          eq(appInstallations.targetId, repoId),
          isNull(appInstallations.uninstalledAt)
        )
      )
      .returning();
    if (!updated) return false;
    // Revoke every live token.
    try {
      await db
        .update(appInstallTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(appInstallTokens.installationId, updated.id),
            isNull(appInstallTokens.revokedAt)
          )
        );
    } catch {
      /* best-effort */
    }
    try {
      await db.insert(appEvents).values({
        appId: app.id,
        installationId: updated.id,
        kind: "uninstalled",
        payload: JSON.stringify({ agent: agentSlug, repoId }),
      });
    } catch {
      /* audit best-effort */
    }
    return true;
  } catch (err) {
    console.error("[agent-identity] uninstallAgent:", err);
    return false;
  }
}

// Types re-exported for callers that only import from this module.
export type { Permission };
