/**
 * Pull request routes — create, list, view, merge, close, comment.
 */

import { Hono } from "hono";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, DiffView } from "../views/components";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  listBranches,
  getRepoPath,
} from "../git/repository";
import type { GitDiffFile } from "../git/repository";
import { html } from "hono/html";
import {
  Flex,
  Container,
  Badge,
  Button,
  LinkButton,
  Form,
  FormGroup,
  Input,
  TextArea,
  Select,
  EmptyState,
  FilterTabs,
  TabNav,
  List,
  ListItem,
  Text,
  Alert,
  MarkdownContent,
  CommentBox,
  formatRelative,
} from "../views/ui";

const pulls = new Hono<AuthEnv>();

async function resolveRepo(ownerName: string, repoName: string) {
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
      and(eq(repositories.ownerId, owner.id), eq(repositories.name, repoName))
    )
    .limit(1);
  if (!repo) return null;
  return { owner, repo };
}

// PR Nav helper
const PrNav = ({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: "code" | "issues" | "pulls" | "commits";
}) => (
  <TabNav
    tabs={[
      { label: "Code", href: `/${owner}/${repo}`, active: active === "code" },
      { label: "Issues", href: `/${owner}/${repo}/issues`, active: active === "issues" },
      { label: "Pull Requests", href: `/${owner}/${repo}/pulls`, active: active === "pulls" },
      { label: "Commits", href: `/${owner}/${repo}/commits`, active: active === "commits" },
    ]}
  />
);

// List PRs
pulls.get("/:owner/:repo/pulls", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const prList = await db
    .select({
      pr: pullRequests,
      author: { username: users.username },
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.state, state)
      )
    )
    .orderBy(desc(pullRequests.createdAt));

  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${pullRequests.state} = 'open')`,
      closed: sql<number>`count(*) filter (where ${pullRequests.state} = 'closed')`,
      merged: sql<number>`count(*) filter (where ${pullRequests.state} = 'merged')`,
    })
    .from(pullRequests)
    .where(eq(pullRequests.repositoryId, resolved.repo.id));

  return c.html(
    <Layout title={`Pull Requests — ${ownerName}/${repoName}`} user={user}>
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <Flex justify="space-between" align="center" style="margin-bottom:16px">
        <FilterTabs
          tabs={[
            { label: `${counts?.open ?? 0} Open`, href: `/${ownerName}/${repoName}/pulls?state=open`, active: state === "open" },
            { label: `${counts?.merged ?? 0} Merged`, href: `/${ownerName}/${repoName}/pulls?state=merged`, active: state === "merged" },
            { label: `${counts?.closed ?? 0} Closed`, href: `/${ownerName}/${repoName}/pulls?state=closed`, active: state === "closed" },
          ]}
        />
        {user && (
          <LinkButton href={`/${ownerName}/${repoName}/pulls/new`} variant="primary">
            New pull request
          </LinkButton>
        )}
      </Flex>
      {prList.length === 0 ? (
        <EmptyState>
          <p>No {state} pull requests.</p>
        </EmptyState>
      ) : (
        <List>
          {prList.map(({ pr, author }) => (
            <ListItem>
              <div
                class={`issue-state-icon ${pr.state === "open" ? "state-open" : pr.state === "merged" ? "state-merged" : "state-closed"}`}
              >
                {pr.state === "open"
                  ? "\u25CB"
                  : pr.state === "merged"
                    ? "\u2B8C"
                    : "\u2713"}
              </div>
              <div>
                <div class="issue-title">
                  <a href={`/${ownerName}/${repoName}/pulls/${pr.number}`}>
                    {pr.title}
                  </a>
                </div>
                <div class="issue-meta">
                  #{pr.number}{" "}
                  {pr.headBranch} → {pr.baseBranch}{" "}
                  by {author.username}{" "}
                  {formatRelative(pr.createdAt)}
                </div>
              </div>
            </ListItem>
          ))}
        </List>
      )}
    </Layout>
  );
});

// New PR form
pulls.get(
  "/:owner/:repo/pulls/new",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const branches = await listBranches(ownerName, repoName);
    const error = c.req.query("error");
    const defaultBase = branches.includes("main") ? "main" : branches[0] || "";

    return c.html(
      <Layout title={`New PR — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <PrNav owner={ownerName} repo={repoName} active="pulls" />
        <Container maxWidth={800}>
          <h2 style="margin-bottom:16px">Open a pull request</h2>
          {error && (
            <Alert variant="error">{decodeURIComponent(error)}</Alert>
          )}
          <Form action={`/${ownerName}/${repoName}/pulls/new`} method="POST">
            <Flex gap={12} align="center" style="margin-bottom:16px">
              <Select name="base" value={defaultBase}>
                {branches.map((b) => (
                  <option value={b} selected={b === defaultBase}>
                    {b}
                  </option>
                ))}
              </Select>
              <Text muted>&larr;</Text>
              <Select name="head">
                {branches
                  .filter((b) => b !== defaultBase)
                  .concat(defaultBase === branches[0] ? [] : [branches[0]])
                  .map((b) => (
                    <option value={b}>{b}</option>
                  ))}
              </Select>
            </Flex>
            <FormGroup>
              <Input
                name="title"
                required
                placeholder="Title"
                style="font-size:16px;padding:10px 14px"
              />
            </FormGroup>
            <FormGroup>
              <TextArea
                name="body"
                rows={8}
                placeholder="Description (Markdown supported)"
                mono
              />
            </FormGroup>
            <Button type="submit" variant="primary">
              Create pull request
            </Button>
          </Form>
        </Container>
      </Layout>
    );
  }
);

