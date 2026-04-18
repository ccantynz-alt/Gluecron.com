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
import { loadOrgForUser, listOrgMembers, orgRoleAtLeast } from "../lib/orgs";
import {
  Container,
  PageHeader,
  Form,
  FormGroup,
  Input,
  TextArea,
  Select,
  Button,
  LinkButton,
  Alert,
  EmptyState,
  Flex,
  Grid,
  Text,
  Badge,
  Section,
  Avatar,
  List,
  ListItem,
} from "../views/ui";

const orgRoutes = new Hono<AuthEnv>();

// ─── Organization List / Create ─────────────────────────────────────────────

orgRoutes.get("/orgs/new", softAuth, requireAuth, (c) => {
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
      <Container maxWidth={900}>
        <Flex gap={24} style="margin-bottom:32px">
          <Avatar name={org.displayName || org.name} size={80} />
          <div>
            <h2>{org.displayName || org.name}</h2>
            <Text size={14} muted>@{org.name}</Text>
            {org.description && <p style="margin-top:8px"><Text size={14} muted>{org.description}</Text></p>}
            {org.website && (
              <a href={org.website} style="font-size:13px" target="_blank" rel="noopener noreferrer">
                {org.website}
              </a>
            )}
          </div>
          {isOwner && (
            <div style="margin-left:auto">
              <LinkButton href={`/orgs/${org.name}/settings`} size="sm">Settings</LinkButton>
            </div>
          )}
        </Flex>

        <Grid cols="1fr 300px" gap={32}>
          <div>
            <Section title="Teams">
              {teamList.length === 0 ? (
                <EmptyState>
                  <p>No teams yet.</p>
                  {isOwner && <LinkButton href={`/orgs/${org.name}/teams/new`} variant="primary" size="sm">Create a team</LinkButton>}
                </EmptyState>
              ) : (
                <List>
                  {teamList.map((team: any) => (
                    <ListItem>
                      <div>
                        <div style="font-weight:500;font-size:15px">
                          <a href={`/orgs/${org.name}/teams/${team.name}`} style="color:var(--text)">{team.name}</a>
                        </div>
                        {team.description && <Text size={13} muted>{team.description}</Text>}
                      </div>
                      <Badge>{team.permission}</Badge>
                    </ListItem>
                  ))}
                </List>
              )}
              {isOwner && teamList.length > 0 && (
                <div style="margin-top:12px">
                  <LinkButton href={`/orgs/${org.name}/teams/new`} variant="primary" size="sm">Create team</LinkButton>
                </div>
              )}
            </Section>
          </div>

          <div>
            <Section title={`Members (${members.length})`}>
              <List>
                {members.map((m: any) => (
                  <ListItem>
                    <Flex align="center" gap={8} style="width:100%">
                      <Avatar name={m.user.displayName || m.user.username} size={32} />
                      <div style="flex:1">
                        <a href={`/${m.user.username}`} style="font-size:14px;font-weight:500">{m.user.username}</a>
                      </div>
                      <Badge style="font-size:11px">{m.member.role}</Badge>
                    </Flex>
                  </ListItem>
                ))}
              </List>
              {isOwner && (
                <div style="margin-top:12px">
                  <LinkButton href={`/orgs/${org.name}/members/invite`} size="sm">Invite member</LinkButton>
                </div>
              )}
            </Section>
          </div>
        </Grid>
      </Container>
    </Layout>
  );
});

// --- PEOPLE -----------------------------------------------------------------

orgRoutes.get("/orgs/:slug/people", async (c) => {
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
  const error = c.req.query("error");
  const canAdmin = isOwner;
  let orgTeams: any[] = [];
  try {
    orgTeams = await db.select().from(teams).where(eq(teams.orgId, org.id));
  } catch { /* */ }

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
    <Layout title={`Invite — ${orgName}`} user={user}>
      <div style="max-width: 560px">
        <div class="breadcrumb">
          <a href={`/orgs/${orgName}`}>{orgName}</a>
          <span>/</span>
          <span>invite</span>
        </div>
        <h2>Invite a member</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        {success && (
          <div class="auth-success">{decodeURIComponent(success)}</div>
        )}
        <form
          method="post"
          action={`/orgs/${orgName}/members/invite`}
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
            <option value="admin">admin</option>
          </select>
          <button type="submit" class="btn btn-primary">
            Invite
          </button>
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

  let org: any;
  try {
    const [found] = await db.select().from(organizations).where(eq(organizations.name, orgName)).limit(1);
    org = found;
  } catch {
    return c.notFound();
  }
  if (!org) return c.notFound();

  return c.html(
    <Layout title={`New team — ${org.name}`} user={user}>
      <div class="settings-container" style="max-width: 560px">
        <div class="breadcrumb">
          <a href={`/orgs/${org.slug}`}>{org.slug}</a>
          <span>/</span>
          <span>new team</span>
        </div>
        <h2>Create team in {org.name}</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="post" action={`/orgs/${org.slug}/teams/new`}>
          <div class="form-group">
            <label for="name">Team name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={80}
              placeholder="Platform engineers"
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
            <label for="permission">Default permission</label>
            <select id="permission" name="permission">
              <option value="read">read</option>
              <option value="write">write</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary">
            Create team
          </button>
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
      <Container maxWidth={800}>
        <Section style="margin-bottom:24px">
          <Text size={14} muted>
            <a href={`/orgs/${orgName}`}>{orgName}</a> / teams
          </Text>
          <h2>{team.name}</h2>
          {team.description && <p style="margin-top:4px"><Text muted>{team.description}</Text></p>}
          <div style="margin-top:8px">
            <Badge>{team.permission} access</Badge>
          </div>
        </Section>

        <Grid cols="1fr 1fr" gap={24}>
          <div>
            <Section title={`Members (${members.length})`}>
              {members.length === 0 ? (
                <EmptyState><Text size={14} muted>No members yet.</Text></EmptyState>
              ) : (
                <List>
                  {members.map((m: any) => (
                    <ListItem>
                      <a href={`/${m.user.username}`}>{m.user.username}</a>
                    </ListItem>
                  ))}
                </List>
              )}
            </Section>
          </div>
          <div>
            <Section title={`Repositories (${repos.length})`}>
              {repos.length === 0 ? (
                <EmptyState><Text size={14} muted>No repositories assigned.</Text></EmptyState>
              ) : (
                <List>
                  {repos.map((r: any) => (
                    <ListItem>
                      <span>{r.repo.name}</span>
                      <Badge style="margin-left:8px;font-size:11px">{r.teamRepo.permission}</Badge>
                    </ListItem>
                  ))}
                </List>
              )}
            </Section>
          </div>
        </Grid>
      </Container>
    </Layout>
  );
});

export default orgRoutes;
