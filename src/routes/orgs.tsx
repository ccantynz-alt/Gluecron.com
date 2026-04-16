/**
 * Organizations (Block B1).
 *
 * Routes:
 *   GET  /orgs                              list orgs the current user belongs to
 *   GET  /orgs/new                          create-org form
 *   POST /orgs/new                          create org; creator becomes owner
 *   GET  /orgs/:slug                        org profile (people + teams summary)
 *   GET  /orgs/:slug/people                 full people list
 *   POST /orgs/:slug/people/add             add member by username (admin+)
 *   POST /orgs/:slug/people/:uid/role       change role (owner only; last-owner guard)
 *   POST /orgs/:slug/people/:uid/remove     remove member (admin+; cannot self-demote if last owner)
 *   GET  /orgs/:slug/teams                  teams list
 *   POST /orgs/:slug/teams/new              create team (admin+)
 *   GET  /orgs/:slug/teams/:teamSlug        team detail + member mgmt
 *   POST /orgs/:slug/teams/:teamSlug/members/add     add team member (maintainer+ of team OR org admin+)
 *   POST /orgs/:slug/teams/:teamSlug/members/:uid/remove
 *
 * Auth: /orgs and sub-paths require auth.
 * Authorization is role-based and checked inside each handler.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  organizations,
  orgMembers,
  teams,
  teamMembers,
  users,
  repositories,
} from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import {
  isValidSlug,
  normalizeSlug,
  orgRoleAtLeast,
  isValidOrgRole,
  isValidTeamRole,
  loadOrgForUser,
  listOrgsForUser,
  listOrgMembers,
  listTeamsForOrg,
  listTeamMembers,
} from "../lib/orgs";
import { audit } from "../lib/notify";
import { initBareRepo, repoExists } from "../git/repository";

const orgs = new Hono<AuthEnv>();

orgs.use("/orgs", requireAuth);
orgs.use("/orgs/*", requireAuth);

// --- helpers ----------------------------------------------------------------

function errorRedirect(path: string, msg: string) {
  return `${path}?error=${encodeURIComponent(msg)}`;
}
function successRedirect(path: string, msg: string) {
  return `${path}?success=${encodeURIComponent(msg)}`;
}

/**
 * Count owners in an org. Used to block the last-owner from being demoted
 * or removed (that would orphan the org).
 */
async function ownerCount(orgId: string): Promise<number> {
  try {
    const rows = await db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")));
    return rows.length;
  } catch (err) {
    console.error("[orgs] ownerCount:", err);
    // Fail-safe: pretend there's more than one so we never accidentally
    // allow the last owner to be removed.
    return 2;
  }
}

async function findUserByUsername(username: string) {
  try {
    const [u] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return u || null;
  } catch (err) {
    console.error("[orgs] findUserByUsername:", err);
    return null;
  }
}

// --- LIST -------------------------------------------------------------------

