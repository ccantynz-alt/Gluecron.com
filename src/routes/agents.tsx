/**
 * Block K8 — Agent inbox + controls UI.
 *
 *   GET  /:owner/:repo/agents                     list recent agent runs (owner or public)
 *   GET  /:owner/:repo/agents/:id                 detail view with log + kill button
 *   POST /:owner/:repo/agents/:id/kill            owner-only; flips status to killed
 *   GET  /:owner/:repo/settings/agents            owner-only; per-repo toggles + budgets
 *   POST /:owner/:repo/settings/agents            owner-only; upserts repo_agent_settings
 *   POST /:owner/:repo/settings/agents/pause      owner-only; toggles paused flag
 *   GET  /admin/agents                             site-admin; recent runs across all repos
 *   POST /admin/agents/pause-all                   site-admin; sets system flag agents_paused=true
 */

import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { agentRuns, repositories, users } from "../db/schema";
import type { AgentKind, AgentRunStatus } from "../lib/agent-runtime";
import { killAgentRun } from "../lib/agent-runtime";
import { isSiteAdmin, setFlag } from "../lib/admin";
import { audit } from "../lib/notify";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const AGENT_KINDS: AgentKind[] = [
  "triage",
  "fix",
  "review_response",
  "deploy_watcher",
  "heal_bot",
  "custom",
];

export interface AgentSettingsInput {
  enabled_kinds?: string | string[];
  daily_budget_cents?: string;
  monthly_budget_cents?: string;
  max_runs_per_hour?: string;
  paused?: string;
}

export interface ParsedAgentSettings {
  enabledKinds: AgentKind[];
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  maxRunsPerHour: number;
  paused: boolean;
}

/** Pure form parser — defensive coercion + allowlist filtering. */
export function parseAgentSettingsForm(
  input: AgentSettingsInput
): ParsedAgentSettings {
  const rawKinds = input.enabled_kinds;
  const kindsArray = Array.isArray(rawKinds)
    ? rawKinds
    : typeof rawKinds === "string" && rawKinds.length > 0
    ? rawKinds.split(",")
    : [];
  const enabledKinds = kindsArray
    .map((k) => String(k).trim())
    .filter((k): k is AgentKind =>
      AGENT_KINDS.includes(k as AgentKind)
    );

  const clampInt = (v: string | undefined, def: number, max: number) => {
    const n = Number.parseInt(String(v ?? ""), 10);
    if (!Number.isFinite(n) || n < 0) return def;
    return Math.min(n, max);
  };

  return {
    enabledKinds,
    dailyBudgetCents: clampInt(input.daily_budget_cents, 100, 1_000_000),
    monthlyBudgetCents: clampInt(input.monthly_budget_cents, 2000, 50_000_000),
    maxRunsPerHour: clampInt(input.max_runs_per_hour, 20, 1000),
    paused: input.paused === "on" || input.paused === "true",
  };
}

async function loadRepo(ownerName: string, repoName: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        isPrivate: repositories.isPrivate,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(eq(users.username, ownerName), eq(repositories.name, repoName))
      )
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

async function loadSettings(repoId: string): Promise<ParsedAgentSettings> {
  try {
    const result = await db.execute(sql`
      SELECT enabled_kinds, daily_budget_cents, monthly_budget_cents,
             max_runs_per_hour, paused
      FROM repo_agent_settings
      WHERE repository_id = ${repoId}
      LIMIT 1
    `);
    const row = (result as unknown as { rows?: unknown[] }).rows?.[0] as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return {
        enabledKinds: [],
        dailyBudgetCents: 100,
        monthlyBudgetCents: 2000,
        maxRunsPerHour: 20,
        paused: false,
      };
    }
    let enabledKinds: AgentKind[] = [];
    try {
      const parsed = JSON.parse(String(row.enabled_kinds ?? "[]"));
      if (Array.isArray(parsed)) {
        enabledKinds = parsed.filter((k): k is AgentKind =>
          AGENT_KINDS.includes(k as AgentKind)
        );
      }
    } catch {
      /* keep empty */
    }
    return {
      enabledKinds,
      dailyBudgetCents: Number(row.daily_budget_cents ?? 100),
      monthlyBudgetCents: Number(row.monthly_budget_cents ?? 2000),
      maxRunsPerHour: Number(row.max_runs_per_hour ?? 20),
      paused: row.paused === true || row.paused === "t",
    };
  } catch {
    return {
      enabledKinds: [],
      dailyBudgetCents: 100,
      monthlyBudgetCents: 2000,
      maxRunsPerHour: 20,
      paused: false,
    };
  }
}

