/**
 * Environments + deployment history UI.
 *
 * Routes:
 *   GET /:owner/:repo/deployments            full deploy history per env
 *   GET /:owner/:repo/deployments/:id        single deployment detail
 *
 * Data comes from the `deployments` table populated by Crontech / gate
 * logic on successful push to the default branch.
 *
 * 2026 polish:
 *   - Page-level eyebrow + display headline + subtitle.
 *   - Each environment is its own polished card with a header strip
 *     (status pill + success rate), and a list of recent deploys as
 *     mini cards (mono SHA, status dot, tabular-nums relative time).
 *   - Empty state is a dashed card with an orb + helpful CTA copy.
 *   - All CSS scoped under `.dk-*` to avoid bleed.
 *
 * Hard rules preserved:
 *   - Every route, form action, POST handler, and DB query is unchanged.
 *   - Layout / ui.tsx / components.tsx are not modified.
 */

import { Hono } from "hono";
import { desc, eq, and } from "drizzle-orm";
import { db } from "../db";
import { deployments, repositories, users } from "../db/schema";
import type { AuthEnv } from "../middleware/auth";
import { softAuth, requireAuth } from "../middleware/auth";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { onDeployFailure } from "../lib/ai-incident";

const dep = new Hono<AuthEnv>();

dep.use("/:owner/:repo/deployments", softAuth);
dep.use("/:owner/:repo/deployments/*", softAuth);

type Row = typeof deployments.$inferSelect & { triggeredByName: string | null };

/* ─────────────────────────────────────────────────────────────────────────
 * Scoped CSS — every class prefixed `.dk-` so this page can't bleed into
 * other surfaces. Mirrors the section-card + traffic-light patterns from
 * admin-integrations.tsx and admin-ops.tsx.
 * ───────────────────────────────────────────────────────────────────── */