orgs.get("/orgs", async (c) => {
  const user = c.get("user")!;
  const rows = await listOrgsForUser(user.id);

  return c.html(
    <Layout title="Organizations" user={user}>
      <div class="settings-container" style="max-width: 800px">
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px"
        >
          <h2 style="margin: 0">Your organizations</h2>
          <a href="/orgs/new" class="btn btn-primary">
            New organization
          </a>
        </div>
        {rows.length === 0 ? (
          <div class="empty-state">
            <h2>No organizations yet</h2>
            <p>
              Organizations let multiple users collaborate on shared repos
              with team-based permissions.
            </p>
            <a href="/orgs/new" class="btn btn-primary" style="margin-top: 8px">
              Create your first org
            </a>
          </div>
        ) : (
          <div style="display: flex; flex-direction: column; gap: 8px">
            {rows.map((r) => (
              <a
                href={`/orgs/${r.slug}`}
                style="display: flex; padding: 12px 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; color: var(--text); align-items: center; gap: 12px"
              >
                <div style="flex: 1">
                  <strong>{r.name}</strong>{" "}
                  <span style="color: var(--text-muted); font-size: 12px">
                    @{r.slug}
                  </span>
                  {r.description && (
                    <div style="color: var(--text-muted); font-size: 13px; margin-top: 2px">
                      {r.description}
                    </div>
                  )}
                </div>
                <span
                  class="gate-status"
                  style="font-size: 11px; text-transform: uppercase"
                >
                  {r.role}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
});

// --- CREATE -----------------------------------------------------------------

orgs.get("/orgs/new", async (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="New organization" user={user}>
      <div class="settings-container" style="max-width: 560px">
        <h2>Create organization</h2>
        <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px">
          Organizations are multi-user namespaces. You'll be the owner and can
          invite teammates after creation.
        </p>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="post" action="/orgs/new">
          <div class="form-group">
            <label for="slug">Slug</label>
            <input
              type="text"
              id="slug"
              name="slug"
              required
              maxLength={39}
              pattern="[a-z0-9][a-z0-9-]{0,38}"
              placeholder="acme-corp"
              autocomplete="off"
            />
            <div style="color: var(--text-muted); font-size: 12px; margin-top: 4px">
              2–39 chars, lowercase letters, numbers, hyphens. Cannot start or
              end with a hyphen.
            </div>
          </div>
          <div class="form-group">
            <label for="name">Display name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={120}
              placeholder="Acme Corp"
            />
          </div>
          <div class="form-group">
            <label for="description">Description (optional)</label>
            <textarea
              id="description"
              name="description"
              rows={3}
              maxLength={500}
              placeholder="What does this org do?"
            />
          </div>
          <button type="submit" class="btn btn-primary">
            Create organization
          </button>
        </form>
      </div>
    </Layout>
  );
});

orgs.post("/orgs/new", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const slug = normalizeSlug(String(body.slug || ""));
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim() || null;

  if (!isValidSlug(slug)) {
    return c.redirect(
      errorRedirect(
        "/orgs/new",
        "Invalid slug. 2–39 chars, lowercase a-z, 0-9, hyphens. No reserved words."
      )
    );
  }
  if (!name) {
    return c.redirect(errorRedirect("/orgs/new", "Display name is required"));
  }

  try {
    // Collision check against usernames (separate namespace but shared URLs)
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, slug))
      .limit(1);
    if (existingUser) {
      return c.redirect(
        errorRedirect(
          "/orgs/new",
          "That slug is already taken by a user account"
        )
      );
    }

    const [org] = await db
      .insert(organizations)
      .values({
        slug,
        name,
        description,
        createdById: user.id,
      })
      .returning();

    if (!org) {
      return c.redirect(
        errorRedirect("/orgs/new", "Failed to create organization")
      );
    }

    // Creator is the first owner
    await db.insert(orgMembers).values({
      orgId: org.id,
      userId: user.id,
      role: "owner",
    });

    await audit({
      userId: user.id,
      action: "org.create",
      targetType: "organization",
      targetId: org.id,
      metadata: { slug, name },
    });

    return c.redirect(`/orgs/${slug}`);
  } catch (err: any) {
    if (String(err?.message || err).includes("organizations_slug")) {
      return c.redirect(
        errorRedirect("/orgs/new", "That slug is already taken")
      );
    }
    console.error("[orgs] create:", err);
    return c.redirect(
      errorRedirect("/orgs/new", "Failed to create organization")
    );
  }
});

// --- PROFILE ----------------------------------------------------------------

orgs.get("/orgs/:slug", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  const error = c.req.query("error");
  const success = c.req.query("success");

  const [members, orgTeams] = await Promise.all([
    listOrgMembers(org.id),
    listTeamsForOrg(org.id),
  ]);

  return c.html(
    <Layout title={`${org.name} (@${org.slug})`} user={user}>
      <div style="max-width: 900px">
        <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 16px">
          <div style="flex: 1">
            <h2 style="margin: 0">{org.name}</h2>
            <div style="color: var(--text-muted); font-size: 13px">
              @{org.slug}
              {role && (
                <>
                  {" · "}
                  <span class="gate-status" style="font-size: 10px">
                    {role}
                  </span>
                </>
              )}
            </div>
          </div>
          <div style="display: flex; gap: 8px">
            <a href={`/orgs/${org.slug}/repos`} class="btn">
              Repositories
            </a>
            {role && orgRoleAtLeast(role, "admin") && (
              <a href={`/orgs/${org.slug}/people`} class="btn">
                Manage
              </a>
            )}
          </div>
        </div>
        {org.description && (
          <p style="color: var(--text-muted); margin-bottom: 16px">
            {org.description}
          </p>
        )}
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px">
          <div>
            <div
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px"
            >
              <h3 style="font-size: 15px; margin: 0">
                People ({members.length})
              </h3>
              <a
                href={`/orgs/${org.slug}/people`}
                style="font-size: 12px"
              >
                view all
              </a>
            </div>
            <div
              style="border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-secondary); padding: 8px 12px"
            >
              {members.slice(0, 8).map((m) => (
                <div
                  style="padding: 4px 0; display: flex; justify-content: space-between; font-size: 13px"
                >
                  <span>
                    <a href={`/${m.username}`}>{m.username}</a>
                  </span>
                  <span
                    style="color: var(--text-muted); font-size: 11px; text-transform: uppercase"
                  >
                    {m.role}
                  </span>
                </div>
              ))}
              {members.length === 0 && (
                <div style="color: var(--text-muted); font-size: 12px">
                  No members yet
                </div>
              )}
            </div>
          </div>
          <div>
            <div
              style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px"
            >
              <h3 style="font-size: 15px; margin: 0">
                Teams ({orgTeams.length})
              </h3>
              <a href={`/orgs/${org.slug}/teams`} style="font-size: 12px">
                view all
              </a>
            </div>
            <div
              style="border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-secondary); padding: 8px 12px"
            >
              {orgTeams.slice(0, 8).map((t) => (
                <div
                  style="padding: 4px 0; display: flex; justify-content: space-between; font-size: 13px"
                >
                  <a href={`/orgs/${org.slug}/teams/${t.slug}`}>
                    {t.name}
                  </a>
                  <span
                    style="color: var(--text-muted); font-size: 11px"
                  >
                    @{t.slug}
                  </span>
                </div>
              ))}
              {orgTeams.length === 0 && (
                <div style="color: var(--text-muted); font-size: 12px">
                  No teams yet
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
});

// --- PEOPLE -----------------------------------------------------------------

orgs.get("/orgs/:slug/people", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role) return c.redirect(`/orgs/${slug}`);

  const members = await listOrgMembers(org.id);
  const error = c.req.query("error");
  const success = c.req.query("success");
  const canAdmin = orgRoleAtLeast(role, "admin");
  const canOwner = orgRoleAtLeast(role, "owner");

  return c.html(
    <Layout title={`${org.name} — people`} user={user}>
      <div style="max-width: 800px">
        <div class="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span>/</span>
          <span>people</span>
        </div>
        <h2>People ({members.length})</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}

        {canAdmin && (
          <form
            method="post"
            action={`/orgs/${org.slug}/people/add`}
            style="display: flex; gap: 8px; margin-bottom: 16px"
          >
            <input
              type="text"
              name="username"
              placeholder="username to add"
              required
              maxLength={64}
              style="flex: 1"
            />
            <select name="role">
              <option value="member">member</option>
              <option value="admin">admin</option>
              {canOwner && <option value="owner">owner</option>}
            </select>
            <button type="submit" class="btn btn-primary">
              Add
            </button>
          </form>
        )}

        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden"
        >
          {members.map((m) => (
            <div
              style="padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary)"
            >
              <div>
                <a href={`/${m.username}`}>
                  <strong>{m.username}</strong>
                </a>
                {m.displayName && (
                  <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px">
                    {m.displayName}
                  </span>
                )}
              </div>
              <div style="display: flex; gap: 8px; align-items: center">
                {canOwner && m.userId !== user.id ? (
                  <form
                    method="post"
                    action={`/orgs/${org.slug}/people/${m.userId}/role`}
                    style="display: flex; gap: 4px"
                  >
                    <select name="role">
                      <option value="member" selected={m.role === "member"}>
                        member
                      </option>
                      <option value="admin" selected={m.role === "admin"}>
                        admin
                      </option>
                      <option value="owner" selected={m.role === "owner"}>
                        owner
                      </option>
                    </select>
                    <button type="submit" class="btn btn-sm">
                      save
                    </button>
                  </form>
                ) : (
                  <span
                    class="gate-status"
                    style="font-size: 11px; text-transform: uppercase"
                  >
                    {m.role}
                  </span>
                )}
                {canAdmin && m.userId !== user.id && (
                  <form
                    method="post"
                    action={`/orgs/${org.slug}/people/${m.userId}/remove`}
                    style="display: inline"
                    onsubmit="return confirm('Remove this member?')"
                  >
                    <button type="submit" class="btn btn-sm btn-danger">
                      remove
                    </button>
                  </form>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
});

orgs.post("/orgs/:slug/people/add", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "You need admin rights")
    );
  }

  const body = await c.req.parseBody();
  const username = String(body.username || "").trim().toLowerCase();
  const newRole = String(body.role || "member");

  if (!username || !isValidOrgRole(newRole)) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Invalid input")
    );
  }
  // Only owners can grant owner
  if (newRole === "owner" && !orgRoleAtLeast(role, "owner")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Only owners can grant owner role")
    );
  }

  const target = await findUserByUsername(username);
  if (!target) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, `User ${username} not found`)
    );
  }

  try {
    await db.insert(orgMembers).values({
      orgId: org.id,
      userId: target.id,
      role: newRole,
    });
    await audit({
      userId: user.id,
      action: "org.member.add",
      targetType: "org_member",
      targetId: target.id,
      metadata: { orgSlug: slug, role: newRole },
    });
  } catch (err: any) {
    if (String(err?.message || err).includes("org_members_unique")) {
      return c.redirect(
        errorRedirect(`/orgs/${slug}/people`, "Already a member")
      );
    }
    console.error("[orgs] add member:", err);
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Failed to add member")
    );
  }
  return c.redirect(successRedirect(`/orgs/${slug}/people`, "Member added"));
});

