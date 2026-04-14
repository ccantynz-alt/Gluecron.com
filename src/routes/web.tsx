/**
 * Web UI routes — browse repositories, code, commits, diffs.
 * Now auth-aware with user profiles, repo creation, stars, and syntax highlighting.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { users, repositories, stars } from "../db/schema";
import { Layout } from "../views/layout";
import {
  RepoHeader,
  RepoNav,
  Breadcrumb,
  FileTable,
  CommitList,
  DiffView,
  RepoCard,
  BranchSwitcher,
  HighlightedCode,
  PlainCode,
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
  initBareRepo,
  getBlame,
  getRawBlob,
  searchCode,
} from "../git/repository";
import { renderMarkdown, markdownCss } from "../lib/markdown";
import { highlightCode } from "../lib/highlight";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const web = new Hono<AuthEnv>();

// Soft auth on all web routes — c.get("user") available but may be null
web.use("*", softAuth);

// Home page
web.get("/", async (c) => {
  const user = c.get("user");

  if (user) {
    const { renderDashboard } = await import("./dashboard");
    return renderDashboard(c);
  }

  return c.html(
    <Layout user={null}>
      <div class="empty-state">
        <h2>gluecron</h2>
        <p>AI-native code intelligence platform</p>
        <div style="margin-top: 24px; display: flex; gap: 12px; justify-content: center">
          <a href="/register" class="btn btn-primary">
            Get started
          </a>
          <a href="/login" class="btn">
            Sign in
          </a>
        </div>
        <pre style="margin-top: 32px">{`# Quick start
curl -X POST http://localhost:3000/api/setup \\
  -H 'Content-Type: application/json' \\
  -d '{"username":"you","email":"you@dev.com","repoName":"hello"}'

git remote add gluecron http://localhost:3000/you/hello.git
git push gluecron main`}</pre>
      </div>
    </Layout>
  );
});

// New repository form
web.get("/new", requireAuth, (c) => {
  const user = c.get("user")!;
  const error = c.req.query("error");

  return c.html(
    <Layout title="New repository" user={user}>
      <div class="new-repo-form">
        <h2>Create a new repository</h2>
        {error && <div class="auth-error">{decodeURIComponent(error)}</div>}
        <form method="POST" action="/new">
          <div class="form-group">
            <label>Owner</label>
            <input type="text" value={user.username} disabled class="input-disabled" />
          </div>
          <div class="form-group">
            <label for="name">Repository name</label>
            <input
              type="text"
              id="name"
              name="name"
              required
              pattern="^[a-zA-Z0-9._-]+$"
              placeholder="my-project"
              autocomplete="off"
            />
          </div>
          <div class="form-group">
            <label for="description">Description (optional)</label>
            <input
              type="text"
              id="description"
              name="description"
              placeholder="A short description of your repository"
            />
          </div>
          <div class="visibility-options">
            <label class="visibility-option">
              <input type="radio" name="visibility" value="public" checked />
              <div class="vis-label">Public</div>
              <div class="vis-desc">Anyone can see this repository</div>
            </label>
            <label class="visibility-option">
              <input type="radio" name="visibility" value="private" />
              <div class="vis-label">Private</div>
              <div class="vis-desc">Only you can see this repository</div>
            </label>
          </div>
          <button type="submit" class="btn btn-primary">
            Create repository
          </button>
        </form>
      </div>
    </Layout>
  );
});

web.post("/new", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const isPrivate = body.visibility === "private";

  if (!name) {
    return c.redirect("/new?error=Repository+name+is+required");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return c.redirect("/new?error=Invalid+repository+name");
  }

  if (await repoExists(user.username, name)) {
    return c.redirect("/new?error=Repository+already+exists");
  }

  const diskPath = await initBareRepo(user.username, name);

  const [newRepo] = await db
    .insert(repositories)
    .values({
      name,
      ownerId: user.id,
      description: description || null,
      isPrivate,
      diskPath,
    })
    .returning();

  if (newRepo) {
    const { bootstrapRepository } = await import("../lib/repo-bootstrap");
    await bootstrapRepository({
      repositoryId: newRepo.id,
      ownerUserId: user.id,
      defaultBranch: "main",
    });
  }

  return c.redirect(`/${user.username}/${name}`);
});

// User profile
web.get("/:owner", async (c) => {
  const { owner: ownerName } = c.req.param();
  const user = c.get("user");

  // Avoid clashing with fixed routes
  if (
    ["login", "register", "logout", "new", "settings", "api"].includes(
      ownerName
    )
  ) {
    return c.notFound();
  }

  let ownerUser;
  try {
    const [found] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    ownerUser = found;
  } catch {
    // DB not available — check if repos exist on disk
    ownerUser = null;
  }

  // Even without DB, show repos if they exist on disk
  let repos: any[] = [];
  if (ownerUser) {
    const allRepos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.ownerId, ownerUser.id))
      .orderBy(desc(repositories.updatedAt));

    // Show public repos to everyone, private only to owner
    repos =
      user?.id === ownerUser.id
        ? allRepos
        : allRepos.filter((r) => !r.isPrivate);
  }

  return c.html(
    <Layout title={ownerName} user={user}>
      <div class="user-profile">
        <div class="user-avatar">
          {(ownerUser?.displayName || ownerName)[0].toUpperCase()}
        </div>
        <div class="user-info">
          <h2>{ownerUser?.displayName || ownerName}</h2>
          <div class="username">@{ownerName}</div>
          {ownerUser?.bio && <div class="bio">{ownerUser.bio}</div>}
        </div>
      </div>
      <h3 style="margin-bottom: 16px">Repositories</h3>
      {repos.length === 0 ? (
        <p style="color: var(--text-muted)">No repositories yet.</p>
      ) : (
        <div class="card-grid">
          {repos.map((repo) => (
            <RepoCard repo={repo} ownerName={ownerName} />
          ))}
        </div>
      )}
    </Layout>
  );
});

// Star/unstar a repo
web.post("/:owner/:repo/star", requireAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user")!;

  try {
    const [ownerUser] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerUser) return c.redirect(`/${ownerName}/${repoName}`);

    const [repo] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerUser.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repo) return c.redirect(`/${ownerName}/${repoName}`);

    // Toggle star
    const [existing] = await db
      .select()
      .from(stars)
      .where(
        and(eq(stars.userId, user.id), eq(stars.repositoryId, repo.id))
      )
      .limit(1);

    if (existing) {
      await db.delete(stars).where(eq(stars.id, existing.id));
      await db
        .update(repositories)
        .set({ starCount: Math.max(0, repo.starCount - 1) })
        .where(eq(repositories.id, repo.id));
    } else {
      await db.insert(stars).values({
        userId: user.id,
        repositoryId: repo.id,
      });
      await db
        .update(repositories)
        .set({ starCount: repo.starCount + 1 })
        .where(eq(repositories.id, repo.id));
    }
  } catch {
    // DB error — ignore
  }

  return c.redirect(`/${ownerName}/${repoName}`);
});

// Repository overview — file tree at HEAD
web.get("/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) {
    return c.html(
      <Layout title="Not Found" user={user}>
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

  // Parallelize all independent operations
  const [defaultBranch, branches] = await Promise.all([
    getDefaultBranch(owner, repo).then((b) => b || "main"),
    listBranches(owner, repo),
  ]);
  const [tree, starInfo] = await Promise.all([
    getTree(owner, repo, defaultBranch),
    // Star info fetched in parallel with tree
    (async () => {
      try {
        const [ownerUser] = await db
          .select()
          .from(users)
          .where(eq(users.username, owner))
          .limit(1);
        if (!ownerUser) return { starCount: 0, starred: false };
        const [repoRow] = await db
          .select()
          .from(repositories)
          .where(
            and(
              eq(repositories.ownerId, ownerUser.id),
              eq(repositories.name, repo)
            )
          )
          .limit(1);
        if (!repoRow) return { starCount: 0, starred: false };
        let starred = false;
        if (user) {
          const [star] = await db
            .select()
            .from(stars)
            .where(
              and(
                eq(stars.userId, user.id),
                eq(stars.repositoryId, repoRow.id)
              )
            )
            .limit(1);
          starred = !!star;
        }
        return { starCount: repoRow.starCount, starred };
      } catch {
        return { starCount: 0, starred: false };
      }
    })(),
  ]);
  const { starCount, starred } = starInfo;

  if (tree.length === 0) {
    return c.html(
      <Layout title={`${owner}/${repo}`} user={user}>
        <RepoHeader
          owner={owner}
          repo={repo}
          starCount={starCount}
          starred={starred}
          currentUser={user?.username}
        />
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
    <Layout title={`${owner}/${repo}`} user={user}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={starCount}
        starred={starred}
        currentUser={user?.username}
      />
      <RepoNav owner={owner} repo={repo} active="code" />
      <BranchSwitcher
        owner={owner}
        repo={repo}
        currentRef={defaultBranch}
        branches={branches}
        pathType="tree"
      />
      <FileTable
        entries={tree}
        owner={owner}
        repo={repo}
        ref={defaultBranch}
        path=""
      />
      {readme && (() => {
        const readmeHtml = renderMarkdown(readme);
        return (
          <div class="blob-view" style="margin-top: 20px">
            <div class="blob-header">README.md</div>
            <style>{markdownCss}</style>
            <div class="markdown-body">
              {html([readmeHtml] as unknown as TemplateStringsArray)}
            </div>
          </div>
        );
      })()}
    </Layout>
  );
});

// Browse tree at ref/path
web.get("/:owner/:repo/tree/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const refAndPath = c.req.param("ref");

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
    <Layout title={`${treePath || "/"} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <BranchSwitcher
        owner={owner}
        repo={repo}
        currentRef={ref}
        branches={branches}
        pathType="tree"
        subPath={treePath}
      />
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

// View file blob with syntax highlighting
web.get("/:owner/:repo/blob/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
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
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>File not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const fileName = filePath.split("/").pop() || filePath;

  return c.html(
    <Layout title={`${filePath} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <BranchSwitcher
        owner={owner}
        repo={repo}
        currentRef={ref}
        branches={branches}
        pathType="blob"
        subPath={filePath}
      />
      <Breadcrumb owner={owner} repo={repo} ref={ref} path={filePath} />
      <div class="blob-view">
        <div class="blob-header">
          <span>{fileName} — {blob.size} bytes</span>
          <span style="display: flex; gap: 12px">
            <a href={`/${owner}/${repo}/raw/${ref}/${filePath}`} style="font-size: 12px">
              Raw
            </a>
            <a href={`/${owner}/${repo}/blame/${ref}/${filePath}`} style="font-size: 12px">
              Blame
            </a>
            {user && (
              <a href={`/${owner}/${repo}/edit/${ref}/${filePath}`} style="font-size: 12px">
                Edit
              </a>
            )}
          </span>
        </div>
        {blob.isBinary ? (
          <div style="padding: 16px; color: var(--text-muted)">
            Binary file not shown.
          </div>
        ) : (() => {
          const { html: highlighted, language } = highlightCode(
            blob.content,
            fileName
          );
          const lineCount = blob.content.split("\n").length;
          // Trim trailing newline from count
          const adjustedCount =
            blob.content.endsWith("\n") ? lineCount - 1 : lineCount;

          if (language) {
            return (
              <HighlightedCode
                highlightedHtml={highlighted}
                lineCount={adjustedCount}
              />
            );
          }
          const lines = blob.content.split("\n");
          if (lines[lines.length - 1] === "") lines.pop();
          return <PlainCode lines={lines} />;
        })()}
      </div>
    </Layout>
  );
});

// Commit log
web.get("/:owner/:repo/commits/:ref?", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const ref =
    c.req.param("ref") || (await getDefaultBranch(owner, repo)) || "main";
  const branches = await listBranches(owner, repo);

  const commits = await listCommits(owner, repo, ref, 50);

  return c.html(
    <Layout title={`Commits — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="commits" />
      <BranchSwitcher
        owner={owner}
        repo={repo}
        currentRef={ref}
        branches={branches}
        pathType="commits"
      />
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
  const user = c.get("user");

  // Fetch commit, full message, and diff in parallel
  const [commit, fullMessage, diffResult] = await Promise.all([
    getCommit(owner, repo, sha),
    getCommitFullMessage(owner, repo, sha),
    getDiff(owner, repo, sha),
  ]);
  if (!commit) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>Commit not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const { files, raw } = diffResult;

  return c.html(
    <Layout title={`${commit.message} — ${owner}/${repo}`} user={user}>
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

// Raw file download
web.get("/:owner/:repo/raw/:ref{.+$}", async (c) => {
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

  const data = await getRawBlob(owner, repo, ref, filePath);
  if (!data) return c.text("Not found", 404);

  const fileName = filePath.split("/").pop() || "file";
  return new Response(data, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
    },
  });
});

// Blame view
web.get("/:owner/:repo/blame/:ref{.+$}", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
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

  const blameLines = await getBlame(owner, repo, ref, filePath);
  if (blameLines.length === 0) {
    return c.html(
      <Layout title="Not Found" user={user}>
        <div class="empty-state">
          <h2>File not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const fileName = filePath.split("/").pop() || filePath;

  return c.html(
    <Layout title={`Blame: ${filePath} — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <Breadcrumb owner={owner} repo={repo} ref={ref} path={filePath} />
      <div class="blob-view">
        <div class="blob-header">
          <span>{fileName} — blame</span>
          <a href={`/${owner}/${repo}/blob/${ref}/${filePath}`} style="font-size: 12px">
            Normal view
          </a>
        </div>
        <div class="blob-code" style="overflow-x: auto">
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; font-family: var(--font-mono)">
            <tbody>
              {blameLines.map((line, i) => {
                const showInfo =
                  i === 0 || blameLines[i - 1].sha !== line.sha;
                return (
                  <tr style="border-bottom: 1px solid var(--border)">
                    <td
                      style={`width: 200px; padding: 0 8px; font-size: 11px; color: var(--text-muted); white-space: nowrap; vertical-align: top; ${showInfo ? "border-top: 1px solid var(--border)" : ""}`}
                    >
                      {showInfo && (
                        <>
                          <a
                            href={`/${owner}/${repo}/commit/${line.sha}`}
                            style="color: var(--text-link); font-family: var(--font-mono)"
                          >
                            {line.sha.slice(0, 7)}
                          </a>{" "}
                          <span>{line.author}</span>
                        </>
                      )}
                    </td>
                    <td class="line-num">{line.lineNum}</td>
                    <td class="line-content">{line.content}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
});

// Search
web.get("/:owner/:repo/search", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");
  const q = c.req.query("q") || "";

  if (!(await repoExists(owner, repo))) return c.notFound();

  const defaultBranch = (await getDefaultBranch(owner, repo)) || "main";
  let results: Array<{ file: string; lineNum: number; line: string }> = [];

  if (q.trim()) {
    results = await searchCode(owner, repo, defaultBranch, q.trim());
  }

  return c.html(
    <Layout title={`Search — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <RepoNav owner={owner} repo={repo} active="code" />
      <form
        method="GET"
        action={`/${owner}/${repo}/search`}
        style="margin-bottom: 20px"
      >
        <div style="display: flex; gap: 8px">
          <input
            type="text"
            name="q"
            value={q}
            placeholder="Search code..."
            style="flex: 1; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px"
          />
          <button type="submit" class="btn btn-primary">
            Search
          </button>
        </div>
      </form>
      {q && (
        <p style="font-size: 14px; color: var(--text-muted); margin-bottom: 16px">
          {results.length} result{results.length !== 1 ? "s" : ""} for{" "}
          <strong style="color: var(--text)">"{q}"</strong>
        </p>
      )}
      {results.length > 0 && (
        <div class="search-results">
          {(() => {
            // Group by file
            const grouped: Record<
              string,
              Array<{ lineNum: number; line: string }>
            > = {};
            for (const r of results) {
              if (!grouped[r.file]) grouped[r.file] = [];
              grouped[r.file].push({ lineNum: r.lineNum, line: r.line });
            }
            return Object.entries(grouped).map(([file, matches]) => (
              <div class="diff-file" style="margin-bottom: 12px">
                <div class="diff-file-header">
                  <a
                    href={`/${owner}/${repo}/blob/${defaultBranch}/${file}`}
                  >
                    {file}
                  </a>
                </div>
                <div class="blob-code">
                  <table>
                    <tbody>
                      {matches.map((m) => (
                        <tr>
                          <td class="line-num">{m.lineNum}</td>
                          <td class="line-content">{m.line}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ));
          })()}
        </div>
      )}
    </Layout>
  );
});

export default web;
