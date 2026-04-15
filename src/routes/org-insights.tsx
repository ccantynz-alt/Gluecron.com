/**
 * Block F2 — Org-wide insights.
 *
 *   GET /orgs/:slug/insights  — rollup across every repo owned by the org:
 *                               gate green-rate, open/merged PR counts, open
 *                               issue count, recent gate activity, per-repo
 *                               rows sorted by activity.
 *
 * No new tables — computed live from existing `repositories`, `gate_runs`,
 * `pull_requests`, `issues`.
 */

import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  gateRuns,
  issues,
  organizations,
  orgMembers,
  pullRequests,
  repositories,
} from "../db/schema";
import { Layout } from "../views/layout";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const orgInsights = new Hono<AuthEnv>();
orgInsights.use("*", softAuth);

export interface OrgInsightsSummary {
  repoCount: number;
  gateRunsTotal: number;
  gatePassed: number;
  gateFailed: number;
  gateRepaired: number;
  greenRate: number; // 0..1
  openIssues: number;
  openPrs: number;
  mergedPrs30d: number;
  perRepo: Array<{
    id: string;
    name: string;
    runs: number;
    greenRate: number;
    openPrs: number;
    openIssues: number;
  }>;
}

export async function computeOrgInsights(
  orgId: string
): Promise<OrgInsightsSummary> {
  const empty: OrgInsightsSummary = {
    repoCount: 0,
    gateRunsTotal: 0,
    gatePassed: 0,
    gateFailed: 0,
    gateRepaired: 0,
    greenRate: 0,
    openIssues: 0,
    openPrs: 0,
    mergedPrs30d: 0,
    perRepo: [],
  };

  try {
    const repos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(eq(repositories.orgId, orgId));
    if (repos.length === 0) return empty;

    const repoIds = repos.map((r) => r.id);
    const idList = sql.raw(
      repoIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")
    );

    // Aggregate gate runs across repos
    const gateRows = await db
      .select({
        repoId: gateRuns.repositoryId,
        status: gateRuns.status,
        n: sql<number>`count(*)::int`,
      })
      .from(gateRuns)
      .where(sql`${gateRuns.repositoryId} IN (${idList})`)
      .groupBy(gateRuns.repositoryId, gateRuns.status);

    const totals = {
      passed: 0,
      failed: 0,
      repaired: 0,
      skipped: 0,
    } as Record<string, number>;
    const byRepo = new Map<
      string,
      { runs: number; passed: number; failed: number; repaired: number }
    >();
    for (const r of gateRows) {
      const n = Number(r.n);
      totals[r.status] = (totals[r.status] || 0) + n;
      const b = byRepo.get(r.repoId) || {
        runs: 0,
        passed: 0,
        failed: 0,
        repaired: 0,
      };
      b.runs += n;
      if (r.status === "passed") b.passed += n;
      else if (r.status === "failed") b.failed += n;
      else if (r.status === "repaired") b.repaired += n;
      byRepo.set(r.repoId, b);
    }
    const gateRunsTotal = Object.values(totals).reduce((a, b) => a + b, 0);
    const gatePassed = totals.passed || 0;
    const gateFailed = totals.failed || 0;
    const gateRepaired = totals.repaired || 0;
    const greenRate = gateRunsTotal
      ? (gatePassed + gateRepaired) / gateRunsTotal
      : 0;

    // Open issues/PRs across org repos
    const issueRows = await db
      .select({
        repoId: issues.repositoryId,
        state: issues.state,
        n: sql<number>`count(*)::int`,
      })
      .from(issues)
      .where(sql`${issues.repositoryId} IN (${idList})`)
      .groupBy(issues.repositoryId, issues.state);

    const openIssuesByRepo = new Map<string, number>();
    let openIssues = 0;
    for (const r of issueRows) {
      if (r.state === "open") {
        openIssuesByRepo.set(r.repoId, Number(r.n));
        openIssues += Number(r.n);
      }
    }

    const prRows = await db
      .select({
        repoId: pullRequests.repositoryId,
        state: pullRequests.state,
        n: sql<number>`count(*)::int`,
      })
      .from(pullRequests)
      .where(sql`${pullRequests.repositoryId} IN (${idList})`)
      .groupBy(pullRequests.repositoryId, pullRequests.state);

    const openPrsByRepo = new Map<string, number>();
    let openPrs = 0;
    for (const r of prRows) {
      if (r.state === "open") {
        openPrsByRepo.set(r.repoId, Number(r.n));
        openPrs += Number(r.n);
      }
    }

    // Merged PRs in last 30d
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [mergedRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(pullRequests)
      .where(
        and(
          sql`${pullRequests.repositoryId} IN (${idList})`,
          eq(pullRequests.state, "merged"),
          gte(pullRequests.mergedAt, since)
        )
      );

    const perRepo = repos.map((r) => {
      const b = byRepo.get(r.id) || {
        runs: 0,
        passed: 0,
        failed: 0,
        repaired: 0,
      };
      const green = b.runs
        ? (b.passed + b.repaired) / b.runs
        : 0;
      return {
        id: r.id,
        name: r.name,
        runs: b.runs,
        greenRate: green,
        openPrs: openPrsByRepo.get(r.id) || 0,
        openIssues: openIssuesByRepo.get(r.id) || 0,
      };
    });
    perRepo.sort((a, b) => b.runs - a.runs);

    return {
      repoCount: repos.length,
      gateRunsTotal,
      gatePassed,
      gateFailed,
      gateRepaired,
      greenRate,
      openIssues,
      openPrs,
      mergedPrs30d: Number(mergedRow?.n || 0),
      perRepo,
    };
  } catch {
    return empty;
  }
}

async function loadOrg(slug: string) {
  try {
    const [o] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);
    return o || null;
  } catch {
    return null;
  }
}