orgs.post("/orgs/:slug/people/:uid/role", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const targetId = c.req.param("uid");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "owner")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Owner-only action")
    );
  }

  const body = await c.req.parseBody();
  const newRole = String(body.role || "member");
  if (!isValidOrgRole(newRole)) {
    return c.redirect(errorRedirect(`/orgs/${slug}/people`, "Invalid role"));
  }

  try {
    // Last-owner guard: demoting the final owner would orphan the org.
    if (newRole !== "owner") {
      const [existing] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(
          and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, targetId))
        )
        .limit(1);
      if (
        existing?.role === "owner" &&
        (await ownerCount(org.id)) <= 1
      ) {
        return c.redirect(
          errorRedirect(
            `/orgs/${slug}/people`,
            "Cannot demote the last owner"
          )
        );
      }
    }

    await db
      .update(orgMembers)
      .set({ role: newRole })
      .where(
        and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, targetId))
      );
    await audit({
      userId: user.id,
      action: "org.member.role",
      targetType: "org_member",
      targetId,
      metadata: { orgSlug: slug, role: newRole },
    });
  } catch (err) {
    console.error("[orgs] role change:", err);
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Failed to change role")
    );
  }
  return c.redirect(successRedirect(`/orgs/${slug}/people`, "Role updated"));
});

