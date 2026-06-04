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
 *
 * 2026 polish: the GET surface uses a scoped `.collab-*` class system that
 * mirrors `admin-ops.tsx` (section cards, hero gradient hairline, traffic-
 * light dots for invite status). RepoHeader sits above untouched; we only
 * own the content-area markup beneath it.
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
import { EmptyState } from "../views/ui";

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

// ─── Scoped CSS (.collab-*) ─────────────────────────────────────────────────
//
// Every selector is prefixed `.collab-*` so the surface can't bleed into
// the repo header / nav / page chrome above. Tokens reused from the layout
// (--bg-elevated, --border, --text-strong, --accent, --space-*, --font-*).

const collabStyles = `
  .collab-wrap { max-width: 1680px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  /* ─── Header strip (sits below RepoHeader + RepoNav) ─── */
  .collab-head { margin-bottom: var(--space-5); }
  .collab-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    font-weight: 600;
    margin-bottom: 10px;
  }
  .collab-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .collab-title {
    font-family: var(--font-display);
    font-size: clamp(24px, 3.4vw, 36px);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.1;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .collab-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .collab-sub {
    margin: 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.5;
    max-width: 700px;
  }

  /* ─── Banners ─── */
  .collab-banner {
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
  .collab-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .collab-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }
  .collab-banner-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: currentColor;
    flex-shrink: 0;
  }

  /* ─── Section cards ─── */
  .collab-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    position: relative;
  }
  .collab-section::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .collab-section-head {
    padding: var(--space-4) var(--space-5) var(--space-3);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .collab-section-head-text { flex: 1; min-width: 240px; }
  .collab-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .collab-section-title-icon {
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
  .collab-section-sub {
    margin: 6px 0 0 36px;
    font-size: 12.5px;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .collab-section-body { padding: var(--space-4) var(--space-5); }

  /* ─── Invite form ─── */
  .collab-invite {
    display: grid;
    grid-template-columns: 1.4fr 1fr auto;
    gap: 10px;
    align-items: end;
  }
  @media (max-width: 700px) {
    .collab-invite { grid-template-columns: 1fr; }
  }
  .collab-field-label {
    display: block;
    font-size: 11.5px;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 6px;
  }
  .collab-input,
  .collab-select {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    font: inherit;
    font-size: 13.5px;
    color: var(--text);
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    transition: border-color 120ms ease, background 120ms ease, box-shadow 120ms ease;
  }
  .collab-input:focus,
  .collab-select:focus {
    outline: none;
    border-color: rgba(140,109,255,0.55);
    background: rgba(255,255,255,0.05);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .collab-select { appearance: none; padding-right: 28px; background-image: linear-gradient(45deg, transparent 50%, var(--text-muted) 50%), linear-gradient(135deg, var(--text-muted) 50%, transparent 50%); background-position: right 12px top 50%, right 7px top 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }

  /* ─── Buttons ─── */
  .collab-btn {
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
    font: inherit;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
    line-height: 1;
    white-space: nowrap;
  }
  .collab-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #ffffff;
    box-shadow: 0 6px 18px -6px rgba(140,109,255,0.50), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .collab-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -8px rgba(140,109,255,0.60), inset 0 1px 0 rgba(255,255,255,0.20);
    text-decoration: none;
    color: #ffffff;
  }
  .collab-btn-ghost {
    background: transparent;
    color: var(--text);
    border-color: var(--border-strong);
  }
  .collab-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .collab-btn-danger {
    background: transparent;
    color: #fca5a5;
    border-color: rgba(248,113,113,0.35);
  }
  .collab-btn-danger:hover {
    border-style: dashed;
    border-color: rgba(248,113,113,0.70);
    background: rgba(248,113,113,0.06);
    color: #fecaca;
    text-decoration: none;
  }

  /* ─── Crumb links above title ─── */
  .collab-crumbs {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: var(--space-4);
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .collab-crumbs a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 11px;
    background: rgba(255,255,255,0.025);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-muted);
    text-decoration: none;
    font-weight: 500;
    transition: border-color 120ms ease, color 120ms ease, background 120ms ease;
  }
  .collab-crumbs a:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    text-decoration: none;
  }

  /* ─── People grid ─── */
  .collab-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
  }
  .collab-card {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 14px;
    background: rgba(255,255,255,0.018);
    border: 1px solid var(--border);
    border-radius: 12px;
    transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
  }
  .collab-card:hover {
    border-color: var(--border-strong);
    background: rgba(255,255,255,0.03);
  }
  .collab-avatar {
    width: 44px; height: 44px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.30), rgba(54,197,214,0.25));
    color: #ffffff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 17px;
    flex-shrink: 0;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.10);
  }
  .collab-avatar img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: block;
  }
  .collab-card-body { flex: 1; min-width: 0; }
  .collab-card-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .collab-card-name {
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 14.5px;
    color: var(--text-strong);
    text-decoration: none;
    letter-spacing: -0.005em;
  }
  .collab-card-name:hover { color: var(--text-strong); text-decoration: underline; }
  .collab-card-handle {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .collab-meta-row {
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .collab-meta-row .sep { opacity: 0.4; }

  /* ─── Role pills ─── */
  .collab-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: capitalize;
  }
  .collab-pill .dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; }
  .collab-pill.is-admin {
    background: rgba(140,109,255,0.16);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .collab-pill.is-write {
    background: rgba(54,197,214,0.14);
    color: #67e8f9;
    box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32);
  }
  .collab-pill.is-read {
    background: rgba(148,163,184,0.16);
    color: #cbd5e1;
    box-shadow: inset 0 0 0 1px rgba(148,163,184,0.30);
  }
  .collab-pill.is-pending {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.32);
  }
  .collab-pill.is-accepted {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }

  /* ─── Card action ─── */
  .collab-card-actions { margin-top: 12px; }
  .collab-card-actions form { margin: 0; }

  /* ─── Empty state ─── */
  .collab-empty {
    position: relative;
    overflow: hidden;
    padding: clamp(28px, 5vw, 48px) clamp(20px, 4vw, 36px);
    text-align: center;
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
  }
  .collab-empty-orb {
    position: absolute;
    inset: -40% 30% auto 30%;
    height: 280px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .collab-empty-inner { position: relative; z-index: 1; }
  .collab-empty-icon {
    width: 56px; height: 56px;
    border-radius: 9999px;
    background: linear-gradient(135deg, rgba(140,109,255,0.25), rgba(54,197,214,0.20));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.40);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #c4b5fd;
    margin-bottom: 14px;
  }
  .collab-empty-title {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 700;
    margin: 0 0 6px;
    color: var(--text-strong);
  }
  .collab-empty-sub {
    margin: 0 auto 0;
    font-size: 13.5px;
    color: var(--text-muted);
    max-width: 420px;
    line-height: 1.5;
  }
`;