const deployStyles = `
  .dk-wrap { max-width: 920px; margin: 0 auto; padding: var(--space-6) var(--space-4); }

  /* ─── Page heading (no hero block — RepoHeader supplies framing) ─── */
  .dk-head { margin-bottom: var(--space-5); }
  .dk-eyebrow {
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
    letter-spacing: 0.02em;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-transform: uppercase;
  }
  .dk-eyebrow-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px; height: 18px;
    border-radius: 6px;
    background: rgba(140,109,255,0.14);
    color: #b69dff;
    box-shadow: inset 0 0 0 1px rgba(140,109,255,0.35);
  }
  .dk-title {
    font-size: clamp(24px, 3.2vw, 32px);
    font-family: var(--font-display);
    font-weight: 800;
    letter-spacing: -0.024em;
    line-height: 1.08;
    margin: 0 0 var(--space-2);
    color: var(--text-strong);
  }
  .dk-title-grad {
    background-image: linear-gradient(135deg, #a48bff 0%, #8c6dff 50%, #36c5d6 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
  }
  .dk-sub {
    font-size: 14.5px;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.55;
    max-width: 620px;
  }
  .dk-sub code {
    font-family: var(--font-mono);
    font-size: 12.5px;
    background: var(--bg-tertiary);
    padding: 1px 5px;
    border-radius: 4px;
  }

  /* ─── Env section cards ─── */
  .dk-envs { display: flex; flex-direction: column; gap: var(--space-4); }
  .dk-env {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    transition: border-color 140ms ease;
  }
  .dk-env:hover { border-color: var(--border-strong); }
  .dk-env-head {
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    background: rgba(255,255,255,0.012);
  }
  .dk-env-name {
    margin: 0;
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-strong);
    letter-spacing: -0.012em;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dk-env-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--text-muted);
    flex-wrap: wrap;
  }
  .dk-env-rate {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    color: var(--text);
  }
  .dk-env-body { padding: var(--space-2) 0; }

  /* ─── Run rows ─── */
  .dk-run {
    display: grid;
    grid-template-columns: 80px 90px 1fr auto auto auto auto;
    align-items: center;
    gap: 12px;
    padding: 10px var(--space-5);
    border-top: 1px solid rgba(255,255,255,0.04);
    font-size: 12.5px;
  }
  .dk-run:first-child { border-top: none; }
  .dk-run:hover { background: rgba(255,255,255,0.02); }
  .dk-run .dk-sha {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-strong);
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 6px;
    width: max-content;
  }
  .dk-run .dk-ref {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dk-run .dk-target {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .dk-run .dk-by { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
  .dk-run .dk-time {
    font-size: 11.5px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .dk-run .dk-link {
    font-size: 11.5px;
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .dk-run .dk-link:hover { text-decoration: underline; }
  .dk-run-more {
    padding: 10px var(--space-5);
    font-size: 12px;
    color: var(--text-muted);
    border-top: 1px solid rgba(255,255,255,0.04);
    text-align: center;
  }
  @media (max-width: 760px) {
    .dk-run {
      grid-template-columns: 80px 1fr auto;
      grid-template-areas:
        "status sha link"
        "ref ref ref"
        "meta meta meta";
      row-gap: 6px;
    }
    .dk-run .dk-status { grid-area: status; }
    .dk-run .dk-sha { grid-area: sha; }
    .dk-run .dk-link { grid-area: link; justify-self: end; }
    .dk-run .dk-ref { grid-area: ref; }
    .dk-run .dk-target,
    .dk-run .dk-by,
    .dk-run .dk-time { grid-area: meta; display: inline; margin-right: 10px; }
  }

  /* ─── Status pill (gate-status replacement) ─── */
  .dk-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 9px;
    border-radius: 9999px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    width: max-content;
  }
  .dk-status .dot {
    width: 6px; height: 6px;
    border-radius: 9999px;
    background: currentColor;
  }
  .dk-status.is-success {
    background: rgba(52,211,153,0.14);
    color: #6ee7b7;
    box-shadow: inset 0 0 0 1px rgba(52,211,153,0.32);
  }
  .dk-status.is-failed {
    background: rgba(248,113,113,0.14);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,0.32);
  }
  .dk-status.is-blocked {
    background: rgba(251,191,36,0.12);
    color: #fde68a;
    box-shadow: inset 0 0 0 1px rgba(251,191,36,0.30);
  }
  .dk-status.is-running {
    background: rgba(96,165,250,0.14);
    color: #bfdbfe;
    box-shadow: inset 0 0 0 1px rgba(96,165,250,0.32);
  }
  .dk-status.is-other {
    background: rgba(107,114,128,0.16);
    color: #d1d5db;
    box-shadow: inset 0 0 0 1px rgba(107,114,128,0.32);
  }

  /* ─── Empty state ─── */
  .dk-empty {
    position: relative;
    padding: var(--space-6) var(--space-5);
    border: 1px dashed var(--border-strong);
    border-radius: 16px;
    background: rgba(255,255,255,0.02);
    text-align: center;
    overflow: hidden;
  }
  .dk-empty-orb {
    position: absolute;
    inset: -40% -10% auto auto;
    width: 320px; height: 320px;
    background: radial-gradient(circle, rgba(140,109,255,0.20), rgba(54,197,214,0.10) 45%, transparent 70%);
    filter: blur(70px);
    opacity: 0.6;
    pointer-events: none;
    z-index: 0;
  }
  .dk-empty-inner { position: relative; z-index: 1; }
  .dk-empty-title {
    font-family: var(--font-display);
    font-size: 17px;
    font-weight: 700;
    color: var(--text-strong);
    margin: 0 0 6px;
    letter-spacing: -0.018em;
  }
  .dk-empty-sub {
    font-size: 13.5px;
    color: var(--text-muted);
    margin: 0 auto;
    max-width: 480px;
    line-height: 1.5;
  }

  /* ─── Detail page ─── */
  .dk-detail-wrap { max-width: 760px; margin: 0 auto; padding: var(--space-6) var(--space-4); }
  .dk-bread {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    color: var(--text-muted);
    margin-bottom: var(--space-3);
  }
  .dk-bread a { color: var(--accent); text-decoration: none; }
  .dk-bread a:hover { text-decoration: underline; }
  .dk-detail-title {
    font-family: var(--font-display);
    font-size: clamp(20px, 2.6vw, 26px);
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text-strong);
    margin: 0 0 var(--space-4);
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .dk-detail-sha {
    font-family: var(--font-mono);
    font-size: 16px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 3px 10px;
    border-radius: 8px;
  }
  .dk-detail-arrow { color: var(--text-muted); font-weight: 500; }
  .dk-detail-env { color: var(--text); }
  .dk-detail-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .dk-kv { width: 100%; border-collapse: collapse; font-size: 13px; }
  .dk-kv th, .dk-kv td {
    padding: 10px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .dk-kv tr:last-child th, .dk-kv tr:last-child td { border-bottom: none; }
  .dk-kv th {
    width: 160px;
    font-weight: 600;
    color: var(--text-muted);
    background: rgba(255,255,255,0.012);
    font-family: var(--font-mono);
    font-size: 12px;
    letter-spacing: -0.005em;
  }
  .dk-kv td { color: var(--text); }
  .dk-kv td code,
  .dk-kv td a code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 6px;
    word-break: break-all;
  }
  .dk-kv td a { color: var(--accent); text-decoration: none; }
  .dk-kv td a:hover { text-decoration: underline; }
  .dk-kv .dk-blocked { color: #fca5a5; }
  .dk-retry {
    margin-top: var(--space-4);
    display: flex;
    justify-content: flex-end;
  }
  .dk-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    border: 1px solid transparent;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
  }
  .dk-btn-ghost {
    background: rgba(255,255,255,0.03);
    border-color: var(--border);
    color: var(--text);
  }
  .dk-btn-ghost:hover {
    background: rgba(255,255,255,0.06);
    border-color: var(--border-strong);
    color: var(--text-strong);
  }
`;

