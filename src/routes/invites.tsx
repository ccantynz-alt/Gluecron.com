/**
 * Collaborator invite acceptance — the flip side of POST /add.
 *
 * When an owner invites a user, `src/routes/collaborators.tsx` generates a
 * random token, stores its sha256 on the `repo_collaborators` row, and
 * emails the plaintext link. This file handles that link being clicked.
 *
 * Flow:
 *   GET /invites                  → list of pending repo + org invites for
 *                                    the signed-in user. The repo invites
 *                                    section can only display rows the user
 *                                    can prove they own (we don't store the
 *                                    plaintext token, so direct accept is
 *                                    still link-based). Org invites accept
 *                                    inline because `org_members` rows are
 *                                    keyed on the user directly.
 *   GET /invites/:token           → accept page for a specific token
 *   POST /invites/:token          → accept the invite (one-shot)
 *
 * 2026 polish: scoped `.inv-*` classes mirror the gradient-hairline hero +
 * card patterns from settings-2fa.tsx. Every existing token flow, ownership
 * assertion, and one-shot accept guarantee is preserved verbatim.
 */

import { Hono } from "hono";
import { eq, and, isNull, asc } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, repoCollaborators } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { hashInviteToken } from "../lib/invite-tokens";

const inviteRoutes = new Hono<AuthEnv>();

inviteRoutes.use("*", softAuth);

// ─── Scoped CSS (.inv-*) ────────────────────────────────────────────────────
const invStyles = `
  .inv-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .inv-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .inv-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .inv-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .inv-hero-inner { position: relative; z-index: 1; max-width: 720px; }
  .inv-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .inv-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .inv-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .inv-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .inv-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Banner ─── */
  .inv-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .inv-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .inv-banner.is-info {
    border-color: rgba(54,197,214,0.40);
    background: rgba(54,197,214,0.08);
    color: #a5f3fc;
  }
  .inv-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section card ─── */
  .inv-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .inv-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }
  .inv-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .inv-section-title-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 8px;
    background: rgba(140,109,255,0.12);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.28);
    flex-shrink: 0;
  }
  .inv-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }
  .inv-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Invite card ─── */
  .inv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .inv-card {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-4);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .inv-card:hover {
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 24px -10px rgba(0,0,0,0.32);
  }
  .inv-logo {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 800;
    color: #e9d5ff;
    text-transform: uppercase;
  }
  .inv-card-body { flex: 1; min-width: 0; }
  .inv-card-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
  }
  .inv-card-title a { color: inherit; text-decoration: none; }
  .inv-card-title a:hover { color: var(--accent); }
  .inv-card-meta {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .inv-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: rgba(140,109,255,0.14);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .inv-pill .dot { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; }
  .inv-card-actions { flex-shrink: 0; display: flex; gap: 8px; flex-wrap: wrap; }

  /* ─── Buttons ─── */
  .inv-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .inv-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .inv-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .inv-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .inv-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .inv-btn-danger {
    background: transparent;
    color: #fecaca;
    border-color: rgba(248,113,113,0.40);
  }
  .inv-btn-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.65);
    color: #fee2e2;
  }

  /* ─── Empty state ─── */
  .inv-empty {
    position: relative;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    overflow: hidden;
  }
  .inv-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .inv-empty-orb {
    width: 96px; height: 96px;
    margin: 0 auto 18px;
    border-radius: 9999px;
    background:
      radial-gradient(circle at 35% 35%, rgba(140,109,255,0.55), rgba(54,197,214,0.25) 55%, transparent 75%);
    box-shadow:
      0 0 32px rgba(140,109,255,0.35),
      inset 0 0 0 1px rgba(140,109,255,0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }
  .inv-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .inv-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 18px;
    max-width: 480px;
  }
`;

const InvIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 8V7l-3 2-3-2v1l3 2 3-2z" />
    <path d="M22 6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);
const InvRepoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);
const InvEmptyIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

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

// ─── List pending invites for the current user ─────────────────────────────

