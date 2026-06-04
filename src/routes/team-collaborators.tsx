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
 *
 * 2026 polish: gradient-hairline hero + orb, scoped `.tc-*` classes,
 * polished form card with focus rings + gradient submit, polished
 * collaborator list cards, orbital empty state.
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
  EmptyState,
} from "../views/ui";

const teamCollaboratorRoutes = new Hono<AuthEnv>();

teamCollaboratorRoutes.use("*", softAuth);

// ─── Scoped CSS — all classes prefixed `.tc-*` ─────────────────────────────
const tcStyles = `
  .tc-wrap { max-width: 1040px; margin: 0 auto; padding: var(--space-5, 24px) var(--space-4, 24px); }

  /* ─── Back link ─── */
  .tc-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
    text-decoration: none;
    margin-bottom: var(--space-3);
    transition: color 140ms ease;
  }
  .tc-back:hover { color: var(--text-strong); }

  /* ─── Hero ─── */
  .tc-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(24px, 3.5vw, 36px) clamp(20px, 3vw, 32px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .tc-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .tc-hero-orb {
    position: absolute;
    inset: -25% -10% auto auto;
    width: 360px; height: 360px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.09) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    animation: tcHeroOrb 14s ease-in-out infinite;
    z-index: 0;
  }
  @keyframes tcHeroOrb {
    0%, 100% { transform: scale(1) translate(0, 0); opacity: 0.55; }
    50%      { transform: scale(1.08) translate(-10px, 8px); opacity: 0.8; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tc-hero-orb { animation: none; }
  }
  .tc-hero-inner { position: relative; z-index: 1; max-width: 640px; }
  .tc-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .tc-eyebrow strong { color: var(--accent); font-weight: 700; }
  .tc-title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.6vw, 36px);
    font-weight: 800;
    letter-spacing: -0.026em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .tc-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .tc-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
    max-width: 560px;
  }

  /* ─── Banners ─── */
  .tc-banner {
    position: relative;
    padding: 12px 16px 12px 40px;
    margin-bottom: var(--space-4);
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 14px;
    line-height: 1.5;
  }
  .tc-banner::before {
    content: '';
    position: absolute;
    left: 14px; top: 16px;
    width: 12px; height: 12px;
    border-radius: 50%;
  }
  .tc-banner-success {
    border-color: rgba(63, 185, 80, 0.32);
    background: linear-gradient(180deg, rgba(63,185,80,0.06) 0%, var(--bg-elevated) 100%);
  }
  .tc-banner-success::before {
    background: radial-gradient(circle, #3fb950 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(63,185,80,0.5);
  }
  .tc-banner-error {
    border-color: rgba(248, 81, 73, 0.32);
    background: linear-gradient(180deg, rgba(248,81,73,0.06) 0%, var(--bg-elevated) 100%);
  }
  .tc-banner-error::before {
    background: radial-gradient(circle, #f85149 30%, transparent 70%);
    box-shadow: 0 0 10px rgba(248,81,73,0.5);
  }

  /* ─── Form card ─── */
  .tc-card {
    position: relative;
    margin-bottom: var(--space-5);
    padding: clamp(20px, 3vw, 28px);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .tc-card-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .tc-card-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px; height: 26px;
    border-radius: 50%;
    background: linear-gradient(135deg, rgba(140,109,255,0.20), rgba(54,197,214,0.14));
    color: #c5b3ff;
    border: 1px solid rgba(140,109,255,0.40);
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 12.5px;
  }
  .tc-card-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    margin: 0;
  }
  .tc-card-sub {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 var(--space-3);
    line-height: 1.5;
  }
  .tc-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--space-3); }
  .tc-field-label {
    font-size: 13px;
    color: var(--text-strong);
    font-weight: 600;
  }
  .tc-field-input,
  .tc-field-select {
    appearance: none;
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text-strong);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 140ms ease, box-shadow 140ms ease;
  }
  .tc-field-select {
    background-image: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
                      linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
    background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    padding-right: 32px;
  }
  .tc-field-input:focus,
  .tc-field-select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .tc-submit {
    appearance: none;
    border: 1px solid rgba(140,109,255,0.45);
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    padding: 11px 22px;
    border-radius: 10px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    box-shadow: 0 8px 20px -8px rgba(140,109,255,0.55);
    transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease;
  }
  .tc-submit:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 24px -8px rgba(140,109,255,0.7);
    filter: brightness(1.06);
  }
  .tc-submit:focus-visible {
    outline: 3px solid rgba(140,109,255,0.45);
    outline-offset: 2px;
  }

  /* ─── Empty card (no orgs) ─── */
  .tc-empty-orgs {
    position: relative;
    padding: var(--space-4);
    border: 1px dashed var(--border);
    border-radius: 12px;
    background: var(--bg-secondary);
    text-align: center;
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
  }
  .tc-empty-orgs a { color: var(--accent); text-decoration: none; }
  .tc-empty-orgs a:hover { text-decoration: underline; }

  /* ─── Collaborator list ─── */
  .tc-list-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: var(--space-5) 0 var(--space-3);
  }
  .tc-list-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.014em;
    color: var(--text-strong);
    margin: 0;
  }
  .tc-list-count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .tc-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tc-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 140ms ease, transform 140ms ease;
  }
  .tc-row:hover {
    border-color: rgba(140,109,255,0.35);
    transform: translateY(-1px);
  }
  .tc-avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--bg-secondary);
    flex-shrink: 0;
  }
  .tc-avatar-fallback {
    width: 32px; height: 32px;
    border-radius: 50%;
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 13px;
    flex-shrink: 0;
  }
  .tc-row-body { flex: 1; min-width: 0; }
  .tc-row-name {
    font-size: 14px;
    color: var(--text-strong);
    font-weight: 600;
    text-decoration: none;
  }
  .tc-row-name:hover { color: var(--accent); }
  .tc-row-meta {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .tc-row-role {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(140,109,255,0.10);
    border: 1px solid rgba(140,109,255,0.30);
    color: #c5b3ff;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tc-row-pill-ok {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(63,185,80,0.10);
    border: 1px solid rgba(63,185,80,0.35);
    color: #4ec55d;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .tc-row-pill-warn {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(251,191,36,0.10);
    border: 1px solid rgba(251,191,36,0.35);
    color: #fbbf24;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* ─── Empty state for no collaborators ─── */
  .tc-empty {
    position: relative;
    padding: 36px 24px;
    text-align: center;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .tc-empty-orb {
    position: absolute;
    inset: -50% 25% auto 25%;
    width: 50%; height: 200px;
    background: radial-gradient(circle, rgba(140,109,255,0.16), transparent 65%);
    filter: blur(50px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .tc-empty-inner { position: relative; z-index: 1; }
  .tc-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    margin: 0 0 6px;
  }
  .tc-empty-desc {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0;
  }
`;

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
        <style dangerouslySetInnerHTML={{ __html: tcStyles }} />
        <div class="tc-wrap">
          <a
            href={`/${ownerName}/${repoName}/settings/collaborators`}
            class="tc-back"
          >
            &larr; Back to collaborators
          </a>

          {/* ─── Hero ─── */}
          <div class="tc-hero">
            <div class="tc-hero-orb" aria-hidden="true" />
            <div class="tc-hero-inner">
              <div class="tc-eyebrow">
                <strong>Teams</strong> · bulk invite
              </div>
              <h1 class="tc-title">
                Invite a whole{" "}
                <span class="tc-title-grad">team</span> at once.
              </h1>
              <p class="tc-sub">
                Pick an org and a team, choose a role, and every member of
                that team is added to{" "}
                <strong>{ownerName}/{repoName}</strong> in one shot. No
                individual invite emails to chase.
              </p>
            </div>
          </div>

          {success && (
            <div class="tc-banner tc-banner-success" role="status">
              {decodeURIComponent(success)}
            </div>
          )}
          {error && (
            <div class="tc-banner tc-banner-error" role="alert">
              {decodeURIComponent(error)}
            </div>
          )}

          {/* ─── Form card ─── */}
          <div class="tc-card">
            <div class="tc-card-head">
              <span class="tc-card-badge" aria-hidden="true">1</span>
              <h2 class="tc-card-title">Invite every member of a team</h2>
            </div>
            <p class="tc-card-sub">
              Each member is added with the role you pick. Existing
              collaborators are updated; the repo owner is always skipped.
            </p>
            {userOrgs.length === 0 ? (
              <div class="tc-empty-orgs">
                You don't belong to any organizations yet.{" "}
                <a href="/orgs/new">Create one</a> to start inviting teams.
              </div>
            ) : (
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/collaborators/teams/add`}
              >
                <div class="tc-field">
                  <label class="tc-field-label" for="orgSlug">Organization</label>
                  <select
                    name="orgSlug"
                    id="orgSlug"
                    class="tc-field-select"
                  >
                    {userOrgs.map((o) => (
                      <option value={o.slug}>
                        {o.name} ({o.slug})
                      </option>
                    ))}
                  </select>
                </div>
                <div class="tc-field">
                  <label class="tc-field-label" for="teamSlug">Team slug</label>
                  <input
                    name="teamSlug"
                    id="teamSlug"
                    placeholder="engineering"
                    required
                    class="tc-field-input"
                  />
                </div>
                <div class="tc-field">
                  <label class="tc-field-label" for="role">Role</label>
                  <select
                    name="role"
                    id="role"
                    class="tc-field-select"
                  >
                    <option value="read">Read — clone + pull</option>
                    <option value="write">Write — push + merge</option>
                    <option value="admin">Admin — full control</option>
                  </select>
                </div>
                <button type="submit" class="tc-submit">
                  Invite team
                </button>
              </form>
            )}
          </div>

          {/* ─── Current collaborators ─── */}
          <div class="tc-list-head">
            <h2 class="tc-list-title">Current collaborators</h2>
            <span class="tc-list-count">{rows.length} total</span>
          </div>
          {rows.length === 0 ? (
            <div class="tc-empty">
              <div class="tc-empty-orb" aria-hidden="true" />
              <div class="tc-empty-inner">
                <h3 class="tc-empty-title">No collaborators yet</h3>
                <p class="tc-empty-desc">
                  Invite a team above to add multiple people at once,
                  or invite a single user from the collaborators page.
                </p>
              </div>
            </div>
          ) : (
            <div class="tc-list">
              {rows.map((row) => (
                <div class="tc-row">
                  {row.avatarUrl ? (
                    <img
                      class="tc-avatar"
                      src={row.avatarUrl}
                      alt=""
                      width={32}
                      height={32}
                    />
                  ) : (
                    <span class="tc-avatar-fallback" aria-hidden="true">
                      {row.username.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div class="tc-row-body">
                    <a href={`/${row.username}`} class="tc-row-name">
                      {row.username}
                    </a>
                    <div class="tc-row-meta">
                      <span class="tc-row-role">{row.role}</span>
                      {row.acceptedAt ? (
                        <span class="tc-row-pill-ok">Accepted</span>
                      ) : (
                        <span class="tc-row-pill-warn">Pending</span>
                      )}
                      <span>
                        Invited {new Date(row.invitedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
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
