/**
 * Block J20 — Stale issue detector.
 *
 *   GET /:owner/:repo/issues/stale[?period=30d|60d|90d|180d]
 *
 * Lists all *open* issues whose `updated_at` is older than the selected
 * threshold — "no activity in N days". Read-only; softAuth so public
 * repos are visible to logged-out visitors. Private repos 404 for
 * non-owner viewers.
 *
 * Filtering + bucketing logic lives in `src/lib/stale-issues.ts` (pure
 * helper, exhaustively unit-tested). This route is thin glue.
 */

import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { issueComments, issues, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  STALE_PERIODS,
  type StalePeriod,
  parsePeriod,
  buildStaleReport,
  periodDays,
  type StaleInputIssue,
} from "../lib/stale-issues";

const staleRoutes = new Hono<AuthEnv>();

const PERIOD_LABEL: Record<StalePeriod, string> = {
  "30d": "30 days",
  "60d": "60 days",
  "90d": "90 days",
  "180d": "180 days",
};

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

staleRoutes.get("/:owner/:repo/issues/stale", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const period: StalePeriod = parsePeriod(c.req.query("period"));

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

  const { repo } = resolved;
  if (repo.isPrivate && (!user || user.id !== resolved.owner.id)) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  // Fetch open issues + comment counts in parallel.
  let rawIssues: StaleInputIssue[] = [];
  try {
    const rows = await db
      .select({
        number: issues.number,
        title: issues.title,
        state: issues.state,
        authorName: users.username,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(users, eq(issues.authorId, users.id))
      .where(
        and(eq(issues.repositoryId, repo.id), eq(issues.state, "open"))
      )
      .limit(2000);

    // Comment counts: one subquery, map by issue number via join on
    // issue_id — simpler to compute per-issue with a count query, but
    // this route is bounded (max 2000 issues) so we do a single grouped
    // query keyed by issue.number for display.
    let commentCounts: Record<number, number> = {};
    try {
      const cc = await db
        .select({
          number: issues.number,
          count: sql<number>`count(${issueComments.id})::int`,
        })
        .from(issues)
        .leftJoin(issueComments, eq(issueComments.issueId, issues.id))
        .where(
          and(eq(issues.repositoryId, repo.id), eq(issues.state, "open"))
        )
        .groupBy(issues.number);
      for (const row of cc) {
        commentCounts[row.number] = Number(row.count) || 0;
      }
    } catch {
      commentCounts = {};
    }

    rawIssues = rows.map((r) => ({
      number: r.number,
      title: r.title,
      state: r.state,
      authorName: r.authorName,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      commentCount: commentCounts[r.number] ?? 0,
    }));
  } catch {
    rawIssues = [];
  }

  const now = new Date();
  const report = buildStaleReport({ period, now, issues: rawIssues });
  const openTotal = rawIssues.length;
  const label = PERIOD_LABEL[period];
  const days = periodDays(period);

  return c.html(
    <Layout title={`Stale issues — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="issues" />
      <div style="max-width: 960px; margin-top: 16px">
        <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px">
          <h2 style="margin: 0">Stale issues</h2>
          <div style="display: flex; gap: 6px; flex-wrap: wrap">
            {STALE_PERIODS.map((p) => (
              <a
                href={`/${ownerName}/${repoName}/issues/stale?period=${p}`}
                class={`btn ${p === period ? "btn-primary" : ""}`}
                style="padding: 4px 10px; font-size: 12px"
              >
                {PERIOD_LABEL[p]}
              </a>
            ))}
          </div>
        </div>

        <p style="color: var(--text-muted); margin-bottom: 20px">
          Open issues with no activity in the last{" "}
          <strong>{label}</strong>. Showing{" "}
          <strong>{report.total}</strong> of{" "}
          <strong>{openTotal}</strong> open issue
          {openTotal === 1 ? "" : "s"}.
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px">
          <BucketCard
            label={`${days}–60d`}
            count={report.buckets["30-60"].length}
            visible={days <= 30}
          />
          <BucketCard
            label="60–90d"
            count={report.buckets["60-90"].length}
            visible={days <= 60}
          />
          <BucketCard
            label="90–180d"
            count={report.buckets["90-180"].length}
            visible={days <= 90}
          />
          <BucketCard
            label="180d+"
            count={report.buckets["180+"].length}
            visible={true}
          />
        </div>

        {report.issues.length === 0 ? (
          <div
            class="empty-state"
            style="padding: 40px 16px; border: 1px dashed var(--border); border-radius: 6px"
          >
            <h3 style="margin: 0 0 6px 0">No stale issues</h3>
            <p style="color: var(--text-muted); margin: 0">
              Every open issue has had activity in the last {label}. Nice
              work!
            </p>
          </div>
        ) : (
          <table
            style="width: 100%; border-collapse: collapse; font-size: 13px"
          >
            <thead>
              <tr style="text-align: left; color: var(--text-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em">
                <th style="padding: 6px 8px; border-bottom: 1px solid var(--border)">
                  #
                </th>
                <th style="padding: 6px 8px; border-bottom: 1px solid var(--border)">
                  Title
                </th>
                <th style="padding: 6px 8px; border-bottom: 1px solid var(--border)">
                  Author
                </th>
                <th style="padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right">
                  Comments
                </th>
                <th style="padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: right">
                  Last activity
                </th>
              </tr>
            </thead>
            <tbody>
              {report.issues.map((i) => (
                <tr>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">
                    #{i.number}
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border)">
                    <a
                      href={`/${ownerName}/${repoName}/issues/${i.number}`}
                      style="font-weight: 500"
                    >
                      {i.title}
                    </a>
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); color: var(--text-muted)">
                    {i.authorName}
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right; color: var(--text-muted)">
                    {i.commentCount}
                  </td>
                  <td style="padding: 8px; border-bottom: 1px solid var(--border); text-align: right">
                    <span
                      style={
                        "color: " +
                        (i.daysSinceUpdate >= 180
                          ? "#f85149"
                          : i.daysSinceUpdate >= 90
                          ? "#f0883e"
                          : "var(--text-muted)")
                      }
                      title={i.updatedAt}
                    >
                      {i.daysSinceUpdate} day
                      {i.daysSinceUpdate === 1 ? "" : "s"} ago
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style="color: var(--text-muted); font-size: 11px; margin-top: 18px">
          Threshold: {days} day{days === 1 ? "" : "s"}. Activity is measured
          by the issue's <code>updated_at</code> timestamp (comments + edits
          refresh it).
        </p>
      </div>
    </Layout>
  );
});

function BucketCard(props: {
  label: string;
  count: number;
  visible: boolean;
}) {
  if (!props.visible) return null as unknown as JSX.Element;
  return (
    <div style="border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; background: var(--bg-secondary)">
      <div style="font-size: 20px; font-weight: 600; line-height: 1">
        {props.count}
      </div>
      <div style="color: var(--text-muted); font-size: 11px; margin-top: 4px">
        {props.label}
      </div>
    </div>
  );
}

export default staleRoutes;
