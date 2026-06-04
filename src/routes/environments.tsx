/**
 * Environments settings + approval routes (Block C4).
 *
 *   GET  /:owner/:repo/settings/environments           list + create form (owner-only)
 *   POST /:owner/:repo/settings/environments           create
 *   POST /:owner/:repo/settings/environments/:envId    update
 *   POST /:owner/:repo/settings/environments/:envId/delete
 *
 *   POST /:owner/:repo/deployments/:deploymentId/approve  approve a pending deploy
 *   POST /:owner/:repo/deployments/:deploymentId/reject   reject a pending deploy
 *
 * Approve/reject live under /deployments/:id/... so they don't collide with
 * the existing `GET /:owner/:repo/deployments/:id` detail page.
 *
 * Visual polish (2026): adopts the gradient-hairline + orb pattern from
 * admin-integrations / error-page. Page-level CSS is scoped under `.envs-*`
 * so it can't bleed into the layout. RepoHeader + RepoNav are untouched.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  environments,
  deployments,
  repositories,
  users,
} from "../db/schema";
import type { Environment } from "../db/schema";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";
import { audit, notify } from "../lib/notify";
import {
  allowedBranchesOf,
  computeApprovalState,
  getEnvironmentById,
  getEnvironmentByName,
  isReviewer,
  listEnvironments,
  recordApproval,
  reviewerIdsOf,
} from "../lib/environments";

const r = new Hono<AuthEnv>();
r.use("*", softAuth);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function loadRepo(owner: string, repo: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerId: repositories.ownerId,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, owner), eq(repositories.name, repo)))
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[environments] loadRepo failed:", err);
    return null;
  }
}

function splitCsv(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function resolveUsernamesToIds(usernames: string[]): Promise<string[]> {
  if (usernames.length === 0) return [];
  try {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.username, usernames));
    return rows.map((r) => r.id);
  } catch (err) {
    console.error("[environments] resolve usernames failed:", err);
    return [];
  }
}

async function idsToUsernames(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  try {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, ids));
    const map = new Map(rows.map((r) => [r.id, r.username]));
    return ids.map((id) => map.get(id) || id);
  } catch {
    return ids;
  }
}

function envProtectionCount(env: Environment): number {
  let n = 0;
  if (env.requireApproval) n++;
  if ((env.waitTimerMinutes ?? 0) > 0) n++;
  if (allowedBranchesOf(env).length > 0) n++;
  return n;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.envs-*` so this surface can't bleed
 * into other pages. Mirrors the gradient hairline + orb language used by
 * admin-integrations and error-page.
 * ───────────────────────────────────────────────────────────────────── */