orgs.post("/orgs/:slug/people/:uid/remove", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const targetId = c.req.param("uid");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Admin-only action")
    );
  }
  if (targetId === user.id) {
    return c.redirect(
      errorRedirect(
        `/orgs/${slug}/people`,
        "Leave the org from your settings instead"
      )
    );
  }

  try {
    const [existing] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, targetId)))
      .limit(1);
    if (!existing) {
      return c.redirect(
        errorRedirect(`/orgs/${slug}/people`, "Member not found")
      );
    }
    if (existing.role === "owner" && (await ownerCount(org.id)) <= 1) {
      return c.redirect(
        errorRedirect(`/orgs/${slug}/people`, "Cannot remove the last owner")
      );
    }
    // Admin cannot remove an owner.
    if (existing.role === "owner" && !orgRoleAtLeast(role, "owner")) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/people`,
          "Only an owner can remove another owner"
        )
      );
    }

    await db
      .delete(orgMembers)
      .where(
        and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, targetId))
      );
    await audit({
      userId: user.id,
      action: "org.member.remove",
      targetType: "org_member",
      targetId,
      metadata: { orgSlug: slug },
    });
  } catch (err) {
    console.error("[orgs] remove member:", err);
    return c.redirect(
      errorRedirect(`/orgs/${slug}/people`, "Failed to remove member")
    );
  }
  return c.redirect(successRedirect(`/orgs/${slug}/people`, "Member removed"));
});

// --- TEAMS ------------------------------------------------------------------

orgs.get("/orgs/:slug/teams", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();

  const orgTeams = await listTeamsForOrg(org.id);
  const error = c.req.query("error");
  const success = c.req.query("success");
  const canAdmin = role && orgRoleAtLeast(role, "admin");

  return c.html(
    <Layout title={`${org.name} — teams`} user={user}>
      <div style="max-width: 800px">
        <div class="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span>/</span>
          <span>teams</span>
        </div>
        <h2>Teams ({orgTeams.length})</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}

        {canAdmin && (
          <form
            method="post"
            action={`/orgs/${org.slug}/teams/new`}
            style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin-bottom: 16px"
          >
            <input
              type="text"
              name="slug"
              placeholder="team-slug"
              required
              maxLength={39}
              pattern="[a-z0-9][a-z0-9-]{0,38}"
            />
            <input
              type="text"
              name="name"
              placeholder="Team name"
              required
              maxLength={80}
            />
            <button type="submit" class="btn btn-primary">
              Create team
            </button>
          </form>
        )}

        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden"
        >
          {orgTeams.length === 0 ? (
            <div
              style="padding: 16px; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary)"
            >
              No teams yet.
            </div>
          ) : (
            orgTeams.map((t) => (
              <a
                href={`/orgs/${org.slug}/teams/${t.slug}`}
                style="display: block; padding: 12px 16px; border-bottom: 1px solid var(--border); text-decoration: none; color: var(--text); background: var(--bg-secondary)"
              >
                <strong>{t.name}</strong>{" "}
                <span style="color: var(--text-muted); font-size: 12px">
                  @{t.slug}
                </span>
                {t.description && (
                  <div style="color: var(--text-muted); font-size: 12px">
                    {t.description}
                  </div>
                )}
              </a>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
});

orgs.post("/orgs/:slug/teams/new", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams`, "Admin-only action")
    );
  }

  const body = await c.req.parseBody();
  const teamSlug = normalizeSlug(String(body.slug || ""));
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim() || null;

  if (!isValidSlug(teamSlug) || !name) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams`, "Invalid slug or name")
    );
  }

  try {
    await db.insert(teams).values({
      orgId: org.id,
      slug: teamSlug,
      name,
      description,
    });
    await audit({
      userId: user.id,
      action: "org.team.create",
      targetType: "team",
      metadata: { orgSlug: slug, teamSlug },
    });
  } catch (err: any) {
    if (String(err?.message || err).includes("teams_org_slug")) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/teams`,
          "A team with that slug already exists"
        )
      );
    }
    console.error("[orgs] team create:", err);
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams`, "Failed to create team")
    );
  }
  return c.redirect(
    successRedirect(`/orgs/${slug}/teams`, "Team created")
  );
});

orgs.get("/orgs/:slug/teams/:teamSlug", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const teamSlug = c.req.param("teamSlug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();

  let team: typeof teams.$inferSelect | null = null;
  try {
    const [t] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.slug, teamSlug)))
      .limit(1);
    team = t || null;
  } catch (err) {
    console.error("[orgs] team detail:", err);
  }
  if (!team) return c.notFound();

  const members = await listTeamMembers(team.id);
  const canAdmin = role && orgRoleAtLeast(role, "admin");
  const error = c.req.query("error");
  const success = c.req.query("success");

  return c.html(
    <Layout title={`${team.name} — ${org.name}`} user={user}>
      <div style="max-width: 800px">
        <div class="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span>/</span>
          <a href={`/orgs/${org.slug}/teams`}>teams</a>
          <span>/</span>
          <span>{team.slug}</span>
        </div>
        <h2>{team.name}</h2>
        {team.description && (
          <p style="color: var(--text-muted)">{team.description}</p>
        )}
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}

        <h3 style="font-size: 15px; margin-top: 16px">
          Members ({members.length})
        </h3>

        {canAdmin && (
          <form
            method="post"
            action={`/orgs/${org.slug}/teams/${team.slug}/members/add`}
            style="display: flex; gap: 8px; margin-bottom: 16px"
          >
            <input
              type="text"
              name="username"
              placeholder="username"
              required
              maxLength={64}
              style="flex: 1"
            />
            <select name="role">
              <option value="member">member</option>
              <option value="maintainer">maintainer</option>
            </select>
            <button type="submit" class="btn btn-primary">
              Add
            </button>
          </form>
        )}

        <div
          style="border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden"
        >
          {members.length === 0 ? (
            <div
              style="padding: 16px; color: var(--text-muted); font-size: 13px; background: var(--bg-secondary)"
            >
              No members yet.
            </div>
          ) : (
            members.map((m) => (
              <div
                style="padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: var(--bg-secondary)"
              >
                <a href={`/${m.username}`}>{m.username}</a>
                <div style="display: flex; gap: 8px; align-items: center">
                  <span
                    class="gate-status"
                    style="font-size: 11px; text-transform: uppercase"
                  >
                    {m.role}
                  </span>
                  {canAdmin && (
                    <form
                      method="post"
                      action={`/orgs/${org.slug}/teams/${team.slug}/members/${m.userId}/remove`}
                      style="display: inline"
                    >
                      <button type="submit" class="btn btn-sm btn-danger">
                        remove
                      </button>
                    </form>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
});

orgs.post("/orgs/:slug/teams/:teamSlug/members/add", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const teamSlug = c.req.param("teamSlug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams/${teamSlug}`, "Admin-only action")
    );
  }

  const body = await c.req.parseBody();
  const username = String(body.username || "").trim().toLowerCase();
  const teamRole = String(body.role || "member");
  if (!username || !isValidTeamRole(teamRole)) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams/${teamSlug}`, "Invalid input")
    );
  }

  try {
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.slug, teamSlug)))
      .limit(1);
    if (!team) return c.notFound();

    const target = await findUserByUsername(username);
    if (!target) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/teams/${teamSlug}`,
          `User ${username} not found`
        )
      );
    }

    // Team membership requires org membership.
    const [orgMem] = await db
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, target.id)))
      .limit(1);
    if (!orgMem) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/teams/${teamSlug}`,
          `${username} is not a member of this org`
        )
      );
    }

    await db
      .insert(teamMembers)
      .values({ teamId: team.id, userId: target.id, role: teamRole });
    await audit({
      userId: user.id,
      action: "org.team.member.add",
      targetType: "team_member",
      targetId: target.id,
      metadata: { orgSlug: slug, teamSlug, role: teamRole },
    });
  } catch (err: any) {
    if (String(err?.message || err).includes("team_members_unique")) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/teams/${teamSlug}`,
          "Already on this team"
        )
      );
    }
    console.error("[orgs] team member add:", err);
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams/${teamSlug}`, "Failed to add member")
    );
  }
  return c.redirect(
    successRedirect(`/orgs/${slug}/teams/${teamSlug}`, "Member added")
  );
});

orgs.post("/orgs/:slug/teams/:teamSlug/members/:uid/remove", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const teamSlug = c.req.param("teamSlug");
  const targetId = c.req.param("uid");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}/teams/${teamSlug}`, "Admin-only action")
    );
  }

  try {
    const [team] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.slug, teamSlug)))
      .limit(1);
    if (!team) return c.notFound();

    await db
      .delete(teamMembers)
      .where(
        and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetId))
      );
    await audit({
      userId: user.id,
      action: "org.team.member.remove",
      targetType: "team_member",
      targetId,
      metadata: { orgSlug: slug, teamSlug },
    });
  } catch (err) {
    console.error("[orgs] team member remove:", err);
    return c.redirect(
      errorRedirect(
        `/orgs/${slug}/teams/${teamSlug}`,
        "Failed to remove member"
      )
    );
  }
  return c.redirect(
    successRedirect(`/orgs/${slug}/teams/${teamSlug}`, "Member removed")
  );
});