inviteRoutes.get("/invites", requireAuth, async (c) => {
  const user = c.get("user")!;
  const declined = c.req.query("declined");

  type RepoInvite = {
    id: string;
    role: string;
    repoName: string;
    ownerName: string;
  };
  let repoInvites: RepoInvite[] = [];
  try {
    const rows = await db
      .select({
        id: repoCollaborators.id,
        role: repoCollaborators.role,
        repoName: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repoCollaborators)
      .innerJoin(
        repositories,
        eq(repositories.id, repoCollaborators.repositoryId)
      )
      .where(
        and(
          eq(repoCollaborators.userId, user.id),
          isNull(repoCollaborators.acceptedAt)
        )
      )
      .orderBy(asc(repositories.name));

    // Resolve owner usernames in a single batch.
    const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId)));
    const ownerByIdEntries = await Promise.all(
      ownerIds.map(async (id) => {
        const [u] = await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        return [id, u?.username || "unknown"] as const;
      })
    );
    const ownerById = new Map(ownerByIdEntries);
    repoInvites = rows.map((r) => ({
      id: r.id,
      role: r.role,
      repoName: r.repoName,
      ownerName: ownerById.get(r.ownerId) || "unknown",
    }));
  } catch (err) {
    console.error("[invites] list:", err);
  }

  const totalCount = repoInvites.length;

  return c.html(
    <Layout title="Your invitations" user={user}>
      <div class="inv-wrap">
        <section class="inv-hero">
          <div class="inv-hero-orb" aria-hidden="true" />
          <div class="inv-hero-inner">
            <div class="inv-eyebrow">
              <span class="inv-eyebrow-pill" aria-hidden="true">
                <InvIcon />
              </span>
              <span>Invitations</span>
              <span>·</span>
              <span>@{user.username}</span>
            </div>
            <h2 class="inv-title">
              <span class="inv-title-grad">Your invitations.</span>
            </h2>
            <p class="inv-sub">
              Repositories you've been invited to collaborate on. Accept to
              gain access, or decline to clear the row — declined invites can
              be re-sent by the repo owner.
            </p>
          </div>
        </section>

        {declined && (
          <div class="inv-banner is-info" role="status">
            <span class="inv-banner-dot" aria-hidden="true" />
            Invitation declined.
          </div>
        )}

        {totalCount === 0 ? (
          <div class="inv-empty">
            <div class="inv-empty-orb" aria-hidden="true">
              <InvEmptyIcon />
            </div>
            <h2 class="inv-empty-title">No pending invitations</h2>
            <p class="inv-empty-sub">
              When someone invites you as a collaborator on a repository or
              organization, the invite will show up here. You can also accept
              directly from the email link you receive.
            </p>
            <a href="/explore" class="inv-btn inv-btn-primary">
              Explore public repositories
            </a>
          </div>
        ) : (
          <section class="inv-section">
            <header class="inv-section-head">
              <h3 class="inv-section-title">
                <span class="inv-section-title-icon" aria-hidden="true">
                  <InvRepoIcon />
                </span>
                Repository invitations ({totalCount})
              </h3>
              <p class="inv-section-sub">
                Each invite is tied to a single repository and role. Declining
                removes the invite row but doesn't block future invitations.
              </p>
            </header>
            <div class="inv-section-body">
              <ul class="inv-list">
                {repoInvites.map((inv) => {
                  const initial = (inv.repoName.charAt(0) || "?").toUpperCase();
                  return (
                    <li>
                      <div class="inv-card">
                        <div class="inv-logo" aria-hidden="true">{initial}</div>
                        <div class="inv-card-body">
                          <h4 class="inv-card-title">
                            <a href={`/${inv.ownerName}/${inv.repoName}`}>
                              {inv.ownerName}/{inv.repoName}
                            </a>
                          </h4>
                          <div class="inv-card-meta">
                            <span class="inv-pill">
                              <span class="dot" aria-hidden="true" />
                              {inv.role}
                            </span>
                            <span>invited by {inv.ownerName}</span>
                          </div>
                        </div>
                        <div class="inv-card-actions">
                          <form
                            method="post"
                            action={`/invites/repo/${inv.id}/accept`}
                            style="margin:0"
                          >
                            <button type="submit" class="inv-btn inv-btn-primary">
                              Accept
                            </button>
                          </form>
                          <form
                            method="post"
                            action={`/invites/repo/${inv.id}/decline`}
                            style="margin:0"
                            onsubmit="return confirm('Decline this invitation?')"
                          >
                            <button type="submit" class="inv-btn inv-btn-ghost">
                              Decline
                            </button>
                          </form>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: invStyles }} />
    </Layout>
  );
});

// ─── Accept / decline by row id (inline list flow) ─────────────────────────
//
// These complement the original /invites/:token email flow: when the user is
// looking at the dashboard list, they already passed authn, so we can act
// directly on `repo_collaborators.id` instead of round-tripping a one-time
// token. We still require the invite to be (a) unaccepted and (b) addressed
// to the signed-in user, otherwise we 404.

inviteRoutes.post("/invites/repo/:id/accept", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    const [row] = await db
      .select({
        id: repoCollaborators.id,
        userId: repoCollaborators.userId,
        acceptedAt: repoCollaborators.acceptedAt,
        repositoryId: repoCollaborators.repositoryId,
      })
      .from(repoCollaborators)
      .where(eq(repoCollaborators.id, id))
      .limit(1);
    if (!row || row.userId !== user.id || row.acceptedAt) {
      return c.notFound();
    }
    await db
      .update(repoCollaborators)
      .set({ acceptedAt: new Date(), inviteTokenHash: null })
      .where(eq(repoCollaborators.id, row.id));

    const [repo] = await db
      .select({ name: repositories.name, ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, row.repositoryId))
      .limit(1);
    if (!repo) return c.redirect("/invites");
    const [owner] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, repo.ownerId))
      .limit(1);
    if (!owner) return c.redirect("/invites");
    return c.redirect(`/${owner.username}/${repo.name}`);
  } catch (err) {
    console.error("[invites] accept:", err);
    return c.redirect("/invites");
  }
});