const envsStyles = `
  .envs-wrap { max-width: 1320px; margin: 0 auto; padding: var(--space-5) var(--space-4) var(--space-8); }

  .envs-head {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-4) var(--space-5);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .envs-head::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 30%, #36c5d6 70%, transparent 100%);
    opacity: 0.7;
    pointer-events: none;
  }
  .envs-head-orb {
    position: absolute;
    inset: -30% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
    z-index: 0;
  }
  .envs-head-inner {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }
  .envs-head-text { flex: 1; min-width: 240px; max-width: 720px; }
  .envs-head-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .envs-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .envs-eyebrow-dot {
    width: 8px; height: 8px;
    border-radius: 9999px;
    background: linear-gradient(135deg, #8c6dff, #36c5d6);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .envs-title {
    margin: 0 0 6px;
    font-family: var(--font-display);
    font-size: clamp(22px, 2.6vw, 30px);
    font-weight: 800;
    letter-spacing: -0.022em;
    line-height: 1.1;
    color: var(--text-strong);
  }
  .envs-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .envs-sub {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text-muted);
  }

  .envs-banner {
    margin-bottom: var(--space-4);
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13.5px;
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.025);
    color: var(--text);
  }
  .envs-banner.is-ok {
    border-color: rgba(52,211,153,0.40);
    background: rgba(52,211,153,0.08);
    color: #bbf7d0;
  }
  .envs-banner.is-error {
    border-color: rgba(248,113,113,0.40);
    background: rgba(248,113,113,0.08);
    color: #fecaca;
  }

  .envs-col-title {
    margin: 0 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-weight: 600;
    color: var(--text-muted);
  }

  .envs-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  /* ─── environment item card ─── */
  .envs-card {
    position: relative;
    padding: var(--space-4) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: transform 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .envs-card::before {
    content: '';
    position: absolute;
    top: 0; left: 14px; right: 14px;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.45) 30%, rgba(54,197,214,0.45) 70%, transparent 100%);
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .envs-card:hover {
    transform: translateY(-1px);
    border-color: rgba(140,109,255,0.32);
    box-shadow: 0 8px 22px -10px rgba(0,0,0,0.40);
  }
  .envs-card:hover::before { opacity: 1; }

  .envs-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .envs-card-titles { flex: 1; min-width: 200px; }
  .envs-card-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    letter-spacing: -0.018em;
    color: var(--text-strong);
  }
  .envs-card-url {
    margin-top: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .envs-card-url a { color: var(--text-muted); text-decoration: none; }
  .envs-card-url a:hover { color: var(--accent); text-decoration: underline; }
  .envs-card-meta {
    margin-top: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* ─── pills ─── */
  .envs-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.04);
    color: var(--text-muted);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .envs-pill.is-active {
    background: rgba(52,211,153,0.10);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.30);
  }
  .envs-pill.is-protected {
    background: rgba(140,109,255,0.12);
    color: #c4b5fd;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
  }
  .envs-pill.is-warn {
    background: rgba(251,191,36,0.10);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .envs-pill-dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }

  .envs-pillrow {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  /* ─── form rows inside an environment card ─── */
  .envs-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
  }
  @media (max-width: 720px) {
    .envs-fields { grid-template-columns: 1fr; }
  }
  .envs-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .envs-field.is-wide { grid-column: 1 / -1; }
  .envs-field label {
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--text-strong);
  }
  .envs-field .hint {
    font-size: 11px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .envs-input, .envs-textarea {
    width: 100%;
    padding: 8px 11px;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    outline: none;
    font-family: var(--font-mono);
    transition: border-color 120ms ease, box-shadow 120ms ease;
    box-sizing: border-box;
  }
  .envs-input:focus, .envs-textarea:focus {
    border-color: rgba(140,109,255,0.50);
    box-shadow: 0 0 0 3px rgba(140,109,255,0.18);
  }
  .envs-check {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text);
    cursor: pointer;
    user-select: none;
  }
  .envs-check input { margin: 0; }

  .envs-card-foot {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .envs-card-foot-left {
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* ─── ghost buttons (page-local) ─── */
  .envs-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: 8px;
    cursor: pointer;
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
    font-family: inherit;
  }
  .envs-btn:hover {
    background: rgba(140,109,255,0.07);
    border-color: rgba(140,109,255,0.45);
    color: var(--text-strong);
    text-decoration: none;
  }
  .envs-btn.is-primary {
    background: linear-gradient(135deg, #8c6dff 0%, #36c5d6 100%);
    color: #fff;
    border-color: transparent;
    box-shadow: 0 4px 12px -4px rgba(140,109,255,0.45), inset 0 1px 0 rgba(255,255,255,0.14);
  }
  .envs-btn.is-primary:hover { transform: translateY(-1px); color: #fff; }
  .envs-btn.is-danger {
    color: #fecaca;
    border-color: rgba(248,113,113,0.35);
  }
  .envs-btn.is-danger:hover {
    background: rgba(248,113,113,0.10);
    border-color: rgba(248,113,113,0.55);
    color: #fecaca;
  }

  /* ─── empty state — dashed card with orb ─── */
  .envs-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-strong, var(--border));
    border-radius: 14px;
    text-align: center;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .envs-empty-orb {
    position: absolute;
    inset: auto auto -40% 50%;
    transform: translateX(-50%);
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.18), rgba(54,197,214,0.08) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.7;
    pointer-events: none;
  }
  .envs-empty-inner { position: relative; z-index: 1; max-width: 460px; margin: 0 auto; }
  .envs-empty-icon {
    width: 44px; height: 44px;
    margin: 0 auto var(--space-3);
    border-radius: 14px;
    background: linear-gradient(135deg, rgba(140,109,255,0.18), rgba(54,197,214,0.14));
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.32);
    display: flex; align-items: center; justify-content: center;
    color: #b69dff;
  }
  .envs-empty-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.01em;
  }
  .envs-empty-body {
    font-size: 13.5px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0 0 var(--space-3);
  }

  /* ─── create form (lives below the list) ─── */
  .envs-create {
    position: relative;
    padding: var(--space-4) var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .envs-create::before {
    content: '';
    position: absolute;
    top: 0; left: 14px; right: 14px;
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(140,109,255,0.40) 30%, rgba(54,197,214,0.40) 70%, transparent 100%);
    opacity: 0.7;
  }
  .envs-create-title {
    margin: 0 0 4px;
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.014em;
    color: var(--text-strong);
  }
  .envs-create-sub {
    margin: 0 0 var(--space-3);
    font-size: 12.5px;
    color: var(--text-muted);
  }
`;

