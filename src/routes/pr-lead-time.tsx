/**
 * Block J29 — PR lead-time insights page.
 *
 *   GET /:owner/:repo/insights/lead-time[?window=7|30|90|365|0]
 *
 * softAuth, read-only. Fetches PRs for the repo, runs the pure
 * `buildLeadTimeReport`, renders a KPI grid (p50/mean/p90/fastest/slowest),
 * four latency buckets, and the oldest still-open PRs.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, pullRequests } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  buildLeadTimeReport,
  formatDuration,
  parseWindow,
  VALID_WINDOWS,
  type PrLeadTimeInput,
} from "../lib/pr-lead-time";

const prLeadTimeRoutes = new Hono<AuthEnv>();

prLeadTimeRoutes.use("*", softAuth);

async function resolveRepo(ownerName: string, repoName: string) {
  try {
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!owner) return null;
    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, owner.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

prLeadTimeRoutes.get(
  "/:owner/:repo/insights/lead-time",
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user");
    const windowDays = parseWindow(c.req.query("window"));

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    if (resolved.repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
      return c.html(
        <Layout title="Not Found" user={user}>
          <div class="empty-state">
            <h2>Repository not found</h2>
          </div>
        </Layout>,
        404
      );
    }

    let prRows: {
      id: string;
      number: number;
      title: string;
      state: string;
      isDraft: boolean;
      createdAt: Date;
      mergedAt: Date | null;
    }[] = [];
    try {
      prRows = await db
        .select({
          id: pullRequests.id,
          number: pullRequests.number,
          title: pullRequests.title,
          state: pullRequests.state,
          isDraft: pullRequests.isDraft,
          createdAt: pullRequests.createdAt,
          mergedAt: pullRequests.mergedAt,
        })
        .from(pullRequests)
        .where(eq(pullRequests.repositoryId, resolved.repo.id))
        .limit(2000);
    } catch {
      // empty → empty report
    }

    const inputs: PrLeadTimeInput[] = prRows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      state: r.state,
      isDraft: r.isDraft,
      createdAt: r.createdAt,
      mergedAt: r.mergedAt,
    }));
    const report = buildLeadTimeReport({ prs: inputs, windowDays });

    const oldestOpen = report.oldestOpenIds
      .map((id) => report.perPr.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .slice(0, 25);

    const windowLabel =
      windowDays === 0 ? "All time" : `Last ${windowDays} days`;

    const kpi = (label: string, value: string) => (
      <div style="border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--bg-secondary)">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px">
          {label}
        </div>
        <div style="font-size: 20px; font-weight: 600; font-family: var(--font-mono)">
          {value}
        </div>
      </div>
    );

    return c.html(
      <Layout title={`Lead time — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <div style="max-width: 920px">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
            <h2 style="margin: 0">PR lead time</h2>
            <form
              method="GET"
              action={`/${ownerName}/${repoName}/insights/lead-time`}
              style="display: flex; gap: 6px; align-items: center"
            >
              <label for="window" style="font-size: 12px; color: var(--text-muted)">
                Window:
              </label>
              <select
                id="window"
                name="window"
                onchange="this.form.submit()"
                style="padding: 4px 8px; font-size: 12px"
              >
                {VALID_WINDOWS.map((w) => (
                  <option value={String(w)} selected={w === windowDays}>
                    {w === 0 ? "All time" : `Last ${w} days`}
                  </option>
                ))}
              </select>
            </form>
          </div>
          <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px">
            <strong>{windowLabel}</strong>. Lead time = time from PR opened to
            merged. Open PRs show as "in-flight" and roll into a separate
            counter so the percentiles aren't skewed by stale drafts.
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px">
            {kpi("Total PRs", String(report.summary.total))}
            {kpi("Merged", String(report.summary.merged))}
            {kpi("Open (non-draft)", String(report.summary.openNonDraft))}
            {kpi("Drafts", String(report.summary.openDraft))}
            {kpi("Median (p50)", formatDuration(report.summary.medianMs))}
            {kpi("Mean", formatDuration(report.summary.meanMs))}
            {kpi("p90", formatDuration(report.summary.p90Ms))}
            {kpi("Fastest", formatDuration(report.summary.fastestMs))}
            {kpi("Slowest", formatDuration(report.summary.slowestMs))}
          </div>

          <h3 style="margin-bottom: 10px">Merge-time distribution</h3>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px">
            {[
              ["≤ 1 hour", report.buckets.within1h],
              ["1h – 1 day", report.buckets.within1d],
              ["1d – 1 week", report.buckets.within1w],
              ["> 1 week", report.buckets.over1w],
            ].map(([label, count]) => (
              <div style="border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; text-align: center">
                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px">
                  {label}
                </div>
                <div style="font-size: 18px; font-weight: 600">{count}</div>
              </div>
            ))}
          </div>

          <h3 style="margin-bottom: 10px">
            Oldest open PRs ({oldestOpen.length}
            {report.oldestOpenIds.length > oldestOpen.length
              ? ` of ${report.oldestOpenIds.length}`
              : ""}
            )
          </h3>
          {oldestOpen.length === 0 ? (
            <div class="empty-state">
              <p>No open PRs. Nice.</p>
            </div>
          ) : (
            <table style="width: 100%; border-collapse: collapse">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                    PR
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 140px">
                    In flight
                  </th>
                </tr>
              </thead>
              <tbody>
                {oldestOpen.map((p) => (
                  <tr>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                      <a href={`/${ownerName}/${repoName}/pulls/${p.number}`}>
                        <span style="color: var(--text-muted)">#{p.number}</span>{" "}
                        {p.title}
                      </a>
                    </td>
                    <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                      {formatDuration(p.inFlightMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Layout>
    );
  }
);

export default prLeadTimeRoutes;
