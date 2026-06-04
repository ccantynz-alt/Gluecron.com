/**
 * /settings/agents — manage AI-agent sessions, see budgets + recent leases.
 *
 * Scoped CSS prefixed with `.sa-` so it cannot bleed into other surfaces.
 * The Layout shell is reused (additive, not modified). All mutations are
 * driven via plain HTML forms — no JS required.
 */

import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { raw } from "hono/html";
import { db } from "../db";
import { agentLeases, agentSessions } from "../db/schema";
import { Layout } from "../views/layout";
import type { AuthEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  createAgentSession,
  revokeAgentSession,
} from "../lib/agent-multiplayer";

const settingsAgents = new Hono<AuthEnv>();

settingsAgents.use("/settings/agents*", requireAuth);

const styles = `
  .sa-wrap { max-width: 1120px; margin: 0 auto; padding: var(--space-6) var(--space-4); }
  .sa-hero {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    margin-bottom: var(--space-5);
  }
  .sa-hero h1 {
    font-size: clamp(24px, 3.5vw, 32px);
    margin: 0 0 var(--space-2);
    letter-spacing: -0.02em;
  }
  .sa-hero p { color: var(--text-muted); margin: 0; line-height: 1.5; }
  .sa-section { margin: var(--space-6) 0; }
  .sa-section h2 {
    font-size: 17px;
    margin: 0 0 var(--space-3);
    letter-spacing: -0.01em;
  }
  .sa-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4);
    background: var(--bg-elevated);
    margin-bottom: var(--space-3);
  }
  .sa-card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .sa-name { font-weight: 600; font-size: 15px; }
  .sa-meta { color: var(--text-muted); font-size: 13px; margin-top: 4px; }
  .sa-namespace {
    display: inline-block;
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    color: var(--accent);
    background: rgba(140, 109, 255, 0.08);
    padding: 2px 8px;
    border-radius: 6px;
  }
  .sa-budget { margin-top: var(--space-3); }
  .sa-budget-label {
    display: flex; justify-content: space-between;
    font-size: 12px; color: var(--text-muted); margin-bottom: 4px;
  }
  .sa-budget-bar {
    width: 100%; height: 6px; background: var(--border);
    border-radius: 3px; overflow: hidden;
  }
  .sa-budget-fill {
    height: 100%;
    background: linear-gradient(90deg, #36c5d6, #8c6dff);
    transition: width 0.3s;
  }
  .sa-budget-fill.over { background: #ef4444; }
  .sa-form { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .sa-form label {
    display: flex; flex-direction: column;
    font-size: 13px; color: var(--text-muted); gap: 4px;
  }
  .sa-form input {
    padding: 8px 10px; border: 1px solid var(--border);
    border-radius: 8px; background: var(--bg);
    color: var(--text); font: inherit;
  }
  .sa-form-actions {
    grid-column: 1 / -1; display: flex;
    justify-content: flex-end; gap: var(--space-2);
  }
  .sa-btn {
    padding: 8px 16px; border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg); color: var(--text);
    cursor: pointer; font: inherit;
  }
  .sa-btn-primary {
    background: var(--accent); color: white; border-color: var(--accent);
  }
  .sa-btn-danger {
    background: transparent; color: #ef4444; border-color: #ef4444;
  }
  .sa-token-banner {
    border: 1px solid #f59e0b;
    background: rgba(245, 158, 11, 0.06);
    padding: var(--space-4); border-radius: 10px;
    margin-bottom: var(--space-4);
  }
  .sa-token-banner code {
    display: block; margin-top: 8px; padding: 8px 10px;
    background: var(--bg); border-radius: 6px;
    word-break: break-all; font-size: 12px;
  }
  .sa-empty {
    color: var(--text-muted); font-size: 14px;
    padding: var(--space-4); text-align: center;
    border: 1px dashed var(--border); border-radius: 12px;
  }
  .sa-lease {
    display: flex; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .sa-lease:last-child { border-bottom: none; }
  .sa-lease-status {
    font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 2px 6px;
    border-radius: 4px; background: var(--border);
  }
  .sa-lease-status.active { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
  .sa-lease-status.released { color: var(--text-muted); }
  .sa-lease-status.expired { color: var(--text-muted); }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toISOString().replace("T", " ").slice(0, 19);
}

type SessionRow = typeof agentSessions.$inferSelect;
type LeaseRow = typeof agentLeases.$inferSelect;

settingsAgents.get("/settings/agents", async (c) => {
  const user = c.get("user")!;
  const justCreatedToken = c.req.query("token");
  const justCreatedName = c.req.query("name");

  let sessions: SessionRow[] = [];
  let leases: LeaseRow[] = [];

  try {
    sessions = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.ownerUserId, user.id))
      .orderBy(desc(agentSessions.createdAt));

    if (sessions.length > 0) {
      const all: LeaseRow[] = [];
      for (const s of sessions) {
        const rows = await db
          .select()
          .from(agentLeases)
          .where(eq(agentLeases.agentSessionId, s.id))
          .orderBy(desc(agentLeases.acquiredAt))
          .limit(10);
        all.push(...rows);
      }
      all.sort(
        (a, b) =>
          new Date(b.acquiredAt).getTime() - new Date(a.acquiredAt).getTime()
      );
      leases = all.slice(0, 25);
    }
  } catch {
    sessions = [];
    leases = [];
  }

  const csrfToken = (c as any).get("csrfToken") || "";
  const csrfInput = csrfToken
    ? `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />`
    : "";

  const tokenBanner = justCreatedToken
    ? `<div class="sa-token-banner">
        <strong>New agent created${justCreatedName ? `: ${escapeHtml(justCreatedName)}` : ""}.</strong>
        Copy this token now &mdash; it will not be shown again.
        <code>${escapeHtml(justCreatedToken)}</code>
       </div>`
    : "";

  const sessionsHtml = sessions.length
    ? sessions
        .map((s) => {
          const pct =
            s.budgetCentsPerDay > 0
              ? Math.min(
                  100,
                  Math.round((s.spentCentsToday / s.budgetCentsPerDay) * 100)
                )
              : 0;
          const over = s.spentCentsToday >= s.budgetCentsPerDay;
          return `
            <div class="sa-card">
              <div class="sa-card-row">
                <div>
                  <div class="sa-name">${escapeHtml(s.name)}</div>
                  <div class="sa-meta">
                    <span class="sa-namespace">refs/heads/${escapeHtml(s.branchNamespace)}*</span>
                    &middot; created ${formatDate(s.createdAt)}
                    &middot; last active ${formatDate(s.lastActiveAt)}
                  </div>
                </div>
                <form method="post" action="/settings/agents/${escapeHtml(s.id)}/revoke" onsubmit="return confirm('Revoke this agent? Its token will stop working immediately.');">
                  ${csrfInput}
                  <button type="submit" class="sa-btn sa-btn-danger">Revoke</button>
                </form>
              </div>
              <div class="sa-budget">
                <div class="sa-budget-label">
                  <span>Today: $${(s.spentCentsToday / 100).toFixed(2)} / $${(s.budgetCentsPerDay / 100).toFixed(2)}</span>
                  <span>${pct}%</span>
                </div>
                <div class="sa-budget-bar">
                  <div class="sa-budget-fill ${over ? "over" : ""}" style="width: ${pct}%"></div>
                </div>
              </div>
            </div>
          `;
        })
        .join("")
    : `<div class="sa-empty">No agents yet. Create one below to give an AI agent its own scoped credentials.</div>`;

  const sessionsById = new Map(sessions.map((s) => [s.id, s.name]));
  const leasesHtml = leases.length
    ? leases
        .map(
          (l) => `
            <div class="sa-lease">
              <div>
                <strong>${escapeHtml(sessionsById.get(l.agentSessionId) ?? "unknown")}</strong>
                &nbsp;&middot;&nbsp;
                <span style="font-family: var(--font-mono, monospace)">${escapeHtml(l.targetType)}:${escapeHtml(l.targetId)}</span>
              </div>
              <div>
                <span class="sa-lease-status ${escapeHtml(l.status)}">${escapeHtml(l.status)}</span>
                &nbsp;&middot;&nbsp;
                <span style="color: var(--text-muted)">${formatDate(l.acquiredAt)}</span>
              </div>
            </div>
          `
        )
        .join("")
    : `<div class="sa-empty">No leases yet. Agents acquire leases via POST /api/v2/agents/leases.</div>`;

  const body = `
    <style>${styles}</style>
    <style>
      .sa-subnav {
        display: flex;
        gap: 6px;
        max-width: 920px;
        margin: 0 auto;
        padding: var(--space-4) var(--space-4) 0;
      }
      .sa-subnav a {
        display: inline-flex;
        align-items: center;
        padding: 6px 12px;
        font-size: 13px;
        color: var(--text-muted);
        background: var(--bg-elevated);
        border: 1px solid var(--border);
        border-radius: 7px;
        text-decoration: none;
        transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
      }
      .sa-subnav a:hover {
        color: var(--text-strong);
        border-color: rgba(140,109,255,0.45);
        text-decoration: none;
      }
      .sa-subnav a.is-active {
        background: linear-gradient(135deg, rgba(140,109,255,0.14), rgba(54,197,214,0.10));
        color: var(--text-strong);
        border-color: rgba(140,109,255,0.45);
        font-weight: 600;
      }
    </style>
    <nav class="sa-subnav" aria-label="Settings sections">
      <a href="/settings">Profile</a>
      <a href="/settings/keys">SSH keys</a>
      <a href="/settings/agents" class="is-active" aria-current="page">Agents</a>
    </nav>
    <div class="sa-wrap">
      <div class="sa-hero">
        <h1>Agent sessions</h1>
        <p>
          Give each AI agent its own credentials, branch namespace, and daily
          spend cap. Agents can only push to branches under their namespace,
          and can coordinate on shared issues / PRs / file paths through the
          lease API.
        </p>
      </div>

      ${tokenBanner}

      <div class="sa-section">
        <h2>Your agents</h2>
        ${sessionsHtml}
      </div>

      <div class="sa-section">
        <h2>Create a new agent</h2>
        <form method="post" action="/settings/agents" class="sa-form sa-card">
          ${csrfInput}
          <label>
            Name
            <input type="text" name="name" required maxlength="64" pattern="[A-Za-z0-9_\\-]+" placeholder="claude-1" />
          </label>
          <label>
            Daily budget (cents)
            <input type="number" name="budget_cents_per_day" min="0" step="50" value="500" />
          </label>
          <label style="grid-column: 1 / -1">
            Branch namespace (optional)
            <input type="text" name="branch_namespace" placeholder="agents/claude-1" />
          </label>
          <div class="sa-form-actions">
            <button type="submit" class="sa-btn sa-btn-primary">Create agent</button>
          </div>
        </form>
      </div>

      <div class="sa-section">
        <h2>Recent leases</h2>
        <div class="sa-card">${leasesHtml}</div>
      </div>
    </div>
  `;

  return c.html(
    <Layout title="Agent sessions" user={user}>
      {raw(body)}
    </Layout>
  );
});

settingsAgents.post("/settings/agents", async (c) => {
  const user = c.get("user")!;
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim();
  const rawBudget = form.budget_cents_per_day;
  const budget =
    typeof rawBudget === "string" && rawBudget !== ""
      ? Number.parseInt(rawBudget, 10)
      : undefined;
  const rawNs = form.branch_namespace;
  const branchNamespace =
    typeof rawNs === "string" && rawNs.trim() !== ""
      ? rawNs.trim()
      : undefined;

  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || name.length > 64) {
    return c.redirect("/settings/agents?error=name");
  }

  const created = await createAgentSession({
    ownerUserId: user.id,
    name,
    branchNamespace,
    budgetCentsPerDay:
      typeof budget === "number" && Number.isFinite(budget) ? budget : undefined,
  });
  if (!created) {
    return c.redirect("/settings/agents?error=duplicate");
  }
  const params = new URLSearchParams({
    token: created.token,
    name: created.session.name,
  });
  return c.redirect(`/settings/agents?${params.toString()}`);
});

settingsAgents.post("/settings/agents/:id/revoke", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  await revokeAgentSession(id, user.id);
  return c.redirect("/settings/agents");
});

export default settingsAgents;
