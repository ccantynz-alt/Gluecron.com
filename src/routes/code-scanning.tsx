/**
 * Block I5 — Code scanning UI.
 *
 *   GET /:owner/:repo/security
 *
 * Aggregates gate_runs where the gate name contains "scan" (Secret scan,
 * Security scan, Dependency scan) and presents them as a clean alerts
 * dashboard. Data already exists — this is a surfacing layer only.
 */

import { Hono } from "hono";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { gateRuns, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const codeScanning = new Hono<AuthEnv>();
codeScanning.use("*", softAuth);

codeScanning.get("/:owner/:repo/security", async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");

  const [ownerUser] = await db
    .select()
    .from(users)
    .where(eq(users.username, ownerName))
    .limit(1);
  if (!ownerUser) return c.notFound();

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerId, ownerUser.id),
        eq(repositories.name, repoName)
      )
    )
    .limit(1);
  if (!repo) return c.notFound();
  if (repo.isPrivate && (!user || user.id !== repo.ownerId)) {
    return c.notFound();
  }

  // Pull the most recent 100 scan-related gate runs.
  const runs = await db
    .select()
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.repositoryId, repo.id),
        or(
          sql`lower(${gateRuns.gateName}) like '%scan%'`,
          sql`lower(${gateRuns.gateName}) like '%security%'`
        )!
      )
    )
    .orderBy(desc(gateRuns.createdAt))
    .limit(100);

  // Summarize: latest status per gate, total alerts (failed + repaired).
  const latestByName = new Map<
    string,
    { status: string; summary: string | null; sha: string; at: Date }
  >();
  for (const r of runs) {
    if (!latestByName.has(r.gateName)) {
      latestByName.set(r.gateName, {
        status: r.status,
        summary: r.summary,
        sha: r.commitSha,
        at: r.createdAt,
      });
    }
  }

  const failed = runs.filter((r) => r.status === "failed").length;
  const repaired = runs.filter((r) => r.status === "repaired").length;

  return c.html(
    <Layout title={`Security — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader
        owner={ownerName}
        repo={repoName}
        currentUser={user?.username}
        archived={repo.isArchived}
        isTemplate={repo.isTemplate}
      />
      <RepoNav owner={ownerName} repo={repoName} active="gates" />

      <div style="display:flex;gap:12px;margin:20px 0">
        <div
          class="panel"
          style="flex:1;padding:16px;text-align:center"
        >
          <div style="font-size:28px;font-weight:700">
            {latestByName.size}
          </div>
          <div style="font-size:12px;color:var(--text-muted)">
            Configured scanners
          </div>
        </div>
        <div
          class="panel"
          style="flex:1;padding:16px;text-align:center"
        >
          <div
            style={`font-size:28px;font-weight:700;color:${failed > 0 ? "var(--red)" : "var(--text)"}`}
          >
            {failed}
          </div>
          <div style="font-size:12px;color:var(--text-muted)">
            Failed runs (last 100)
          </div>
        </div>
        <div
          class="panel"
          style="flex:1;padding:16px;text-align:center"
        >
          <div style="font-size:28px;font-weight:700;color:var(--green)">
            {repaired}
          </div>
          <div style="font-size:12px;color:var(--text-muted)">
            Auto-repaired
          </div>
        </div>
      </div>

      <h3>Scanner status</h3>
      <div class="panel" style="margin-bottom:20px">
        {latestByName.size === 0 ? (
          <div class="panel-empty">
            No scan runs yet. Push a commit to trigger scanners.
          </div>
        ) : (
          Array.from(latestByName.entries()).map(([name, info]) => (
            <div class="panel-item" style="justify-content:space-between">
              <div>
                <div style="font-weight:600">{name}</div>
                <div
                  style="font-size:12px;color:var(--text-muted);margin-top:2px"
                >
                  {info.summary || "no summary"}
                </div>
              </div>
              <div style="text-align:right">
                <span
                  style={`font-size:11px;text-transform:uppercase;padding:2px 8px;border-radius:10px;background:${statusColor(info.status)};color:white`}
                >
                  {info.status}
                </span>
                <div
                  style="font-size:11px;color:var(--text-muted);margin-top:4px"
                >
                  <code>{info.sha.slice(0, 7)}</code> ·{" "}
                  {info.at.toLocaleDateString()}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <h3>Recent runs</h3>
      <div class="panel">
        {runs.length === 0 ? (
          <div class="panel-empty">No runs.</div>
        ) : (
          runs.slice(0, 50).map((r) => (
            <div class="panel-item" style="justify-content:space-between">
              <div style="flex:1;min-width:0">
                <code style="font-size:12px">{r.commitSha.slice(0, 7)}</code>{" "}
                <span style="font-size:13px">{r.gateName}</span>
                {r.summary && (
                  <div
                    style="font-size:12px;color:var(--text-muted);margin-top:2px"
                  >
                    {r.summary}
                  </div>
                )}
              </div>
              <div style="text-align:right;white-space:nowrap">
                <span
                  style={`font-size:11px;text-transform:uppercase;padding:2px 8px;border-radius:10px;background:${statusColor(r.status)};color:white`}
                >
                  {r.status}
                </span>
                <div
                  style="font-size:11px;color:var(--text-muted);margin-top:2px"
                >
                  {r.createdAt.toLocaleString()}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

function statusColor(status: string): string {
  switch (status) {
    case "passed":
      return "var(--green)";
    case "failed":
      return "var(--red)";
    case "repaired":
      return "var(--accent)";
    case "skipped":
      return "var(--text-muted)";
    default:
      return "var(--text-muted)";
  }
}

export default codeScanning;
