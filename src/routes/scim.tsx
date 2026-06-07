/**
 * SCIM 2.0 — System for Cross-domain Identity Management.
 *
 * Identity providers (Okta, Azure AD, Google Workspace) use SCIM to
 * automatically provision and deprovision users from Gluecron orgs.
 *
 * Endpoints:
 *   GET    /scim/v2/:orgId/Users              — list users in the org
 *   POST   /scim/v2/:orgId/Users              — provision (create) a user
 *   GET    /scim/v2/:orgId/Users/:userId      — get user details
 *   PUT    /scim/v2/:orgId/Users/:userId      — replace user
 *   PATCH  /scim/v2/:orgId/Users/:userId      — partial update (deactivate, etc.)
 *   DELETE /scim/v2/:orgId/Users/:userId      — deprovision (disable, keep data)
 *
 * Auth: Bearer token → validated against scim_tokens.token_hash (SHA-256).
 *
 * All responses follow RFC 7643 (SCIM Core Schema) and RFC 7644 (SCIM Protocol).
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import * as crypto from "crypto";
import { db } from "../db";
import {
  scimTokens,
  orgMembers,
  organizations,
  users,
} from "../db/schema";
import type { AuthEnv } from "../middleware/auth";

const scim = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// SCIM schemas / constants
// ---------------------------------------------------------------------------

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function scimAuth(
  c: any,
  orgId: string
): Promise<{ ok: true; token: typeof scimTokens.$inferSelect } | { ok: false }> {
  const authHeader = c.req.header("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return { ok: false };
  const rawToken = authHeader.slice(7);
  const tokenHash = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");

  const [token] = await db
    .select()
    .from(scimTokens)
    .where(
      and(
        eq(scimTokens.tokenHash, tokenHash),
        eq(scimTokens.orgId, orgId)
      )
    )
    .limit(1);

  if (!token) return { ok: false };

  // Update last_used_at lazily (fire-and-forget)
  db.update(scimTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(scimTokens.id, token.id))
    .catch(() => {});

  return { ok: true, token };
}

function scimError(c: any, status: number, detail: string, scimType?: string) {
  return c.json(
    {
      schemas: [SCIM_ERROR_SCHEMA],
      status,
      ...(scimType ? { scimType } : {}),
      detail,
    },
    status
  );
}

/** Convert a Drizzle user row to a SCIM User resource. */
function toScimUser(user: {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}) {
  const [firstName, ...rest] = (user.displayName || user.username).split(" ");
  const lastName = rest.join(" ") || "";
  const base = process.env.APP_URL || process.env.BASE_URL || "https://gluecron.com";
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    userName: user.email,
    name: {
      formatted: user.displayName || user.username,
      givenName: firstName,
      familyName: lastName,
    },
    emails: [{ value: user.email, primary: true }],
    active: !user.deletedAt,
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: `${base}/scim/v2/${user.id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /scim/v2/:orgId/Users — list users in the org
// ---------------------------------------------------------------------------

scim.get("/scim/v2/:orgId/Users", async (c) => {
  const { orgId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  // Verify org exists
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return scimError(c, 404, "Organization not found");

  // Pagination params
  const startIndex = Math.max(1, parseInt(c.req.query("startIndex") || "1", 10));
  const count = Math.min(100, Math.max(1, parseInt(c.req.query("count") || "100", 10)));
  const offset = startIndex - 1;

  // Get org members and their user data
  const members = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      deletedAt: users.deletedAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId))
    .limit(count)
    .offset(offset);

  const resources = members.map(toScimUser);

  return c.json({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length + offset, // approximate
    startIndex,
    itemsPerPage: count,
    Resources: resources,
  });
});

// ---------------------------------------------------------------------------
// POST /scim/v2/:orgId/Users — provision a user
// ---------------------------------------------------------------------------

scim.post("/scim/v2/:orgId/Users", async (c) => {
  const { orgId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return scimError(c, 404, "Organization not found");

  let body: {
    userName?: string;
    name?: { formatted?: string; givenName?: string; familyName?: string };
    emails?: Array<{ value: string; primary?: boolean }>;
    active?: boolean;
    displayName?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return scimError(c, 400, "Invalid JSON", "invalidValue");
  }

  const email =
    body.emails?.find((e) => e.primary)?.value ||
    body.emails?.[0]?.value ||
    body.userName ||
    "";
  if (!email || !email.includes("@")) {
    return scimError(c, 400, "email is required", "invalidValue");
  }

  // Check if user already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  let userId: string;

  if (existing) {
    userId = existing.id;
  } else {
    // Auto-derive a username
    let username = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 39);
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (taken) username = username + "-" + crypto.randomBytes(3).toString("hex");

    const displayName =
      body.displayName ||
      body.name?.formatted ||
      [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") ||
      username;

    const [created] = await db
      .insert(users)
      .values({
        username,
        email,
        displayName,
        passwordHash: await Bun.password.hash(crypto.randomBytes(32).toString("hex"), {
          algorithm: "bcrypt",
          cost: 10,
        }),
        emailVerifiedAt: new Date(),
      })
      .returning({ id: users.id });

    if (!created) return scimError(c, 500, "Failed to create user");
    userId = created.id;
  }

  // Add to org if not already a member
  const [isMember] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);

  if (!isMember) {
    await db.insert(orgMembers).values({
      orgId,
      userId,
      role: "member",
    });
  }

  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return c.json(toScimUser(userRow), 201);
});

// ---------------------------------------------------------------------------
// GET /scim/v2/:orgId/Users/:userId — get a single user
// ---------------------------------------------------------------------------

scim.get("/scim/v2/:orgId/Users/:userId", async (c) => {
  const { orgId, userId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  const [member] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      deletedAt: users.deletedAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);

  if (!member) return scimError(c, 404, "User not found");

  return c.json(toScimUser(member));
});

// ---------------------------------------------------------------------------
// PUT /scim/v2/:orgId/Users/:userId — replace a user
// ---------------------------------------------------------------------------

scim.put("/scim/v2/:orgId/Users/:userId", async (c) => {
  const { orgId, userId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  const [member] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) return scimError(c, 404, "User not found in this organization");

  let body: {
    displayName?: string;
    name?: { formatted?: string; givenName?: string; familyName?: string };
    active?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return scimError(c, 400, "Invalid JSON", "invalidValue");
  }

  const displayName =
    body.displayName ||
    body.name?.formatted ||
    [body.name?.givenName, body.name?.familyName].filter(Boolean).join(" ") ||
    undefined;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (displayName) updates.displayName = displayName;
  if (body.active === false) {
    updates.deletedAt = new Date();
    updates.deletionScheduledFor = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  } else if (body.active === true) {
    updates.deletedAt = null;
    updates.deletionScheduledFor = null;
  }

  await db.update(users).set(updates).where(eq(users.id, userId));

  const [updated] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return c.json(toScimUser(updated));
});

// ---------------------------------------------------------------------------
// PATCH /scim/v2/:orgId/Users/:userId — partial update
// ---------------------------------------------------------------------------

scim.patch("/scim/v2/:orgId/Users/:userId", async (c) => {
  const { orgId, userId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  const [member] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) return scimError(c, 404, "User not found in this organization");

  let body: {
    Operations?: Array<{
      op: string;
      path?: string;
      value?: unknown;
    }>;
  };
  try {
    body = await c.req.json();
  } catch {
    return scimError(c, 400, "Invalid JSON", "invalidValue");
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };

  for (const op of body.Operations || []) {
    const opLower = (op.op || "").toLowerCase();
    if (op.path === "active" || (typeof op.value === "object" && op.value !== null && "active" in (op.value as object))) {
      const activeVal =
        op.path === "active"
          ? op.value
          : (op.value as Record<string, unknown>)["active"];
      if (opLower === "replace" || opLower === "add") {
        if (activeVal === false || activeVal === "false") {
          updates.deletedAt = new Date();
          updates.deletionScheduledFor = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        } else {
          updates.deletedAt = null;
          updates.deletionScheduledFor = null;
        }
      }
    }
    if (op.path === "displayName" && (opLower === "replace" || opLower === "add")) {
      updates.displayName = String(op.value || "");
    }
  }

  await db.update(users).set(updates).where(eq(users.id, userId));

  const [updated] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return c.json(toScimUser(updated));
});

// ---------------------------------------------------------------------------
// DELETE /scim/v2/:orgId/Users/:userId — deprovision (soft-delete)
// ---------------------------------------------------------------------------

scim.delete("/scim/v2/:orgId/Users/:userId", async (c) => {
  const { orgId, userId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  const [member] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  if (!member) return scimError(c, 404, "User not found in this organization");

  // Remove from org membership (preserves user account + git history)
  await db
    .delete(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));

  // Soft-disable the account
  await db.update(users).set({
    deletedAt: new Date(),
    deletionScheduledFor: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
  }).where(eq(users.id, userId));

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// GET /scim/v2/:orgId/ServiceProviderConfig — SCIM capability discovery
// ---------------------------------------------------------------------------

scim.get("/scim/v2/:orgId/ServiceProviderConfig", async (c) => {
  const { orgId } = c.req.param();
  const auth = await scimAuth(c, orgId);
  if (!auth.ok) return scimError(c, 401, "Unauthorized");

  const base = process.env.APP_URL || process.env.BASE_URL || "https://gluecron.com";
  return c.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: false, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Authentication scheme using the OAuth Bearer Token Standard",
        specUri: "http://www.rfc-editor.org/info/rfc6750",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${base}/scim/v2/${orgId}/ServiceProviderConfig`,
    },
  });
});

export default scim;
