/**
 * Tests for src/lib/branch-previews.ts — per-branch preview URLs.
 *
 * Two layers:
 *
 *   1. Pure helpers — URL slugging, expires-in formatting, status
 *      label mapping. No DB, no network. Always run.
 *
 *   2. DB-backed pipeline — gated on HAS_DB so the suite stays green
 *      on machines without Postgres. Covers:
 *        - enqueue creates a row
 *        - re-push to the same branch DEDUPES (replaces commit_sha + URL,
 *          resets status to 'building')
 *        - markPreviewReady / markPreviewFailed flip status as expected
 *        - expireOldPreviews flips expired rows to 'expired'
 *        - listPreviewsForRepo / getPreviewForBranch round-trip
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  buildPreviewUrl,
  enqueuePreviewBuild,
  expireOldPreviews,
  formatExpiresIn,
  getPreviewForBranch,
  listPreviewsForRepo,
  markPreviewFailed,
  markPreviewReady,
  previewStatusLabel,
  slugifyForUrl,
} from "../lib/branch-previews";
import { db } from "../db";
import { branchPreviews, repositories, users } from "../db/schema";
import { eq } from "drizzle-orm";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe("branch-previews — slugifyForUrl", () => {
  it("lowercases and replaces non-alphanumerics with dashes", () => {
    expect(slugifyForUrl("Feature/Branch_42")).toBe("feature-branch-42");
  });

  it("strips leading + trailing dashes", () => {
    expect(slugifyForUrl("--foo--")).toBe("foo");
  });

  it("clips to 50 characters", () => {
    const long = "a".repeat(200);
    expect(slugifyForUrl(long).length).toBe(50);
  });

  it("returns empty string for empty input", () => {
    expect(slugifyForUrl("")).toBe("");
  });
});

describe("branch-previews — buildPreviewUrl", () => {
  it("produces a wildcard subdomain URL with default domain", () => {
    const prev = process.env.PREVIEW_DOMAIN;
    delete process.env.PREVIEW_DOMAIN;
    try {
      const url = buildPreviewUrl("alice", "site", "feat/new");
      expect(url).toBe("https://feat-new-alice-site.preview.gluecron.com");
    } finally {
      if (prev !== undefined) process.env.PREVIEW_DOMAIN = prev;
    }
  });

  it("honours a custom PREVIEW_DOMAIN env var", () => {
    const prev = process.env.PREVIEW_DOMAIN;
    process.env.PREVIEW_DOMAIN = "preview.acme.dev";
    try {
      const url = buildPreviewUrl("a", "b", "main-thing");
      expect(url).toBe("https://main-thing-a-b.preview.acme.dev");
    } finally {
      if (prev === undefined) delete process.env.PREVIEW_DOMAIN;
      else process.env.PREVIEW_DOMAIN = prev;
    }
  });

  it("falls back to 'branch' when branch slug is empty", () => {
    const url = buildPreviewUrl("a", "b", "///");
    expect(url).toContain("branch-");
  });

  it("strips scheme from PREVIEW_DOMAIN if accidentally included", () => {
    const prev = process.env.PREVIEW_DOMAIN;
    process.env.PREVIEW_DOMAIN = "https://preview.foo.com";
    try {
      const url = buildPreviewUrl("a", "b", "c");
      expect(url).toBe("https://c-a-b.preview.foo.com");
    } finally {
      if (prev === undefined) delete process.env.PREVIEW_DOMAIN;
      else process.env.PREVIEW_DOMAIN = prev;
    }
  });
});

describe("branch-previews — formatExpiresIn", () => {
  it("returns 'expired' for past timestamps", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const past = new Date("2026-01-01T11:00:00Z");
    expect(formatExpiresIn(past, now)).toBe("expired");
  });

  it("returns 'less than a minute' for sub-minute futures", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const soon = new Date("2026-01-01T12:00:30Z");
    expect(formatExpiresIn(soon, now)).toBe("less than a minute");
  });

  it("returns just minutes when under an hour away", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const future = new Date("2026-01-01T12:42:00Z");
    expect(formatExpiresIn(future, now)).toBe("42m");
  });

  it("returns hours + minutes when over an hour away", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    const future = new Date("2026-01-02T08:30:00Z");
    expect(formatExpiresIn(future, now)).toBe("20h 30m");
  });

  it("returns em-dash for null", () => {
    expect(formatExpiresIn(null)).toBe("—");
  });
});

describe("branch-previews — previewStatusLabel", () => {
  it("maps known statuses to human labels", () => {
    expect(previewStatusLabel("building")).toBe("Building");
    expect(previewStatusLabel("ready")).toBe("Ready");
    expect(previewStatusLabel("failed")).toBe("Failed");
    expect(previewStatusLabel("expired")).toBe("Expired");
  });

  it("passes through unknown statuses unchanged", () => {
    expect(previewStatusLabel("weird")).toBe("weird");
  });
});

// ---------------------------------------------------------------------------
// 2. Graceful no-ops without DB — must not throw on empty/missing inputs
// ---------------------------------------------------------------------------

describe("branch-previews — graceful no-ops", () => {
  it("enqueuePreviewBuild returns null for missing required fields", async () => {
    expect(
      await enqueuePreviewBuild({
        repositoryId: "",
        ownerName: "a",
        repoName: "b",
        branchName: "c",
        commitSha: "d",
      })
    ).toBeNull();
    expect(
      await enqueuePreviewBuild({
        repositoryId: "x",
        ownerName: "a",
        repoName: "b",
        branchName: "",
        commitSha: "d",
      })
    ).toBeNull();
    expect(
      await enqueuePreviewBuild({
        repositoryId: "x",
        ownerName: "a",
        repoName: "b",
        branchName: "c",
        commitSha: "",
      })
    ).toBeNull();
  });

  it("getPreviewForBranch returns null for empty inputs", async () => {
    expect(await getPreviewForBranch("", "main")).toBeNull();
    expect(await getPreviewForBranch("repo-id", "")).toBeNull();
  });

  it("listPreviewsForRepo returns [] for empty repository id", async () => {
    expect(await listPreviewsForRepo("")).toEqual([]);
  });

  it("markPreviewReady / markPreviewFailed swallow empty ids", async () => {
    await markPreviewReady("");
    await markPreviewFailed("", "err");
    // No throw = pass.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. DB-backed pipeline
// ---------------------------------------------------------------------------

const TEST_USER_PREFIX = "previewtest_";

async function seedRepo(): Promise<{ userId: string; repoId: string }> {
  const username =
    TEST_USER_PREFIX + Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({
      username,
      email: `${username}@previewtest.local`,
      passwordHash: "$2b$10$" + "x".repeat(53),
    })
    .returning();
  const [repo] = await db
    .insert(repositories)
    .values({
      name: "previews-test-" + Math.random().toString(36).slice(2, 8),
      ownerId: user!.id,
      diskPath: "/tmp/previews-test-" + Math.random().toString(36).slice(2, 8),
    })
    .returning();
  return { userId: user!.id, repoId: repo!.id };
}

async function cleanupRepo(userId: string): Promise<void> {
  try {
    await db.delete(repositories).where(eq(repositories.ownerId, userId));
    await db.delete(users).where(eq(users.id, userId));
  } catch {
    /* best effort */
  }
}

