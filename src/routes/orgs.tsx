/**
 * Organization and team routes — create orgs, manage members, teams, permissions.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import { organizations, orgMembers, teams, teamMembers, teamRepos } from "../db/schema-extensions";
import { users, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const orgRoutes = new Hono<AuthEnv>();

// ─── Organization List / Create ─────────────────────────────────────────────

orgRoutes.get("/orgs/new", softAuth, requireAuth, (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="New Organization" user={user}>
      <div style="max-width:500px">
        <h2 style="margin-bottom:16px">Create a new organization</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="post" action="/orgs/new">
          <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
          <div class="form-group">
            <label for="name">Organization name</label>
            <input type="text" id="name" name="name" required pattern="^[a-zA-Z0-9._-]+$" placeholder="my-org" autocomplete="off" />
            <span style="font-size:12px;color:var(--text-muted)">Letters, numbers, hyphens, dots, underscores only</span>
          </div>
          <div class="form-group">
            <label for="displayName">Display name</label>
            <input type="text" id="displayName" name="displayName" placeholder="My Organization" />
          </div>
          <div class="form-group">
            <label for="description">Description</label>
            <textarea id="description" name="description" rows={3} placeholder="What does this organization do?" />
          </div>
          <div class="form-group">
            <label for="website">Website</label>
            <input type="url" id="website" name="website" placeholder="https://example.com" />
          </div>
          <button type="submit" class="btn btn-primary">Create organization</button>
        </form>
      </div>
    </Layout>
  );
});

orgRoutes.post("/orgs/new", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const displayName = String(body.displayName || "").trim();
  const description = String(body.description || "").trim();
  const website = String(body.website || "").trim();

  if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.redirect("/orgs/new?error=Invalid+organization+name");
  }

  try {
    // Check if name is taken (by user or org)
    const [existingUser] = await db.select().from(users).where(eq(users.username, name)).limit(1);
    if (existingUser) {
      return c.redirect("/orgs/new?error=Name+already+taken");
    }

    const [existingOrg] = await db.select().from(organizations).where(eq(organizations.name, name)).limit(1);
    if (existingOrg) {
      return c.redirect("/orgs/new?error=Organization+already+exists");
    }

    const [org] = await db
      .insert(organizations)
      .values({
        name,
        displayName: displayName || name,
        description: description || null,
        website: website || null,
      })
      .returning();

    // Add creator as owner
    await db.insert(orgMembers).values({
      orgId: org.id,
      userId: user.id,
      role: "owner",
    });

    return c.redirect(`/orgs/${name}`);
  } catch (err: any) {
    return c.redirect(`/orgs/new?error=${encodeURIComponent(err.message || "Failed to create organization")}`);
  }
});

// ─── Organization Profile ───────────────────────────────────────────────────

orgRoutes.get("/orgs/:org", softAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user");

  let org: any;
  try {
    const [found] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    org = found;
  } catch {
    return c.notFound();
  }

  if (!org) return c.notFound();

  // Get members
  let members: any[] = [];
  try {
    members = await db
      .select({ member: orgMembers, user: { username: users.username, displayName: users.displayName } })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.orgId, org.id))
      .orderBy(asc(orgMembers.role));
  } catch {
    // Table may not exist
  }

  // Get teams
  let teamList: any[] = [];
  try {
    teamList = await db.select().from(teams).where(eq(teams.orgId, org.id)).orderBy(asc(teams.name));
  } catch {
    // Table may not exist
  }

  const isMember = user && members.some((m: any) => m.member.userId === user.id);
  const isOwner = user && members.some((m: any) => m.member.userId === user.id && m.member.role === "owner");

  return c.html(
    <Layout title={org.displayName || org.name} user={user}>
      <div style="max-width:900px">
        <div style="display:flex;gap:24px;margin-bottom:32px">
          <div class="user-avatar" style="width:80px;height:80px;font-size:32px">
            {(org.displayName || org.name)[0].toUpperCase()}
          </div>
          <div>
            <h2>{org.displayName || org.name}</h2>
            <div style="font-size:14px;color:var(--text-muted)">@{org.name}</div>
            {org.description && <p style="margin-top:8px;font-size:14px;color:var(--text-muted)">{org.description}</p>}
            {org.website && (
              <a href={org.website} style="font-size:13px" target="_blank" rel="noopener noreferrer">
                {org.website}
              </a>
            )}
          </div>
          {isOwner && (
            <div style="margin-left:auto">
              <a href={`/orgs/${org.name}/settings`} class="btn btn-sm">Settings</a>
            </div>
          )}
        </div>

        <div style="display:grid;grid-template-columns:1fr 300px;gap:32px">
          <div>
            <h3 style="margin-bottom:16px">Teams</h3>
            {teamList.length === 0 ? (
              <div class="empty-state" style="padding:24px">
                <p>No teams yet.</p>
                {isOwner && <a href={`/orgs/${org.name}/teams/new`} class="btn btn-sm btn-primary" style="margin-top:8px">Create a team</a>}
              </div>
            ) : (
              <div class="issue-list">
                {teamList.map((team: any) => (
                  <div class="issue-item">
                    <div>
                      <div style="font-weight:500;font-size:15px">
                        <a href={`/orgs/${org.name}/teams/${team.name}`} style="color:var(--text)">{team.name}</a>
                      </div>
                      {team.description && <div style="font-size:13px;color:var(--text-muted)">{team.description}</div>}
                    </div>
                    <span class="badge">{team.permission}</span>
                  </div>
                ))}
              </div>
            )}
            {isOwner && teamList.length > 0 && (
              <a href={`/orgs/${org.name}/teams/new`} class="btn btn-sm btn-primary" style="margin-top:12px">Create team</a>
            )}
          </div>

          <div>
            <h3 style="margin-bottom:16px">Members ({members.length})</h3>
            <div style="display:flex;flex-direction:column;gap:8px">
              {members.map((m: any) => (
                <div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
                  <div class="user-avatar" style="width:32px;height:32px;font-size:14px">
                    {(m.user.displayName || m.user.username)[0].toUpperCase()}
                  </div>
                  <div style="flex:1">
                    <a href={`/${m.user.username}`} style="font-size:14px;font-weight:500">{m.user.username}</a>
                  </div>
                  <span class="badge" style="font-size:11px">{m.member.role}</span>
                </div>
              ))}
            </div>
            {isOwner && (
              <a href={`/orgs/${org.name}/members/invite`} class="btn btn-sm" style="margin-top:12px;width:100%;text-align:center">
                Invite member
              </a>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
});

// ─── Organization Settings ──────────────────────────────────────────────────

orgRoutes.get("/orgs/:org/settings", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;

  let org: any;
  try {
    const [found] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    org = found;
  } catch {
    return c.notFound();
  }
  if (!org) return c.notFound();

  // Check owner
  let isOwner = false;
  try {
    const [member] = await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id), eq(orgMembers.role, "owner")))
      .limit(1);
    isOwner = !!member;
  } catch { /* */ }
  if (!isOwner) return c.redirect(`/orgs/${orgName}`);

  const success = c.req.query("success");

  return c.html(
    <Layout title={`Settings — ${org.name}`} user={user}>
      <div style="max-width:600px">
        <h2 style="margin-bottom:20px">Organization Settings</h2>
        {success && <div class="auth-success">Settings updated.</div>}
        <form method="post" action={`/orgs/${orgName}/settings`}>
          <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
          <div class="form-group">
            <label for="displayName">Display name</label>
            <input type="text" id="displayName" name="displayName" value={org.displayName || ""} />
          </div>
          <div class="form-group">
            <label for="description">Description</label>
            <textarea id="description" name="description" rows={3}>{org.description || ""}</textarea>
          </div>
          <div class="form-group">
            <label for="website">Website</label>
            <input type="url" id="website" name="website" value={org.website || ""} />
          </div>
          <div class="form-group">
            <label for="location">Location</label>
            <input type="text" id="location" name="location" value={org.location || ""} />
          </div>
          <button type="submit" class="btn btn-primary">Save changes</button>
        </form>

        <div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--red)">
          <h3 style="color:var(--red);margin-bottom:12px">Danger Zone</h3>
          <form method="post" action={`/orgs/${orgName}/delete`} class="confirm-action" data-confirm="This will permanently delete the organization. Are you sure?">
            <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
            <button type="submit" class="btn btn-danger">Delete organization</button>
          </form>
        </div>
      </div>
    </Layout>
  );
});

