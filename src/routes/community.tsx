/**
 * Block J12 — Community profile / health scorecard route.
 *
 *   GET /:owner/:repo/community
 *
 * Renders GitHub-parity "Community standards" checklist: README, LICENSE,
 * CODE_OF_CONDUCT, CONTRIBUTING, issue + PR templates, description, topics.
 * Scored in percentage and broken down by required vs recommended.
 *
 * Never 500s — falls back to a zero-score report when git or DB reads fail.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, repoTopics, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { computeHealth, type HealthReport } from "../lib/community";
import { getUnreadCount } from "../lib/unread";

const community = new Hono<AuthEnv>();

community.get("/:owner/:repo/community", softAuth, async (c) => {
  const user = c.get("user");
  const { owner: ownerName, repo: repoName } = c.req.param();

  let repoRow: {
    id: string;
    description: string | null;
    starCount: number;
    forkCount: number;
  } | null = null;
  try {
    const rows = await db
      .select({
        id: repositories.id,
        description: repositories.description,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(
        and(
          eq(users.username, ownerName),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    repoRow = rows[0] || null;
  } catch {
    repoRow = null;
  }
  if (!repoRow) return c.notFound();

  let topics: string[] = [];
  try {
    const rows = await db
      .select({ topic: repoTopics.topic })
      .from(repoTopics)
      .where(eq(repoTopics.repositoryId, repoRow.id));
    topics = rows.map((r) => r.topic);
  } catch {
    topics = [];
  }

  const report: HealthReport = await computeHealth({
    owner: ownerName,
    repo: repoName,
    description: repoRow.description,
    topics,
  });

  const unread = user ? await getUnreadCount(user.id) : 0;

  const barColor =
    report.score >= 80
      ? "var(--green)"
      : report.score >= 50
        ? "var(--yellow)"
        : "var(--red)";

  return c.html(
    <Layout
      title={`Community standards — ${ownerName}/${repoName}`}
      user={user}
      notificationCount={unread}
    >
      <RepoHeader
        owner={ownerName}
        repo={repoName}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={ownerName} repo={repoName} active="insights" />
      <h2>Community standards</h2>
      <p style="color: var(--text-muted); max-width: 640px">
        Healthy projects set expectations and onboard new contributors. Here's
        how this repo scores on GlueCron's community profile checklist.
      </p>

      <div
        style="margin: 16px 0 24px; padding: 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius)"
        data-testid="community-score"
      >
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px">
          <strong style="font-size: 18px">{report.score}%</strong>
          <span style="color: var(--text-muted); font-size: 13px">
            {report.passed} of {report.total} items present · {report.requiredPassed}/{report.requiredTotal} required
          </span>
        </div>
        <div style="height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden">
          <div
            style={`width: ${report.score}%; height: 100%; background: ${barColor}; transition: width 0.3s`}
          />
        </div>
        <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted)">
          {report.meetsRequired
            ? "All required items present — nice work."
            : "Add the required items to reach the minimum community profile."}
        </div>
      </div>

      <ul style="list-style: none; padding: 0; margin: 0">
        {report.items.map((item) => (
          <li
            style="display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border)"
            data-testid={`community-item-${item.key}`}
          >
            <span
              style={`font-size: 20px; color: ${item.present ? "var(--green)" : item.required ? "var(--red)" : "var(--text-muted)"}; line-height: 1`}
              aria-label={item.present ? "present" : "missing"}
            >
              {item.present ? "\u2713" : item.required ? "\u2717" : "\u25CB"}
            </span>
            <div style="flex: 1">
              <div style="display: flex; align-items: center; gap: 8px">
                <strong>{item.label}</strong>
                {item.required && (
                  <span
                    style="font-size: 10px; padding: 1px 6px; border-radius: 10px; background: rgba(248, 81, 73, 0.1); color: var(--red); text-transform: uppercase; letter-spacing: 0.5px"
                  >
                    Required
                  </span>
                )}
              </div>
              <div style="color: var(--text-muted); font-size: 13px; margin-top: 2px">
                {item.description}
              </div>
              {!item.present && item.suggestedPath && (
                <div style="margin-top: 6px">
                  <a
                    href={`/${ownerName}/${repoName}/new/main?path=${encodeURIComponent(item.suggestedPath)}`}
                    class="btn"
                    style="font-size: 12px; padding: 4px 10px"
                  >
                    Add {item.suggestedPath}
                  </a>
                </div>
              )}
              {!item.present && item.key === "description" && (
                <div style="margin-top: 6px">
                  <a
                    href={`/${ownerName}/${repoName}/settings`}
                    class="btn"
                    style="font-size: 12px; padding: 4px 10px"
                  >
                    Edit description
                  </a>
                </div>
              )}
              {!item.present && item.key === "topics" && (
                <div style="margin-top: 6px">
                  <a
                    href={`/${ownerName}/${repoName}/settings`}
                    class="btn"
                    style="font-size: 12px; padding: 4px 10px"
                  >
                    Add topics
                  </a>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Layout>
  );
});

export default community;