// ---------------------------------------------------------------------------
// GET /:owner/:repo/settings/environments
// ---------------------------------------------------------------------------

r.get("/:owner/:repo/settings/environments", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const envs = await listEnvironments(repoRow.id);
  const unread = await getUnreadCount(user.id);
  const success = c.req.query("success");
  const err = c.req.query("error");

  // Resolve reviewer IDs → usernames per env for display.
  const envUsernames: Record<string, string[]> = {};
  for (const env of envs) {
    envUsernames[env.id] = await idsToUsernames(reviewerIdsOf(env));
  }

  return c.html(
    <Layout
      title={`Environments — ${owner}/${repo}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="code" />

      <div class="envs-wrap">
        <section class="envs-head">
          <div class="envs-head-orb" aria-hidden="true" />
          <div class="envs-head-inner">
            <div class="envs-head-text">
              <div class="envs-eyebrow">
                <span class="envs-eyebrow-dot" aria-hidden="true" />
                Deploy environments · {owner}/{repo}
              </div>
              <h2 class="envs-title">
                <span class="envs-title-grad">Environments.</span>
              </h2>
              <p class="envs-sub">
                Gate every deploy with reviewers, wait timers, and branch
                allowlists — the same way GitHub Environments protects
                production rollouts.
              </p>
            </div>
            <div class="envs-head-actions">
              <a
                href={`/${owner}/${repo}/deployments`}
                class="envs-btn"
              >
                Back to deployments
              </a>
            </div>
          </div>
        </section>

        {success && (
          <div class="envs-banner is-ok">{decodeURIComponent(success)}</div>
        )}
        {err && (
          <div class="envs-banner is-error">{decodeURIComponent(err)}</div>
        )}

        <h4 class="envs-col-title">
          {envs.length === 0
            ? "No environments yet"
            : `${envs.length} environment${envs.length === 1 ? "" : "s"}`}
        </h4>

        {envs.length === 0 ? (
          <div class="envs-empty">
            <div class="envs-empty-orb" aria-hidden="true" />
            <div class="envs-empty-inner">
              <div class="envs-empty-icon" aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                  <line x1="12" y1="22.08" x2="12" y2="12" />
                </svg>
              </div>
              <h3 class="envs-empty-title">Add your first environment</h3>
              <p class="envs-empty-body">
                Create a named environment like <strong>production</strong> or{" "}
                <strong>staging</strong>, then require approval, wait timers,
                or branch allowlists before any deploy may target it.
              </p>
            </div>
          </div>
        ) : (
          <div class="envs-list">
            {envs.map((env) => {
              const reviewers = envUsernames[env.id] || [];
              const branches = allowedBranchesOf(env);
              const protections = envProtectionCount(env);
              const updatedAt = env.updatedAt
                ? new Date(env.updatedAt)
                : null;
              const updatedLabel = updatedAt
                ? updatedAt.toLocaleString()
                : "—";
              const envUrl = `/${owner}/${repo}/deployments?environment=${encodeURIComponent(env.name)}`;
              return (
                <form
                  method="post"
                  action={`/${owner}/${repo}/settings/environments/${env.id}`}
                  class="envs-card"
                >
                  <div class="envs-card-head">
                    <div class="envs-card-titles">
                      <h3 class="envs-card-title">{env.name}</h3>
                      <div class="envs-card-url">
                        <a href={envUrl}>{envUrl}</a>
                      </div>
                      <div class="envs-card-meta">
                        <span title={updatedAt ? updatedAt.toISOString() : ""}>
                          last deploy target · {updatedLabel}
                        </span>
                      </div>
                    </div>
                    <div class="envs-pillrow">
                      <span class="envs-pill is-active">
                        <span class="envs-pill-dot" aria-hidden="true" />
                        Active
                      </span>
                      <span
                        class={protections > 0 ? "envs-pill is-protected" : "envs-pill"}
                        title={`${protections} protection rule${protections === 1 ? "" : "s"}`}
                      >
                        <span class="envs-pill-dot" aria-hidden="true" />
                        {protections} rule{protections === 1 ? "" : "s"}
                      </span>
                      {env.requireApproval && (
                        <span class="envs-pill is-warn">
                          <span class="envs-pill-dot" aria-hidden="true" />
                          Approval
                        </span>
                      )}
                    </div>
                  </div>

                  <div class="envs-fields">
                    <div class="envs-field is-wide">
                      <label class="envs-check">
                        <input
                          type="checkbox"
                          name="requireApproval"
                          value="1"
                          checked={env.requireApproval}
                        />
                        Require approval before deploy
                      </label>
                    </div>
                    <div class="envs-field is-wide">
                      <label for={`env-rev-${env.id}`}>Reviewers</label>
                      <input
                        id={`env-rev-${env.id}`}
                        type="text"
                        name="reviewers"
                        value={reviewers.join(", ")}
                        placeholder="alice, bob"
                        aria-label="Reviewers"
                        class="envs-input"
                      />
                      <span class="hint">Comma-separated usernames.</span>
                    </div>
                    <div class="envs-field">
                      <label for={`env-wait-${env.id}`}>Wait timer (minutes)</label>
                      <input
                        id={`env-wait-${env.id}`}
                        type="number"
                        name="waitTimerMinutes"
                        min="0"
                        max="1440"
                        value={String(env.waitTimerMinutes)}
                        aria-label="Wait timer in minutes"
                        class="envs-input"
                      />
                      <span class="hint">0 disables the timer. Max 1440 (24h).</span>
                    </div>
                    <div class="envs-field">
                      <label for={`env-br-${env.id}`}>Allowed branches</label>
                      <input
                        id={`env-br-${env.id}`}
                        type="text"
                        name="allowedBranches"
                        value={branches.join(", ")}
                        placeholder="main, release/*"
                        aria-label="Allowed branches"
                        class="envs-input"
                      />
                      <span class="hint">Comma-separated glob patterns.</span>
                    </div>
                  </div>

                  <div class="envs-card-foot">
                    <div class="envs-card-foot-left">
                      {reviewers.length > 0
                        ? `${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}`
                        : "No reviewers"}
                      {" · "}
                      {branches.length > 0
                        ? `${branches.length} branch pattern${branches.length === 1 ? "" : "s"}`
                        : "any branch"}
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">
                      <a href={envUrl} class="envs-btn">View runs</a>
                      <button
                        type="submit"
                        formaction={`/${owner}/${repo}/settings/environments/${env.id}/delete`}
                        class="envs-btn is-danger"
                        onclick="return confirm('Delete this environment?')"
                      >
                        Delete
                      </button>
                      <button type="submit" class="envs-btn is-primary">
                        Save
                      </button>
                    </div>
                  </div>
                </form>
              );
            })}
          </div>
        )}

        <form
          method="post"
          action={`/${owner}/${repo}/settings/environments`}
          class="envs-create"
        >
          <h3 class="envs-create-title">New environment</h3>
          <p class="envs-create-sub">
            Pick a short, lowercase name like <strong>production</strong>,{" "}
            <strong>staging</strong>, or <strong>preview</strong>.
          </p>
          <div class="envs-fields">
            <div class="envs-field is-wide">
              <label for="envs-new-name">Name</label>
              <input
                id="envs-new-name"
                type="text"
                name="name"
                required
                placeholder="production"
                aria-label="Environment name"
                class="envs-input"
              />
            </div>
            <div class="envs-field is-wide">
              <label class="envs-check">
                <input
                  type="checkbox"
                  name="requireApproval"
                  value="1"
                  checked
                />
                Require approval
              </label>
            </div>
            <div class="envs-field is-wide">
              <label for="envs-new-reviewers">Reviewers</label>
              <input
                id="envs-new-reviewers"
                type="text"
                name="reviewers"
                placeholder="alice, bob"
                aria-label="Reviewers"
                class="envs-input"
              />
              <span class="hint">Comma-separated usernames.</span>
            </div>
            <div class="envs-field">
              <label for="envs-new-wait">Wait timer (minutes)</label>
              <input
                id="envs-new-wait"
                type="number"
                name="waitTimerMinutes"
                min="0"
                max="1440"
                value="0"
                aria-label="Wait timer in minutes"
                class="envs-input"
              />
            </div>
            <div class="envs-field">
              <label for="envs-new-branches">Allowed branches</label>
              <input
                id="envs-new-branches"
                type="text"
                name="allowedBranches"
                placeholder="main, release/*"
                aria-label="Allowed branches"
                class="envs-input"
              />
              <span class="hint">Comma-separated glob patterns.</span>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:var(--space-3)">
            <button type="submit" class="envs-btn is-primary">
              Create environment
            </button>
          </div>
        </form>
      </div>

      <style dangerouslySetInnerHTML={{ __html: envsStyles }} />
    </Layout>
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/settings/environments      (create)
// ---------------------------------------------------------------------------

r.post("/:owner/:repo/settings/environments", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  if (!name) {
    return c.redirect(
      `/${owner}/${repo}/settings/environments?error=${encodeURIComponent(
        "Name required"
      )}`
    );
  }
  const requireApproval = body.requireApproval === "1" || body.requireApproval === "on";
  const reviewers = await resolveUsernamesToIds(splitCsv(body.reviewers));
  const waitTimerMinutes = Math.max(
    0,
    Math.min(1440, parseInt(String(body.waitTimerMinutes || "0"), 10) || 0)
  );
  const allowedBranches = splitCsv(body.allowedBranches);

  try {
    await db.insert(environments).values({
      repositoryId: repoRow.id,
      name,
      requireApproval,
      reviewers: JSON.stringify(reviewers),
      waitTimerMinutes,
      allowedBranches: JSON.stringify(allowedBranches),
    });
  } catch (err) {
    console.error("[environments] create failed:", err);
    return c.redirect(
      `/${owner}/${repo}/settings/environments?error=${encodeURIComponent(
        "Could not create (duplicate name?)"
      )}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "environment.create",
    targetType: "environment",
    metadata: { name, requireApproval, reviewers, allowedBranches },
  });

  return c.redirect(
    `/${owner}/${repo}/settings/environments?success=${encodeURIComponent(
      "Environment created"
    )}`
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/settings/environments/:envId  (update)
// ---------------------------------------------------------------------------

r.post("/:owner/:repo/settings/environments/:envId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, envId } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }

  const env = await getEnvironmentById(repoRow.id, envId);
  if (!env) return c.notFound();

  const body = await c.req.parseBody();
  const requireApproval =
    body.requireApproval === "1" || body.requireApproval === "on";
  const reviewers = await resolveUsernamesToIds(splitCsv(body.reviewers));
  const waitTimerMinutes = Math.max(
    0,
    Math.min(1440, parseInt(String(body.waitTimerMinutes || "0"), 10) || 0)
  );
  const allowedBranches = splitCsv(body.allowedBranches);

  try {
    await db
      .update(environments)
      .set({
        requireApproval,
        reviewers: JSON.stringify(reviewers),
        waitTimerMinutes,
        allowedBranches: JSON.stringify(allowedBranches),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(environments.id, envId),
          eq(environments.repositoryId, repoRow.id)
        )
      );
  } catch (err) {
    console.error("[environments] update failed:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "environment.update",
    targetType: "environment",
    targetId: envId,
    metadata: { requireApproval, reviewers, allowedBranches, waitTimerMinutes },
  });

  return c.redirect(
    `/${owner}/${repo}/settings/environments?success=${encodeURIComponent(
      "Environment updated"
    )}`
  );
});

// ---------------------------------------------------------------------------
// POST /:owner/:repo/settings/environments/:envId/delete
// ---------------------------------------------------------------------------

r.post(
  "/:owner/:repo/settings/environments/:envId/delete",
  requireAuth,
  async (c) => {
    const user = c.get("user")!;
    const { owner, repo, envId } = c.req.param();
    const repoRow = await loadRepo(owner, repo);
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(`/${owner}/${repo}`);
    }

    try {
      await db
        .delete(environments)
        .where(
          and(
            eq(environments.id, envId),
            eq(environments.repositoryId, repoRow.id)
          )
        );
    } catch (err) {
      console.error("[environments] delete failed:", err);
    }

    await audit({
      userId: user.id,
      repositoryId: repoRow.id,
      action: "environment.delete",
      targetType: "environment",
      targetId: envId,
    });

    return c.redirect(
      `/${owner}/${repo}/settings/environments?success=${encodeURIComponent(
        "Environment removed"
      )}`
    );
  }
);

