/**
 * Block J18 — Repository pulse.
 *
 *   GET /:owner/:repo/pulse[?window=1d|7d|30d|90d]
 *
 * Renders a GitHub-parity "Pulse" overview: commit activity, active PRs,
 * recent merges/closes, issue throughput, top contributors — bucketed into
 * a rolling window. Read-only. softAuth so public repos are accessible to
 * logged-out visitors.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { issues, pullRequests, repositories, users } from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { listCommits, getDefaultBranch } from "../git/repository";
import {
  PULSE_WINDOWS,
  type PulseWindow,
  parseWindow,
  buildPulseReport,
  windowDays,
  type PulseCommit,
  type PulsePr,
  type PulseIssue,
} from "../lib/repo-pulse";

const pulseRoutes = new Hono<AuthEnv>();

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

const WINDOW_LABEL: Record<PulseWindow, string> = {
  "1d": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
};

pulseRoutes.get("/:owner/:repo/pulse", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const w: PulseWindow = parseWindow(c.req.query("window"));

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

  // --- Fetch inputs in parallel -------------------------------------------
  const [commitsRaw, prRows, issueRows, defaultBranch] = await Promise.all([
    (async (): Promise<PulseCommit[]> => {
      try {
        const ref =
          (await getDefaultBranch(ownerName, repoName)) || "HEAD";
        const commits = await listCommits(ownerName, repoName, ref, 500, 0);
        return commits.map((c) => ({
          sha: c.sha,
          author: c.author,
          authorEmail: c.authorEmail,
          date: c.date,
          message: c.message,
        }));
      } catch {
        return [];
      }
    })(),
    db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        state: pullRequests.state,
        isDraft: pullRequests.isDraft,
        authorName: users.username,
        createdAt: pullRequests.createdAt,
        updatedAt: pullRequests.updatedAt,
        closedAt: pullRequests.closedAt,
        mergedAt: pullRequests.mergedAt,
      })
      .from(pullRequests)
      .innerJoin(users, eq(pullRequests.authorId, users.id))
      .where(eq(pullRequests.repositoryId, repo.id))
      .limit(1000),
    db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        state: issues.state,
        authorName: users.username,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        closedAt: issues.closedAt,
      })
      .from(issues)
      .innerJoin(users, eq(issues.authorId, users.id))
      .where(eq(issues.repositoryId, repo.id))
      .limit(1000),
    getDefaultBranch(ownerName, repoName).catch(() => "HEAD"),
  ]);

  const now = new Date();
  const report = buildPulseReport({
    window: w,
    now,
    commits: commitsRaw,
    prs: prRows as PulsePr[],
    issues: issueRows as PulseIssue[],
  });

  const label = WINDOW_LABEL[w];
  const days = windowDays(w);

  return c.html(
    <Layout title={`Pulse — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <RepoNav owner={ownerName} repo={repoName} active="insights" />
      <div style="max-width: 960px; margin-top: 16px">
        <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 16px">
          <h2 style="margin: 0">Pulse</h2>
          <div style="display: flex; gap: 6px">
            {PULSE_WINDOWS.map((opt) => (
              <a
                href={`/${ownerName}/${repoName}/pulse?window=${opt}`}
                class={`btn ${opt === w ? "btn-primary" : ""}`}
                style="padding: 4px 10px; font-size: 12px"
              >
                {WINDOW_LABEL[opt]}
              </a>
            ))}
          </div>
        </div>

        <p style="color: var(--text-muted); margin-bottom: 24px">
          Activity in the last {label} on{" "}
          <code>{defaultBranch || "HEAD"}</code> —{" "}
          <strong>{report.commits.total}</strong> commit
          {report.commits.total === 1 ? "" : "s"} from{" "}
          <strong>{report.commits.byAuthor.length}</strong> contributor
          {report.commits.byAuthor.length === 1 ? "" : "s"}.
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px">
          <PulseCard label="Opened PRs" value={report.prs.opened} tone="blue" />
          <PulseCard
            label="Merged PRs"
            value={report.prs.mergedCount}
            tone="green"
          />
          <PulseCard
            label="Closed PRs"
            value={report.prs.closed}
            tone="red"
          />
          <PulseCard
            label="Active PRs"
            value={report.prs.active}
            tone="grey"
          />
          <PulseCard
            label="Opened issues"
            value={report.issues.opened}
            tone="blue"
          />
          <PulseCard
            label="Closed issues"
            value={report.issues.closed}
            tone="red"
          />
          <PulseCard
            label="Active issues"
            value={report.issues.active}
            tone="grey"
          />
          <PulseCard
            label="Commits"
            value={report.commits.total}
            tone="green"
          />
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px">
          <section>
            <h3 style="font-size: 14px; margin-bottom: 8px">
              Top contributors
            </h3>
            {report.commits.byAuthor.length === 0 ? (
              <p style="color: var(--text-muted); font-size: 13px">
                No commits in the last {label}.
              </p>
            ) : (
              <ul style="list-style: none; padding: 0; margin: 0">
                {report.commits.byAuthor.slice(0, 10).map((a) => (
                  <li style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border)">
                    <span style="font-weight: 500">{a.author}</span>
                    <span style="color: var(--text-muted); font-size: 12px">
                      {a.count} commit{a.count === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 style="font-size: 14px; margin-bottom: 8px">
              Recently merged PRs
            </h3>
            {report.prs.mergedList.length === 0 ? (
              <p style="color: var(--text-muted); font-size: 13px">
                No PRs merged in the last {label}.
              </p>
            ) : (
              <ul style="list-style: none; padding: 0; margin: 0">
                {report.prs.mergedList.slice(0, 10).map((p) => (
                  <li style="padding: 6px 0; border-bottom: 1px solid var(--border)">
                    <a
                      href={`/${ownerName}/${repoName}/pulls/${p.number}`}
                      style="font-weight: 500"
                    >
                      #{p.number}
                    </a>{" "}
                    {p.title}
                    {p.authorName && (
                      <span style="color: var(--text-muted); font-size: 12px">
                        {" "}
                        · {p.authorName}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 24px">
          <section>
            <h3 style="font-size: 14px; margin-bottom: 8px">
              Newly opened issues
            </h3>
            {report.issues.openedList.length === 0 ? (
              <p style="color: var(--text-muted); font-size: 13px">
                No new issues in the last {label}.
              </p>
            ) : (
              <ul style="list-style: none; padding: 0; margin: 0">
                {report.issues.openedList.slice(0, 10).map((i) => (
                  <li style="padding: 6px 0; border-bottom: 1px solid var(--border)">
                    <a
                      href={`/${ownerName}/${repoName}/issues/${i.number}`}
                      style="font-weight: 500"
                    >
                      #{i.number}
                    </a>{" "}
                    {i.title}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 style="font-size: 14px; margin-bottom: 8px">
              Newly closed issues
            </h3>
            {report.issues.closedList.length === 0 ? (
              <p style="color: var(--text-muted); font-size: 13px">
                No issues closed in the last {label}.
              </p>
            ) : (
              <ul style="list-style: none; padding: 0; margin: 0">
                {report.issues.closedList.slice(0, 10).map((i) => (
                  <li style="padding: 6px 0; border-bottom: 1px solid var(--border)">
                    <a
                      href={`/${ownerName}/${repoName}/issues/${i.number}`}
                      style="font-weight: 500"
                    >
                      #{i.number}
                    </a>{" "}
                    {i.title}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <p style="color: var(--text-muted); font-size: 11px; margin-top: 24px">
          Window: {days} day{days === 1 ? "" : "s"} · {report.start.slice(0, 10)}{" "}
          → {report.end.slice(0, 10)}
        </p>
      </div>
    </Layout>
  );
});

const TONE_COLORS: Record<string, string> = {
  green: "#2ea043",
  red: "#f85149",
  blue: "#58a6ff",
  grey: "var(--text-muted)",
};

function PulseCard(props: { label: string; value: number; tone: string }) {
  const colour = TONE_COLORS[props.tone] || TONE_COLORS.grey;
  return (
    <div style="border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; background: var(--bg-secondary)">
      <div
        style={`font-size: 22px; font-weight: 600; color: ${colour}; line-height: 1`}
      >
        {props.value}
      </div>
      <div style="color: var(--text-muted); font-size: 12px; margin-top: 4px">
        {props.label}
      </div>
    </div>
  );
}

export default pulseRoutes;
