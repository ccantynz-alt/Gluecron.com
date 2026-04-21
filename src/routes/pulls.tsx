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
  issues,
  issueComments,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, DiffView } from "../views/components";
import { ReactionsBar } from "../views/reactions";
import { summariseReactions } from "../lib/reactions";
import { loadPrTemplate } from "../lib/templates";
import { renderMarkdown } from "../lib/markdown";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { requireRepoAccess } from "../middleware/repo-access";
import { isAiReviewEnabled, triggerAiReview } from "../lib/ai-review";
import { triggerPrTriage } from "../lib/pr-triage";
import { runAllGateChecks } from "../lib/gate";
import type { GateCheckResult } from "../lib/gate";
import {
  matchProtection,
  countHumanApprovals,
  listRequiredChecks,
  passingCheckNames,
  evaluateProtection,
} from "../lib/branch-protection";
import { mergeWithAutoResolve } from "../lib/merge-resolver";
import {
  listBranches,
  getRepoPath,
  resolveRef,
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
pulls.get("/:owner/:repo/pulls", softAuth, requireRepoAccess("read"), async (c) => {
  const { owner: ownerName, repo: repoName } = c.req.param();
  const user = c.get("user");
  const state = c.req.query("state") || "open";

  const resolved = await resolveRepo(ownerName, repoName);
  if (!resolved) return c.notFound();

  // "draft" is a virtual filter — rows are state='open' + isDraft=true.
  const stateFilter =
    state === "draft"
      ? and(
          eq(pullRequests.state, "open"),
          eq(pullRequests.isDraft, true)
        )
      : eq(pullRequests.state, state);

  const prList = await db
    .select({
      pr: pullRequests,
      author: { username: users.username },
    })
    .from(pullRequests)
    .innerJoin(users, eq(pullRequests.authorId, users.id))
    .where(
      and(eq(pullRequests.repositoryId, resolved.repo.id), stateFilter)
    )
    .orderBy(desc(pullRequests.createdAt));

  const [counts] = await db
    .select({
      open: sql<number>`count(*) filter (where ${pullRequests.state} = 'open')`,
      draft: sql<number>`count(*) filter (where ${pullRequests.state} = 'open' and ${pullRequests.isDraft} = true)`,
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
  requireRepoAccess("write"),
  async (c) => {
    const { owner: ownerName, repo: repoName } = c.req.param();
    const user = c.get("user")!;
    const branches = await listBranches(ownerName, repoName);
    const error = c.req.query("error");
    const defaultBase = branches.includes("main") ? "main" : branches[0] || "";
    const template = await loadPrTemplate(ownerName, repoName);

    return c.html(
      <Layout title={`New PR — ${ownerName}/${repoName}`} user={user}>
        <RepoHeader owner={ownerName} repo={repoName} />
        <PrNav owner={ownerName} repo={repoName} active="pulls" />
        <Container maxWidth={800}>
          <h2 style="margin-bottom:16px">Open a pull request</h2>
          {error && (
            <Alert variant="error">{decodeURIComponent(error)}</Alert>
          )}
          <Form method="post" action={`/${ownerName}/${repoName}/pulls/new`}>
            <Flex gap={12} align="center" style="margin-bottom: 16px">
              <Select name="base">
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
  requireRepoAccess("write"),
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

    const isDraft = String(body.draft || "") === "1";

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: resolved.repo.id,
        authorId: user.id,
        title,
        body: prBody || null,
        baseBranch,
        headBranch,
        isDraft,
      })
      .returning();

    // Skip AI review on drafts — it runs again when the PR is marked ready.
    if (!isDraft && isAiReviewEnabled()) {
      triggerAiReview(ownerName, repoName, pr.id, title, prBody, baseBranch, headBranch).catch(
        (err) => console.error("[ai-review] Failed:", err)
      );
    }

    // D3 — fire-and-forget AI triage: suggest labels/reviewers on the PR.
    triggerPrTriage({
      ownerName,
      repoName,
      repositoryId: resolved.repo.id,
      prId: pr.id,
      prAuthorId: user.id,
      title,
      body: prBody,
      baseBranch,
      headBranch,
    }).catch((err) => console.error("[pr-triage] Failed:", err));

    return c.redirect(`/${ownerName}/${repoName}/pulls/${pr.number}`);
  }
);

// View single PR
pulls.get("/:owner/:repo/pulls/:number", softAuth, requireRepoAccess("read"), async (c) => {
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

  // Reactions for the PR body + each comment, in parallel.
  const [prReactions, ...prCommentReactions] = await Promise.all([
    summariseReactions("pr", pr.id, user?.id),
    ...comments.map((row) =>
      summariseReactions("pr_comment", row.comment.id, user?.id)
    ),
  ]);

  const canManage =
    user &&
    (user.id === resolved.owner.id || user.id === pr.authorId);

  const error = c.req.query("error");

  // Get gate check status for open PRs
  let gateChecks: GateCheckResult[] = [];
  if (pr.state === "open") {
    const headSha = await resolveRef(ownerName, repoName, pr.headBranch);
    if (headSha) {
      const aiComments = comments.filter(({ comment }) => comment.isAiReview);
      const aiApproved = aiComments.length === 0 || aiComments.some(
        ({ comment }) => comment.body.includes("**Approved**")
      );
      const gateResult = await runAllGateChecks(
        ownerName, repoName, pr.baseBranch, pr.headBranch, headSha, aiApproved
      );
      gateChecks = gateResult.checks;
    }
  }

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

            {comments.map(({ comment, author: commentAuthor }, i) => (
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

            {error && (
              <div class="auth-error" style="margin-top: 16px; padding: 12px; background: rgba(248, 81, 73, 0.1); border: 1px solid var(--red); border-radius: var(--radius); color: var(--red)">
                {decodeURIComponent(error)}
              </div>
            )}

            {pr.state === "open" && gateChecks.length > 0 && (
              <div style="margin-top: 20px; padding: 16px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius)">
                <h3 style="margin: 0 0 12px; font-size: 14px">Gate Checks</h3>
                {gateChecks.map((check) => (
                  <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border)">
                    <span style={`font-size: 16px; color: ${check.passed ? "var(--green)" : "var(--red)"}`}>
                      {check.passed ? "\u2713" : "\u2717"}
                    </span>
                    <strong style="font-size: 13px">{check.name}</strong>
                    <span style="font-size: 12px; color: var(--text-muted); margin-left: auto">{check.details}</span>
                  </div>
                ))}
                <div style="margin-top: 8px; font-size: 12px; color: var(--text-muted)">
                  {gateChecks.every((c) => c.passed)
                    ? "All checks passed — ready to merge"
                    : gateChecks.some((c) => !c.passed && c.name === "Merge check")
                      ? "Conflicts detected — GlueCron AI will attempt auto-resolution on merge"
                      : "Some checks failed — resolve issues before merging"}
                </div>
              </div>
            )}

            {user && pr.state === "open" && (
              <div style="margin-top: 20px">
                <Form
                  method="post"
                  action={`/${ownerName}/${repoName}/pulls/${pr.number}/comment`}
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
  requireRepoAccess("write"),
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

// Merge PR — with green gate enforcement and auto conflict resolution
// NOTE: Merging is a high-impact action that arguably warrants "admin" access,
// but we keep it at "write" for v1 so trusted collaborators can ship.
// Revisit when we introduce a distinct "maintain" / "admin" collaborator role
// surface. Branch-protection rules (evaluated below) are the current mechanism
// for locking down merges further on specific branches.
pulls.post(
  "/:owner/:repo/pulls/:number/merge",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
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

    // Draft PRs cannot be merged — must be marked ready first.
    if (pr.isDraft) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(
          "This PR is a draft. Mark it as ready for review before merging."
        )}`
      );
    }

    // Resolve head SHA
    const headSha = await resolveRef(ownerName, repoName, pr.headBranch);
    if (!headSha) {
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Head branch not found")}`
      );
    }

    // Check if AI review approved this PR
    const aiComments = await db
      .select()
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pr.id),
          eq(prComments.isAiReview, true)
        )
      );
    const aiApproved = aiComments.length === 0 || aiComments.some(
      (c) => c.body.includes("**Approved**") || c.body.includes("approved: true") || c.body.toLowerCase().includes("lgtm")
    );

    // Run all green gate checks (GateTest + mergeability + AI review)
    const gateResult = await runAllGateChecks(
      ownerName,
      repoName,
      pr.baseBranch,
      pr.headBranch,
      headSha,
      aiApproved
    );

    // If GateTest or AI review failed (hard blocks), reject the merge
    const hardFailures = gateResult.checks.filter(
      (check) => !check.passed && check.name !== "Merge check"
    );
    if (hardFailures.length > 0) {
      const errorMsg = hardFailures
        .map((f) => `${f.name}: ${f.details}`)
        .join("; ");
      return c.redirect(
        `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(errorMsg)}`
      );
    }

    // D5 — Branch-protection enforcement. Looks up the matching rule for the
    // base branch and blocks the merge if requireAiApproval / requireGreenGates
    // / requireHumanReview / requiredApprovals are not satisfied. Independent
    // of repo-global settings, so owners can lock specific branches down
    // further than the repo default.
    const protectionRule = await matchProtection(
      resolved.repo.id,
      pr.baseBranch
    );
    if (protectionRule) {
      const humanApprovals = await countHumanApprovals(pr.id);
      const required = await listRequiredChecks(protectionRule.id);
      const passingNames = required.length > 0
        ? await passingCheckNames(resolved.repo.id, headSha)
        : [];
      const decision = evaluateProtection(
        protectionRule,
        {
          aiApproved,
          humanApprovalCount: humanApprovals,
          gateResultGreen: hardFailures.length === 0,
          hasFailedGates: hardFailures.length > 0,
          passingCheckNames: passingNames,
        },
        required.map((r) => r.checkName)
      );
      if (!decision.allowed) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(
            decision.reasons.join(" ")
          )}`
        );
      }
    }

    // Attempt the merge — with auto conflict resolution if needed
    const repoDir = getRepoPath(ownerName, repoName);
    const mergeCheck = gateResult.checks.find((c) => c.name === "Merge check");
    const hasConflicts = mergeCheck && !mergeCheck.passed;

    if (hasConflicts && isAiReviewEnabled()) {
      // Use Claude to auto-resolve conflicts
      const mergeResult = await mergeWithAutoResolve(
        ownerName,
        repoName,
        pr.baseBranch,
        pr.headBranch,
        `Merge pull request #${pr.number}: ${pr.title}`
      );

      if (!mergeResult.success) {
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent(mergeResult.error || "Auto-merge failed")}`
        );
      }

      // Post a comment about the auto-resolution
      if (mergeResult.resolvedFiles.length > 0) {
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: user.id,
          body: `**Auto-resolved merge conflicts** in:\n${mergeResult.resolvedFiles.map((f) => `- \`${f}\``).join("\n")}\n\nConflicts were automatically resolved by GlueCron AI.`,
          isAiReview: true,
        });
      }
    } else {
      // Standard merge — fast-forward or clean merge
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
        return c.redirect(
          `/${ownerName}/${repoName}/pulls/${prNum}?error=${encodeURIComponent("Merge failed — unable to update branch ref")}`
        );
      }
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

    // J7 — closing keywords. Scan PR title + body for "closes #N" style refs
    // and auto-close each matching open issue with a back-link comment. Bounded
    // to the same repo for v1 (cross-repo refs ignored). Failures never block
    // the merge redirect.
    try {
      const { extractClosingRefsMulti } = await import("../lib/close-keywords");
      const refs = extractClosingRefsMulti([pr.title, pr.body]);
      for (const n of refs) {
        const [issue] = await db
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.repositoryId, resolved.repo.id),
              eq(issues.number, n)
            )
          )
          .limit(1);
        if (!issue || issue.state !== "open") continue;
        await db
          .update(issues)
          .set({ state: "closed", closedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, issue.id));
        await db.insert(issueComments).values({
          issueId: issue.id,
          authorId: user.id,
          body: `Closed by pull request #${pr.number}.`,
        });
      }
    } catch {
      // Never block the merge on close-keyword failures.
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Toggle draft state — mark a PR as "ready for review". Triggers AI review if it
// hasn't run yet on this PR.
pulls.post(
  "/:owner/:repo/pulls/:number/ready",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
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
    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    // Only the author or repo owner can toggle draft state.
    if (pr.authorId !== user.id && resolved.owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    if (pr.state === "open" && pr.isDraft) {
      await db
        .update(pullRequests)
        .set({ isDraft: false, updatedAt: new Date() })
        .where(eq(pullRequests.id, pr.id));

      if (isAiReviewEnabled()) {
        triggerAiReview(
          ownerName,
          repoName,
          pr.id,
          pr.title,
          pr.body || "",
          pr.baseBranch,
          pr.headBranch
        ).catch((err) => console.error("[ai-review] ready trigger failed:", err));
      }
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Convert a PR back to draft.
pulls.post(
  "/:owner/:repo/pulls/:number/draft",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
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
    if (!pr) return c.redirect(`/${ownerName}/${repoName}/pulls`);

    if (pr.authorId !== user.id && resolved.owner.id !== user.id) {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
    }

    if (pr.state === "open" && !pr.isDraft) {
      await db
        .update(pullRequests)
        .set({ isDraft: true, updatedAt: new Date() })
        .where(eq(pullRequests.id, pr.id));
    }

    return c.redirect(`/${ownerName}/${repoName}/pulls/${prNum}`);
  }
);

// Close PR
pulls.post(
  "/:owner/:repo/pulls/:number/close",
  softAuth,
  requireAuth,
  requireRepoAccess("write"),
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
