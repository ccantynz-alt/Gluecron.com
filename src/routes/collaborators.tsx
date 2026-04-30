/**
 * Repository collaborators — add, list, remove.
 *
 * Owner-only. Adding a collaborator inserts a pending `repo_collaborators`
 * row with `acceptedAt = NULL` and a hashed invite token, then emails the
 * invitee a `/invites/:token` link. The grantee becomes active only after
 * they click the link (see `src/routes/invites.tsx`).
 *
 * Collaborator lifecycle matrix:
 *   - Add:      POST /:owner/:repo/settings/collaborators/add
 *   - Remove:   POST /:owner/:repo/settings/collaborators/:collaboratorId/remove
 *   - List:     GET  /:owner/:repo/settings/collaborators
 *
 * Middleware: softAuth on all, plus an inline owner-only check that mirrors
 * `src/routes/repo-settings.tsx` — the owner of the repo (by username) must
 * match the authed user. Non-owners get 403.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  repoCollaborators,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { generateInviteToken, hashInviteToken } from "../lib/invite-tokens";
import { sendEmail, absoluteUrl } from "../lib/email";
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

const collaboratorRoutes = new Hono<AuthEnv>();

collaboratorRoutes.use("*", softAuth);

/**
 * Resolve (owner user, repo) from URL params, enforcing the authed user is
 * the repo owner. Returns `{ owner, repo }` on success, or an already-built
 * Response on failure (caller should return it directly).
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

// ─── List collaborators ─────────────────────────────────────────────────────

collaboratorRoutes.get(
  "/:owner/:repo/settings/collaborators",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const success = c.req.query("success");
    const error = c.req.query("error");

    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if ("error" in resolved) return resolved.error;
    const { repo, user } = resolved;

    // Join collaborators with users to get username + avatar.
    const rows = await db
      .select({
        id: repoCollaborators.id,
        role: repoCollaborators.role,
        invitedAt: repoCollaborators.invitedAt,
        acceptedAt: repoCollaborators.acceptedAt,
        username: users.username,
        avatarUrl: users.avatarUrl,
        userId: users.id,
      })
      .from(repoCollaborators)
      .innerJoin(users, eq(users.id, repoCollaborators.userId))
      .where(eq(repoCollaborators.repositoryId, repo.id));

    return c.html(
      <Layout title={`Collaborators — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <Container maxWidth={700}>
          <h2 style="margin-bottom: 16px">Collaborators</h2>
          <p style="font-size:14px;color:var(--text-muted);margin-bottom:16px">
            <a href={`/${ownerName}/${repoName}/settings`}>← Back to settings</a>
            {" | "}
            <a
              href={`/${ownerName}/${repoName}/settings/collaborators/teams`}
            >
              Invite a team →
            </a>
          </p>
          {success && (
            <Alert variant="success">{decodeURIComponent(success)}</Alert>
          )}
          {error && <Alert variant="error">{decodeURIComponent(error)}</Alert>}

          <div
            style="margin-bottom: 24px; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius)"
          >
            <h3 style="margin-bottom: 12px">Add a collaborator</h3>
            <Form
              method="post"
              action={`/${ownerName}/${repoName}/settings/collaborators/add`}
            >
              <FormGroup label="Username" htmlFor="username">
                <Input
                  name="username"
                  id="username"
                  placeholder="github-username"
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
                Add collaborator
              </Button>
            </Form>
          </div>

          {rows.length === 0 ? (
            <EmptyState title="No collaborators yet">
              <p>
                Add a collaborator above to grant them access to this
                repository.
              </p>
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
                  <form
                    method="post"
                    action={`/${ownerName}/${repoName}/settings/collaborators/${row.id}/remove`}
                    onsubmit="return confirm('Remove this collaborator?')"
                  >
                    <Button type="submit" variant="danger" size="sm">
                      Remove
                    </Button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </Container>
      </Layout>
    );
  }
);

// ─── Add collaborator ───────────────────────────────────────────────────────

collaboratorRoutes.post(
  "/:owner/:repo/settings/collaborators/add",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const body = await c.req.parseBody();

    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if ("error" in resolved) return resolved.error;
    const { repo, user } = resolved;

    const username = String(body.username || "").trim();
    const roleRaw = String(body.role || "read");
    const role: "read" | "write" | "admin" =
      roleRaw === "write" || roleRaw === "admin" ? roleRaw : "read";

    if (!username) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/collaborators?error=Username+required`
      );
    }

    const [invitee] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!invitee) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/collaborators?error=User+not+found`
      );
    }
    if (invitee.id === user.id) {
      return c.redirect(
        `/${ownerName}/${repoName}/settings/collaborators?error=Owner+is+already+a+collaborator`
      );
    }

    // If a row already exists for (repo, user), update the role instead of
    // erroring. Mirrors the "upsert" contract so the owner can re-invite
    // with a different role without first removing the prior row.
    const [existing] = await db
      .select()
      .from(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.repositoryId, repo.id),
          eq(repoCollaborators.userId, invitee.id)
        )
      )
      .limit(1);

    if (existing) {
      // Re-inviting an existing collaborator just updates the role. We don't
      // re-issue a token here — if the prior invite hasn't been accepted the
      // existing token is still valid; if it has, they're already in.
      await db
        .update(repoCollaborators)
        .set({ role })
        .where(eq(repoCollaborators.id, existing.id));
      return c.redirect(
        `/${ownerName}/${repoName}/settings/collaborators?success=Role+updated`
      );
    }

    // Fresh invite: generate a single-use token, store only its hash, and
    // email the plaintext to the invitee. acceptedAt stays NULL until they
    // click through /invites/:token.
    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);

    await db.insert(repoCollaborators).values({
      repositoryId: repo.id,
      userId: invitee.id,
      role,
      invitedBy: user.id,
      inviteTokenHash: tokenHash,
    });

    // Email delivery degrades gracefully — a failed send should never block
    // the invite row from existing. Owner can resend / share the URL by hand.
    const inviteUrl = absoluteUrl(`/invites/${token}`);
    try {
      const result = await sendEmail({
        to: invitee.email,
        subject: `You've been invited to ${ownerName}/${repoName}`,
        text: `You've been invited to ${ownerName}/${repoName}. Click: ${inviteUrl}`,
      });
      if (!result.ok) {
        console.error(
          `[collaborators] invite email send failed for ${invitee.username}:`,
          result.error || result.skipped
        );
      }
    } catch (err) {
      console.error(
        `[collaborators] invite email threw for ${invitee.username}:`,
        err
      );
    }

    return c.redirect(
      `/${ownerName}/${repoName}/settings/collaborators?success=Invite+sent`
    );
  }
);

// ─── Remove collaborator ────────────────────────────────────────────────────

collaboratorRoutes.post(
  "/:owner/:repo/settings/collaborators/:collaboratorId/remove",
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, collaboratorId } =
      c.req.param();

    const resolved = await resolveOwnerRepo(c, ownerName, repoName);
    if ("error" in resolved) return resolved.error;
    const { repo } = resolved;

    // Scope the delete to this repo so an owner can't remove a collaborator
    // from some other repo by crafting a URL.
    await db
      .delete(repoCollaborators)
      .where(
        and(
          eq(repoCollaborators.id, collaboratorId),
          eq(repoCollaborators.repositoryId, repo.id)
        )
      );

    return c.redirect(
      `/${ownerName}/${repoName}/settings/collaborators?success=Collaborator+removed`
    );
  }
);

export default collaboratorRoutes;