// Create PR
pulls.post(
  "/:owner/:repo/pulls/new",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const title = String(body.title || "").trim();
    const prBody = String(body.body || "").trim();
    const baseBranch = String(body.base || "main");
    const headBranch = String(body.head || "");

    if (!title || !headBranch) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/new?error=Title+and+branches+are+required`
      );
    }

    if (baseBranch === headBranch) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/new?error=Base+and+head+branches+must+be+different`
      );
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: resolved.repo.id,
        authorId: user.id,
        title,
        body: prBody || null,
        baseBranch,
        headBranch,
      })
      .returning();

    return c.redirect(`/${ownerName}/${repoName}/pulls/${pr.number}`);
  }
);

// View single PR
pulls.get("/:owner/:repo/pulls/:number", softAuth, async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const prNum = parseInt(c.req.param("number"), 10);
  const user = c.get("user");
  const tab = c.req.query("tab") || "conversation";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, resolved.repo.id),
        eq(pullRequests.number, prNum)
      )
    )
    .limit(1);

  if (!pr) return c.notFound();

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.id, pr.authorId))
    .limit(1);

  const comments = await db
    .select({
      comment: prComments,
      author: { username: users.username },
    })
    .from(prComments)
    .innerJoin(users, eq(prComments.authorId, users.id))
    .where(eq(prComments.pullRequestId, pr.id))
    .orderBy(asc(prComments.createdAt));

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === pr.authorId);

  // Get diff for "Files changed" tab
  let diffRaw = "";
  let diffFiles: GitDiffFile[] = [];
  if (tab === "files") {
    const repoDir = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "diff", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    diffRaw = await new Response(proc.stdout).text();
    await proc.exited;

    const statProc = Bun.spawn(
      ["git", "diff", "--numstat", `${pr.baseBranch}...${pr.headBranch}`],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const stat = await new Response(statProc.stdout).text();
    await statProc.exited;

    diffFiles = stat
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
  }

  return c.html(
    <Layout
      title={`${pr.title} #${pr.number} — ${ownerName}/${repoName}`}
      user={user}
    >
      <RepoHeader owner={ownerName} repo={repoName} />
      <PrNav owner={ownerName} repo={repoName} active="pulls" />
      <div class="issue-detail">
        <h2>
          {pr.title}{" "}
          <Text color="var(--text-muted)" weight={400}>
            #{pr.number}
          </Text>
        </h2>
        <Flex align="center" gap={8} style="margin:8px 0 20px">
          <Badge
            variant={pr.state === "open" ? "open" : pr.state === "merged" ? "merged" : "closed"}
          >
            {pr.state === "open"
              ? "\u25CB Open"
              : pr.state === "merged"
                ? "\u2B8C Merged"
                : "\u2713 Closed"}
          </Badge>
          <Text size={14} muted>
            <strong style="color:var(--text)">
              {author?.username}
            </strong>{" "}
            wants to merge <code>{pr.headBranch}</code> into{" "}
            <code>{pr.baseBranch}</code>
          </Text>
        </Flex>

        <FilterTabs
          tabs={[
            {
              label: "Conversation",
              href: `/${ownerName}/${repoName}/pulls/${pr.number}`,
              active: tab === "conversation",
            },
            {
              label: "Files changed",
              href: `/${ownerName}/${repoName}/pulls/${pr.number}?tab=files`,
              active: tab === "files",
            },
          ]}
        />

        {tab === "files" ? (
          <DiffView raw={diffRaw} files={diffFiles} />
        ) : (
          <>
            {pr.body && (
              <CommentBox
                author={author?.username ?? "unknown"}
                date={pr.createdAt}
                body={renderMarkdown(pr.body)}
              />
            )}

            {comments.map(({ comment, author: commentAuthor }) => (
              <div
                class={`issue-comment-box ${comment.isAiReview ? "ai-review" : ""}`}
              >
                <div class="comment-header">
                  <Flex gap={8} align="center">
                    <strong>{commentAuthor.username}</strong>
                    {comment.isAiReview && (
                      <Badge variant="default" style="margin-left:8px;background:rgba(31,111,235,0.15);color:var(--text-link);border-color:var(--accent)">
                        AI Review
                      </Badge>
                    )}
                    <Text size={13} muted>
                      commented {formatRelative(comment.createdAt)}
                    </Text>
                    {comment.filePath && (
                      <Text size={11} mono style="margin-left:8px">
                        {comment.filePath}
                        {comment.lineNumber ? `:${comment.lineNumber}` : ""}
                      </Text>
                    )}
                  </Flex>
                </div>
                <MarkdownContent html={renderMarkdown(comment.body)} />
              </div>
            ))}

            {user && pr.state === "open" && (
              <div style="margin-top:20px">
                <Form
                  action={`/${ownerName}/${repoName}/pulls/${pr.number}/comment`}
                  method="POST"
                >
                  <FormGroup>
                    <TextArea
                      name="body"
                      rows={6}
                      required
                      placeholder="Leave a comment... (Markdown supported)"
                      mono
                    />
                  </FormGroup>
                  <Flex gap={8}>
                    <Button type="submit" variant="primary">
                      Comment
                    </Button>
                    {canManage && (
                      <>
                        <button
                          type="submit"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/merge`}
                          class="btn"
                          style="background:rgba(63,185,80,0.15);border-color:var(--green);color:var(--green)"
                        >
                          Merge pull request
                        </button>
                        <Button
                          type="submit"
                          variant="danger"
                          formaction={`/${ownerName}/${repoName}/pulls/${pr.number}/close`}
                        >
                          Close
                        </Button>
                      </>
                    )}
                  </Flex>
                </Form>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
});

// Add comment to PR
pulls.post(
  "/:owner/:repo/pulls/:number/comment",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;
    const body = await c.req.parseBody();
    const commentBody = String(body.body || "").trim();

    if (!commentBody) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    await db.insert(prComments).values({
      pullRequestId: pr.id,
      authorId: user.id,
      body: commentBody,
    });

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Merge PR
pulls.post(
  "/:owner/:repo/pulls/:number/merge",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);
    const user = c.get("user")!;

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      )
      .limit(1);

    if (!pr || pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    // Perform git merge
    const repoDir = getRepoPath(ownerName, repoName);
    const mergeProc = Bun.spawn(
      [
        "git",
        "merge-base",
        "--is-ancestor",
        pr.baseBranch,
        pr.headBranch,
      ],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    await mergeProc.exited;

    // Use git update-ref for fast-forward or create merge commit
    const ffProc = Bun.spawn(
      [
        "git",
        "update-ref",
        `refs/heads/${pr.baseBranch}`,
        `refs/heads/${pr.headBranch}`,
      ],
      { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
    );
    const ffExit = await ffProc.exited;

    if (ffExit !== 0) {
      // Fallback: try creating a merge commit via a temporary checkout
      // For now, just report the error
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=merge_conflict`
      );
    }

    await db
      .update(pullRequests)
      .set({
        state: "merged",
        mergedAt: new Date(),
        mergedBy: user.id,
        updatedAt: new Date(),
      })
      .where(eq(pullRequests.id, pr.id));

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Close PR
pulls.post(
  "/:owner/:repo/pulls/:number/close",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const prNum = parseInt(c.req.param("number"), 10);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.redirect(`/${ownerName}/${repoName}`);

    await db
      .update(pullRequests)
      .set({
        state: "closed",
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNum)
        )
      );

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

export default pulls;