// ---------------------------------------------------------------------------
// Approve/reject a pending deployment
// ---------------------------------------------------------------------------

async function loadDeployment(repositoryId: string, deploymentId: string) {
  try {
    const [row] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.id, deploymentId),
          eq(deployments.repositoryId, repositoryId)
        )
      )
      .limit(1);
    return row || null;
  } catch (err) {
    console.error("[environments] loadDeployment failed:", err);
    return null;
  }
}

async function decide(
  c: Context<AuthEnv>,
  decision: "approved" | "rejected"
) {
  const user = c.get("user")!;
  const { owner, repo, deploymentId } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const deployment = await loadDeployment(repoRow.id, deploymentId);
  if (!deployment) return c.notFound();

  const envName = deployment.environment;
  const env = await getEnvironmentByName(repoRow.id, envName);
  if (!env) {
    // No env configured — nothing to approve. Treat as 404 for safety.
    return c.notFound();
  }

  const allowed = await isReviewer(env, user.id);
  if (!allowed) {
    return c.redirect(
      `/${owner}/${repo}/deployments/${deploymentId}?error=${encodeURIComponent(
        "Not a reviewer"
      )}`
    );
  }

  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const comment = typeof body.comment === "string" ? body.comment : undefined;

  const inserted = await recordApproval({
    deploymentId,
    userId: user.id,
    decision,
    comment,
  });

  // Re-read state and flip the deployment row accordingly. When the env
  // carries a wait timer and the timer hasn't elapsed yet, we hold the
  // deploy in status="waiting_timer" with `readyAfter` populated; the
  // autopilot ticker (`releaseExpiredWaitTimers`) flips it later.
  const state = await computeApprovalState(deploymentId, env);
  let newStatus: string | null = null;
  let readyAfter: Date | null = null;
  let blockedReason: string | null = null;
  if (state.rejected) {
    newStatus = "rejected";
    blockedReason = "rejected by reviewer";
  } else if (state.approved && deployment.status === "pending_approval") {
    const now = new Date();
    if (state.readyAfter && state.readyAfter.getTime() > now.getTime()) {
      newStatus = "waiting_timer";
      readyAfter = state.readyAfter;
      blockedReason = `wait_timer until ${state.readyAfter.toISOString()}`;
    } else {
      newStatus = "pending"; // hand off to existing deployer
    }
  }

  if (newStatus) {
    try {
      await db
        .update(deployments)
        .set({
          status: newStatus,
          blockedReason,
          // Always overwrite readyAfter — clears any prior value when the
          // status flips to anything other than waiting_timer.
          readyAfter,
        })
        .where(eq(deployments.id, deploymentId));
    } catch (err) {
      console.error("[environments] deployment status flip failed:", err);
    }
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: decision === "approved" ? "deployment.approve" : "deployment.reject",
    targetType: "deployment",
    targetId: deploymentId,
    metadata: { recorded: !!inserted, newStatus },
  });

  if (deployment.triggeredBy && deployment.triggeredBy !== user.id) {
    try {
      await notify(deployment.triggeredBy, {
        kind: "deployment_approval",
        title:
          decision === "approved"
            ? `Deploy to ${envName} approved`
            : `Deploy to ${envName} rejected`,
        body:
          decision === "approved"
            ? `${user.username} approved the deploy of ${deployment.commitSha.slice(0, 7)}.`
            : `${user.username} rejected the deploy of ${deployment.commitSha.slice(0, 7)}.`,
        url: `/${owner}/${repo}/deployments/${deploymentId}`,
        repositoryId: repoRow.id,
      });
    } catch (err) {
      console.error("[environments] notify triggeredBy failed:", err);
    }
  }

  return c.redirect(`/${owner}/${repo}/deployments/${deploymentId}`);
}

r.post(
  "/:owner/:repo/deployments/:deploymentId/approve",
  requireAuth,
  async (c) => decide(c, "approved")
);

r.post(
  "/:owner/:repo/deployments/:deploymentId/reject",
  requireAuth,
  async (c) => decide(c, "rejected")
);

export default r;
