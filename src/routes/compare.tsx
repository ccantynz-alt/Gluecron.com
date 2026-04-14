/**
 * Compare view — diff between two branches or commits.
 * URL: /:owner/:repo/compare/:base...:head
 */

import { Hono } from "hono";
import { join } from "path";
import { Layout } from "../views/layout";
import { RepoHeader, DiffView } from "../views/components";
import { IssueNav } from "./issues";
import {
  listBranches,
  listCommits,
  repoExists,
  getRepoPath,
} from "../git/repository";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import type { GitDiffFile } from "../git/repository";

const compare = new Hono<AuthEnv>();

compare.use("*", softAuth);

compare.get("/:owner/:repo/compare/:spec?", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const spec = c.req.param("spec");

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const branches = await listBranches(owner, repo);

  if (!spec || !spec.includes("...")) {
    // Show compare picker
    const defaultBase = branches.includes("main") ? "main" : branches[0] || "";
    return c.html(
      <Layout title={`Compare — ${owner}/${repo}`} user={user}>
        <RepoHeader owner={owner} repo={repo} />
        <IssueNav owner={owner} repo={repo} active="code" />
        <h2 style="margin-bottom: 16px">Compare changes</h2>
        <form
          method="get"
          action={`/${owner}/${repo}/compare`}
          style="display: flex; gap: 12px; align-items: center; margin-bottom: 20px"
        >
          <select name="base" class="branch-selector" style="cursor: pointer">
            {branches.map((b) => (
              <option value={b} selected={b === defaultBase}>
                {b}
              </option>
            ))}
          </select>
          <span style="color: var(--text-muted)">...</span>
          <select name="head" class="branch-selector" style="cursor: pointer">
            {branches.map((b) => (
              <option value={b} selected={b !== defaultBase}>
                {b}
              </option>
            ))}
          </select>
          <button
            type="submit"
            class="btn btn-primary"
            onclick={`this.form.action='/${owner}/${repo}/compare/'+this.form.base.value+'...'+this.form.head.value; return true;`}
          >
            Compare
          </button>
        </form>
      </Layout>
    );
  }

  const [base, head] = spec.split("...");

  // Get diff
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn(
    ["git", "diff", `${base}...${head}`],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  // Get numstat
  const statProc = Bun.spawn(
    ["git", "diff", "--numstat", `${base}...${head}`],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const stat = await new Response(statProc.stdout).text();
  await statProc.exited;

  const files: GitDiffFile[] = stat
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [add, del, filePath] = line.split("\t");
      return {
        path: filePath,
        status: "modified",
        additions: add === "-" ? 0 : parseInt(add, 10),
        deletions: del === "-" ? 0 : parseInt(del, 10),
        patch: "",
      };
    });

  // Get commits between
  const logProc = Bun.spawn(
    [
      "git",
      "log",
      "--format=%H%x00%s%x00%an%x00%aI",
      `${base}...${head}`,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const logOutput = await new Response(logProc.stdout).text();
  await logProc.exited;

  const commitsBetween = logOutput
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, msg, author, date] = line.split("\0");
      return { sha, message: msg, author, date };
    });

  return c.html(
    <Layout title={`${base}...${head} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <IssueNav owner={owner} repo={repo} active="code" />
      <h2 style="margin-bottom: 8px">
        Comparing {base}...{head}
      </h2>
      <div style="margin-bottom: 20px; font-size: 14px; color: var(--text-muted)">
        {commitsBetween.length} commit{commitsBetween.length !== 1 ? "s" : ""}
      </div>

      {commitsBetween.length > 0 && (
        <div class="commit-list" style="margin-bottom: 24px">
          {commitsBetween.map((cm) => (
            <div class="commit-item">
              <div>
                <div class="commit-message">
                  <a href={`/${owner}/${repo}/commit/${cm.sha}`}>
                    {cm.message}
                  </a>
                </div>
                <div class="commit-meta">{cm.author}</div>
              </div>
              <a
                href={`/${owner}/${repo}/commit/${cm.sha}`}
                class="commit-sha"
              >
                {cm.sha.slice(0, 7)}
              </a>
            </div>
          ))}
        </div>
      )}

      <DiffView raw={raw} files={files} />
    </Layout>
  );
});

export default compare;
