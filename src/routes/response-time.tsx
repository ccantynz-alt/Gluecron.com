/**
 * Block J25 — Time-to-first-response insights page.
 *
 *   GET /:owner/:repo/insights/response-time[?window=7|30|90|365|0]
 *
 * softAuth, read-only. Fetches issues for the repo + all their comments
 * in two queries, runs the pure `buildResponseReport`, renders a
 * KPI grid (p50/mean/p90/fastest/slowest), four latency buckets, and
 * the oldest still-unreplied open issues.
 */

import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db";
import { repositories, users, issues, issueComments } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  buildResponseReport,
  formatDuration,
  parseWindow,
  VALID_WINDOWS,
  type ResponseIssueInput,
} from "../lib/response-time";

const responseTimeRoutes = new Hono<AuthEnv>();

responseTimeRoutes.use("*", softAuth);

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

responseTimeRoutes.get(
  "/:owner/:repo/insights/response-time",
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

    // Private-repo visibility: only the owner can see the metric.
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

    let issueRows: {
      id: string;
      number: number;
      title: string;
      state: string;
      authorId: string;
      createdAt: Date;
    }[] = [];
    let commentRows: {
      issueId: string;
      authorId: string;
      createdAt: Date;
    }[] = [];
    try {
      issueRows = await db
        .select({
          id: issues.id,
          number: issues.number,
          title: issues.title,
          state: issues.state,
          authorId: issues.authorId,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(eq(issues.repositoryId, resolved.repo.id))
        .limit(2000);

      if (issueRows.length > 0) {
        commentRows = await db
          .select({
            issueId: issueComments.issueId,
            authorId: issueComments.authorId,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(
            inArray(
              issueComments.issueId,
              issueRows.map((i) => i.id)
            )
          );
      }
    } catch {
      // Empty arrays → empty report. Page still renders.
    }

    const commentsByIssue = new Map<
      string,
      { authorId: string; createdAt: Date }[]
    >();
    for (const c0 of commentRows) {
      const arr = commentsByIssue.get(c0.issueId) ?? [];
      arr.push({ authorId: c0.authorId, createdAt: c0.createdAt });
      commentsByIssue.set(c0.issueId, arr);
    }

    const inputs: ResponseIssueInput[] = issueRows.map((i) => ({
      id: i.id,
      state: i.state,
      authorId: i.authorId,
      createdAt: i.createdAt,
      comments: commentsByIssue.get(i.id) ?? [],
    }));
    const report = buildResponseReport({ issues: inputs, windowDays });

    // Look up titles for unreplied issues so we can render a link.
    const unrepliedMeta = report.unrepliedIssueIds
      .map((id) => {
        const i = issueRows.find((r) => r.id === id);
        if (!i) return null;
        return {
          id,
          number: i.number,
          title: i.title,
          createdAt: i.createdAt,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .slice(0, 25);

    const windowLabel =
      windowDays === 0 ? "All time" : `Last ${windowDays} days`;

    const kpi = (label: string, value: string) => (
      <div
        style="border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; background: var(--bg-secondary)"
      >
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 6px">
          {label}
        </div>
        <div style="font-size: 20px; font-weight: 600; font-family: var(--font-mono)">
          {value}
        </div>
      </div>
    );

    return c.html(
      <Layout
        title={`Response time — ${ownerName}/${repoName}`}
        user={user}
      >
        <RepoHeader owner={ownerName} repo={repoName} />
        <div style="max-width: 920px">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px">
            <h2 style="margin: 0">Time to first response</h2>
            <form
              method="GET"
              action={`/${ownerName}/${repoName}/insights/response-time`}
              style="display: flex; gap: 6px; align-items: center"
            >
              <label
                for="window"
                style="font-size: 12px; color: var(--text-muted)"
              >
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
            <strong>{windowLabel}</strong>. Response time = time from issue
            creation to the first comment by someone other than the author.
            Comments authored by the issue author themselves don't count.
          </p>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px">
            {kpi("Total issues", String(report.summary.total))}
            {kpi("Responded", String(report.summary.responded))}
            {kpi(
              "Unreplied (open)",
              String(report.summary.unresponded)
            )}
            {kpi("Median (p50)", formatDuration(report.summary.medianMs))}
            {kpi("Mean", formatDuration(report.summary.meanMs))}
            {kpi("p90", formatDuration(report.summary.p90Ms))}
            {kpi("Fastest", formatDuration(report.summary.fastestMs))}
            {kpi("Slowest", formatDuration(report.summary.slowestMs))}
          </div>

          <h3 style="margin-bottom: 10px">Distribution</h3>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px">
            {[
              ["≤ 1 hour", report.buckets.within1h],
              ["1h – 1 day", report.buckets.within1d],
              ["1d – 1 week", report.buckets.within1w],
              ["> 1 week", report.buckets.over1w],
            ].map(([label, count]) => (
              <div
                style="border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; text-align: center"
              >
                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px">
                  {label}
                </div>
                <div style="font-size: 18px; font-weight: 600">{count}</div>
              </div>
            ))}
          </div>

          <h3 style="margin-bottom: 10px">
            Oldest unreplied open issues ({unrepliedMeta.length}
            {report.unrepliedIssueIds.length > unrepliedMeta.length
              ? ` of ${report.unrepliedIssueIds.length}`
              : ""}
            )
          </h3>
          {unrepliedMeta.length === 0 ? (
            <div class="empty-state">
              <p>Nothing is waiting for a response. Nice.</p>
            </div>
          ) : (
            <table style="width: 100%; border-collapse: collapse">
              <thead>
                <tr>
                  <th style="text-align: left; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted)">
                    Issue
                  </th>
                  <th style="text-align: right; padding: 8px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-muted); width: 140px">
                    Waiting
                  </th>
                </tr>
              </thead>
              <tbody>
                {unrepliedMeta.map((i) => {
                  const waitingMs = Math.max(
                    0,
                    report.now - new Date(i.createdAt).getTime()
                  );
                  return (
                    <tr>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                        <a
                          href={`/${ownerName}/${repoName}/issues/${i.number}`}
                        >
                          <span style="color: var(--text-muted)">
                            #{i.number}
                          </span>{" "}
                          {i.title}
                        </a>
                      </td>
                      <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; font-family: var(--font-mono); font-size: 12px">
                        {formatDuration(waitingMs)}
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
  }
);

export default responseTimeRoutes;