async function upsertSettings(repoId: string, s: ParsedAgentSettings) {
  await db.execute(sql`
    INSERT INTO repo_agent_settings
      (repository_id, enabled_kinds, daily_budget_cents,
       monthly_budget_cents, max_runs_per_hour, paused, updated_at)
    VALUES
      (${repoId}, ${JSON.stringify(s.enabledKinds)}, ${s.dailyBudgetCents},
       ${s.monthlyBudgetCents}, ${s.maxRunsPerHour}, ${s.paused}, now())
    ON CONFLICT (repository_id) DO UPDATE SET
      enabled_kinds = EXCLUDED.enabled_kinds,
      daily_budget_cents = EXCLUDED.daily_budget_cents,
      monthly_budget_cents = EXCLUDED.monthly_budget_cents,
      max_runs_per_hour = EXCLUDED.max_runs_per_hour,
      paused = EXCLUDED.paused,
      updated_at = now()
  `);
}

function statusClass(s: string): string {
  if (s === "succeeded") return "gate-status passed";
  if (s === "failed" || s === "timeout" || s === "killed")
    return "gate-status failed";
  if (s === "running") return "gate-status running";
  return "gate-status pending";
}

function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function triggerLink(
  owner: string,
  repo: string,
  kind: string,
  ref: string | null
): string | null {
  if (!ref) return null;
  if (kind === "triage" || kind === "fix" || kind === "review_response") {
    const n = ref.split(":")[0];
    if (/^\d+$/.test(n)) return `/${owner}/${repo}/pulls/${n}`;
  }
  return null;
}

const agents = new Hono<AuthEnv>();
agents.use("*", softAuth);

// ---------- per-repo inbox ----------

agents.get("/:owner/:repo/agents", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.isPrivate && (!user || user.id !== repoRow.ownerId)) {
    return c.redirect("/login");
  }

  const kindFilter = c.req.query("kind") as AgentKind | undefined;
  const statusFilter = c.req.query("status") as AgentRunStatus | undefined;

  const conditions = [eq(agentRuns.repositoryId, repoRow.id)];
  if (kindFilter && AGENT_KINDS.includes(kindFilter)) {
    conditions.push(eq(agentRuns.kind, kindFilter));
  }
  if (statusFilter) {
    conditions.push(eq(agentRuns.status, statusFilter));
  }

  const runs = await db
    .select()
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.createdAt))
    .limit(200);

  return c.html(
    <Layout title={`Agents — ${owner}/${repo}`} user={user ?? undefined}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username}
      />
      <RepoNav owner={owner} repo={repo} active="agents" />

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3>Agent runs</h3>
        {user && user.id === repoRow.ownerId && (
          <a
            href={`/${owner}/${repo}/settings/agents`}
            class="btn btn-sm"
          >
            Settings
          </a>
        )}
      </div>

      <form method="GET" style="margin-bottom:16px;display:flex;gap:8px">
        <select name="kind">
          <option value="">All kinds</option>
          {AGENT_KINDS.map((k) => (
            <option value={k} selected={k === kindFilter}>
              {k}
            </option>
          ))}
        </select>
        <select name="status">
          <option value="">All statuses</option>
          {["queued", "running", "succeeded", "failed", "killed", "timeout"].map(
            (s) => (
              <option value={s} selected={s === statusFilter}>
                {s}
              </option>
            )
          )}
        </select>
        <button type="submit" class="btn btn-sm">
          Filter
        </button>
      </form>

      <div class="panel">
        {runs.length === 0 ? (
          <div class="panel-empty">No agent runs yet.</div>
        ) : (
          <table style="width:100%;font-size:13px">
            <thead>
              <tr>
                <th style="text-align:left;padding:8px">Kind</th>
                <th style="text-align:left;padding:8px">Trigger</th>
                <th style="text-align:left;padding:8px">Status</th>
                <th style="text-align:left;padding:8px">Ref</th>
                <th style="text-align:right;padding:8px">Cost</th>
                <th style="text-align:left;padding:8px">Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const link = triggerLink(owner, repo, r.kind, r.triggerRef);
                return (
                  <tr>
                    <td style="padding:8px">
                      <code>{r.kind}</code>
                    </td>
                    <td style="padding:8px">{r.trigger}</td>
                    <td style="padding:8px">
                      <span class={statusClass(r.status)}>{r.status}</span>
                    </td>
                    <td style="padding:8px">
                      {link ? (
                        <a href={link}>{r.triggerRef}</a>
                      ) : (
                        r.triggerRef || "—"
                      )}
                    </td>
                    <td style="padding:8px;text-align:right">
                      {formatCost(r.costCents)}
                    </td>
                    <td style="padding:8px">
                      {r.createdAt?.toISOString().slice(0, 19) || "—"}
                    </td>
                    <td style="padding:8px">
                      <a
                        href={`/${owner}/${repo}/agents/${r.id}`}
                        class="btn btn-sm"
                      >
                        view
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
});

agents.get("/:owner/:repo/agents/:id", async (c) => {
  const user = c.get("user");
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.isPrivate && (!user || user.id !== repoRow.ownerId)) {
    return c.redirect("/login");
  }

  const [run] = await db
    .select()
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, id), eq(agentRuns.repositoryId, repoRow.id))
    )
    .limit(1);
  if (!run) return c.notFound();

  const isOwner = user?.id === repoRow.ownerId;
  const canKill =
    isOwner && (run.status === "queued" || run.status === "running");

  const durationMs =
    run.startedAt && run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;

  const link = triggerLink(owner, repo, run.kind, run.triggerRef);

  return c.html(
    <Layout title={`Agent run ${run.id}`} user={user ?? undefined}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username}
      />
      <RepoNav owner={owner} repo={repo} active="agents" />

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3>
          Agent run · <code>{run.kind}</code>
        </h3>
        <a href={`/${owner}/${repo}/agents`} class="btn btn-sm">
          Back
        </a>
      </div>

      <div class="panel" style="padding:16px;margin-bottom:16px">
        <div>
          Status: <span class={statusClass(run.status)}>{run.status}</span>
        </div>
        <div>Trigger: {run.trigger}</div>
        {run.triggerRef && (
          <div>
            Ref: {link ? <a href={link}>{run.triggerRef}</a> : run.triggerRef}
          </div>
        )}
        {run.summary && <div>Summary: {run.summary}</div>}
        <div>
          Cost: {formatCost(run.costCents)} ({run.costInputTokens} in /{" "}
          {run.costOutputTokens} out tokens)
        </div>
        {durationMs !== null && (
          <div>Duration: {(durationMs / 1000).toFixed(1)}s</div>
        )}
        {run.errorMessage && (
          <div style="color:var(--red);margin-top:8px">
            <strong>Error:</strong>
            <pre style="white-space:pre-wrap;margin-top:4px">
              {run.errorMessage}
            </pre>
          </div>
        )}
      </div>

      {canKill && (
        <form
          method="POST"
          action={`/${owner}/${repo}/agents/${run.id}/kill`}
          style="margin-bottom:16px"
          onsubmit="return confirm('Kill this running agent?')"
        >
          <button type="submit" class="btn btn-danger">
            Kill run
          </button>
        </form>
      )}

      <div class="panel">
        <div class="panel-item" style="flex-direction:column;align-items:flex-start">
          <strong>Log</strong>
          <pre style="white-space:pre-wrap;font-size:12px;width:100%;margin-top:8px;max-height:400px;overflow:auto">
            {run.log || "(empty)"}
          </pre>
        </div>
      </div>
    </Layout>
  );
});