describe.skipIf(!HAS_DB)("branch-previews — DB pipeline", () => {
  let userId = "";
  let repoId = "";

  afterEach(async () => {
    if (userId) await cleanupRepo(userId);
    userId = "";
    repoId = "";
  });

  it("enqueue creates a building row with a computed preview URL", async () => {
    ({ userId, repoId } = await seedRepo());

    const row = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "alice",
      repoName: "site",
      branchName: "feat/a",
      commitSha: "abc1234567890",
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe("building");
    expect(row!.branchName).toBe("feat/a");
    expect(row!.commitSha).toBe("abc1234567890");
    expect(row!.previewUrl).toContain("feat-a-");
    expect(row!.previewUrl.startsWith("https://")).toBe(true);
    expect(row!.expiresAt instanceof Date).toBe(true);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("re-pushing the same branch DEDUPES — same id, new SHA, status='building'", async () => {
    ({ userId, repoId } = await seedRepo());

    const first = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "alice",
      repoName: "site",
      branchName: "feat/b",
      commitSha: "sha-one",
    });
    expect(first).not.toBeNull();

    // Flip to ready so we can verify the upsert resets it.
    await markPreviewReady(first!.id);
    let row = await getPreviewForBranch(repoId, "feat/b");
    expect(row!.status).toBe("ready");

    // Second push to the same branch → upsert path.
    const second = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "alice",
      repoName: "site",
      branchName: "feat/b",
      commitSha: "sha-two",
    });
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id); // same row
    expect(second!.commitSha).toBe("sha-two");
    expect(second!.status).toBe("building");
    expect(second!.buildCompletedAt).toBeNull();

    // And only ONE row exists for the (repo, branch) pair.
    const all = await listPreviewsForRepo(repoId);
    const matching = all.filter((p) => p.branchName === "feat/b");
    expect(matching.length).toBe(1);
  });

  it("markPreviewReady flips status to 'ready' with completed_at", async () => {
    ({ userId, repoId } = await seedRepo());

    const row = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "a",
      repoName: "b",
      branchName: "x",
      commitSha: "abc",
    });
    await markPreviewReady(row!.id);
    const after = await getPreviewForBranch(repoId, "x");
    expect(after!.status).toBe("ready");
    expect(after!.buildCompletedAt).not.toBeNull();
  });

  it("markPreviewFailed records error_message + truncates", async () => {
    ({ userId, repoId } = await seedRepo());

    const row = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "a",
      repoName: "b",
      branchName: "y",
      commitSha: "def",
    });
    const longError = "boom\n".repeat(10_000);
    await markPreviewFailed(row!.id, longError);
    const after = await getPreviewForBranch(repoId, "y");
    expect(after!.status).toBe("failed");
    expect(after!.errorMessage).not.toBeNull();
    expect(after!.errorMessage!.length).toBeLessThanOrEqual(2_000);
  });

  it("expireOldPreviews transitions ready rows past expires_at to 'expired'", async () => {
    ({ userId, repoId } = await seedRepo());

    const row = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "a",
      repoName: "b",
      branchName: "stale",
      commitSha: "old",
    });
    expect(row).not.toBeNull();
    await markPreviewReady(row!.id);

    // Force expires_at into the past.
    await db
      .update(branchPreviews)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(branchPreviews.id, row!.id));

    const flipped = await expireOldPreviews();
    expect(flipped).toBeGreaterThanOrEqual(1);

    const after = await getPreviewForBranch(repoId, "stale");
    expect(after!.status).toBe("expired");
  });

  it("expireOldPreviews leaves fresh rows alone", async () => {
    ({ userId, repoId } = await seedRepo());

    const row = await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "a",
      repoName: "b",
      branchName: "fresh",
      commitSha: "new",
    });
    expect(row).not.toBeNull();
    await markPreviewReady(row!.id);

    // Default expiresAt is now+24h → expire pass should ignore it.
    await expireOldPreviews();
    const after = await getPreviewForBranch(repoId, "fresh");
    expect(after!.status).toBe("ready");
  });

  it("listPreviewsForRepo orders by build_started_at descending", async () => {
    ({ userId, repoId } = await seedRepo());

    const oldNow = () => new Date(Date.now() - 60_000);
    const newNow = () => new Date();

    await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "a",
      repoName: "b",
      branchName: "old-branch",
      commitSha: "1",
      now: oldNow,
    });
    await enqueuePreviewBuild({
      repositoryId: repoId,
      ownerName: "a",
      repoName: "b",
      branchName: "new-branch",
      commitSha: "2",
      now: newNow,
    });

    const list = await listPreviewsForRepo(repoId);
    expect(list.length).toBe(2);
    expect(list[0]!.branchName).toBe("new-branch");
    expect(list[1]!.branchName).toBe("old-branch");
  });
});