async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

orgInsights.get("/orgs/:slug/insights", requireAuth, async (c) => {
  const user = c.get("user")!;
  const slug = c.req.param("slug");
  const org = await loadOrg(slug);
  if (!org) return c.notFound();
  const member = await isOrgMember(org.id, user.id);
  if (!member) return c.redirect(`/orgs/${slug}`);

  const summary = await computeOrgInsights(org.id);
  const pct = (n: number) => Math.round(n * 100);

  return c.html(
    <Layout title={`${org.name} — Insights`} user={user}>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2>{org.name} · Insights</h2>
        <a href={`/orgs/${slug}`} class="btn btn-sm">
          Back to {slug}
        </a>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700">{summary.repoCount}</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Repos
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:var(--green)">
            {pct(summary.greenRate)}%
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Green rate
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#79c0ff">
            {summary.openPrs}
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Open PRs
          </div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:22px;font-weight:700;color:#d2a8ff">
            {summary.mergedPrs30d}
          </div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase">
            Merged 30d
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:18px;font-weight:600">{summary.gateRunsTotal}</div>
          <div style="font-size:11px;color:var(--text-muted)">Total gate runs</div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:18px;font-weight:600;color:var(--green)">
            {summary.gatePassed}
          </div>
          <div style="font-size:11px;color:var(--text-muted)">Passed</div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:18px;font-weight:600;color:#bc8cff">
            {summary.gateRepaired}
          </div>
          <div style="font-size:11px;color:var(--text-muted)">Repaired</div>
        </div>
        <div class="panel" style="padding:12px;text-align:center">
          <div style="font-size:18px;font-weight:600;color:var(--red)">
            {summary.gateFailed}
          </div>
          <div style="font-size:11px;color:var(--text-muted)">Failed</div>
        </div>
      </div>

      <h3>Per-repo breakdown</h3>
      <div class="panel" style="margin-bottom:20px">
        {summary.perRepo.length === 0 ? (
          <div class="panel-empty">This org has no repositories yet.</div>
        ) : (
          summary.perRepo.map((r) => (
            <div class="panel-item" style="justify-content:space-between">
              <div style="flex:1;min-width:0">
                <a href={`/${slug}/${r.name}`} style="font-weight:600">
                  {slug}/{r.name}
                </a>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">
                  {r.runs} runs · {r.openPrs} open PRs · {r.openIssues} open
                  issues
                </div>
              </div>
              <span
                style={`font-family:var(--font-mono);color:${r.greenRate >= 0.9 ? "var(--green)" : r.greenRate >= 0.7 ? "#f0b72f" : "var(--red)"}`}
              >
                {r.runs > 0 ? `${pct(r.greenRate)}%` : "—"}
              </span>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
});

export default orgInsights;