orgRoutes.post("/orgs/:org/settings", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;
  const body = await c.req.parseBody();

  try {
    const [org] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    if (!org) return c.redirect("/");

    const [member] = await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id), eq(orgMembers.role, "owner")))
      .limit(1);
    if (!member) return c.redirect(`/orgs/${orgName}`);

    await db.update(organizations).set({
      displayName: String(body.displayName || "").trim() || org.name,
      description: String(body.description || "").trim() || null,
      website: String(body.website || "").trim() || null,
      location: String(body.location || "").trim() || null,
      updatedAt: new Date(),
    }).where(eq(organizations.id, org.id));
  } catch { /* */ }

  return c.redirect(`/orgs/${orgName}/settings?success=1`);
});

orgRoutes.post("/orgs/:org/delete", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;

  try {
    const [org] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    if (!org) return c.redirect("/");

    const [member] = await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id), eq(orgMembers.role, "owner")))
      .limit(1);
    if (!member) return c.redirect(`/orgs/${orgName}`);

    await db.delete(organizations).where(eq(organizations.id, org.id));
  } catch { /* */ }

  return c.redirect("/");
});

// ─── Member Invite ──────────────────────────────────────────────────────────

orgRoutes.get("/orgs/:org/members/invite", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;
  const error = c.req.query("error");
  const success = c.req.query("success");

  return c.html(
    <Layout title={`Invite Member — ${orgName}`} user={user}>
      <div style="max-width:500px">
        <h2 style="margin-bottom:16px">Invite a member to {orgName}</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && <div class="auth-success">Member invited successfully.</div>}
        <form method="post" action={`/orgs/${orgName}/members/invite`}>
          <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
          <div class="form-group">
            <label for="username">Username</label>
            <input type="text" id="username" name="username" required placeholder="Enter username" autocomplete="off" />
          </div>
          <div class="form-group">
            <label for="role">Role</label>
            <select id="role" name="role">
              <option value="member">Member — can view</option>
              <option value="admin">Admin — can manage teams</option>
              <option value="owner">Owner — full control</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary">Send invitation</button>
        </form>
      </div>
    </Layout>
  );
});

