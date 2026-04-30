/**
 * Team-based repo collaborators — invite every accepted member of a team
 * as a repo collaborator in a single action.
 *
 * Owner-only. Mirrors `src/routes/collaborators.tsx`'s resolveOwnerRepo
 * pattern for the inline owner check. The "invite whole team" action
 * iterates the team's members and upserts one `repo_collaborators` row per
 * user (skipping the repo owner), auto-accepting the invite — matching the
 * v1 auto-accept contract used by the single-user invite flow.
 *
 *   GET  /:owner/:repo/settings/collaborators/teams  — form + list
 *   POST /:owner/:repo/settings/collaborators/teams/add — bulk insert
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  repoCollaborators,
  organizations,
  orgMembers,
  teams,
  teamMembers,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  Container,
  Form,
  FormGroup,
  Input,
  Select,
  Button,
  Alert,
  EmptyState,
} from "../views/ui";

const teamCollaboratorRoutes = new Hono<AuthEnv>();

teamCollaboratorRoutes.use("*", softAuth);

/**
 * Resolve (owner user, repo) from URL params and enforce owner-only access.
 * Mirrors the helper in `src/routes/collaborators.tsx` for consistency.
 */
async function resolveOwnerRepo(
  c: any,
  ownerName: string,
  repoName: string
) {
  const user = c.get("user")!;
  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!owner || owner.id !== user.id) {
    return {
      error: c.html(
        <Layout title="Unauthorized" user={user}>
          <EmptyState title="Unauthorized">
            <p>Only the repository owner can manage collaborators.</p>
          </EmptyState>
        </Layout>,
        403
      ),
    };
  }
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) {
    return { error: c.notFound() };
  }
  return { owner, repo, user };
}

// ─── List + invite form ─────────────────────────────────────────────────────

