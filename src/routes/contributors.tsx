/**
 * Contributors page — who contributed to this repo, commit counts.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getRepoPath, repoExists, getDefaultBranch } from "../git/repository";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const contributors = new Hono<AuthEnv>();

contributors.use("*", softAuth);

interface Contributor {
  name: string;
  email: string;
  commits: number;
  additions: number;
  deletions: number;
}

contributors.get("/:owner/:repo/contributors", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();

  const ref = (await getDefaultBranch(owner, repo)) || "main";
  const repoDir = getRepoPath(owner, repo);

  // Get shortlog for commit counts
  const shortlogProc = Bun.spawn(
    ["git", "shortlog", "-sne", ref],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const shortlogOut = await new Response(shortlogProc.stdout).text();
  await shortlogProc.exited;

  const contribs: Contributor[] = shortlogOut
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\t(.+?)\s+<(.+?)>$/);
      if (!match) return null;
      return {
        name: match[2],
        email: match[3],
        commits: parseInt(match[1], 10),
        additions: 0,
        deletions: 0,
      };
    })
    .filter((c): c is Contributor => c !== null)
    .sort((a, b) => b.commits - a.commits);

  // Get recent commit activity (last 52 weeks)
  const activityProc = Bun.spawn(
    [
      "git",
      "log",
      "--format=%aI",
      "--since=1 year ago",
      ref,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const activityOut = await new Response(activityProc.stdout).text();
  await activityProc.exited;

  // Build weekly commit counts
  const weekCounts: number[] = new Array(52).fill(0);
  const now = Date.now();
  for (const line of activityOut.trim().split("\n").filter(Boolean)) {
    const date = new Date(line);
    const weeksAgo = Math.floor(
      (now - date.getTime()) / (7 * 24 * 60 * 60 * 1000)
    );
    if (weeksAgo >= 0 && weeksAgo < 52) {
      weekCounts[51 - weeksAgo]++;
    }
  }

  const maxWeek = Math.max(...weekCounts, 1);

  return c.html(
    <Layout title={`Contributors — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <h2 style="margin-bottom: 16px">Contributors</h2>

      <div
        style="margin-bottom: 24px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px"
      >
        <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px">
          Commit activity — last year
        </div>
        <div style="display: flex; gap: 2px; align-items: flex-end; height: 60px">
          {weekCounts.map((count) => (
            <div
              style={`flex: 1; background: var(--green); opacity: ${count === 0 ? "0.1" : Math.max(0.3, count / maxWeek).toFixed(2)}; height: ${count === 0 ? "2px" : Math.max(4, (count / maxWeek) * 60).toFixed(0) + "px"}; border-radius: 1px;`}
              title={`${count} commits`}
            />
          ))}
        </div>
      </div>

      <div class="issue-list">
        {contribs.map((contrib, i) => (
          <div class="issue-item">
            <div style="display: flex; align-items: center; gap: 12px; flex: 1">
              <div class="user-avatar" style="width: 36px; height: 36px; font-size: 16px; flex-shrink: 0">
                {contrib.name[0].toUpperCase()}
              </div>
              <div>
                <div style="font-weight: 600; font-size: 14px">
                  {contrib.name}
                </div>
                <div style="font-size: 12px; color: var(--text-muted)">
                  {contrib.email}
                </div>
              </div>
            </div>
            <div style="text-align: right">
              <span style="font-weight: 600; font-size: 14px">
                {contrib.commits}
              </span>
              <span style="color: var(--text-muted); font-size: 13px">
                {" "}
                commit{contrib.commits !== 1 ? "s" : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
});

export default contributors;