async function resolveRepo(owner: string, name: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(and(eq(users.username, owner), eq(repositories.name, name)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

/** Parse "auto-issue #42" from a blockedReason string. Returns null if absent. */
function parseAutoIssueNumber(blockedReason: string | null): number | null {
  if (!blockedReason) return null;
  const m = blockedReason.match(/auto-issue #(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function statusClass(status: string): string {
  switch (status) {
    case "success":
      return "dk-status is-success";
    case "failed":
      return "dk-status is-failed";
    case "blocked":
      return "dk-status is-blocked";
    case "running":
    case "pending":
      return "dk-status is-running";
    default:
      return "dk-status is-other";
  }
}

function fmtTs(t: Date | null | undefined): string {
  if (!t) return "—";
  return new Date(t).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/** Render a relative time like "12s ago", "3m ago", "2h ago", "3d ago". */
function dkRelativeTime(from: Date | null, now: Date = new Date()): string {
  if (!from) return "—";
  const ms = now.getTime() - new Date(from).getTime();
  if (ms < 5_000) return "just now";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function groupByEnv(rows: Row[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const r of rows) {
    (out[r.environment] ||= []).push(r);
  }
  return out;
}

function envSummary(rows: Row[]): { last: Row | undefined; successRate: number } {
  const last = rows[0];
  const recent = rows.slice(0, 20);
  const successes = recent.filter((r) => r.status === "success").length;
  const rate = recent.length ? successes / recent.length : 1;
  return { last, successRate: rate };
}

dep.get("/:owner/:repo/deployments", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const repoRow = await resolveRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let rows: Row[] = [];
  try {
    rows = (await db
      .select({
        id: deployments.id,
        repositoryId: deployments.repositoryId,
        environment: deployments.environment,
        commitSha: deployments.commitSha,
        ref: deployments.ref,
        status: deployments.status,
        blockedReason: deployments.blockedReason,
        target: deployments.target,
        triggeredBy: deployments.triggeredBy,
        createdAt: deployments.createdAt,
        completedAt: deployments.completedAt,
        triggeredByName: users.username,
      })
      .from(deployments)
      .leftJoin(users, eq(users.id, deployments.triggeredBy))
      .where(eq(deployments.repositoryId, repoRow.id))
      .orderBy(desc(deployments.createdAt))
      .limit(500)) as Row[];
  } catch (err) {
    console.error("[deployments] list:", err);
  }

  const envs = groupByEnv(rows);
  const envNames = Object.keys(envs).sort();

  return c.html(
    <Layout title={`${owner}/${repo} — deployments`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <div class="dk-wrap">
        <header class="dk-head">
          <div class="dk-eyebrow">
            <span class="dk-eyebrow-pill" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12h4l3 8 4-16 3 8h4" />
              </svg>
            </span>
            Deployments · {owner}/{repo}
          </div>
          <h2 class="dk-title">
            <span class="dk-title-grad">Shipped</span>, env by env.
          </h2>
          <p class="dk-sub">
            Every deploy to every environment, newest first. Rolled up by
            environment with the latest status and success rate across the
            last 20 runs.
          </p>
        </header>

        {envNames.length === 0 ? (
          <div class="dk-empty">
            <div class="dk-empty-orb" aria-hidden="true" />
            <div class="dk-empty-inner">
              <p class="dk-empty-title">No deployments yet</p>
              <p class="dk-empty-sub">
                When a green push reaches the default branch and a deploy
                target is configured, deploys land here — with status, SHA,
                and the operator who shipped it.
              </p>
            </div>
          </div>
        ) : (
          <div class="dk-envs">
            {envNames.map((env) => {
              const envRows = envs[env];
              const { last, successRate } = envSummary(envRows);
              const rate = Math.round(successRate * 100);
              return (
                <section class="dk-env" aria-label={`Environment ${env}`}>
                  <header class="dk-env-head">
                    <h3 class="dk-env-name">{env}</h3>
                    <div class="dk-env-meta">
                      {last && (
                        <span class={statusClass(last.status)}>
                          <span class="dot" aria-hidden="true" />
                          {last.status}
                        </span>
                      )}
                      <span class="dk-env-rate">
                        {rate}% green · {envRows.length} total
                      </span>
                    </div>
                  </header>
                  <div class="dk-env-body">
                    {envRows.slice(0, 10).map((r) => (
                      <div class="dk-run">
                        <span class={statusClass(r.status)}>
                          <span class="dot" aria-hidden="true" />
                          {r.status}
                        </span>
                        <code class="dk-sha">{r.commitSha.slice(0, 7)}</code>
                        <span class="dk-ref">
                          {r.ref.replace(/^refs\/heads\//, "")}
                        </span>
                        <span class="dk-target">{r.target || "—"}</span>
                        <span class="dk-by">
                          by {r.triggeredByName || "system"}
                        </span>
                        <span
                          class="dk-time"
                          title={fmtTs(r.createdAt)}
                        >
                          {dkRelativeTime(r.createdAt)}
                        </span>
                        <a
                          href={`/${owner}/${repo}/deployments/${r.id}`}
                          class="dk-link"
                        >
                          details
                        </a>
                      </div>
                    ))}
                    {envRows.length > 10 && (
                      <div class="dk-run-more">
                        + {envRows.length - 10} more{"…"}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: deployStyles }} />
    </Layout>
  );
});

dep.get("/:owner/:repo/deployments/:id", async (c) => {
  const { owner, repo, id } = c.req.param();
  const user = c.get("user");
  const repoRow = await resolveRepo(owner, repo);
  if (!repoRow) return c.notFound();

  let row: Row | null = null;
  try {
    const [r] = await db
      .select({
        id: deployments.id,
        repositoryId: deployments.repositoryId,
        environment: deployments.environment,
        commitSha: deployments.commitSha,
        ref: deployments.ref,
        status: deployments.status,
        blockedReason: deployments.blockedReason,
        target: deployments.target,
        triggeredBy: deployments.triggeredBy,
        createdAt: deployments.createdAt,
        completedAt: deployments.completedAt,
        triggeredByName: users.username,
      })
      .from(deployments)
      .leftJoin(users, eq(users.id, deployments.triggeredBy))
      .where(
        and(eq(deployments.id, id), eq(deployments.repositoryId, repoRow.id))
      )
      .limit(1);
    row = (r as Row) || null;
  } catch (err) {
    console.error("[deployments] detail:", err);
  }

  if (!row) return c.notFound();

  const autoIssue = parseAutoIssueNumber(row.blockedReason);

  return c.html(
    <Layout
      title={`Deploy ${row.commitSha.slice(0, 7)} → ${row.environment}`}
      user={user}
    >
      <RepoHeader owner={owner} repo={repo} />
      <div class="dk-detail-wrap">
        <div class="dk-bread">
          <a href={`/${owner}/${repo}/deployments`}>deployments</a>
          <span aria-hidden="true">/</span>
          <span>{row.id.slice(0, 8)}</span>
        </div>
        <h2 class="dk-detail-title">
          <span class={statusClass(row.status)}>
            <span class="dot" aria-hidden="true" />
            {row.status}
          </span>
          <span class="dk-detail-sha">{row.commitSha.slice(0, 7)}</span>
          <span class="dk-detail-arrow" aria-hidden="true">&rarr;</span>
          <span class="dk-detail-env">{row.environment}</span>
        </h2>
        <div class="dk-detail-card">
          <table class="dk-kv">
            <tbody>
              <tr>
                <th>Target</th>
                <td>{row.target || "—"}</td>
              </tr>
              <tr>
                <th>Ref</th>
                <td>
                  <code>{row.ref}</code>
                </td>
              </tr>
              <tr>
                <th>Commit</th>
                <td>
                  <a href={`/${owner}/${repo}/commit/${row.commitSha}`}>
                    <code>{row.commitSha}</code>
                  </a>
                </td>
              </tr>
              <tr>
                <th>Triggered by</th>
                <td>{row.triggeredByName || "system"}</td>
              </tr>
              <tr>
                <th>Created</th>
                <td>
                  {fmtTs(row.createdAt)}{" "}
                  <span style="color:var(--text-muted);font-variant-numeric:tabular-nums">
                    ({dkRelativeTime(row.createdAt)})
                  </span>
                </td>
              </tr>
              <tr>
                <th>Completed</th>
                <td>
                  {fmtTs(row.completedAt)}
                  {row.completedAt && (
                    <span style="color:var(--text-muted);font-variant-numeric:tabular-nums">
                      {" "}({dkRelativeTime(row.completedAt)})
                    </span>
                  )}
                </td>
              </tr>
              {row.blockedReason && (
                <tr>
                  <th>Blocked reason</th>
                  <td class="dk-blocked">{row.blockedReason}</td>
                </tr>
              )}
              {autoIssue !== null && (
                <tr>
                  <th>Incident issue</th>
                  <td>
                    <a href={`/${owner}/${repo}/issues/${autoIssue}`}>
                      #{autoIssue}
                    </a>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {row.status === "failed" && (
          <form
            method="post"
            action={`/${owner}/${repo}/deployments/${row.id}/retry-incident`}
            class="dk-retry"
          >
            <button type="submit" class="dk-btn dk-btn-ghost">
              Re-run incident analysis
            </button>
          </form>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: deployStyles }} />
    </Layout>
  );
});

// D4: re-trigger the AI incident responder for a failed deployment. Owner-only.
// Redirects back to the deployment detail page in all cases.
dep.post(
  "/:owner/:repo/deployments/:id/retry-incident",
  requireAuth,
  async (c) => {
    const { owner, repo, id } = c.req.param();
    const user = c.get("user")!;
    const repoRow = await resolveRepo(owner, repo);
    const back = `/${owner}/${repo}/deployments/${id}`;
    if (!repoRow) return c.notFound();
    if (repoRow.ownerId !== user.id) {
      return c.redirect(back);
    }
    try {
      const [depRow] = await db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.id, id), eq(deployments.repositoryId, repoRow.id))
        )
        .limit(1);
      if (!depRow || depRow.status !== "failed") return c.redirect(back);
      await onDeployFailure({
        repositoryId: repoRow.id,
        deploymentId: depRow.id,
        ref: depRow.ref,
        commitSha: depRow.commitSha,
        target: depRow.target,
        errorMessage: depRow.blockedReason,
      });
    } catch (err) {
      console.error("[deployments] retry-incident:", err);
    }
    return c.redirect(back);
  }
);

export default dep;
