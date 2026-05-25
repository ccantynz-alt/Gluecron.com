/**
 * Organization and team routes — create orgs, manage members, teams, permissions.
 *
 * 2026 polish: `/orgs` list + `/orgs/:org` detail wrapped in scoped `.orgs-*`
 * classes (gradient hairline hero, avatar + member-count cards, empty state
 * with orb). Other admin/team subroutes keep their existing UI shells. Every
 * POST handler, validation rule, and ownership check is preserved verbatim.
 */

import { Hono } from "hono";
import { eq, and, asc, sql } from "drizzle-orm";
import { db } from "../db";
import { organizations, orgMembers, teams, teamMembers, teamRepos } from "../db/schema-extensions";
import { users, repositories } from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { loadOrgForUser, listOrgMembers, orgRoleAtLeast } from "../lib/orgs";
import {
  Container,
  EmptyState,
  Grid,
  Text,
  Badge,
  Section,
  List,
  ListItem,
} from "../views/ui";

const orgRoutes = new Hono<AuthEnv>();

// ─── Scoped CSS (.orgs-*) ───────────────────────────────────────────────────
// Every selector prefixed `.orgs-*` so the surface can't bleed into the
// repo header / nav / page chrome. Mirrors the gradient-hairline hero +
// card patterns from settings-2fa.tsx + admin-integrations.tsx.
const orgsStyles = `
  .orgs-wrap { max-width: 1000px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  .orgs-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .orgs-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .orgs-hero-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .orgs-hero-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .orgs-hero-text { flex: 1; min-width: 280px; max-width: 660px; }
  .orgs-eyebrow {
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
  .orgs-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .orgs-crumb { color: var(--text-muted); text-decoration: none; }
  .orgs-crumb:hover { color: var(--text); }
  .orgs-title {
    font-size: clamp(28px, 4vw, 40px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .orgs-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .orgs-sub {
    font-size: 15px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }

  /* ─── Buttons ─── */
  .orgs-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 18px;
    border-radius: 10px;
    font-size: 13.5px;
    font-weight: 600;
    text-decoration: none;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .orgs-btn-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    box-shadow: 0 6px 18px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.16);
  }
  .orgs-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -6px rgba(140,109,255,0.55), inset 0 1px 0 rgba(255,255,255,0.20);
    color: #fff;
    text-decoration: none;
  }
  .orgs-btn-ghost {
    background: rgba(255,255,255,0.025);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .orgs-btn-ghost:hover {
    background: rgba(140,109,255,0.06);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }

  /* ─── Org grid ─── */
  .orgs-grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--space-3);
  }
  .orgs-card {
    display: flex;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    text-decoration: none;
    color: inherit;
    transition: transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
  }
  .orgs-card:hover {
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 24px -10px rgba(0,0,0,0.32);
    transform: translateY(-1px);
    color: inherit;
    text-decoration: none;
  }
  .orgs-avatar {
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 800;
    color: #e9d5ff;
    text-transform: uppercase;
  }
  .orgs-card-body { flex: 1; min-width: 0; }
  .orgs-card-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
  }
  .orgs-card-handle {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .orgs-card-meta {
    margin-top: 10px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .orgs-pill {
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
  .orgs-pill.is-role { background: rgba(54,197,214,0.14); color: #67e8f9; box-shadow: inset 0 0 0 1px rgba(54,197,214,0.32); }
  .orgs-pill .dot { width: 5px; height: 5px; border-radius: 9999px; background: currentColor; }
  .orgs-stat {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  /* ─── Detail hero ─── */
  .orgs-detail {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }
  .orgs-detail::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .orgs-detail-orb {
    position: absolute;
    inset: -20% -10% auto auto;
    width: 380px; height: 380px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(80px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .orgs-detail-inner {
    position: relative;
    z-index: 1;
    display: flex;
    gap: var(--space-4);
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .orgs-avatar-lg {
    flex-shrink: 0;
    width: 86px;
    height: 86px;
    border-radius: 18px;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 36px;
    font-weight: 800;
    color: #e9d5ff;
    text-transform: uppercase;
  }
  .orgs-detail-text { flex: 1; min-width: 220px; }
  .orgs-detail-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(22px, 3vw, 30px);
    font-weight: 800;
    letter-spacing: -0.022em;
    color: var(--text-strong);
  }
  .orgs-detail-handle {
    margin: 4px 0 0;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-muted);
  }
  .orgs-detail-desc {
    margin: 12px 0 0;
    font-size: 14px;
    color: var(--text-muted);
    line-height: 1.55;
    max-width: 620px;
  }
  .orgs-detail-meta {
    margin-top: 12px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .orgs-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; align-self: center; }

  /* ─── Section card ─── */
  .orgs-section {
    margin-bottom: var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .orgs-section-head {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .orgs-section-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.012em;
    color: var(--text-strong);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .orgs-section-icon {
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
  .orgs-section-body { padding: var(--space-4) var(--space-5); }

  .orgs-row-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .orgs-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
  }
  .orgs-row-avatar {
    flex-shrink: 0;
    width: 30px; height: 30px;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(140,109,255,0.22), rgba(54,197,214,0.16));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-size: 13px;
    font-weight: 800;
    color: #e9d5ff;
    text-transform: uppercase;
  }
  .orgs-row-name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    color: var(--text);
    text-decoration: none;
  }
  .orgs-row-name:hover { color: var(--accent); }
  .orgs-row-meta { color: var(--text-muted); font-size: 12px; }

  /* ─── Empty state ─── */
  .orgs-empty {
    position: relative;
    padding: 56px 32px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    text-align: center;
    overflow: hidden;
  }
  .orgs-empty::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.55;
    pointer-events: none;
  }
  .orgs-empty-orb {
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
  .orgs-empty-title {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
    margin: 0 0 8px;
  }
  .orgs-empty-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    line-height: 1.55;
    margin: 0 auto 18px;
    max-width: 460px;
  }

  .orgs-grid-2 {
    display: grid;
    grid-template-columns: 1fr 300px;
    gap: var(--space-4);
  }
  @media (max-width: 800px) {
    .orgs-grid-2 { grid-template-columns: 1fr; }
  }
`;

const OrgsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 21h18" />
    <path d="M5 21V7l8-4v18" />
    <path d="M19 21V11l-6-4" />
    <line x1="9" y1="9" x2="9" y2="9.01" />
    <line x1="9" y1="12" x2="9" y2="12.01" />
    <line x1="9" y1="15" x2="9" y2="15.01" />
    <line x1="9" y1="18" x2="9" y2="18.01" />
  </svg>
);
const OrgsTeamIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const OrgsEmptyIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 21h18" />
    <path d="M5 21V7l8-4v18" />
    <path d="M19 21V11l-6-4" />
  </svg>
);

// ─── Organization List (index) ──────────────────────────────────────────────
// GET /orgs — auth-required directory of the viewer's organizations.
orgRoutes.get("/orgs", softAuth, requireAuth, async (c) => {
  const user = c.get("user")!;
  type OrgRow = {
    org: typeof organizations.$inferSelect;
    role: string;
    memberCount: number;
    repoCount: number;
  };
  let rows: OrgRow[] = [];
  try {
    const base = await db
      .select({ org: organizations, role: orgMembers.role })
      .from(orgMembers)
      .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
      .where(eq(orgMembers.userId, user.id))
      .orderBy(asc(organizations.name));
    rows = await Promise.all(
      base.map(async (r) => {
        let memberCount = 0;
        let repoCount = 0;
        try {
          const [m] = await db
            .select({ count: sql<number>`count(*)` })
            .from(orgMembers)
            .where(eq(orgMembers.orgId, r.org.id));
          memberCount = Number(m?.count ?? 0);
        } catch { /* ignore */ }
        try {
          // Org-owned repos are scoped by username convention (organizations.name).
          // The repositories table keys ownership via users.id, so we look up the
          // synthetic owner-user row whose username matches the org name.
          const [u] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.username, r.org.name))
            .limit(1);
          if (u) {
            const [rc] = await db
              .select({ count: sql<number>`count(*)` })
              .from(repositories)
              .where(eq(repositories.ownerId, u.id));
            repoCount = Number(rc?.count ?? 0);
          }
        } catch { /* ignore */ }
        return { org: r.org, role: r.role, memberCount, repoCount };
      })
    );
  } catch {
    rows = [];
  }

  return c.html(
    <Layout title="Your organizations" user={user}>
      <div class="orgs-wrap">
        <section class="orgs-hero">
          <div class="orgs-hero-orb" aria-hidden="true" />
          <div class="orgs-hero-inner">
            <div class="orgs-hero-text">
              <div class="orgs-eyebrow">
                <span class="orgs-eyebrow-pill" aria-hidden="true">
                  <OrgsIcon />
                </span>
                <span>Organizations</span>
                <span>·</span>
                <span>@{user.username}</span>
              </div>
              <h2 class="orgs-title">
                <span class="orgs-title-grad">Your organizations.</span>
              </h2>
              <p class="orgs-sub">
                Multi-user namespaces for sharing repos and managing teams.
                Create one to invite teammates with role-based access.
              </p>
            </div>
            <a href="/orgs/new" class="orgs-btn orgs-btn-primary">
              + New organization
            </a>
          </div>
        </section>

        {rows.length === 0 ? (
          <div class="orgs-empty">
            <div class="orgs-empty-orb" aria-hidden="true">
              <OrgsEmptyIcon />
            </div>
            <h2 class="orgs-empty-title">No organizations yet</h2>
            <p class="orgs-empty-sub">
              Organizations let you collaborate with teammates under a shared
              namespace, with role-based access and team-scoped repos.
            </p>
            <a href="/orgs/new" class="orgs-btn orgs-btn-primary">
              Create your first organization
            </a>
          </div>
        ) : (
          <ul class="orgs-grid">
            {rows.map((r) => {
              const displayName =
                (r.org as any).displayName || (r.org as any).name || "?";
              const slug = (r.org as any).slug || (r.org as any).name || "";
              const initial = (displayName.charAt(0) || "?").toUpperCase();
              return (
                <li>
                  <a href={`/orgs/${slug}`} class="orgs-card">
                    <div class="orgs-avatar" aria-hidden="true">{initial}</div>
                    <div class="orgs-card-body">
                      <h3 class="orgs-card-name">{displayName}</h3>
                      <p class="orgs-card-handle">@{slug}</p>
                      <div class="orgs-card-meta">
                        <span class="orgs-pill is-role">
                          <span class="dot" aria-hidden="true" />
                          {r.role}
                        </span>
                        <span class="orgs-stat">
                          {r.memberCount} {r.memberCount === 1 ? "member" : "members"}
                        </span>
                        <span class="orgs-stat">·</span>
                        <span class="orgs-stat">
                          {r.repoCount} {r.repoCount === 1 ? "repo" : "repos"}
                        </span>
                      </div>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: orgsStyles }} />
    </Layout>
  );
});

// ─── Org-scoped repos stubs — require auth, delegate to existing flows ──────
orgRoutes.get("/orgs/:org/repos", softAuth, requireAuth, async (c) => {
  return c.redirect(`/orgs/${c.req.param("org")}`);
});
orgRoutes.get("/orgs/:org/repos/new", softAuth, requireAuth, (c) => {
  const org = c.req.param("org");
  return c.redirect(`/new?org=${encodeURIComponent(org)}`);
});
orgRoutes.post("/orgs/:org/repos/new", softAuth, requireAuth, (c) => {
  const org = c.req.param("org");
  return c.redirect(`/new?org=${encodeURIComponent(org)}`);
});

// ─── Org people mutation stub — require auth ────────────────────────────────
orgRoutes.post("/orgs/:org/people/add", softAuth, requireAuth, (c) => {
  return c.redirect(`/orgs/${c.req.param("org")}/people`);
});

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

orgRoutes.get("/orgs/:org", softAuth, requireAuth, async (c) => {
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

  const initial = ((org.displayName || org.name || "?").charAt(0) || "?").toUpperCase();
  return (
    c.html(
      <Layout title={org.displayName || org.name} user={user}>
        <div class="orgs-wrap">
          <section class="orgs-detail">
            <div class="orgs-detail-orb" aria-hidden="true" />
            <div class="orgs-detail-inner">
              <div class="orgs-avatar-lg" aria-hidden="true">{initial}</div>
              <div class="orgs-detail-text">
                <h2 class="orgs-detail-name">{org.displayName || org.name}</h2>
                <p class="orgs-detail-handle">@{org.name}</p>
                {org.description && <p class="orgs-detail-desc">{org.description}</p>}
                <div class="orgs-detail-meta">
                  <span class="orgs-pill">
                    <span class="dot" aria-hidden="true" />
                    {members.length} {members.length === 1 ? "member" : "members"}
                  </span>
                  <span class="orgs-pill is-role">
                    <span class="dot" aria-hidden="true" />
                    {teamList.length} {teamList.length === 1 ? "team" : "teams"}
                  </span>
                  {org.website && (
                    <a
                      href={org.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      style="font-size:12.5px;color:var(--text-muted);text-decoration:none"
                    >
                      {org.website}
                    </a>
                  )}
                </div>
              </div>
              {isOwner && (
                <div class="orgs-detail-actions">
                  <a
                    href={`/orgs/${org.name}/members/invite`}
                    class="orgs-btn orgs-btn-ghost"
                  >
                    Invite member
                  </a>
                  <a
                    href={`/orgs/${org.name}/settings`}
                    class="orgs-btn orgs-btn-primary"
                  >
                    Settings
                  </a>
                </div>
              )}
            </div>
          </section>

          <div class="orgs-grid-2">
            <section class="orgs-section">
              <header class="orgs-section-head">
                <h3 class="orgs-section-title">
                  <span class="orgs-section-icon" aria-hidden="true">
                    <OrgsTeamIcon />
                  </span>
                  Teams ({teamList.length})
                </h3>
                {isOwner && teamList.length > 0 && (
                  <a
                    href={`/orgs/${org.name}/teams/new`}
                    class="orgs-btn orgs-btn-ghost"
                    style="padding:6px 12px;font-size:12.5px"
                  >
                    + New team
                  </a>
                )}
              </header>
              <div class="orgs-section-body">
                {teamList.length === 0 ? (
                  <div style="text-align:center;padding:24px 12px;color:var(--text-muted);font-size:13.5px;line-height:1.55">
                    No teams yet.
                    {isOwner && (
                      <div style="margin-top:12px">
                        <a
                          href={`/orgs/${org.name}/teams/new`}
                          class="orgs-btn orgs-btn-primary"
                        >
                          Create your first team
                        </a>
                      </div>
                    )}
                  </div>
                ) : (
                  <ul class="orgs-row-list">
                    {teamList.map((team: any) => (
                      <li class="orgs-row">
                        <div class="orgs-row-avatar" aria-hidden="true">
                          {(team.name.charAt(0) || "?").toUpperCase()}
                        </div>
                        <a
                          href={`/orgs/${org.name}/teams/${team.name}`}
                          class="orgs-row-name"
                          style="font-weight:600"
                        >
                          {team.name}
                          {team.description && (
                            <span class="orgs-row-meta" style="margin-left:8px">
                              — {team.description}
                            </span>
                          )}
                        </a>
                        <span class="orgs-pill is-role">
                          <span class="dot" aria-hidden="true" />
                          {team.permission}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section class="orgs-section">
              <header class="orgs-section-head">
                <h3 class="orgs-section-title">
                  <span class="orgs-section-icon" aria-hidden="true">
                    <OrgsTeamIcon />
                  </span>
                  Members ({members.length})
                </h3>
              </header>
              <div class="orgs-section-body">
                {members.length === 0 ? (
                  <div style="text-align:center;padding:18px 12px;color:var(--text-muted);font-size:13.5px">
                    No members.
                  </div>
                ) : (
                  <ul class="orgs-row-list">
                    {members.map((m: any) => {
                      const init = (
                        (m.user.displayName || m.user.username || "?").charAt(0) || "?"
                      ).toUpperCase();
                      return (
                        <li class="orgs-row">
                          <div class="orgs-row-avatar" aria-hidden="true">{init}</div>
                          <a href={`/${m.user.username}`} class="orgs-row-name">
                            {m.user.displayName || m.user.username}
                            <span class="orgs-row-meta" style="margin-left:6px">
                              @{m.user.username}
                            </span>
                          </a>
                          <span class="orgs-pill is-role">
                            <span class="dot" aria-hidden="true" />
                            {m.member.role}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>
        <style dangerouslySetInnerHTML={{ __html: orgsStyles }} />
      </Layout>
    )
  );
});

// --- PEOPLE -----------------------------------------------------------------

orgRoutes.get("/orgs/:slug/people", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  // Anonymous users get bounced to login; org membership is non-public.
  // Previously dereferenced `user!.id` immediately and crashed for anon
  // (smoke crawl: TypeError, null is not an object — orgs.tsx:338).
  if (!user) return c.redirect(`/login?redirect=/orgs/${slug}/people`);
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
              aria-label="Username to add"
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
              aria-label="Team slug"
            />
            <input
              type="text"
              name="name"
              placeholder="Team name"
              required
              maxLength={80}
              aria-label="Team name"
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
            aria-label="Username to invite"
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
