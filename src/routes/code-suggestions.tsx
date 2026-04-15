/**
 * Block J22 — Apply a code review suggestion to the PR's head branch.
 *
 *   POST /:owner/:repo/pulls/:number/comments/:commentId/apply-suggestion
 *     body: index (optional; defaults to 0)
 *
 * Only the repo owner or the PR author may apply. The suggestion must
 * be anchored to a comment with a `file_path` + `line_number`. We read
 * the file on the PR's head branch, apply the suggestion via the pure
 * `applySuggestionToContent`, and commit the result using the same
 * plumbing pattern `src/routes/editor.tsx` uses for edits.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { requireAuth, softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { getBlob, getRepoPath } from "../git/repository";
import {
  applySuggestionToContent,
  extractSuggestions,
} from "../lib/code-suggestions";

const codeSuggestions = new Hono<AuthEnv>();

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

codeSuggestions.post(
  "/:owner/:repo/pulls/:number/comments/:commentId/apply-suggestion",
  softAuth,
  requireAuth,
  async (c) => {
    const { owner: ownerName, repo: repoName, number, commentId } =
      c.req.param();
    const user = c.get("user")!;
    const prNumber = parseInt(number, 10);
    if (!Number.isFinite(prNumber)) return c.text("bad pr number", 400);

    const resolved = await resolveRepo(ownerName, repoName);
    if (!resolved) return c.text("not found", 404);
    if (
      resolved.repo.isPrivate &&
      user.id !== resolved.owner.id
    ) {
      return c.text("not found", 404);
    }

    // Look up PR + comment.
    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, resolved.repo.id),
          eq(pullRequests.number, prNumber)
        )
      )
      .limit(1);
    if (!pr) return c.text("pr not found", 404);
    if (pr.state !== "open") {
      return c.redirect(`/${ownerName}/${repoName}/pulls/${prNumber}`);
    }

    const [comment] = await db
      .select()
      .from(prComments)
      .where(
        and(
          eq(prComments.id, commentId),
          eq(prComments.pullRequestId, pr.id)
        )
      )
      .limit(1);
    if (!comment) return c.text("comment not found", 404);
    if (!comment.filePath || !comment.lineNumber) {
      return c.text("comment has no file anchor", 400);
    }

    // Authorisation: owner, PR author, or comment author.
    const allowed =
      user.id === resolved.owner.id ||
      user.id === pr.authorId ||
      user.id === comment.authorId;
    if (!allowed) return c.text("forbidden", 403);

    // Which suggestion block?
    const form = await c.req.parseBody().catch(() => ({}));
    const rawIdx = (form as Record<string, unknown>).index;
    const idx =
      typeof rawIdx === "string" && rawIdx.trim() !== ""
        ? parseInt(rawIdx, 10)
        : 0;
    const blocks = extractSuggestions(comment.body);
    if (!Number.isFinite(idx) || idx < 0 || idx >= blocks.length) {
      return c.text("no such suggestion", 400);
    }
    const suggestion = blocks[idx].content;

    // Read file on head branch.
    const headRef = pr.headBranch;
    let blob: { content: string; isBinary: boolean } | null = null;
    try {
      blob = await getBlob(
        ownerName,
        repoName,
        headRef,
        comment.filePath
      );
    } catch {
      blob = null;
    }
    if (!blob || blob.isBinary) {
      return c.text("file missing or binary", 400);
    }

    const applied = applySuggestionToContent({
      content: blob.content,
      startLine: comment.lineNumber,
      endLine: comment.lineNumber,
      suggestion,
    });
    if (!applied.ok) {
      return c.text(`apply failed: ${applied.reason}`, 400);
    }

    // Commit to head branch using the editor-style plumbing.
    const repoDir = getRepoPath(ownerName, repoName);
    const run = async (cmd: string[], stdin?: string) => {
      const proc = Bun.spawn(cmd, {
        cwd: repoDir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: stdin !== undefined ? "pipe" : undefined,
      });
      if (stdin !== undefined && proc.stdin) {
        proc.stdin.write(new TextEncoder().encode(stdin));
        proc.stdin.end();
      }
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return stdout.trim();
    };

    try {
      const blobSha = await run(
        ["git", "hash-object", "-w", "--stdin"],
        applied.content
      );
      const treeContent = await run(["git", "ls-tree", "-r", headRef]);
      const updated =
        treeContent
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const parts = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
            if (parts && parts[4] === comment.filePath) {
              return `${parts[1]} blob ${blobSha}\t${parts[4]}`;
            }
            return line;
          })
          .join("\n") + "\n";
      const newTreeSha = await run(["git", "mktree"], updated);
      const parentSha = await run(["git", "rev-parse", headRef]);
      const env = {
        GIT_AUTHOR_NAME: user.displayName || user.username,
        GIT_AUTHOR_EMAIL: user.email,
        GIT_COMMITTER_NAME: user.displayName || user.username,
        GIT_COMMITTER_EMAIL: user.email,
      };
      const message = `Apply suggestion from #${prNumber}\n\nCo-authored-by: ${
        user.displayName || user.username
      } <${user.email}>`;
      const commitProc = Bun.spawn(
        ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
        {
          cwd: repoDir,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, ...env },
        }
      );
      const commitSha = (await new Response(commitProc.stdout).text()).trim();
      await commitProc.exited;
      await run([
        "git",
        "update-ref",
        `refs/heads/${headRef}`,
        commitSha,
      ]);
    } catch (err) {
      console.error("[apply-suggestion]", err);
      return c.text("commit failed", 500);
    }

    return c.redirect(
      `/${ownerName}/${repoName}/pulls/${prNumber}#comment-${comment.id}`
    );
  }
);

export default codeSuggestions;