orgRoutes.post("/orgs/:org/members/invite", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const username = String(body.username || "").trim();
  const role = String(body.role || "member");

  try {
    const [org] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    if (!org) return c.redirect("/");

    // Check inviter is owner or admin
    const [inviter] = await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id)))
      .limit(1);
    if (!inviter || (inviter.role !== "owner" && inviter.role !== "admin")) {
      return c.redirect(`/orgs/${orgName}/members/invite?error=Permission+denied`);
    }

    // Find user
    const [targetUser] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!targetUser) {
      return c.redirect(`/orgs/${orgName}/members/invite?error=User+not+found`);
    }

    // Check if already member
    const [existing] = await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, targetUser.id)))
      .limit(1);
    if (existing) {
      return c.redirect(`/orgs/${orgName}/members/invite?error=User+is+already+a+member`);
    }

    await db.insert(orgMembers).values({
      orgId: org.id,
      userId: targetUser.id,
      role: ["owner", "admin", "member"].includes(role) ? role : "member",
    });

    return c.redirect(`/orgs/${orgName}/members/invite?success=1`);
  } catch (err: any) {
    return c.redirect(`/orgs/${orgName}/members/invite?error=${encodeURIComponent(err.message || "Failed")}`);
  }
});

// ─── Team Create ────────────────────────────────────────────────────────────

