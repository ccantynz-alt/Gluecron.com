/**
 * Developer Velocity Dashboard.
 *
 * Route: GET /:owner/:repo/insights/velocity
 *
 * Query params: ?window=7|30|90 (default 30 days)
 *
 * Panels:
 *   1. 4 team-summary stat cards (PRs opened, PRs merged, avg time-to-merge,
 *      most active reviewer)
 *   2. Top contributors table (PRs opened, PRs merged, avg TTM, reviews given)
 *   3. PR size insights — count by merge speed bucket (Fast <4h, Normal 4-48h,
 *      Slow >48h)
 *
 * All queries are scoped to the repository and the chosen time window.
 * No new DB tables — everything derived from pull_requests + pr_comments + users.
 */

import { Hono } from "hono";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  users,
  repositories,
} from "../db/schema";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import type { AuthEnv } from "../middleware/auth";
import { softAuth } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getUnreadCount } from "../lib/unread";

const velocityRoutes = new Hono<AuthEnv>();

// ─── CSS ──────────────────────────────────────────────────────────────────────

const styles = `
  .vel-wrap {
    max-width: 1080px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4);
  }

  /* Insights sub-navigation */
  .vel-subnav {
    display: flex;
    gap: 4px;
    margin-bottom: var(--space-5);
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .vel-subnav-link {
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color 120ms ease, border-color 120ms ease;
    border-radius: 4px 4px 0 0;
  }
  .vel-subnav-link:hover { color: var(--text); }
  .vel-subnav-link.active {
    color: var(--accent, #5865f2);
    border-bottom-color: var(--accent, #5865f2);
  }

  /* Hero */
  .vel-hero {
    position: relative;
    margin-bottom: var(--space-5);
    padding: var(--space-5) var(--space-6);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
  }
  .vel-hero::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, transparent 0%, #34d399 30%, #3b82f6 70%, transparent 100%);
    opacity: 0.8;
    pointer-events: none;
  }
  .vel-hero-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 var(--space-2) 0;
    color: var(--text);
  }
  .vel-hero-sub {
    color: var(--text-muted);
    font-size: 14px;
    margin: 0 0 var(--space-4) 0;
  }

  /* Window selector */
  .vel-window-bar {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .vel-window-label {
    font-size: 12px;
    color: var(--text-muted);
    margin-right: 4px;
  }
  .vel-window-btn {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    text-decoration: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    background: var(--bg);
    transition: border-color 120ms ease, color 120ms ease;
  }
  .vel-window-btn:hover { color: var(--text); border-color: var(--border-strong, var(--border)); }
  .vel-window-btn.active {
    background: var(--accent, #5865f2);
    border-color: var(--accent, #5865f2);
    color: #fff;
  }

  /* Stat cards row */
  .vel-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .vel-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .vel-card-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    font-weight: 600;
  }
  .vel-card-value {
    font-size: 28px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1.1;
  }
  .vel-card-value.vel-na {
    font-size: 18px;
    color: var(--text-muted);
  }
  .vel-card-hint {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }

  /* Section headings */
  .vel-section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin: 0 0 var(--space-3) 0;
  }

  /* Contributor table */
  .vel-table-wrap {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: var(--space-5);
  }
  .vel-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .vel-table th {
    text-align: left;
    padding: 10px 16px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .vel-table td {
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    vertical-align: middle;
    font-variant-numeric: tabular-nums;
  }
  .vel-table tr:last-child td { border-bottom: none; }
  .vel-table tr:hover td { background: rgba(255,255,255,0.03); }

  /* Avatar initials */
  .vel-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, #5865f2, #34d399);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    margin-right: 8px;
    flex-shrink: 0;
  }
  .vel-user-cell {
    display: flex;
    align-items: center;
  }
  .vel-username {
    font-weight: 500;
    color: var(--text);
  }
  .vel-display-name {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 1px;
  }

  /* Size buckets */
  .vel-buckets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .vel-bucket {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .vel-bucket-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
  }
  .vel-bucket-value {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .vel-bucket-value.fast  { color: #34d399; }
  .vel-bucket-value.normal { color: #60a5fa; }
  .vel-bucket-value.slow  { color: #f87171; }
  .vel-bucket-hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  /* Empty state */
  .vel-empty {
    text-align: center;
    padding: var(--space-6) var(--space-4);
    border: 1px dashed var(--border);
    border-radius: 12px;
    color: var(--text-muted);
    margin-bottom: var(--space-5);
  }
  .vel-empty strong {
    display: block;
    font-size: 15px;
    color: var(--text);
    margin-bottom: 6px;
  }
  .vel-empty span { font-size: 13px; }

  /* Numeric right-align for stat columns */
  .vel-num { text-align: right; }
  .vel-table th.vel-num { text-align: right; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
}

// ─── Route ────────────────────────────────────────────────────────────────────

velocityRoutes.use(
  "/:owner/:repo/insights/velocity",
  softAuth
);

velocityRoutes.get(
  "/:owner/:repo/insights/velocity",
  requireRepoAccess("read"),
  async (c) => {
    const { owner, repo } = c.req.param();
    const user = c.get("user") ?? null;
    const repository = (
      c.get("repository" as never) as { id: string; name: string; isPrivate: boolean }
    ) ?? null;

    if (!repository) {
      return c.html("Repository not found", 404);
    }

    // Parse window (days)
    const windowParam = c.req.query("window");
    const windowDays =
      windowParam === "7" ? 7 : windowParam === "90" ? 90 : 30;
    const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const repoId = repository.id;

    // ─── Parallel DB queries ───────────────────────────────────────────────

    const [contributorRows, summaryRows, reviewerRows] = await Promise.all([

      // Query 1: per-author PR stats + reviews given
      (async () => {
        try {
          // Subquery: reviews given per author (pr_comments where !isAiReview,
          // joined via pull_requests to scope to this repo + window)
          const reviewsSubq = db
            .select({
              authorId: prComments.authorId,
              reviews: sql<number>`count(*)::int`.as("reviews"),
            })
            .from(prComments)
            .innerJoin(
              pullRequests,
              eq(prComments.pullRequestId, pullRequests.id)
            )
            .where(
              and(
                eq(pullRequests.repositoryId, repoId),
                gte(pullRequests.createdAt, windowStart),
                eq(prComments.isAiReview, false)
              )
            )
            .groupBy(prComments.authorId)
            .as("reviews_by_author");

          const rows = await db
            .select({
              authorId: pullRequests.authorId,
              username: users.username,
              displayName: users.displayName,
              prsOpened: sql<number>`count(*)::int`,
              prsMerged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')::int`,
              avgTtmHours: sql<number>`
                avg(
                  case when ${pullRequests.state} = 'merged' and ${pullRequests.mergedAt} is not null
                  then extract(epoch from (${pullRequests.mergedAt} - ${pullRequests.createdAt})) / 3600.0
                  end
                )
              `,
              reviewsGiven: sql<number>`coalesce(${reviewsSubq.reviews}, 0)::int`,
            })
            .from(pullRequests)
            .innerJoin(users, eq(pullRequests.authorId, users.id))
            .leftJoin(
              reviewsSubq,
              eq(pullRequests.authorId, reviewsSubq.authorId)
            )
            .where(
              and(
                eq(pullRequests.repositoryId, repoId),
                gte(pullRequests.createdAt, windowStart)
              )
            )
            .groupBy(
              pullRequests.authorId,
              users.username,
              users.displayName,
              reviewsSubq.reviews
            )
            .orderBy(desc(sql`count(*)`));

          return rows;
        } catch (err) {
          console.warn("[velocity] contributor query failed:", err);
          return null;
        }
      })(),

      // Query 2: team summary aggregates (total PRs opened, merged, avg TTM)
      (async () => {
        try {
          const [row] = await db
            .select({
              totalOpened: sql<number>`count(*)::int`,
              totalMerged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')::int`,
              avgTtmHours: sql<number>`
                avg(
                  case when ${pullRequests.state} = 'merged' and ${pullRequests.mergedAt} is not null
                  then extract(epoch from (${pullRequests.mergedAt} - ${pullRequests.createdAt})) / 3600.0
                  end
                )
              `,
            })
            .from(pullRequests)
            .where(
              and(
                eq(pullRequests.repositoryId, repoId),
                gte(pullRequests.createdAt, windowStart)
              )
            );
          return row ?? null;
        } catch (err) {
          console.warn("[velocity] summary query failed:", err);
          return null;
        }
      })(),

      // Query 3: most active reviewer (by pr_comment count, human only)
      (async () => {
        try {
          const rows = await db
            .select({
              username: users.username,
              reviewCount: sql<number>`count(*)::int`,
            })
            .from(prComments)
            .innerJoin(users, eq(prComments.authorId, users.id))
            .innerJoin(
              pullRequests,
              eq(prComments.pullRequestId, pullRequests.id)
            )
            .where(
              and(
                eq(pullRequests.repositoryId, repoId),
                gte(pullRequests.createdAt, windowStart),
                eq(prComments.isAiReview, false)
              )
            )
            .groupBy(users.username)
            .orderBy(desc(sql`count(*)`))
            .limit(1);
          return rows[0] ?? null;
        } catch (err) {
          console.warn("[velocity] reviewer query failed:", err);
          return null;
        }
      })(),
    ]);

    // ─── Derived values ────────────────────────────────────────────────────

    const totalOpened = summaryRows?.totalOpened ?? 0;
    const totalMerged = summaryRows?.totalMerged ?? 0;
    const avgTtmRaw =
      summaryRows?.avgTtmHours != null
        ? Number(summaryRows.avgTtmHours)
        : null;
    const avgTtm = avgTtmRaw != null && !isNaN(avgTtmRaw) ? avgTtmRaw : null;
    const topReviewer = reviewerRows?.username ?? null;

    const contributors = contributorRows ?? [];

    // PR age buckets derived from contributor data
    // We need per-PR TTM to bucket — run a targeted query
    let fastCount = 0;
    let normalCount = 0;
    let slowCount = 0;

    try {
      const bucketRows = await db
        .select({
          ttmHours: sql<number>`
            extract(epoch from (${pullRequests.mergedAt} - ${pullRequests.createdAt})) / 3600.0
          `,
        })
        .from(pullRequests)
        .where(
          and(
            eq(pullRequests.repositoryId, repoId),
            gte(pullRequests.createdAt, windowStart),
            eq(pullRequests.state, "merged"),
            sql`${pullRequests.mergedAt} is not null`
          )
        );

      for (const row of bucketRows) {
        const h = Number(row.ttmHours);
        if (isNaN(h)) continue;
        if (h < 4) fastCount++;
        else if (h <= 48) normalCount++;
        else slowCount++;
      }
    } catch (err) {
      console.warn("[velocity] bucket query failed:", err);
    }

    const noPrs = totalOpened === 0 && contributors.length === 0;

    // Unread notification count for the nav badge
    const unreadCount = user ? await getUnreadCount(user.id) : 0;

    // ─── Render ───────────────────────────────────────────────────────────

    const baseUrl = `/${owner}/${repo}/insights/velocity`;

    return c.html(
      <Layout
        title={`Velocity — ${owner}/${repo}`}
        user={user}
        notificationCount={unreadCount}
      >
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div class="vel-wrap">
          <RepoHeader owner={owner} repo={repo} />
          <RepoNav owner={owner} repo={repo} active="insights" />

          {/* Insights sub-nav */}
          <div class="vel-subnav">
            <a
              href={`/${owner}/${repo}/insights/dora`}
              class="vel-subnav-link"
            >
              DORA
            </a>
            <a
              href={`/${owner}/${repo}/insights/velocity`}
              class="vel-subnav-link active"
            >
              Velocity
            </a>
          </div>

          {/* Hero */}
          <div class="vel-hero">
            <h1 class="vel-hero-title">Developer Velocity</h1>
            <p class="vel-hero-sub">
              Pull request throughput, contributor activity, and merge speed
              insights for {owner}/{repo}.
            </p>

            {/* Window selector */}
            <div class="vel-window-bar">
              <span class="vel-window-label">Time window:</span>
              {([7, 30, 90] as const).map((w) => (
                <a
                  href={`${baseUrl}?window=${w}`}
                  class={`vel-window-btn${windowDays === w ? " active" : ""}`}
                >
                  {w}d
                </a>
              ))}
            </div>
          </div>

          {noPrs ? (
            <div class="vel-empty">
              <strong>No pull requests in the last {windowDays} days</strong>
              <span>
                Open and merge some PRs, then come back to see velocity metrics.
              </span>
            </div>
          ) : (
            <>
              {/* ── Team summary cards ── */}
              <h2 class="vel-section-title">Team Summary</h2>
              <div class="vel-cards">
                <div class="vel-card">
                  <div class="vel-card-label">PRs Opened</div>
                  <div class="vel-card-value">{totalOpened}</div>
                  <div class="vel-card-hint">Last {windowDays} days</div>
                </div>

                <div class="vel-card">
                  <div class="vel-card-label">PRs Merged</div>
                  <div class="vel-card-value">{totalMerged}</div>
                  <div class="vel-card-hint">
                    {totalOpened > 0
                      ? `${Math.round((totalMerged / totalOpened) * 100)}% merge rate`
                      : "—"}
                  </div>
                </div>

                <div class="vel-card">
                  <div class="vel-card-label">Avg Time to Merge</div>
                  {avgTtm !== null ? (
                    <>
                      <div class="vel-card-value">{formatHours(avgTtm)}</div>
                      <div class="vel-card-hint">Across merged PRs</div>
                    </>
                  ) : (
                    <div class="vel-card-value vel-na">No merged PRs</div>
                  )}
                </div>

                <div class="vel-card">
                  <div class="vel-card-label">Top Reviewer</div>
                  {topReviewer ? (
                    <>
                      <div class="vel-card-value" style="font-size:18px">
                        {topReviewer}
                      </div>
                      <div class="vel-card-hint">Most PR comments</div>
                    </>
                  ) : (
                    <div class="vel-card-value vel-na">No reviews</div>
                  )}
                </div>
              </div>

              {/* ── Merge speed buckets ── */}
              <h2 class="vel-section-title">PR Merge Speed</h2>
              <div class="vel-buckets">
                <div class="vel-bucket">
                  <div class="vel-bucket-label">Fast</div>
                  <div class="vel-bucket-value fast">{fastCount}</div>
                  <div class="vel-bucket-hint">Merged in under 4 hours</div>
                </div>
                <div class="vel-bucket">
                  <div class="vel-bucket-label">Normal</div>
                  <div class="vel-bucket-value normal">{normalCount}</div>
                  <div class="vel-bucket-hint">Merged in 4 – 48 hours</div>
                </div>
                <div class="vel-bucket">
                  <div class="vel-bucket-label">Slow</div>
                  <div class="vel-bucket-value slow">{slowCount}</div>
                  <div class="vel-bucket-hint">Merged in over 48 hours</div>
                </div>
              </div>

              {/* ── Top contributors table ── */}
              <h2 class="vel-section-title">Top Contributors</h2>
              {contributors.length === 0 ? (
                <div class="vel-empty">
                  <strong>No contributors found</strong>
                  <span>No PRs were opened in this window.</span>
                </div>
              ) : (
                <div class="vel-table-wrap">
                  <table class="vel-table">
                    <thead>
                      <tr>
                        <th>Contributor</th>
                        <th class="vel-num">PRs Opened</th>
                        <th class="vel-num">PRs Merged</th>
                        <th class="vel-num">Avg Time to Merge</th>
                        <th class="vel-num">Reviews Given</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contributors.map((c) => {
                        const initial = (c.username ?? "?")[0];
                        const ttmH =
                          c.avgTtmHours != null
                            ? Number(c.avgTtmHours)
                            : null;
                        const ttmDisplay =
                          ttmH != null && !isNaN(ttmH)
                            ? formatHours(ttmH)
                            : "—";
                        return (
                          <tr key={c.authorId}>
                            <td>
                              <div class="vel-user-cell">
                                <span class="vel-avatar">{initial}</span>
                                <div>
                                  <div class="vel-username">
                                    <a
                                      href={`/${c.username}`}
                                      style="color:inherit;text-decoration:none"
                                    >
                                      {c.username}
                                    </a>
                                  </div>
                                  {c.displayName && (
                                    <div class="vel-display-name">
                                      {c.displayName}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td class="vel-num">{c.prsOpened}</td>
                            <td class="vel-num">{c.prsMerged}</td>
                            <td class="vel-num">{ttmDisplay}</td>
                            <td class="vel-num">{c.reviewsGiven}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </Layout>
    );
  }
);

export default velocityRoutes;
