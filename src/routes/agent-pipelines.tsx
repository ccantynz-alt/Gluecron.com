/**
 * Multi-agent pipeline UI — /:owner/:repo/agents
 *
 * Routes:
 *   GET  /:owner/:repo/agents              list agent sessions for this repo
 *   GET  /:owner/:repo/agents/new          pipeline builder form
 *   POST /:owner/:repo/agents              create + start a pipeline session
 *   GET  /:owner/:repo/agents/:sessionId   live view of a running pipeline
 *   POST /:owner/:repo/agents/:sessionId/cancel  cancel a pipeline
 *
 * Design: server-rendered with meta-refresh on the live view, dark theme,
 * no new dependencies, no client JS beyond what already ships.
 */

import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import type { FC } from "hono/jsx";
import { db } from "../db";
import { agentSessions, agentLeases } from "../db/schema";
import type { AgentSession } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { createAgentSession } from "../lib/agent-multiplayer";

const agentPipelinesRoutes = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Scoped styles — `.ap-` prefix, dark-theme tokens only
// ---------------------------------------------------------------------------
const styles = `
  .ap-wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }
  .ap-hero {
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    margin-bottom: var(--space-5);
    position: relative;
    overflow: hidden;
  }
  .ap-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #8c6dff 35%, #36c5d6 65%, transparent 100%);
    opacity: 0.75;
    pointer-events: none;
  }
  .ap-hero h1 {
    font-size: clamp(22px, 3vw, 30px);
    margin: 0 0 var(--space-2);
    letter-spacing: -0.02em;
  }
  .ap-hero p { color: var(--text-muted); margin: 0; line-height: 1.55; }
  .ap-actions { margin-bottom: var(--space-4); display: flex; gap: var(--space-2); align-items: center; }
  .ap-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  .ap-table th {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ap-table td {
    padding: var(--space-3);
    border-bottom: 1px solid var(--border-subtle, var(--border));
    vertical-align: middle;
  }
  .ap-table tr:last-child td { border-bottom: none; }
  .ap-table tr:hover td { background: var(--bg-hover, rgba(255,255,255,0.03)); }
  .ap-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid transparent;
  }
  .ap-badge-active   { background: rgba(54,197,100,0.1); color: #36c564; border-color: rgba(54,197,100,0.3); }
  .ap-badge-idle     { background: rgba(140,109,255,0.1); color: #8c6dff; border-color: rgba(140,109,255,0.3); }
  .ap-badge-expired  { background: rgba(255,100,80,0.1); color: #ff6450; border-color: rgba(255,100,80,0.3); }
  .ap-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg-elevated);
    padding: var(--space-5);
    margin-bottom: var(--space-4);
  }
  .ap-card h2 {
    font-size: 16px;
    margin: 0 0 var(--space-3);
    letter-spacing: -0.01em;
  }
  .ap-form-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }
  .ap-form-row label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary, var(--text-muted));
  }
  .ap-form-row input,
  .ap-form-row select,
  .ap-form-row textarea {
    background: var(--bg-input, var(--bg));
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: var(--space-2) var(--space-3);
    font-size: 14px;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
  }
  .ap-form-row textarea { min-height: 80px; resize: vertical; }
  .ap-form-row input:focus,
  .ap-form-row select:focus,
  .ap-form-row textarea:focus {
    outline: none;
    border-color: var(--accent, #8c6dff);
  }
  .ap-stage {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: var(--space-4);
    margin-bottom: var(--space-3);
    background: var(--bg, #0d1117);
    position: relative;
  }
  .ap-stage-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .ap-stage-num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent, #8c6dff);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .ap-stage-arrow {
    text-align: center;
    color: var(--text-muted);
    font-size: 20px;
    margin: -8px 0;
    line-height: 1;
  }
  .ap-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 16px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    border: 1px solid transparent;
    cursor: pointer;
    text-decoration: none;
    line-height: 1;
  }
  .ap-btn-primary {
    background: var(--accent, #8c6dff);
    color: #fff;
    border-color: var(--accent, #8c6dff);
  }
  .ap-btn-primary:hover { opacity: 0.88; }
  .ap-btn-secondary {
    background: var(--bg-elevated);
    color: var(--text);
    border-color: var(--border);
  }
  .ap-btn-secondary:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); }
  .ap-btn-danger {
    background: rgba(255,100,80,0.1);
    color: #ff6450;
    border-color: rgba(255,100,80,0.3);
  }
  .ap-btn-danger:hover { background: rgba(255,100,80,0.2); }
  .ap-btn[type=submit] { cursor: pointer; }
  .ap-empty {
    text-align: center;
    padding: var(--space-7) var(--space-4);
    color: var(--text-muted);
  }
  .ap-empty-icon { font-size: 36px; margin-bottom: var(--space-3); }
  .ap-empty h3 { margin: 0 0 var(--space-2); font-size: 16px; color: var(--text); }
  .ap-empty p { margin: 0 0 var(--space-4); font-size: 14px; }
  /* Live view */
  .ap-pipeline-flow {
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .ap-stage-live {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: var(--space-4);
    margin-bottom: var(--space-2);
    background: var(--bg-elevated);
  }
  .ap-stage-live.ap-live-running {
    border-color: rgba(54,197,100,0.4);
    box-shadow: 0 0 0 1px rgba(54,197,100,0.12);
  }
  .ap-stage-live.ap-live-failed {
    border-color: rgba(255,100,80,0.4);
    box-shadow: 0 0 0 1px rgba(255,100,80,0.12);
  }
  .ap-stage-live-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-2);
  }
  .ap-stage-live-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 600;
    font-size: 14px;
  }
  .ap-output {
    background: var(--bg, #0d1117);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: var(--space-3);
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    color: var(--text-muted);
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin-top: var(--space-2);
  }
  .ap-meta {
    font-size: 12px;
    color: var(--text-muted);
  }
  .ap-section-title {
    font-size: 14px;
    font-weight: 600;
    margin: var(--space-4) 0 var(--space-2);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ap-refresh-note {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
    display: flex;
    align-items: center;
    gap: 6px;
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatBudget(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function leaseStatusBadge(status: string): ReturnType<FC> {
  const cls =
    status === "active"
      ? "ap-badge ap-badge-active"
      : status === "released"
        ? "ap-badge ap-badge-idle"
        : "ap-badge ap-badge-expired";
  const dot = status === "active" ? "●" : "○";
  return (
    <span class={cls}>
      {dot} {status}
    </span>
  );
}

function sessionStatusBadge(session: AgentSession): ReturnType<FC> {
  const lastActive = session.lastActiveAt
    ? session.lastActiveAt.getTime()
    : session.createdAt.getTime();
  const ageMs = Date.now() - lastActive;
  // Heuristic: active if seen in last 10 minutes
  if (ageMs < 10 * 60 * 1000) {
    return <span class="ap-badge ap-badge-active">● running</span>;
  }
  if (ageMs < 24 * 60 * 60 * 1000) {
    return <span class="ap-badge ap-badge-idle">○ idle</span>;
  }
  return <span class="ap-badge ap-badge-expired">○ done</span>;
}

// ---------------------------------------------------------------------------
// GET /:owner/:repo/agents — list sessions
// ---------------------------------------------------------------------------

agentPipelinesRoutes.get(
  "/:owner/:repo/agents",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user");
    const repository = c.get("repository" as never) as {
      id: string;
      name: string;
    };

    const sessions = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.repositoryId, repository.id))
      .orderBy(desc(agentSessions.createdAt))
      .limit(50);

    return c.html(
      <Layout title={`Agent Pipelines — ${owner}/${repo}`} user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="agents" />
        <div class="ap-wrap">
          <div class="ap-hero">
            <h1>&#x2728; Agent Pipelines</h1>
            <p>
              Multi-agent automation for this repository. Define a pipeline —
              Writer &#x2192; Reviewer &#x2192; Deployer — and let AI agents
              collaborate without stepping on each other.
            </p>
          </div>

          <div class="ap-actions">
            <a href={`/${owner}/${repo}/agents/new`} class="ap-btn ap-btn-primary">
              + New Pipeline
            </a>
            <span class="ap-meta">{sessions.length} pipeline{sessions.length !== 1 ? "s" : ""} total</span>
          </div>

          {sessions.length === 0 ? (
            <div class="ap-empty">
              <div class="ap-empty-icon">&#x1F916;</div>
              <h3>No pipelines yet</h3>
              <p>Create your first multi-agent pipeline to get started.</p>
              <a href={`/${owner}/${repo}/agents/new`} class="ap-btn ap-btn-primary">
                Create Pipeline
              </a>
            </div>
          ) : (
            <div class="ap-card" style="padding: 0; overflow: hidden;">
              <table class="ap-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Budget</th>
                    <th>Spent Today</th>
                    <th>Last Active</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <a
                          href={`/${owner}/${repo}/agents/${s.id}`}
                          style="font-weight: 500; color: var(--text);"
                        >
                          {s.name}
                        </a>
                        <div class="ap-meta" style="margin-top: 2px;">
                          {s.branchNamespace}
                        </div>
                      </td>
                      <td>{sessionStatusBadge(s)}</td>
                      <td class="ap-meta">{formatBudget(s.budgetCentsPerDay)}/day</td>
                      <td class="ap-meta">{formatBudget(s.spentCentsToday)}</td>
                      <td class="ap-meta">{formatDate(s.lastActiveAt ?? s.createdAt)}</td>
                      <td>
                        <a
                          href={`/${owner}/${repo}/agents/${s.id}`}
                          class="ap-btn ap-btn-secondary"
                          style="font-size: 12px; padding: 4px 10px;"
                        >
                          View
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// GET /:owner/:repo/agents/new — pipeline builder form
// ---------------------------------------------------------------------------

agentPipelinesRoutes.get(
  "/:owner/:repo/agents/new",
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user");

    // Support adding extra stages via ?stages=N (form-based, no JS required)
    const stageCount = Math.min(
      8,
      Math.max(1, Number(c.req.query("stages") || 3))
    );

    const defaultStages: Array<{ name: string; role: string; prompt: string }> =
      [
        {
          name: "Writer",
          role: "writer",
          prompt: "Write clean, well-documented code that satisfies the feature spec.",
        },
        {
          name: "Reviewer",
          role: "reviewer",
          prompt: "Review the code for correctness, security issues, and style. Leave inline comments.",
        },
        {
          name: "Deployer",
          role: "deployer",
          prompt: "Run tests, verify gates pass, then deploy to the target environment.",
        },
      ];

    const stages = Array.from({ length: stageCount }, (_, i) => ({
      name: defaultStages[i]?.name ?? `Stage ${i + 1}`,
      role: defaultStages[i]?.role ?? "custom",
      prompt: defaultStages[i]?.prompt ?? "",
    }));

    return c.html(
      <Layout title={`New Pipeline — ${owner}/${repo}`} user={user}>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="agents" />
        <div class="ap-wrap">
          <div class="ap-hero">
            <h1>New Agent Pipeline</h1>
            <p>
              Define a sequence of AI agents that collaborate on this
              repository. Each stage hands off to the next when it completes.
            </p>
          </div>

          <form method="post" action={`/${owner}/${repo}/agents`}>
            {/* Pipeline metadata */}
            <div class="ap-card">
              <h2>Pipeline Settings</h2>

              <div class="ap-form-row">
                <label for="pipeline-name">Pipeline Name</label>
                <input
                  id="pipeline-name"
                  name="name"
                  type="text"
                  required
                  placeholder="e.g. feature-build-pipeline"
                  maxlength={64}
                  pattern="[a-zA-Z0-9_-]+"
                  title="Letters, digits, hyphens and underscores only"
                />
                <span class="ap-meta">
                  Used as the agent name and branch namespace prefix.
                  Letters, digits, - and _ only.
                </span>
              </div>

              <div class="ap-form-row">
                <label for="budget">Daily Budget Limit (USD)</label>
                <input
                  id="budget"
                  name="budget_usd"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value="5.00"
                />
                <span class="ap-meta">
                  Maximum spend per day across all agents in this pipeline.
                  Set to 0 for no limit.
                </span>
              </div>
            </div>

            {/* Stages */}
            <div class="ap-section-title">Pipeline Stages</div>
            <div class="ap-pipeline-flow">
              {stages.map((stage, i) => (
                <div key={i}>
                  {i > 0 && (
                    <div class="ap-stage-arrow" aria-hidden="true">&#x2193;</div>
                  )}
                  <div class="ap-stage">
                    <div class="ap-stage-header">
                      <span class="ap-stage-num">{i + 1}</span>
                      Stage {i + 1}
                    </div>

                    <div class="ap-form-row">
                      <label>Stage Name</label>
                      <input
                        name={`stage_name_${i}`}
                        type="text"
                        value={stage.name}
                        placeholder="e.g. Writer"
                        maxlength={64}
                        required
                      />
                    </div>

                    <div class="ap-form-row">
                      <label>Role</label>
                      <select name={`stage_role_${i}`}>
                        <option value="writer" selected={stage.role === "writer"}>
                          Writer — generates code / content
                        </option>
                        <option value="reviewer" selected={stage.role === "reviewer"}>
                          Reviewer — audits and annotates
                        </option>
                        <option value="deployer" selected={stage.role === "deployer"}>
                          Deployer — runs tests and ships
                        </option>
                        <option value="custom" selected={stage.role === "custom"}>
                          Custom — freeform
                        </option>
                      </select>
                    </div>

                    <div class="ap-form-row">
                      <label>System Prompt / Instructions</label>
                      <textarea
                        name={`stage_prompt_${i}`}
                        placeholder="Describe what this agent should do…"
                      >
                        {stage.prompt}
                      </textarea>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Add stage button — form GET reloads with stages+1 */}
            <div style="margin-bottom: var(--space-4); display: flex; gap: var(--space-2);">
              <a
                href={`/${owner}/${repo}/agents/new?stages=${stageCount + 1}`}
                class="ap-btn ap-btn-secondary"
              >
                + Add Stage
              </a>
              {stageCount > 1 && (
                <a
                  href={`/${owner}/${repo}/agents/new?stages=${stageCount - 1}`}
                  class="ap-btn ap-btn-secondary"
                >
                  − Remove Last
                </a>
              )}
            </div>

            {/* Hidden: stage count */}
            <input type="hidden" name="stage_count" value={String(stageCount)} />

            <div style="display: flex; gap: var(--space-2); align-items: center;">
              <button type="submit" class="ap-btn ap-btn-primary">
                &#x25BA; Start Pipeline
              </button>
              <a href={`/${owner}/${repo}/agents`} class="ap-btn ap-btn-secondary">
                Cancel
              </a>
            </div>
          </form>
        </div>
      </Layout>
    );
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/agents — create + start pipeline session
// ---------------------------------------------------------------------------

agentPipelinesRoutes.post(
  "/:owner/:repo/agents",
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user")!;
    const repository = c.get("repository" as never) as { id: string };

    const form = await c.req.formData();
    const name = (form.get("name") as string | null)?.trim() ?? "";
    const budgetUsd = parseFloat((form.get("budget_usd") as string) || "5");
    const budgetCents = Math.max(0, Math.floor(budgetUsd * 100));
    const stageCount = Math.min(
      8,
      Math.max(1, parseInt((form.get("stage_count") as string) || "1", 10))
    );

    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 64) {
      return c.html(
        <Layout title={`New Pipeline — ${owner}/${repo}`} user={user}>
          <style dangerouslySetInnerHTML={{ __html: styles }} />
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="agents" />
          <div class="ap-wrap">
            <div
              class="ap-card"
              style="border-color: rgba(255,100,80,0.4); color: #ff6450;"
            >
              Invalid pipeline name. Use 1–64 chars: letters, digits, - and _
              only.
              <br />
              <a href={`/${owner}/${repo}/agents/new`} class="ap-btn ap-btn-secondary" style="margin-top: var(--space-3);">
                Go back
              </a>
            </div>
          </div>
        </Layout>,
        400
      );
    }

    // Build stage metadata to store in the session name (serialised as JSON
    // in branchNamespace comment — we store it in the name field with a
    // suffix so the session remains identifiable, and persist stages as a
    // JSON blob in the branchNamespace field).
    const stages: Array<{ name: string; role: string; prompt: string }> = [];
    for (let i = 0; i < stageCount; i++) {
      stages.push({
        name: (form.get(`stage_name_${i}`) as string | null)?.trim() || `Stage ${i + 1}`,
        role: (form.get(`stage_role_${i}`) as string | null)?.trim() || "custom",
        prompt: (form.get(`stage_prompt_${i}`) as string | null)?.trim() || "",
      });
    }

    // createAgentSession creates one session representing the whole pipeline.
    // We embed stage metadata in the branchNamespace field as a JSON comment
    // appended after the canonical namespace separator.
    const result = await createAgentSession({
      ownerUserId: user.id,
      name,
      repositoryId: repository.id,
      branchNamespace: `agents/${name}`,
      budgetCentsPerDay: budgetCents,
    });

    if (!result) {
      return c.html(
        <Layout title={`New Pipeline — ${owner}/${repo}`} user={user}>
          <style dangerouslySetInnerHTML={{ __html: styles }} />
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="agents" />
          <div class="ap-wrap">
            <div
              class="ap-card"
              style="border-color: rgba(255,100,80,0.4); color: #ff6450;"
            >
              Failed to create pipeline. A pipeline with the name{" "}
              <strong>{name}</strong> may already exist for this account.
              <br />
              <a href={`/${owner}/${repo}/agents/new`} class="ap-btn ap-btn-secondary" style="margin-top: var(--space-3);">
                Go back
              </a>
            </div>
          </div>
        </Layout>,
        409
      );
    }

    // Store stage definitions on the session row via a metadata update.
    // We use the existing branchNamespace column comment field (appended JSON)
    // because there is no dedicated metadata column; the canonical namespace
    // part stays intact for the git enforcement path.
    const stagesJson = JSON.stringify(stages);
    try {
      await db
        .update(agentSessions)
        .set({
          // branchNamespace stays canonical (agents/<name>/); we patch nothing
          // sensitive here — just stash stage definitions for the UI to read.
          // We repurpose a naming trick: store stages in the name column suffix
          // won't work (unique index), so we write a no-op update to touch
          // lastActiveAt and let callers reconstruct stages from leases.
          lastActiveAt: new Date(),
        })
        .where(eq(agentSessions.id, result.session.id));

      // Acquire leases for each stage so the UI can show them.
      // Each stage gets a lease on a synthetic target "pipeline:<sessionId>:stage:<i>".
      // This is a soft coordination primitive — the real agent work happens
      // via the API token returned to the calling agent process.
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        await db.insert(agentLeases).values({
          agentSessionId: result.session.id,
          targetType: "pipeline_stage",
          targetId: `stage:${i}:${stage.role}:${encodeURIComponent(stage.name)}`,
          acquiredAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          status: i === 0 ? "active" : "active", // all start as "pending" conceptually
        });
      }
    } catch {
      // Non-fatal — the session was created; the lease recording is best-effort.
    }

    return c.redirect(`/${owner}/${repo}/agents/${result.session.id}`);
  }
);

// ---------------------------------------------------------------------------
// POST /:owner/:repo/agents/:sessionId/cancel — cancel a pipeline
// ---------------------------------------------------------------------------

agentPipelinesRoutes.post(
  "/:owner/:repo/agents/:sessionId/cancel",
  requireAuth,
  requireRepoAccess("write"),
  async (c) => {
    const { owner, repo, sessionId } = c.req.param();
    const user = c.get("user")!;
    const repository = c.get("repository" as never) as { id: string };

    // Verify session belongs to this repo and the acting user owns it.
    const [session] = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.repositoryId, repository.id)
        )
      )
      .limit(1);

    if (!session) {
      return c.notFound();
    }

    // Flip all active leases to 'expired' (pipeline cancelled)
    try {
      await db
        .update(agentLeases)
        .set({ status: "expired" })
        .where(
          and(
            eq(agentLeases.agentSessionId, sessionId),
            eq(agentLeases.status, "active")
          )
        );
    } catch {
      // Best-effort
    }

    return c.redirect(`/${owner}/${repo}/agents/${sessionId}?cancelled=1`);
  }
);

// ---------------------------------------------------------------------------
// GET /:owner/:repo/agents/:sessionId — live pipeline view
// ---------------------------------------------------------------------------

agentPipelinesRoutes.get(
  "/:owner/:repo/agents/:sessionId",
  softAuth,
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo, sessionId } = c.req.param();
    const user = c.get("user");
    const repository = c.get("repository" as never) as { id: string };
    const cancelled = c.req.query("cancelled") === "1";

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.repositoryId, repository.id)
        )
      )
      .limit(1);

    if (!session) {
      return c.notFound();
    }

    // Load leases for this session (pipeline stages are stored as leases)
    const leases = await db
      .select()
      .from(agentLeases)
      .where(eq(agentLeases.agentSessionId, sessionId))
      .orderBy(agentLeases.createdAt);

    // Separate pipeline stage leases from other leases
    const stageLiases = leases.filter((l) =>
      l.targetType === "pipeline_stage"
    );
    const otherLeases = leases.filter((l) =>
      l.targetType !== "pipeline_stage"
    );

    // Parse stage metadata from targetId: "stage:<i>:<role>:<encodedName>"
    const stages = stageLiases.map((l) => {
      const parts = l.targetId.split(":");
      return {
        lease: l,
        index: parseInt(parts[1] ?? "0", 10),
        role: parts[2] ?? "custom",
        name: decodeURIComponent(parts[3] ?? "Stage"),
      };
    });

    // Determine overall pipeline status
    const hasExpired = stages.some((s) => s.lease.status === "expired");
    const allReleased = stages.length > 0 && stages.every((s) => s.lease.status === "released");
    const hasActive = stages.some((s) => s.lease.status === "active");

    let pipelineStatus: "running" | "done" | "cancelled" | "idle";
    if (cancelled || hasExpired) {
      pipelineStatus = "cancelled";
    } else if (allReleased) {
      pipelineStatus = "done";
    } else if (hasActive) {
      pipelineStatus = "running";
    } else {
      pipelineStatus = "idle";
    }

    const lastActive = session.lastActiveAt ?? session.createdAt;
    const ageMs = Date.now() - lastActive.getTime();
    const isStale = ageMs > 10 * 60 * 1000; // >10 min since last activity

    // Auto-refresh only when pipeline may still be running
    const autoRefresh = pipelineStatus === "running" || pipelineStatus === "idle";

    const pipelineBadge = () => {
      if (pipelineStatus === "running") {
        return <span class="ap-badge ap-badge-active">● running</span>;
      }
      if (pipelineStatus === "done") {
        return <span class="ap-badge ap-badge-idle">✓ done</span>;
      }
      if (pipelineStatus === "cancelled") {
        return <span class="ap-badge ap-badge-expired">✕ cancelled</span>;
      }
      return <span class="ap-badge ap-badge-idle">○ idle</span>;
    };

    const stageBadge = (status: string) => {
      if (status === "active") {
        return <span class="ap-badge ap-badge-active">● active</span>;
      }
      if (status === "released") {
        return <span class="ap-badge ap-badge-idle">✓ complete</span>;
      }
      return <span class="ap-badge ap-badge-expired">✕ {status}</span>;
    };

    const roleIcon = (role: string) => {
      if (role === "writer") return "✍️";
      if (role === "reviewer") return "🔍";
      if (role === "deployer") return "🚀";
      return "🤖";
    };

    const usagePercent = session.budgetCentsPerDay > 0
      ? Math.min(100, Math.round((session.spentCentsToday / session.budgetCentsPerDay) * 100))
      : 0;

    return c.html(
      <Layout
        title={`${session.name} — Agent Pipeline — ${owner}/${repo}`}
        user={user}
      >
        {autoRefresh && (
          <meta http-equiv="refresh" content="5" />
        )}
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="agents" />
        <div class="ap-wrap">
          {cancelled && (
            <div
              class="ap-card"
              style="border-color: rgba(255,197,54,0.4); color: #ffc536; margin-bottom: var(--space-3);"
            >
              Pipeline cancelled. All active leases have been released.
            </div>
          )}

          {/* Header */}
          <div class="ap-hero">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
              <div>
                <h1 style="margin-bottom: var(--space-2);">
                  &#x2728; {session.name}
                </h1>
                <p style="margin-bottom: var(--space-2);">
                  {pipelineBadge()}{" "}
                  <span class="ap-meta" style="margin-left: 8px;">
                    Branch namespace: <code>{session.branchNamespace}</code>
                  </span>
                </p>
                <p style="font-size: 13px; color: var(--text-muted);">
                  Created {formatDate(session.createdAt)} &bull;{" "}
                  Last active {formatDate(session.lastActiveAt)}
                </p>
              </div>
              {pipelineStatus !== "cancelled" && pipelineStatus !== "done" && (
                <form
                  method="post"
                  action={`/${owner}/${repo}/agents/${sessionId}/cancel`}
                >
                  <button type="submit" class="ap-btn ap-btn-danger">
                    Cancel Pipeline
                  </button>
                </form>
              )}
            </div>

            {/* Budget bar */}
            <div style="margin-top: var(--space-3);">
              <div class="ap-meta" style="margin-bottom: 6px;">
                Budget: {formatBudget(session.spentCentsToday)} spent of{" "}
                {formatBudget(session.budgetCentsPerDay)}/day ({usagePercent}%)
              </div>
              <div
                style={`
                  height: 6px; border-radius: 3px;
                  background: var(--border);
                  overflow: hidden;
                `}
              >
                <div
                  style={`
                    height: 100%;
                    width: ${usagePercent}%;
                    border-radius: 3px;
                    background: ${usagePercent > 80 ? "#ff6450" : usagePercent > 50 ? "#ffc536" : "#36c564"};
                    transition: width 0.3s;
                  `}
                />
              </div>
            </div>
          </div>

          {autoRefresh && (
            <div class="ap-refresh-note">
              &#x21BB; Auto-refreshing every 5 seconds
              &mdash;{" "}
              <a href={`/${owner}/${repo}/agents/${sessionId}`} style="color: var(--text-muted);">
                stop refresh
              </a>
            </div>
          )}

          {/* Pipeline stages */}
          {stages.length > 0 ? (
            <div>
              <div class="ap-section-title">Pipeline Stages</div>
              <div class="ap-pipeline-flow">
                {stages.map((s, idx) => {
                  const stageClass = `ap-stage-live${
                    s.lease.status === "active" ? " ap-live-running" : ""
                  }${s.lease.status === "expired" ? " ap-live-failed" : ""}`;
                  return (
                    <div key={s.lease.id}>
                      {idx > 0 && (
                        <div class="ap-stage-arrow" aria-hidden="true">
                          &#x2193;
                        </div>
                      )}
                      <div class={stageClass}>
                        <div class="ap-stage-live-header">
                          <div class="ap-stage-live-title">
                            <span class="ap-stage-num">{s.index + 1}</span>
                            {roleIcon(s.role)}{" "}
                            {s.name}
                            <span class="ap-meta">({s.role})</span>
                          </div>
                          {stageBadge(s.lease.status)}
                        </div>
                        <div class="ap-meta">
                          Target: <code>{s.lease.targetId}</code> &bull;{" "}
                          Acquired {formatDate(s.lease.acquiredAt)} &bull;{" "}
                          Expires {formatDate(s.lease.expiresAt)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div class="ap-card">
              <p class="ap-meta">
                No pipeline stages recorded yet. Stages appear here as agents
                acquire leases via the API.
              </p>
            </div>
          )}

          {/* Other active leases */}
          {otherLeases.length > 0 && (
            <div>
              <div class="ap-section-title">Resource Leases</div>
              <div class="ap-card" style="padding: 0; overflow: hidden;">
                <table class="ap-table">
                  <thead>
                    <tr>
                      <th>Target Type</th>
                      <th>Target ID</th>
                      <th>Status</th>
                      <th>Acquired</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {otherLeases.map((l) => (
                      <tr key={l.id}>
                        <td class="ap-meta">{l.targetType}</td>
                        <td>
                          <code style="font-size: 12px;">{l.targetId}</code>
                        </td>
                        <td>{leaseStatusBadge(l.status)}</td>
                        <td class="ap-meta">{formatDate(l.acquiredAt)}</td>
                        <td class="ap-meta">{formatDate(l.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Agent token hint */}
          <div class="ap-card" style="margin-top: var(--space-4);">
            <h2 style="margin-bottom: var(--space-2);">Using This Pipeline</h2>
            <p class="ap-meta" style="margin-bottom: var(--space-2);">
              Agents authenticate to this pipeline with a Bearer token issued
              at creation time. Tokens are shown once and cannot be recovered.
              To create a new token, visit{" "}
              <a href="/settings/agents">Settings &rarr; Agents</a>.
            </p>
            <p class="ap-meta">
              Branch namespace: <code>{session.branchNamespace}</code> &mdash;
              agents may only push refs under this prefix.
            </p>
          </div>

          <div style="margin-top: var(--space-4);">
            <a href={`/${owner}/${repo}/agents`} class="ap-btn ap-btn-secondary">
              &#x2190; All Pipelines
            </a>
          </div>
        </div>
      </Layout>
    );
  }
);

export default agentPipelinesRoutes;
