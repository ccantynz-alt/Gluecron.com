/**
 * Web UI routes — browse repositories, code, commits, diffs.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import {
  RepoHeader,
  RepoNav,
  Breadcrumb,
  FileTable,
  CommitList,
  DiffView,
} from "../views/components";
import {
  getTree,
  getBlob,
  listCommits,
  getCommit,
  getCommitFullMessage,
  getDiff,
  getReadme,
  getDefaultBranch,
  listBranches,
  repoExists,
} from "../git/repository";

const web = new Hono();

// Home page
web.get("/", (c) => {
  return c.html(
    <Layout>
      <div class="empty-state">
        <h2>gluecron</h2>
        <p>AI-native code intelligence platform</p>
        <pre>{`# Quick start
curl -X POST http://localhost:3000/api/setup \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"you","email":"you@dev.com","repoName":"hello"}'

git remote add gluecron http://localhost:3000/you/hello.git
git push gluecron main`}</pre>
      </div>
    </Layout>
  );
});

// User profile (list repos) — placeholder
web.get("/:owner", async (c) => {
  const { owner } = c.req.param();
  return c.html(
    <Layout title={owner}>
      <h2 style="margin-bottom: 16px">{owner}</h2>
      <p style="color: var(--text-muted)">
        Repository listing coming soon. Use the API to browse repos.
      </p>
    </Layout>
  );
});

// Repository overview — file tree at HEAD
web.get("/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found">
        <div class="empty-state">
          <h2>Repository not found</h2>
          <p>
            {owner}/{repo} does not exist.
          </p>
        </div>
      </Layout>,
      404
    );
  }

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  const tree = await getTree(owner, repo, defaultBranch);

  if (tree.length === 0) {
    return c.html(
      <Layout title={`${owner}/${repo}`}>
        <RepoHeader owner={owner} repo={repo} />
        <RepoNav owner={owner} repo={repo} active="code" />
        <div class="empty-state">
          <h2>Empty repository</h2>
          <p>Get started by pushing code:</p>
          <pre>{`git remote add gluecron http://localhost:3000/${owner}/${repo}.git
git push -u gluecron main`}</pre>
        </div>
      </Layout>
    );
  }

  const readme = await getReadme(owner, repo, defaultBranch);

  return c.html(
    <Layout title={`${owner}/${repo}`}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="branch-selector">{defaultBranch}</div>
      <FileTable
        entries={tree}
        owner={owner}
        repo={repo}
        ref={defaultBranch}
        path=""
      />
      {readme && (
        <div
          class="blob-view"
          style="margin-top: 20px"
        >
          <div class="blob-header">README.md</div>
          <div style="padding: 16px; white-space: pre-wrap; font-size: 14px;">
            {readme}
          </div>
        </div>
      )}
    </Layout>
  );
});

// Browse tree at ref/path
web.get("/:owner/:repo/tree/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const refAndPath = c.req.param("ref");

  // Parse ref from path — try known branches first, fallback to first segment
  const branches = await listBranches(owner, repo);
  let ref = "";
  let treePath = "";

  for (const branch of branches) {
    if (refAndPath === branch || refAndPath.startsWith(branch + "/")) {
      ref = branch;
      treePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }

  if (!ref) {
    // Assume first path segment is the ref
    const slashIdx = refAndPath.indexOf("/");
    if (slashIdx === -1) {
      ref = refAndPath;
    } else {
      ref = refAndPath.slice(0, slashIdx);
      treePath = refAndPath.slice(slashIdx + 1);
    }
  }

  const tree = await getTree(owner, repo, ref, treePath);

  return c.html(
    <Layout title={`${treePath || "/"} — ${owner}/${repo}`}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="branch-selector">{ref}</div>
      <Breadcrumb owner={owner} repo={repo} ref={ref} path={treePath} />
      <FileTable
        entries={tree}
        owner={owner}
        repo={repo}
        ref={ref}
        path={treePath}
      />
    </Layout>
  );
});

// View file blob
web.get("/:owner/:repo/blob/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const refAndPath = c.req.param("ref");

  const branches = await listBranches(owner, repo);
  let ref = "";
  let filePath = "";

  for (const branch of branches) {
    if (refAndPath.startsWith(branch + "/")) {
      ref = branch;
      filePath = refAndPath.slice(branch.length + 1);
      break;
    }
  }

  if (!ref) {
    const slashIdx = refAndPath.indexOf("/");
    if (slashIdx === -1) return c.text("Not found", 404);
    ref = refAndPath.slice(0, slashIdx);
    filePath = refAndPath.slice(slashIdx + 1);
  }

  const blob = await getBlob(owner, repo, ref, filePath);
  if (!blob) {
    return c.html(
      <Layout title="Not Found">
        <div class="empty-state">
          <h2>File not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const lines = blob.content.split("\n");
  // Remove trailing empty line from split
  if (lines[lines.length - 1] === "") lines.pop();

  return c.html(
    <Layout title={`${filePath} — ${owner}/${repo}`}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <div class="branch-selector">{ref}</div>
      <Breadcrumb owner={owner} repo={repo} ref={ref} path={filePath} />
      <div class="blob-view">
        <div class="blob-header">
          {filePath.split("/").pop()} — {blob.size} bytes
        </div>
        {blob.isBinary ? (
          <div style="padding: 16px; color: var(--text-muted)">
            Binary file not shown.
          </div>
        ) : (
          <div class="blob-code">
            <table>
              <tbody>
                {lines.map((line, i) => (
                  <tr>
                    <td class="line-num">{i + 1}</td>
                    <td class="line-content">{line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
});

// Commit log
web.get("/:owner/:repo/commits/:ref?", async (c) => {
  const { owner, repo } = c.req.param();
  const ref =
    c.req.param("ref") || (await getDefaultBranch(owner, repo)) || "main";

  const commits = await listCommits(owner, repo, ref, 50);

  return c.html(
    <Layout title={`Commits — ${owner}/${repo}`}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="commits" />
      <div class="branch-selector">{ref}</div>
      {commits.length === 0 ? (
        <div class="empty-state">
          <p>No commits yet.</p>
        </div>
      ) : (
        <CommitList commits={commits} owner={owner} repo={repo} />
      )}
    </Layout>
  );
});

// Single commit with diff
web.get("/:owner/:repo/commit/:sha", async (c) => {
  const { owner, repo, sha } = c.req.param();

  const commit = await getCommit(owner, repo, sha);
  if (!commit) {
    return c.html(
      <Layout title="Not Found">
        <div class="empty-state">
          <h2>Commit not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const fullMessage = await getCommitFullMessage(owner, repo, sha);
  const { files, raw } = await getDiff(owner, repo, sha);

  return c.html(
    <Layout title={`${commit.message} — ${owner}/${repo}`}>
      <RepoHeader owner={owner} repo={repo} />
      <div
        style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 20px"
      >
        <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px">
          {commit.message}
        </div>
        {fullMessage !== commit.message && (
          <div style="white-space: pre-wrap; color: var(--text-muted); font-size: 14px; margin-bottom: 12px">
            {fullMessage}
          </div>
        )}
        <div style="font-size: 13px; color: var(--text-muted)">
          <strong style="color: var(--text)">{commit.author}</strong>{" "}
          committed on{" "}
          {new Date(commit.date).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </div>
        <div style="margin-top: 8px">
          <span class="commit-sha">{commit.sha}</span>
          {commit.parentShas.length > 0 && (
            <span style="margin-left: 12px; font-size: 13px; color: var(--text-muted)">
              Parent:{" "}
              {commit.parentShas.map((p) => (
                <a
                  href={`/${owner}/${repo}/commit/${p}`}
                  class="commit-sha"
                  style="margin-left: 4px"
                >
                  {p.slice(0, 7)}
                </a>
              ))}
            </span>
          )}
        </div>
      </div>
      <DiffView raw={raw} files={files} />
    </Layout>
  );
});

export default web;