function IconUsers() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconArrowLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}
function IconArrowRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

type CollabRole = "read" | "write" | "admin";

function rolePillClass(role: string): string {
  if (role === "admin") return "collab-pill is-admin";
  if (role === "write") return "collab-pill is-write";
  return "collab-pill is-read";
}

function roleLabel(role: string): string {
  if (role === "admin") return "Admin";
  if (role === "write") return "Write";
  return "Read";
}

/** ISO-style short date with tabular-nums-friendly format. */
function shortDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toISOString().slice(0, 10);
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
        <div class="collab-wrap">
          <div class="collab-crumbs">
            <a href={`/${ownerName}/${repoName}/settings`}>
              <IconArrowLeft />
              Back to settings
            </a>
            <a href={`/${ownerName}/${repoName}/settings/collaborators/teams`}>
              Invite a team
              <IconArrowRight />
            </a>
          </div>

          <header class="collab-head">
            <div class="collab-eyebrow">
              <span class="collab-eyebrow-dot" aria-hidden="true" />
              Repository · Collaborators
            </div>
            <h1 class="collab-title">
              <span class="collab-title-grad">People with access.</span>
            </h1>
            <p class="collab-sub">
              Owners can grant read, write, or admin scopes. Invitees confirm via
              email before they appear as active.
            </p>
          </header>

          {success && (
            <div class="collab-banner is-ok" role="status">
              <span class="collab-banner-dot" aria-hidden="true" />
              {decodeURIComponent(success)}
            </div>
          )}
          {error && (
            <div class="collab-banner is-error" role="alert">
              <span class="collab-banner-dot" aria-hidden="true" />
              {decodeURIComponent(error)}
            </div>
          )}

          {/* ─── Invite section ─── */}
          <section class="collab-section">
            <header class="collab-section-head">
              <div class="collab-section-head-text">
                <h2 class="collab-section-title">
                  <span class="collab-section-title-icon" aria-hidden="true">
                    <IconPlus />
                  </span>
                  Invite a collaborator
                </h2>
                <p class="collab-section-sub">
                  Enter a Gluecron username. They'll receive an email with a
                  one-time invite link.
                </p>
              </div>
            </header>
            <div class="collab-section-body">
              <form
                method="post"
                action={`/${ownerName}/${repoName}/settings/collaborators/add`}
                class="collab-invite"
              >
                <div>
                  <label class="collab-field-label" for="collab-username">Username</label>
                  <input
                    class="collab-input"
                    name="username"
                    id="collab-username"
                    placeholder="github-username"
                    required
                  />
                </div>
                <div>
                  <label class="collab-field-label" for="collab-role">Role</label>
                  <select class="collab-select" name="role" id="collab-role">
                    <option value="read">Read — clone + pull</option>
                    <option value="write">Write — push + merge</option>
                    <option value="admin">Admin — full control</option>
                  </select>
                </div>
                <div>
                  <button type="submit" class="collab-btn collab-btn-primary">
                    <IconPlus />
                    Send invite
                  </button>
                </div>
              </form>
            </div>
          </section>

          {/* ─── People section ─── */}
          <section class="collab-section">
            <header class="collab-section-head">
              <div class="collab-section-head-text">
                <h2 class="collab-section-title">
                  <span class="collab-section-title-icon" aria-hidden="true">
                    <IconUsers />
                  </span>
                  Active &amp; pending
                  <span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);font-weight:500;font-variant-numeric:tabular-nums">
                    {" "}({rows.length})
                  </span>
                </h2>
                <p class="collab-section-sub">
                  Click a name to view their profile. Removing a collaborator
                  revokes access immediately.
                </p>
              </div>
            </header>
            <div class="collab-section-body">
              {rows.length === 0 ? (
                <div class="collab-empty">
                  <div class="collab-empty-orb" aria-hidden="true" />
                  <div class="collab-empty-inner">
                    <div class="collab-empty-icon" aria-hidden="true">
                      <IconUsers />
                    </div>
                    <h3 class="collab-empty-title">Invite your first collaborator</h3>
                    <p class="collab-empty-sub">
                      Add a teammate above to grant them clone, push, or admin
                      access to this repository.
                    </p>
                  </div>
                </div>
              ) : (
                <div class="collab-grid">
                  {rows.map((row) => {
                    const accepted = !!row.acceptedAt;
                    return (
                      <div class="collab-card">
                        <div class="collab-avatar" aria-hidden="true">
                          {row.avatarUrl ? (
                            <img src={row.avatarUrl} alt="" loading="lazy" />
                          ) : (
                            row.username[0]?.toUpperCase() ?? "?"
                          )}
                        </div>
                        <div class="collab-card-body">
                          <div class="collab-card-row">
                            <a href={`/${row.username}`} class="collab-card-name">
                              {row.username}
                            </a>
                            <span class={rolePillClass(row.role)}>
                              <span class="dot" aria-hidden="true" />
                              {roleLabel(row.role)}
                            </span>
                          </div>
                          <div class="collab-card-handle">@{row.username}</div>
                          <div class="collab-meta-row">
                            <span class={accepted ? "collab-pill is-accepted" : "collab-pill is-pending"}>
                              <span class="dot" aria-hidden="true" />
                              {accepted ? "Accepted" : "Pending"}
                            </span>
                            <span class="sep">·</span>
                            <span>Invited {shortDate(row.invitedAt)}</span>
                            {accepted && row.acceptedAt && (
                              <>
                                <span class="sep">·</span>
                                <span>Joined {shortDate(row.acceptedAt)}</span>
                              </>
                            )}
                          </div>
                          <div class="collab-card-actions">
                            <form
                              method="post"
                              action={`/${ownerName}/${repoName}/settings/collaborators/${row.id}/remove`}
                              onsubmit="return confirm('Remove this collaborator?')"
                            >
                              <button type="submit" class="collab-btn collab-btn-danger">
                                Remove access
                              </button>
                            </form>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: collabStyles }} />
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
    const role: CollabRole =
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
