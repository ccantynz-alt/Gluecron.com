/**
 * Comment moderation tests — the anti-impersonation gate.
 *
 * Two halves:
 *   1. Pure-decision tests (`shouldRequireApproval`) — set up a repo
 *      with a fixed owner + a couple of commenters and assert each
 *      branch of the decision matrix (owner / write collab / read-only
 *      stranger / trusted / banned / thread-author).
 *   2. End-to-end POST → render flow — submit a comment as a stranger
 *      via `app.request`, confirm it lands as 'pending', isn't shown in
 *      the JSON API list, and that the approve flow promotes it.
 *
 * Every DB-touching test sits behind `describe.skipIf(!HAS_DB)` so the
 * suite stays green on machines without Postgres (mirroring the
 * established pattern across the repo's other test files).
 */

import { describe, it, expect } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("comment-moderation — shouldRequireApproval", () => {
  it("returns false for the repo owner", async () => {
    const { shouldRequireApproval } = await import(
      "../lib/comment-moderation"
    );
    const fx = await seed();
    const r = await shouldRequireApproval({
      commenterUserId: fx.ownerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: fx.issueId,
    });
    expect(r.requireApproval).toBe(false);
  });

  it("returns false for a write collaborator", async () => {
    const { shouldRequireApproval } = await import(
      "../lib/comment-moderation"
    );
    const fx = await seed();
    await addCollaborator(fx.repoId, fx.writerId, "write");
    const r = await shouldRequireApproval({
      commenterUserId: fx.writerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: fx.issueId,
    });
    expect(r.requireApproval).toBe(false);
  });

  it("returns true for a read-only stranger on a public repo", async () => {
    const { shouldRequireApproval } = await import(
      "../lib/comment-moderation"
    );
    const fx = await seed();
    const r = await shouldRequireApproval({
      commenterUserId: fx.strangerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: fx.issueId,
    });
    expect(r.requireApproval).toBe(true);
    expect(r.autoReject).toBe(false);
  });

  it("returns false when the commenter has a 'trusted' trust row", async () => {
    const { shouldRequireApproval } = await import(
      "../lib/comment-moderation"
    );
    const { db } = await import("../db");
    const { repoCommenterTrust } = await import("../db/schema");
    const fx = await seed();
    await db.insert(repoCommenterTrust).values({
      repositoryId: fx.repoId,
      commenterUserId: fx.strangerId,
      status: "trusted",
      grantedByUserId: fx.ownerId,
    });
    const r = await shouldRequireApproval({
      commenterUserId: fx.strangerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: fx.issueId,
    });
    expect(r.requireApproval).toBe(false);
  });

  it("returns false when the commenter is the original issue author", async () => {
    const { shouldRequireApproval } = await import(
      "../lib/comment-moderation"
    );
    const { db } = await import("../db");
    const { issues } = await import("../db/schema");
    const fx = await seed();
    // Open a SECOND issue authored by the stranger themselves so they
    // are the thread author (the seed issue is opened by `ownerId`).
    const [strangerIssue] = await db
      .insert(issues)
      .values({
        repositoryId: fx.repoId,
        authorId: fx.strangerId,
        title: "stranger-issue",
      })
      .returning({ id: issues.id });
    const r = await shouldRequireApproval({
      commenterUserId: fx.strangerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: strangerIssue!.id,
    });
    expect(r.requireApproval).toBe(false);
    expect(r.reason).toContain("opened this issue");
  });

  it("auto-rejects when the commenter is banned", async () => {
    const { shouldRequireApproval } = await import(
      "../lib/comment-moderation"
    );
    const { db } = await import("../db");
    const { repoCommenterTrust } = await import("../db/schema");
    const fx = await seed();
    await db.insert(repoCommenterTrust).values({
      repositoryId: fx.repoId,
      commenterUserId: fx.strangerId,
      status: "banned",
      grantedByUserId: fx.ownerId,
    });
    const r = await shouldRequireApproval({
      commenterUserId: fx.strangerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: fx.issueId,
    });
    expect(r.requireApproval).toBe(true);
    expect(r.autoReject).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("comment-moderation — POST + render flow", () => {
  it("inserts a stranger's comment as 'pending' and hides it from the public API", async () => {
    const app = (await import("../app")).default;
    const { db } = await import("../db");
    const { issueComments, sessions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const { randomBytes } = await import("crypto");

    const fx = await seed();
    // Mint a stranger session.
    const token = randomBytes(32).toString("hex");
    await db.insert(sessions).values({
      userId: fx.strangerId,
      token,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request(
      `/${fx.ownerUsername}/${fx.repoName}/issues/${fx.issueNumber}/comment`,
      {
        method: "POST",
        headers: {
          cookie: `session=${token}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ body: "Hi from a stranger!" }),
      }
    );
    // Hono's c.redirect → 302
    expect([200, 302]).toContain(res.status);

    const inserted = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.authorId, fx.strangerId));
    expect(inserted.length).toBe(1);
    expect(inserted[0]!.moderationStatus).toBe("pending");

    // Public API hides pending.
    const apiRes = await app.request(
      `/api/v2/repos/${fx.ownerUsername}/${fx.repoName}/issues/${fx.issueNumber}`
    );
    if (apiRes.status === 200) {
      const json = (await apiRes.json()) as { comments: unknown[] };
      expect(Array.isArray(json.comments)).toBe(true);
      // The stranger's comment must not leak.
      const bodies = (json.comments as Array<{ body: string }>).map(
        (c) => c.body
      );
      expect(bodies.includes("Hi from a stranger!")).toBe(false);
    }
  });

  it("approve flow flips status to 'approved' and notifies the author", async () => {
    const { approveComment } = await import("../lib/comment-moderation");
    const { db } = await import("../db");
    const { issueComments, notifications } = await import("../db/schema");
    const { eq, and } = await import("drizzle-orm");

    const fx = await seed();
    // Seed a pending comment from the stranger directly.
    const [c] = await db
      .insert(issueComments)
      .values({
        issueId: fx.issueId,
        authorId: fx.strangerId,
        body: "Approve me please",
        moderationStatus: "pending",
      })
      .returning({ id: issueComments.id });

    const res = await approveComment({
      commentId: c!.id,
      kind: "issue",
      moderatorUserId: fx.ownerId,
    });
    expect(res.ok).toBe(true);

    const [after] = await db
      .select({ status: issueComments.moderationStatus })
      .from(issueComments)
      .where(eq(issueComments.id, c!.id));
    expect(after!.status).toBe("approved");

    // Notification fired.
    const notif = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, fx.strangerId),
          eq(notifications.kind, "comment.approved")
        )
      );
    expect(notif.length).toBeGreaterThanOrEqual(1);
  });

  it("markAsSpam flow inserts a 'banned' trust row and auto-rejects next comment", async () => {
    const {
      markAsSpam,
      decideInitialStatus,
    } = await import("../lib/comment-moderation");
    const { db } = await import("../db");
    const { issueComments, repoCommenterTrust } = await import("../db/schema");
    const { eq, and } = await import("drizzle-orm");

    const fx = await seed();
    const [c] = await db
      .insert(issueComments)
      .values({
        issueId: fx.issueId,
        authorId: fx.strangerId,
        body: "Spammy stuff",
        moderationStatus: "pending",
      })
      .returning({ id: issueComments.id });

    const res = await markAsSpam({
      commentId: c!.id,
      kind: "issue",
      moderatorUserId: fx.ownerId,
    });
    expect(res.ok).toBe(true);

    // Banned trust row exists.
    const trust = await db
      .select({ status: repoCommenterTrust.status })
      .from(repoCommenterTrust)
      .where(
        and(
          eq(repoCommenterTrust.repositoryId, fx.repoId),
          eq(repoCommenterTrust.commenterUserId, fx.strangerId)
        )
      );
    expect(trust.length).toBe(1);
    expect(trust[0]!.status).toBe("banned");

    // Next comment auto-rejects.
    const decision = await decideInitialStatus({
      commenterUserId: fx.strangerId,
      repositoryId: fx.repoId,
      kind: "issue",
      threadId: fx.issueId,
    });
    expect(decision.status).toBe("rejected");
  });
});

// ─── seed helpers ─────────────────────────────────────────────────────

async function seed(): Promise<{
  ownerId: string;
  ownerUsername: string;
  writerId: string;
  strangerId: string;
  repoId: string;
  repoName: string;
  issueId: string;
  issueNumber: number;
}> {
  const { db } = await import("../db");
  const { users, repositories, issues } = await import("../db/schema");
  const { randomBytes } = await import("crypto");
  const tag = randomBytes(4).toString("hex");

  const [owner] = await db
    .insert(users)
    .values({
      username: `modq_owner_${tag}`,
      email: `modq_owner_${tag}@test.local`,
      passwordHash: "x",
    })
    .returning({ id: users.id, username: users.username });
  const [writer] = await db
    .insert(users)
    .values({
      username: `modq_writer_${tag}`,
      email: `modq_writer_${tag}@test.local`,
      passwordHash: "x",
    })
    .returning({ id: users.id });
  const [stranger] = await db
    .insert(users)
    .values({
      username: `modq_stranger_${tag}`,
      email: `modq_stranger_${tag}@test.local`,
      passwordHash: "x",
    })
    .returning({ id: users.id });
  const [repo] = await db
    .insert(repositories)
    .values({
      ownerId: owner!.id,
      name: `modq-repo-${tag}`,
      diskPath: `/tmp/modq/${tag}`,
      defaultBranch: "main",
      isPrivate: false,
    })
    .returning({ id: repositories.id, name: repositories.name });
  const [issue] = await db
    .insert(issues)
    .values({
      repositoryId: repo!.id,
      authorId: owner!.id,
      title: "Seed issue for moderation tests",
    })
    .returning({ id: issues.id, number: issues.number });

  return {
    ownerId: owner!.id,
    ownerUsername: owner!.username,
    writerId: writer!.id,
    strangerId: stranger!.id,
    repoId: repo!.id,
    repoName: repo!.name,
    issueId: issue!.id,
    issueNumber: issue!.number,
  };
}

async function addCollaborator(
  repoId: string,
  userId: string,
  role: "read" | "write" | "admin"
): Promise<void> {
  const { db } = await import("../db");
  const { repoCollaborators } = await import("../db/schema");
  await db.insert(repoCollaborators).values({
    repositoryId: repoId,
    userId,
    role,
    invitedBy: userId,
    acceptedAt: new Date(),
  });
}
