/**
 * Contributors page — who contributed to this repo, commit counts.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { getRepoPath, repoExists, getDefaultBranch } from "../git/repository";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  Avatar,
  Card,
  Flex,
  List,
  ListItem,
  PageHeader,
  Text,
  Tooltip,
} from "../views/ui";

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
      <PageHeader title="Contributors" />

      <Card style="margin-bottom:24px;padding:16px">
        <Text size={13} muted>Commit activity — last year</Text>
        <Flex gap={2} align="flex-end" style="height:60px;margin-top:8px">
          {weekCounts.map((count) => (
            <Tooltip text={`${count} commits`}>
              <div
                style={`flex:1;background:var(--green);opacity:${count === 0 ? "0.1" : Math.max(0.3, count / maxWeek).toFixed(2)};height:${count === 0 ? "2px" : Math.max(4, (count / maxWeek) * 60).toFixed(0) + "px"};border-radius:1px;`}
              />
            </Tooltip>
          ))}
        </Flex>
      </Card>

      <List>
        {contribs.map((contrib) => (
          <ListItem>
            <Flex align="center" gap={12} style="flex:1">
              <Avatar name={contrib.name} size={36} />
              <div>
                <Text size={14} weight={600}>
                  {contrib.name}
                </Text>
                <br />
                <Text size={12} muted>
                  {contrib.email}
                </Text>
              </div>
            </Flex>
            <div style="text-align:right">
              <Text size={14} weight={600}>
                {contrib.commits}
              </Text>
              <Text size={13} muted>
                {" "}commit{contrib.commits !== 1 ? "s" : ""}
              </Text>
            </div>
          </ListItem>
        ))}
      </List>
    </Layout>
  );
});

export default contributors;
