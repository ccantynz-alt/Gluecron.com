/**
 * Block E5 — Merge queue UI + actions.
 *
 *   GET  /:owner/:repo/queue                  — queue history + current state
 *   POST /:owner/:repo/pulls/:n/enqueue       — enqueue a PR (requireAuth)
 *   POST /:owner/:repo/queue/:id/dequeue      — remove entry (owner OR enqueuer)
 *   POST /:owner/:repo/queue/process-next     — owner-only: run the head
 *
 * The "process-next" handler is v1 — it just re-runs gates against the base
 * and, if green, merges by updating the base branch ref. A full background
 * worker is future work; this keeps the feature usable without a daemon.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  mergeQueueEntries,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import { softAuth, requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import {
  enqueuePr,
  dequeueEntry,
  listQueueWithPrs,
  markHeadRunning,
  completeEntry,
  peekHead,
} from "../lib/merge-queue";
import { runAllGateChecks } from "../lib/gate";
import { resolveRef, getRepoPath } from "../git/repository";
import { audit } from "../lib/notify";

const queue = new Hono<AuthEnv>();
queue.use("*", softAuth);

async function loadRepo(ownerName: string, repoName: string) {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
        starCount: repositories.starCount,
        forkCount: repositories.forkCount,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(and(eq(users.username, ownerName), eq(repositories.name, repoName)))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

function relTime(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return t.toLocaleDateString();
}

// ---------- Queue list ----------

queue.get("/:owner/:repo/queue", async (c) => {
  const user = c.get("user");
  const { owner, repo } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) {
    return c.html(
      <Layout title="Not found" user={user}>
        <div class="empty-state">
          <h2>Repository not found</h2>
        </div>
      </Layout>,
      404
    );
  }

  const entries = await listQueueWithPrs(repoRow.id);
  const byBranch = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byBranch.get(e.baseBranch) || [];
    arr.push(e);
    byBranch.set(e.baseBranch, arr);
  }

  const isOwner = !!user && user.id === repoRow.ownerId;
  const success = c.req.query("success");
  const error = c.req.query("error");

  const stateBadge = (s: string) => {
    const style: Record<string, string> = {
      queued: "background:#30363d;color:#c9d1d9",
      running: "background:#1f6feb;color:white",
      merged: "background:#8957e5;color:white",
      failed: "background:#da3633;color:white",
      dequeued: "background:#484f58;color:#c9d1d9",
    };
    return (
      <span
        style={`${style[s] || style.queued};padding:2px 8px;border-radius:3px;font-size:11px;text-transform:uppercase;font-weight:600`}
      >
        {s}
      </span>
    );
  };

  return c.html(
    <Layout title={`Merge queue — ${owner}/${repo}`} user={user}>
      <RepoHeader
        owner={owner}
        repo={repo}
        starCount={repoRow.starCount}
        forkCount={repoRow.forkCount}
        currentUser={user?.username || null}
      />
      <RepoNav owner={owner} repo={repo} active="pulls" />

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3>Merge queue</h3>
        <a href={`/${owner}/${repo}/pulls`} class="btn btn-sm">
          Back to PRs
        </a>
      </div>

      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
        Serialised merges: PRs queued here re-run gates against the latest base
        before being merged. This prevents green-in-isolation / red-after-merge
        races.
      </p>

      {success && <div class="auth-success">{decodeURIComponent(success)}</div>}
      {error && <div class="auth-error">{decodeURIComponent(error)}</div>}

      {entries.length === 0 ? (
        <div class="empty-state">
          <p>Queue is empty. Enqueue a PR from the pull-request page.</p>
        </div>
      ) : (
        Array.from(byBranch.entries()).map(([branch, items]) => {
          const active = items.filter(
            (i) => i.state === "queued" || i.state === "running"
          );
          return (
            <div class="panel" style="margin-bottom:20px;overflow:hidden">
              <div style="padding:12px 14px;background:var(--bg-tertiary);display:flex;justify-content:space-between;align-items:center">
                <div style="font-weight:600">
                  Base: <code>{branch}</code>{" "}
                  <span style="font-size:12px;color:var(--text-muted);font-weight:400;margin-left:8px">
                    {active.length} active
                  </span>
                </div>
                {isOwner && active.length > 0 && (
                  <form
                    method="POST"
                    action={`/${owner}/${repo}/queue/process-next?base=${encodeURIComponent(branch)}`}
                  >
                    <button type="submit" class="btn btn-sm btn-primary">
                      Process next
                    </button>
                  </form>
                )}
              </div>
              {items.map((it) => (
                <div
                  class="panel-item"
                  style="justify-content:space-between;align-items:flex-start"
                >
                  <div style="flex:1;min-width:0">
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                      {stateBadge(it.state)}
                      {it.prNumber != null ? (
                        <a
                          href={`/${owner}/${repo}/pulls/${it.prNumber}`}
                          style="font-weight:600"
                        >
                          #{it.prNumber} {it.prTitle}
                        </a>
                      ) : (
                        <span style="color:var(--text-muted)">(PR gone)</span>
                      )}
                    </div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:4px">
                      pos {it.position} ·{" "}
                      {it.prHeadBranch ? <code>{it.prHeadBranch}</code> : ""} ·
                      enqueued {relTime(it.enqueuedAt)}
                      {it.startedAt
                        ? ` · started ${relTime(it.startedAt)}`
                        : ""}
                      {it.finishedAt
                        ? ` · finished ${relTime(it.finishedAt)}`
                        : ""}
                    </div>
                    {it.errorMessage && (
                      <div style="font-size:12px;color:var(--red);margin-top:4px">
                        {it.errorMessage}
                      </div>
                    )}
                  </div>
                  {(it.state === "queued" || it.state === "running") &&
                    user &&
                    (isOwner || user.id === it.enqueuedBy) && (
                      <form
                        method="POST"
                        action={`/${owner}/${repo}/queue/${it.id}/dequeue`}
                        onsubmit="return confirm('Remove from queue?')"
                      >
                        <button type="submit" class="btn btn-sm">
                          Remove
                        </button>
                      </form>
                    )}
                </div>
              ))}
            </div>
          );
        })
      )}
    </Layout>
  );
});

// ---------- Enqueue a PR ----------

queue.post("/:owner/:repo/pulls/:number/enqueue", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const prNum = parseInt(c.req.param("number"), 10);
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repoRow.id),
        eq(pullRequests.number, prNum)
      )
    )
    .limit(1);
  if (!pr || pr.state !== "open") {
    return c.redirect(
      `/${owner}/${repo}/pulls/${prNum}?error=${encodeURIComponent(
        "PR must be open to enqueue."
      )}`
    );
  }
  if (pr.isDraft) {
    return c.redirect(
      `/${owner}/${repo}/pulls/${prNum}?error=${encodeURIComponent(
        "Cannot enqueue a draft PR."
      )}`
    );
  }

  const result = await enqueuePr({
    repositoryId: repoRow.id,
    pullRequestId: pr.id,
    baseBranch: pr.baseBranch,
    enqueuedBy: user.id,
  });
  if (!result.ok) {
    return c.redirect(
      `/${owner}/${repo}/pulls/${prNum}?error=${encodeURIComponent(
        result.reason || "Enqueue failed"
      )}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "merge_queue.enqueue",
    targetId: pr.id,
    metadata: { prNumber: pr.number, baseBranch: pr.baseBranch },
  });

  return c.redirect(
    `/${owner}/${repo}/queue?success=${encodeURIComponent(
      `PR #${pr.number} enqueued`
    )}`
  );
});

// ---------- Dequeue ----------

queue.post("/:owner/:repo/queue/:id/dequeue", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo, id } = c.req.param();
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();

  const [entry] = await db
    .select()
    .from(mergeQueueEntries)
    .where(
      and(
        eq(mergeQueueEntries.id, id),
        eq(mergeQueueEntries.repositoryId, repoRow.id)
      )
    )
    .limit(1);
  if (!entry) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("Entry not found")}`
    );
  }
  const isOwner = user.id === repoRow.ownerId;
  if (!isOwner && entry.enqueuedBy !== user.id) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Only the enqueuer or a repo owner can remove this entry."
      )}`
    );
  }

  const ok = await dequeueEntry(id);
  if (!ok) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("Could not remove entry")}`
    );
  }

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "merge_queue.dequeue",
    targetId: entry.pullRequestId,
  });

  return c.redirect(
    `/${owner}/${repo}/queue?success=${encodeURIComponent("Entry removed")}`
  );
});

// ---------- Process next ----------

queue.post("/:owner/:repo/queue/process-next", requireAuth, async (c) => {
  const user = c.get("user")!;
  const { owner, repo } = c.req.param();
  const base = c.req.query("base");
  const repoRow = await loadRepo(owner, repo);
  if (!repoRow) return c.notFound();
  if (repoRow.ownerId !== user.id) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Only repo owners can process the queue."
      )}`
    );
  }

  const targetBase = base || repoRow.defaultBranch || "main";
  const head = await peekHead(repoRow.id, targetBase);
  if (!head) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        `No queued entries for base ${targetBase}`
      )}`
    );
  }

  const started = await markHeadRunning(repoRow.id, targetBase);
  if (!started) {
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Could not transition head to running"
      )}`
    );
  }

  // Re-run gates against latest base.
  const [pr] = await db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.id, started.pullRequestId))
    .limit(1);
  if (!pr) {
    await completeEntry(started.id, "failed", "Pull request no longer exists.");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("PR vanished")}`
    );
  }
  if (pr.state !== "open") {
    await completeEntry(started.id, "failed", "Pull request is no longer open.");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("PR is no longer open")}`
    );
  }

  const headSha = await resolveRef(owner, repo, pr.headBranch);
  if (!headSha) {
    await completeEntry(started.id, "failed", "Head branch not found.");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent("Head branch not found")}`
    );
  }

  const gateResult = await runAllGateChecks(
    owner,
    repo,
    pr.baseBranch,
    pr.headBranch,
    headSha,
    true
  );
  const hardFailures = gateResult.checks.filter(
    (check) => !check.passed && check.name !== "Merge check"
  );
  if (hardFailures.length > 0) {
    const msg = hardFailures
      .map((f) => `${f.name}: ${f.details}`)
      .join("; ");
    await completeEntry(started.id, "failed", msg);
    try {
      await db.insert(prComments).values({
        pullRequestId: pr.id,
        authorId: user.id,
        body: `**Merge queue:** gates failed on latest base — ${msg}`,
        isAiReview: false,
      });
    } catch {}
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(msg)}`
    );
  }

  // Gates passed — merge by updating base ref to head.
  const repoDir = getRepoPath(owner, repo);
  const proc = Bun.spawn(
    [
      "git",
      "update-ref",
      `refs/heads/${pr.baseBranch}`,
      `refs/heads/${pr.headBranch}`,
    ],
    { cwd: repoDir, stdout: "pipe", stderr: "pipe" }
  );
  const exit = await proc.exited;
  if (exit !== 0) {
    await completeEntry(started.id, "failed", "update-ref failed");
    return c.redirect(
      `/${owner}/${repo}/queue?error=${encodeURIComponent(
        "Merge failed — unable to update base ref"
      )}`
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

  await completeEntry(started.id, "merged");

  await audit({
    userId: user.id,
    repositoryId: repoRow.id,
    action: "merge_queue.merged",
    targetId: pr.id,
    metadata: { prNumber: pr.number, baseBranch: pr.baseBranch },
  });

  return c.redirect(
    `/${owner}/${repo}/queue?success=${encodeURIComponent(
      `PR #${pr.number} merged via queue`
    )}`
  );
});

export default queue;