// --- ORG-OWNED REPOS (B2) ---------------------------------------------------

orgs.get("/orgs/:slug/repos/new", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}`, "Admin rights required to create repos")
    );
  }
  const error = c.req.query("error");

  return c.html(
    <Layout title={`New repo — ${org.name}`} user={user}>
      <div class="settings-container" style="max-width: 560px">
        <div class="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span>/</span>
          <span>new repo</span>
        </div>
        <h2>Create repository in {org.name}</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="post" action={`/orgs/${org.slug}/repos/new`}>
          <div class="form-group">
            <label for="name">Repository name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={100}
              pattern="[a-zA-Z0-9._-]+"
              placeholder="my-repo"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label for="description">Description (optional)</label>
            <textarea
              id="description"
              name="description"
              rows={3}
              maxLength={500}
            />
          </div>
          <div class="form-group">
            <label>
              <input type="checkbox" name="isPrivate" value="1" /> Private
            </label>
          </div>
          <button type="submit" class="btn btn-primary">
            Create repository
          </button>
        </form>
      </div>
    </Layout>
  );
});

orgs.post("/orgs/:slug/repos/new", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  if (!role || !orgRoleAtLeast(role, "admin")) {
    return c.redirect(
      errorRedirect(`/orgs/${slug}`, "Admin rights required")
    );
  }

  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim() || null;
  const isPrivate = body.isPrivate === "1";

  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.redirect(
      errorRedirect(
        `/orgs/${slug}/repos/new`,
        "Invalid repo name (a-z, 0-9, . _ - only)"
      )
    );
  }

  try {
    // Name collision within the org's namespace
    const [existing] = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(eq(repositories.orgId, org.id), eq(repositories.name, name))
      )
      .limit(1);
    if (existing) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/repos/new`,
          "A repo with that name already exists in this org"
        )
      );
    }
    // Disk-side collision (namespace slug is the org's slug on disk)
    if (await repoExists(org.slug, name)) {
      return c.redirect(
        errorRedirect(
          `/orgs/${slug}/repos/new`,
          "On-disk path already exists"
        )
      );
    }

    const diskPath = await initBareRepo(org.slug, name);
    const [repo] = await db
      .insert(repositories)
      .values({
        name,
        ownerId: user.id,
        orgId: org.id,
        description,
        isPrivate,
        diskPath,
      })
      .returning();

    if (repo) {
      const { bootstrapRepository } = await import("../lib/repo-bootstrap");
      await bootstrapRepository({
        repositoryId: repo.id,
        ownerUserId: user.id,
      });
      await audit({
        userId: user.id,
        repositoryId: repo.id,
        action: "org.repo.create",
        targetType: "repository",
        targetId: repo.id,
        metadata: { orgSlug: slug, name, isPrivate },
      });
    }

    return c.redirect(`/${org.slug}/${name}`);
  } catch (err) {
    console.error("[orgs] repo create:", err);
    return c.redirect(
      errorRedirect(`/orgs/${slug}/repos/new`, "Failed to create repository")
    );
  }
});