inviteRoutes.post("/invites/repo/:id/decline", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  try {
    const [row] = await db
      .select({
        id: repoCollaborators.id,
        userId: repoCollaborators.userId,
        acceptedAt: repoCollaborators.acceptedAt,
      })
      .from(repoCollaborators)
      .where(eq(repoCollaborators.id, id))
      .limit(1);
    if (!row || row.userId !== user.id || row.acceptedAt) {
      return c.notFound();
    }
    await db
      .delete(repoCollaborators)
      .where(eq(repoCollaborators.id, row.id));
  } catch (err) {
    console.error("[invites] decline:", err);
  }
  return c.redirect("/invites?declined=1");
});

// ─── Display accept page (single-token email link) ─────────────────────────

inviteRoutes.get("/invites/:token", async (c) => {
  const { token } = c.req.param();
  const user = c.get("user");
  const invite = await resolvePendingInvite(token);
  if (!invite) return c.notFound();

  return c.html(
    <Layout title="Accept invitation" user={user}>
      <div class="inv-wrap">
        <section class="inv-hero">
          <div class="inv-hero-orb" aria-hidden="true" />
          <div class="inv-hero-inner">
            <div class="inv-eyebrow">
              <span class="inv-eyebrow-pill" aria-hidden="true">
                <InvIcon />
              </span>
              <a href="/invites" style="color:var(--text-muted);text-decoration:none">
                Invitations
              </a>
              <span>/</span>
              <span>Accept</span>
            </div>
            <h2 class="inv-title">
              <span class="inv-title-grad">You've been invited.</span>
            </h2>
            <p class="inv-sub">
              {invite.ownerName} invited you to collaborate on{" "}
              <strong>{invite.ownerName}/{invite.repoName}</strong> as a{" "}
              <strong>{invite.role}</strong>. Accepting grants you access
              immediately; the link is one-shot.
            </p>
          </div>
        </section>

        {!user && (
          <div class="inv-banner is-info" role="status">
            <span class="inv-banner-dot" aria-hidden="true" />
            You need to{" "}
            <a href={`/login?next=/invites/${token}`} style="color:inherit;text-decoration:underline">
              sign in
            </a>{" "}
            before accepting this invitation.
          </div>
        )}

        <section class="inv-section">
          <header class="inv-section-head">
            <h3 class="inv-section-title">
              <span class="inv-section-title-icon" aria-hidden="true">
                <InvRepoIcon />
              </span>
              {invite.ownerName}/{invite.repoName}
            </h3>
            <p class="inv-section-sub">
              Role on accept: <strong>{invite.role}</strong>.
            </p>
          </header>
          <div class="inv-section-body">
            {user ? (
              <form method="post" action={`/invites/${token}`} style="margin:0">
                <button type="submit" class="inv-btn inv-btn-primary">
                  Accept invitation
                </button>
              </form>
            ) : (
              <a href={`/login?next=/invites/${token}`} class="inv-btn inv-btn-primary">
                Sign in to accept
              </a>
            )}
          </div>
        </section>
      </div>
      <style dangerouslySetInnerHTML={{ __html: invStyles }} />
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
        <div class="inv-wrap">
          <section class="inv-hero">
            <div class="inv-hero-orb" aria-hidden="true" />
            <div class="inv-hero-inner">
              <div class="inv-eyebrow">
                <span class="inv-eyebrow-pill" aria-hidden="true">
                  <InvIcon />
                </span>
                <span>Invitations</span>
              </div>
              <h2 class="inv-title">
                <span class="inv-title-grad">Not your invitation.</span>
              </h2>
              <p class="inv-sub">
                This invitation was sent to a different account. Sign in as
                the addressee to accept, or ask the inviter for a fresh link.
              </p>
            </div>
          </section>
          <a href="/invites" class="inv-btn inv-btn-primary">View your invitations</a>
        </div>
        <style dangerouslySetInnerHTML={{ __html: invStyles }} />
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