agents.post("/:owner/:repo/agents/:id/kill", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}/agents`);
  }
  await killAgentRun(id);
  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "agent.kill",
    targetId: id,
  });
  return c.redirect(`/${owner}/${repo}/agents/${id}`);
});

// ---------- per-repo settings ----------

agents.get("/:owner/:repo/settings/agents", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }
  const settings = await loadSettings(repoRow.id);

  return c.html(
    <Layout title={`Agent settings — ${repo}`} user={user}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user.username}
      />
      <RepoNav owner={owner} repo={repo} active="agents" />

      <h3>Agent settings</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
        Enable specific agent kinds for this repository and set budget caps.
        Pausing stops all scheduled agents immediately.
      </p>

      <form
        method="POST"
        action={`/${owner}/${repo}/settings/agents`}
        class="panel"
        style="padding:16px"
      >
        <div class="form-group">
          <label>
            <strong>Enabled kinds</strong>
          </label>
          {AGENT_KINDS.map((k) => (
            <label style="display:block;margin:4px 0">
              <input
                type="checkbox"
                name="enabled_kinds"
                value={k}
                checked={settings.enabledKinds.includes(k)}
              />{" "}
              <code>{k}</code>
            </label>
          ))}
        </div>
        <div class="form-group">
          <label>Daily budget (cents)</label>
          <input
            type="number"
            name="daily_budget_cents"
            value={String(settings.dailyBudgetCents)}
            min="0"
            max="1000000"
          />
        </div>
        <div class="form-group">
          <label>Monthly budget (cents)</label>
          <input
            type="number"
            name="monthly_budget_cents"
            value={String(settings.monthlyBudgetCents)}
            min="0"
            max="50000000"
          />
        </div>
        <div class="form-group">
          <label>Max runs per hour</label>
          <input
            type="number"
            name="max_runs_per_hour"
            value={String(settings.maxRunsPerHour)}
            min="0"
            max="1000"
          />
        </div>
        <div class="form-group">
          <label>
            <input
              type="checkbox"
              name="paused"
              checked={settings.paused}
            />{" "}
            Paused (all agents disabled)
          </label>
        </div>
        <button type="submit" class="btn btn-primary">
          Save settings
        </button>
      </form>

      <form
        method="POST"
        action={`/${owner}/${repo}/settings/agents/pause`}
        style="margin-top:16px"
      >
        <button type="submit" class="btn btn-sm">
          Toggle paused
        </button>
      </form>
    </Layout>
  );
});

agents.post("/:owner/:repo/settings/agents", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }
  const body = await c.req.parseBody({ all: true });
  const parsed = parseAgentSettingsForm(
    body as unknown as AgentSettingsInput
  );

  try {
    await upsertSettings(repoRow.id, parsed);
  } catch (err) {
    console.error("[agents] upsertSettings:", err);
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "agent.settings.update",
    metadata: {
      enabledKinds: parsed.enabledKinds,
      daily: parsed.dailyBudgetCents,
      monthly: parsed.monthlyBudgetCents,
    },
  });

  return c.redirect(`/${owner}/${repo}/settings/agents`);
});

agents.post("/:owner/:repo/settings/agents/pause", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(`/${owner}/${repo}`);
  }
  const cur = await loadSettings(repoRow.id);
  try {
    await upsertSettings(repoRow.id, { ...cur, paused: !cur.paused });
  } catch (err) {
    console.error("[agents] pause:", err);
  }
  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "agent.settings.pause",
    metadata: { paused: !cur.paused },
  });
  return c.redirect(`/${owner}/${repo}/settings/agents`);
});

// ---------- site-admin ----------

agents.get("/admin/agents", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) return c.redirect("/");

  const runs = await db
    .select({
      id: agentRuns.id,
      kind: agentRuns.kind,
      trigger: agentRuns.trigger,
      status: agentRuns.status,
      costCents: agentRuns.costCents,
      createdAt: agentRuns.createdAt,
      repoId: agentRuns.repositoryId,
      repoName: repositories.name,
      ownerUsername: users.username,
    })
    .from(agentRuns)
    .leftJoin(repositories, eq(repositories.id, agentRuns.repositoryId))
    .leftJoin(users, eq(users.id, repositories.ownerId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(500);

  const todayCostCents = runs
    .filter((r) => {
      const d = r.createdAt ? new Date(r.createdAt) : null;
      if (!d) return false;
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      return d.getTime() >= dayAgo;
    })
    .reduce((sum, r) => sum + (r.costCents || 0), 0);

  return c.html(
    <Layout title="Admin — Agents" user={user}>
      <h2>Admin · Agents</h2>
      <div class="panel" style="padding:16px;margin-bottom:16px">
        <div>
          <strong>24h spend:</strong> {formatCost(todayCostCents)}
        </div>
        <div>
          <strong>Recent runs:</strong> {runs.length}
        </div>
      </div>

      <form
        method="POST"
        action="/admin/agents/pause-all"
        style="margin-bottom:16px"
        onsubmit="return confirm('Pause ALL agents platform-wide?')"
      >
        <button type="submit" class="btn btn-danger">
          Pause all agents (platform kill-switch)
        </button>
      </form>

      <div class="panel">
        {runs.length === 0 ? (
          <div class="panel-empty">No agent runs.</div>
        ) : (
          <table style="width:100%;font-size:13px">
            <thead>
              <tr>
                <th style="text-align:left;padding:8px">Repo</th>
                <th style="text-align:left;padding:8px">Kind</th>
                <th style="text-align:left;padding:8px">Status</th>
                <th style="text-align:right;padding:8px">Cost</th>
                <th style="text-align:left;padding:8px">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr>
                  <td style="padding:8px">
                    {r.ownerUsername && r.repoName ? (
                      <a href={`/${r.ownerUsername}/${r.repoName}/agents/${r.id}`}>
                        {r.ownerUsername}/{r.repoName}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style="padding:8px">
                    <code>{r.kind}</code>
                  </td>
                  <td style="padding:8px">
                    <span class={statusClass(r.status)}>{r.status}</span>
                  </td>
                  <td style="padding:8px;text-align:right">
                    {formatCost(r.costCents || 0)}
                  </td>
                  <td style="padding:8px">
                    {r.createdAt?.toISOString().slice(0, 19) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
});

agents.post("/admin/agents/pause-all", requireAuth, async (c) => {
  const user = c.get("user")!;
  if (!(await isSiteAdmin(user.id))) return c.redirect("/");
  await setFlag("agents_paused", "true", user.id);
  await audit({
    userId: user.id,
    action: "admin.agents.pause_all",
  });
  return c.redirect("/admin/agents");
});

export default agents;