orgRoutes.get("/orgs/:org/teams/new", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title={`New Team — ${orgName}`} user={user}>
      <div style="max-width:500px">
        <h2 style="margin-bottom:16px">Create a new team</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="post" action={`/orgs/${orgName}/teams/new`}>
          <input type="hidden" name="_csrf" value={(c as any).get("csrfToken") || ""} />
          <div class="form-group">
            <label for="name">Team name</label>
            <input type="text" id="name" name="name" required placeholder="engineering" autocomplete="off" />
          </div>
          <div class="form-group">
            <label for="description">Description</label>
            <textarea id="description" name="description" rows={2} placeholder="What does this team do?" />
          </div>
          <div class="form-group">
            <label for="permission">Default permission</label>
            <select id="permission" name="permission">
              <option value="read">Read — view repos</option>
              <option value="write">Write — push to repos</option>
              <option value="admin">Admin — manage repos</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary">Create team</button>
        </form>
      </div>
    </Layout>
  );
});

orgRoutes.post("/orgs/:org/teams/new", softAuth, requireAuth, async (c) => {
  const orgName = c.req.param("org");
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const permission = String(body.permission || "read");

  try {
    const [org] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    if (!org) return c.redirect("/");

    const [member] = await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id)))
      .limit(1);
    if (!member || member.role === "member") {
      return c.redirect(`/orgs/${orgName}/teams/new?error=Permission+denied`);
    }

    if (!name) {
      return c.redirect(`/orgs/${orgName}/teams/new?error=Team+name+is+required`);
    }

    await db.insert(teams).values({
      orgId: org.id,
      name,
      description: description || null,
      permission: ["read", "write", "admin"].includes(permission) ? permission : "read",
    });

    return c.redirect(`/orgs/${orgName}`);
  } catch (err: any) {
    return c.redirect(`/orgs/${orgName}/teams/new?error=${encodeURIComponent(err.message || "Failed")}`);
  }
});

// ─── Team Detail ────────────────────────────────────────────────────────────

orgRoutes.get("/orgs/:org/teams/:team", softAuth, async (c) => {
  const orgName = c.req.param("org");
  const teamName = c.req.param("team");
  const user = c.get("user");

  let org: any, team: any;
  try {
    [org] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    if (!org) return c.notFound();
    [team] = await db.select().from(teams).where(and(eq(teams.orgId, org.id), eq(teams.name, teamName))).limit(1);
    if (!team) return c.notFound();
  } catch {
    return c.notFound();
  }

  let members: any[] = [];
  try {
    members = await db
      .select({ member: teamMembers, user: { username: users.username } })
      .from(teamMembers)
      .innerJoin(users, eq(teamMembers.userId, users.id))
      .where(eq(teamMembers.teamId, team.id));
  } catch { /* */ }

  let repos: any[] = [];
  try {
    repos = await db
      .select({ teamRepo: teamRepos, repo: { name: repositories.name } })
      .from(teamRepos)
      .innerJoin(repositories, eq(teamRepos.repositoryId, repositories.id))
      .where(eq(teamRepos.teamId, team.id));
  } catch { /* */ }

  return c.html(
    <Layout title={`${teamName} — ${orgName}`} user={user}>
      <div style="max-width:800px">
        <div style="margin-bottom:24px">
          <div style="font-size:14px;color:var(--text-muted);margin-bottom:4px">
            <a href={`/orgs/${orgName}`}>{orgName}</a> / teams
          </div>
          <h2>{team.name}</h2>
          {team.description && <p style="color:var(--text-muted);margin-top:4px">{team.description}</p>}
          <span class="badge" style="margin-top:8px">{team.permission} access</span>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
          <div>
            <h3 style="margin-bottom:12px">Members ({members.length})</h3>
            {members.length === 0 ? (
              <p style="color:var(--text-muted);font-size:14px">No members yet.</p>
            ) : (
              <div style="display:flex;flex-direction:column;gap:8px">
                {members.map((m: any) => (
                  <div style="padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
                    <a href={`/${m.user.username}`}>{m.user.username}</a>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3 style="margin-bottom:12px">Repositories ({repos.length})</h3>
            {repos.length === 0 ? (
              <p style="color:var(--text-muted);font-size:14px">No repositories assigned.</p>
            ) : (
              <div style="display:flex;flex-direction:column;gap:8px">
                {repos.map((r: any) => (
                  <div style="padding:8px;border:1px solid var(--border);border-radius:var(--radius)">
                    {r.repo.name}
                    <span class="badge" style="margin-left:8px;font-size:11px">{r.teamRepo.permission}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
});

export default orgRoutes;