orgs.get("/orgs/:slug/repos", async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const { org, role } = await loadOrgForUser(slug, user.id);
  if (!org) return c.notFound();
  const canCreate = role && orgRoleAtLeast(role, "admin");

  let repos: (typeof repositories.$inferSelect)[] = [];
  try {
    repos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.orgId, org.id));
  } catch (err) {
    console.error("[orgs] list repos:", err);
  }

  return c.html(
    <Layout title={`${org.name} — repositories`} user={user}>
      <div style="max-width: 900px">
        <div class="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span>/</span>
          <span>repos</span>
        </div>
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px"
        >
          <h2 style="margin: 0">Repositories ({repos.length})</h2>
          {canCreate && (
            <a
              href={`/orgs/${org.slug}/repos/new`}
              class="btn btn-primary"
            >
              New repo
            </a>
          )}
        </div>
        {repos.length === 0 ? (
          <div class="empty-state">
            <h2>No repositories yet</h2>
            {canCreate ? (
              <a
                href={`/orgs/${org.slug}/repos/new`}
                class="btn btn-primary"
                style="margin-top: 8px"
              >
                Create your first repo
              </a>
            ) : (
              <p>Ask an admin to create one.</p>
            )}
          </div>
        ) : (
          <div
            style="display: flex; flex-direction: column; gap: 8px"
          >
            {repos.map((r) => (
              <a
                href={`/${org.slug}/${r.name}`}
                style="display: block; padding: 12px 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); text-decoration: none; color: var(--text)"
              >
                <strong>{r.name}</strong>
                {r.isPrivate && (
                  <span
                    class="gate-status"
                    style="font-size: 10px; margin-left: 8px"
                  >
                    private
                  </span>
                )}
                {r.description && (
                  <div style="color: var(--text-muted); font-size: 13px; margin-top: 2px">
                    {r.description}
                  </div>
                )}
              </a>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
});

export default orgs;
