/**
 * Collaborator invite acceptance — the flip side of POST /add.
 *
 * When an owner invites a user, `src/routes/collaborators.tsx` generates a
 * random token, stores its sha256 on the `repo_collaborators` row, and
 * emails the plaintext link. This file handles that link being clicked.
 *
 * Flow:
 *   GET /invites/:token
 *     → hash the presented token, find the pending row, render "Accept"
 *   POST /invites/:token
 *     → same lookup, assert the invite is for the authed user, flip
 *       `acceptedAt` to now() and null the hash so the link is one-shot.
 *       Redirect to /:owner/:repo on success.
 *
 * Not-found / already-accepted / wrong-user paths all degrade safely (404 /
 * 403) without leaking which of those branches triggered.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoCollaborators } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Container, Form, Button, EmptyState, Alert } from "../views/ui";
import { hashInviteToken } from "../lib/invite-tokens";

const inviteRoutes = new Hono<AuthEnv>();

inviteRoutes.use("*", softAuth);

/**
 * Resolve the pending invite by token hash + join repo/owner for display.
 * Returns null for not-found, already-accepted, or DB errors — the caller
 * surfaces a single 404 in all cases so we don't leak invite existence.
 */
async function resolvePendingInvite(token: string) {
  if (!token) return null;
  let hash: string;
  try {
    hash = hashInviteToken(token);
  } catch {
    return null;
  }
  try {
    const [row] = await db
      .select({
        id: repoCollaborators.id,
        userId: repoCollaborators.userId,
        acceptedAt: repoCollaborators.acceptedAt,
        inviteTokenHash: repoCollaborators.inviteTokenHash,
        repositoryId: repoCollaborators.repositoryId,
        role: repoCollaborators.role,
        repoName: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repoCollaborators)
      .innerJoin(
        repositories,
        eq(repositories.id, repoCollaborators.repositoryId)
      )
      .where(eq(repoCollaborators.inviteTokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.acceptedAt) return null;
    const [owner] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .limit(1);
    if (!owner) return null;
    return { ...row, ownerName: owner.username };
  } catch {
    return null;
  }
}

// ─── Display accept page ────────────────────────────────────────────────────

inviteRoutes.get("/invites/:token", async (c) => {
  const { token } = c.req.param();
  const user = c.get("user");
  const invite = await resolvePendingInvite(token);
  if (!invite) return c.notFound();

  return c.html(
    <Layout title="Accept invitation" user={user}>
      <Container maxWidth={600}>
        <h2 style="margin-bottom: 16px">
          Accept invitation to {invite.ownerName}/{invite.repoName}
        </h2>
        <p style="color:var(--text-muted);margin-bottom:24px">
          You've been invited as a <strong>{invite.role}</strong> collaborator
          on this repository.
        </p>
        {!user && (
          <Alert variant="info">
            You need to{" "}
            <a href={`/login?next=/invites/${token}`}>sign in</a> before
            accepting this invitation.
          </Alert>
        )}
        {user && (
          <Form method="post" action={`/invites/${token}`}>
            <Button type="submit" variant="primary">
              Accept invitation
            </Button>
          </Form>
        )}
      </Container>
    </Layout>
  );
});

// ─── Accept (POST) ──────────────────────────────────────────────────────────

inviteRoutes.post("/invites/:token", requireAuth, async (c) => {
  const { token } = c.req.param();
  const user = c.get("user")!;
  const invite = await resolvePendingInvite(token);
  if (!invite) return c.notFound();

  // The invite is bound to a specific user at creation time — reject if
  // someone else is clicking the link from a shared inbox.
  if (invite.userId !== user.id) {
    return c.html(
      <Layout title="Forbidden" user={user}>
        <EmptyState title="Not your invitation">
          <p>This invitation was sent to a different account.</p>
        </EmptyState>
      </Layout>,
      403
    );
  }

  await db
    .update(repoCollaborators)
    .set({ acceptedAt: new Date(), inviteTokenHash: null })
    .where(eq(repoCollaborators.id, invite.id));

  return c.redirect(`/${invite.ownerName}/${invite.repoName}`);
});

export default inviteRoutes;
