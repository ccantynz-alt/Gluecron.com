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
    <Layout title="New Organization" user={user}>
      <Container maxWidth={500}>
        <PageHeader title="Create a new organization" />
        {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}
        <Form action="/orgs/new" csrfToken={(c as any).get("csrfToken") || ""}>
          <FormGroup label="Organization name" htmlFor="name" hint="Letters, numbers, hyphens, dots, underscores only">
            <Input name="name" required pattern="^[a-zA-Z0-9._-]+$" placeholder="my-org" autocomplete="off" />
          </FormGroup>
          <FormGroup label="Display name" htmlFor="displayName">
            <Input name="displayName" placeholder="My Organization" />
          </FormGroup>
          <FormGroup label="Description" htmlFor="description">
            <TextArea name="description" rows={3} placeholder="What does this organization do?" />
          </FormGroup>
          <FormGroup label="Website" htmlFor="website">
            <Input name="website" type="url" placeholder="https://example.com" />
          </FormGroup>
          <Button type="submit" variant="primary">Create organization</Button>
        </Form>
      </Container>
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
      <Container maxWidth={600}>
        <PageHeader title="Organization Settings" />
        {success && <Alert variant="success">Settings updated.</Alert>}
        <Form action={`/orgs/${orgName}/settings`} csrfToken={(c as any).get("csrfToken") || ""}>
          <FormGroup label="Display name" htmlFor="displayName">
            <Input name="displayName" value={org.displayName || ""} />
          </FormGroup>
          <FormGroup label="Description" htmlFor="description">
            <TextArea name="description" rows={3} value={org.description || ""} />
          </FormGroup>
          <FormGroup label="Website" htmlFor="website">
            <Input name="website" type="url" value={org.website || ""} />
          </FormGroup>
          <FormGroup label="Location" htmlFor="location">
            <Input name="location" value={org.location || ""} />
          </FormGroup>
          <Button type="submit" variant="primary">Save changes</Button>
        </Form>

        <div style="margin-top:40px;padding-top:24px;border-top:1px solid var(--red)">
          <h3 style="color:var(--red);margin-bottom:12px">Danger Zone</h3>
          <Form action={`/orgs/${orgName}/delete`} csrfToken={(c as any).get("csrfToken") || ""} class="confirm-action" >
            <Button type="submit" variant="danger">Delete organization</Button>
          </Form>
        </div>
      </Container>
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
      <Container maxWidth={500}>
        <PageHeader title={`Invite a member to ${orgName}`} />
        {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}
        {success && <Alert variant="success">Member invited successfully.</Alert>}
        <Form action={`/orgs/${orgName}/members/invite`} csrfToken={(c as any).get("csrfToken") || ""}>
          <FormGroup label="Username" htmlFor="username">
            <Input name="username" required placeholder="Enter username" autocomplete="off" />
          </FormGroup>
          <FormGroup label="Role" htmlFor="role">
            <Select name="role">
              <option value="member">Member — can view</option>
              <option value="admin">Admin — can manage teams</option>
              <option value="owner">Owner — full control</option>
            </Select>
          </FormGroup>
          <Button type="submit" variant="primary">Send invitation</Button>
        </Form>
      </Container>
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
      <Container maxWidth={500}>
        <PageHeader title="Create a new team" />
        {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}
        <Form action={`/orgs/${orgName}/teams/new`} csrfToken={(c as any).get("csrfToken") || ""}>
          <FormGroup label="Team name" htmlFor="name">
            <Input name="name" required placeholder="engineering" autocomplete="off" />
          </FormGroup>
          <FormGroup label="Description" htmlFor="description">
            <TextArea name="description" rows={2} placeholder="What does this team do?" />
          </FormGroup>
          <FormGroup label="Default permission" htmlFor="permission">
            <Select name="permission">
              <option value="read">Read — view repos</option>
              <option value="write">Write — push to repos</option>
              <option value="admin">Admin — manage repos</option>
            </Select>
          </FormGroup>
          <Button type="submit" variant="primary">Create team</Button>
        </Form>
      </Container>
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