teamCollaboratorRoutes.get(
  "/:owner/:repo/settings/collaborators/teams",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const success = c.req.query("success");
    const error = c.req.query("error");

    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if ("error" in resolved) return resolved.error;
    const { repo, user } = resolved;

    // Orgs the current user belongs to — these populate the org dropdown.
    const userOrgs = await db
      .select({
        id: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
      })
      .from(organizations)
      .innerJoin(orgMembers, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, user.id));

    // All collaborators for this repo — v1 just lists everyone with a count,
    // not filtered by "added via team" (would need a sourceTeamId column).
    const rows = await db
      .select({
        id: repoCollaborators.id,
        role: repoCollaborators.role,
        invitedAt: repoCollaborators.invitedAt,
        acceptedAt: repoCollaborators.acceptedAt,
        username: users.username,
        avatarUrl: users.avatarUrl,
      })
      .from(repoCollaborators)
      .innerJoin(users, eq(users.id, repoCollaborators.userId))
      .where(eq(repoCollaborators.repositoryId, repo.id));

    return c.html(
      <Layout
        title={`Invite team — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <Container maxWidth={700}>
          <h2 style="margin-bottom: 16px">Invite a team</h2>
          <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px">
            <a href={`/${ownerName}/${repoName}/settings/collaborators`}>
              ← Back to collaborators
            </a>
          </p>
          {success && (
            <Alert variant="success">{decodeURIComponent(success)}</Alert>
          )}
          {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}

          <div
            style="margin-bottom: 24px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius)"
          >
            <h3 style="margin-bottom: 12px">Invite every member of a team</h3>
            {userOrgs.length === 0 ? (
              <p style="font-size:14px;color:var(--text-muted)">
                You don't belong to any organizations yet.
              </p>
            ) : (
              <Form
                method="post"
                action={`/${ownerName}/${repoName}/settings/collaborators/teams/add`}
              >
                <FormGroup label="Organization" htmlFor="orgSlug">
                  <Select name="orgSlug" id="orgSlug">
                    {userOrgs.map((o) => (
                      <option value={o.slug}>
                        {o.name} ({o.slug})
                      </option>
                    ))}
                  </Select>
                </FormGroup>
                <FormGroup label="Team slug" htmlFor="teamSlug">
                  <Input
                    name="teamSlug"
                    id="teamSlug"
                    placeholder="engineering"
                    required
                  />
                </FormGroup>
                <FormGroup label="Role" htmlFor="role">
                  <Select name="role" id="role" value="read">
                    <option value="read">Read — clone + pull</option>
                    <option value="write">Write — push + merge</option>
                    <option value="admin">Admin — full control</option>
                  </Select>
                </FormGroup>
                <Button type="submit" variant="primary">
                  Invite team
                </Button>
              </Form>
            )}
          </div>

          <h3 style="margin-bottom: 12px">
            Current collaborators ({rows.length})
          </h3>
          {rows.length === 0 ? (
            <EmptyState title="No collaborators yet">
              <p>Invite a team above to add multiple people at once.</p>
            </EmptyState>
          ) : (
            <div>
              {rows.map((row) => (
                <div class="ssh-key-item">
                  <div>
                    <strong>
                      {row.avatarUrl && (
                        <img
                          src={row.avatarUrl}
                          alt=""
                          width={20}
                          height={20}
                          style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px"
                        />
                      )}
                      <a href={`/${row.username}`}>{row.username}</a>
                    </strong>
                    <div class="ssh-key-meta">
                      Role: <strong>{row.role}</strong> | Invited:{" "}
                      {new Date(row.invitedAt).toLocaleDateString()} |{" "}
                      {row.acceptedAt ? (
                        <span style="color: var(--green)">Accepted</span>
                      ) : (
                        <span style="color: var(--yellow)">Pending</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Container>
      </Layout>
    );
  }
);

// ─── Invite entire team ─────────────────────────────────────────────────────

teamCollaboratorRoutes.post(
  "/:owner/:repo/settings/collaborators/teams/add",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const body = await c.req.parseBody();

    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if ("error" in resolved) return resolved.error;
    const { repo, user } = resolved;

    const orgSlug = String(body.orgSlug || "").trim();
    const teamSlug = String(body.teamSlug || "").trim();
    const roleRaw = String(body.role || "read");
    const role: "read" | "write" | "admin" =
      roleRaw === "write" || roleRaw === "admin" ? roleRaw : "read";

    const redirBase = `/${ownerName}/${repoName}/settings/collaborators/teams`;

    if (!orgSlug || !teamSlug) {
      return c.redirect(
        `${redirBase}?error=Organization+and+team+slug+are+required`
      );
    }

    // Resolve org by slug, then team by (orgId, slug). We also verify the
    // authed user is a member of the org — otherwise they shouldn't be able
    // to enumerate team membership via this endpoint.
    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, orgSlug))
      .limit(1);
    if (!org) {
      return c.redirect(`${redirBase}?error=Organization+not+found`);
    }

    const [membership] = await db
      .select()
      .from(orgMembers)
      .where(
        and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, user.id))
      )
      .limit(1);
    if (!membership) {
      return c.redirect(
        `${redirBase}?error=You+are+not+a+member+of+that+organization`
      );
    }

    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.slug, teamSlug)))
      .limit(1);
    if (!team) {
      return c.redirect(`${redirBase}?error=Team+not+found`);
    }

    // Fetch team members. The team_members schema has no "acceptedAt"
    // column — a row existing IS the acceptance — so every row counts.
    const members = await db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, team.id));

    let added = 0;
    for (const m of members) {
      // Never add the repo owner as their own collaborator.
      if (m.userId === repo.ownerId) continue;

      const [existing] = await db
        .select()
        .from(repoCollaborators)
        .where(
          and(
            eq(repoCollaborators.repositoryId, repo.id),
            eq(repoCollaborators.userId, m.userId)
          )
        )
        .limit(1);

      if (existing) {
        await db
          .update(repoCollaborators)
          .set({ role, acceptedAt: existing.acceptedAt ?? new Date() })
          .where(eq(repoCollaborators.id, existing.id));
      } else {
        await db.insert(repoCollaborators).values({
          repositoryId: repo.id,
          userId: m.userId,
          role,
          invitedBy: user.id,
          acceptedAt: new Date(), // v1 auto-accept
        });
      }
      added += 1;
    }

    const msg = `Added ${added} collaborators from team ${team.name}`;
    return c.redirect(`${redirBase}?success=${encodeURIComponent(msg)}`);
  }
);

export default teamCollaboratorRoutes;
