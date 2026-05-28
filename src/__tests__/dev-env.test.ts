/**
 * Tests for src/lib/dev-env.ts and src/routes/dev-env.tsx — cloud dev
 * environments (migration 0072).
 *
 * Three layers:
 *
 *   1. Route smoke tests — module loads without error; unauthenticated
 *      visitors on a public repo are redirected to login.
 *
 *   2. Pure helpers — URL building, status label mapping, machine-size
 *      validation. No DB, no network. Always run.
 *
 *   3. DB-backed pipeline — gated on HAS_DB so the suite stays green on
 *      machines without Postgres. Covers:
 *        - startDevEnv reads committed dev.yml when present
 *        - startDevEnv generates a default when no file is committed
 *        - per-repo opt-in gate (refuses when devEnvsEnabled=false)
 *        - expireIdleEnvs only touches idle ones
 *        - stop / restart upsert keeps the same row
 */

import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../app";
import {
  buildDevEnvUrl,
  DEFAULT_IDLE_MINUTES,
  devEnvStatusLabel,
  expireIdleEnvs,
  generateDevYml,
  getDevEnv,
  getDevEnvForOwner,
  markFailed,
  markReady,
  normalizeMachineSize,
  recordActivity,
  startDevEnv,
  stopDevEnv,
} from "../lib/dev-env";
import { db } from "../db";
import { devEnvs, repositories, users } from "../db/schema";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// 1. Route smoke tests
// ---------------------------------------------------------------------------

describe("dev-env — route module", () => {
  it("loads without error and exports a Hono app", async () => {
    // Dynamic import to verify the module resolves cleanly at runtime.
    const mod = await import("../routes/dev-env");
    expect(mod.default).toBeDefined();
    // Hono instances expose a `fetch` method.
    expect(typeof mod.default.fetch).toBe("function");
  });
});

describe("dev-env — unauthenticated redirect", () => {
  it.skipIf(!HAS_DB)(
    "GET /:owner/:repo/dev redirects unauthenticated visitor on a public repo to /login",
    async () => {
      // Seed a minimal public repo so resolveRepoForUser resolves.
      const { db: database } = await import("../db");
      const { repositories: repos, users: usersTable } = await import(
        "../db/schema"
      );
      const username =
        "devenvsmoke_" + Math.random().toString(36).slice(2, 10);
      const [user] = await database
        .insert(usersTable)
        .values({
          username,
          email: `${username}@test.local`,
          passwordHash: "$2b$10$" + "x".repeat(53),
        })
        .returning();
      const repoName = "pub-" + Math.random().toString(36).slice(2, 8);
      await database
        .insert(repos)
        .values({
          name: repoName,
          ownerId: user!.id,
          diskPath: `/tmp/devenvsmoke-${repoName}`,
          isPrivate: false,
          devEnvsEnabled: true,
        })
        .returning();

      try {
        // No session cookie → softAuth sets user=null → redirect to /login.
        const res = await app.request(
          `/${username}/${repoName}/dev`,
          { redirect: "manual" }
        );
        expect(res.status).toBe(302);
        const location = res.headers.get("location") ?? "";
        expect(location).toContain("/login");
      } finally {
        // Clean up seeded rows.
        try {
          const { eq: eqFn } = await import("drizzle-orm");
          await database
            .delete(repos)
            .where(eqFn(repos.ownerId, user!.id));
          await database
            .delete(usersTable)
            .where(eqFn(usersTable.id, user!.id));
        } catch {
          /* best effort */
        }
      }
    }
  );

  it("GET /:owner/:repo/dev returns 404 for non-existent repo (no DB or absent repo)", async () => {
    // Without a real repo row the route cannot resolve the repo and returns 404.
    // This test always runs (no DB required) because resolveRepoForUser
    // returns null when the DB is unreachable or the repo doesn't exist.
    const res = await app.request(
      "/no-such-owner-xyzzy/no-such-repo-xyzzy/dev",
      { redirect: "manual" }
    );
    // 404 (repo not found) or 302 (redirect if somehow auth redirects first).
    expect([404, 302].includes(res.status)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Pure helpers
// ---------------------------------------------------------------------------

describe("dev-env — buildDevEnvUrl", () => {
  it("produces a wildcard subdomain with default domain", () => {
    const prev = process.env.DEV_ENV_DOMAIN;
    delete process.env.DEV_ENV_DOMAIN;
    try {
      const url = buildDevEnvUrl("abcdef-1234");
      expect(url.startsWith("https://dev-")).toBe(true);
      expect(url.endsWith(".gluecron.com")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.DEV_ENV_DOMAIN = prev;
    }
  });

  it("honours DEV_ENV_DOMAIN env var", () => {
    const prev = process.env.DEV_ENV_DOMAIN;
    process.env.DEV_ENV_DOMAIN = "dev.acme.dev";
    try {
      const url = buildDevEnvUrl("abc");
      expect(url).toBe("https://dev-abc.dev.acme.dev");
    } finally {
      if (prev === undefined) delete process.env.DEV_ENV_DOMAIN;
      else process.env.DEV_ENV_DOMAIN = prev;
    }
  });

  it("strips scheme from DEV_ENV_DOMAIN if accidentally included", () => {
    const prev = process.env.DEV_ENV_DOMAIN;
    process.env.DEV_ENV_DOMAIN = "https://dev.foo.com";
    try {
      const url = buildDevEnvUrl("xyz");
      expect(url).toBe("https://dev-xyz.dev.foo.com");
    } finally {
      if (prev === undefined) delete process.env.DEV_ENV_DOMAIN;
      else process.env.DEV_ENV_DOMAIN = prev;
    }
  });

  it("slugifies the env id so a UUID lands cleanly", () => {
    // UUID with dashes is still a valid DNS label after slugify.
    const url = buildDevEnvUrl("11111111-2222-3333-4444-555555555555");
    expect(url).toContain("dev-11111111-2222-3333-4444-555555555555.");
  });

  it("handles empty / missing ids gracefully", () => {
    const url = buildDevEnvUrl("");
    expect(url.startsWith("https://dev-")).toBe(true);
  });
});

describe("dev-env — devEnvStatusLabel", () => {
  it("maps known statuses to human labels", () => {
    expect(devEnvStatusLabel("cold")).toBe("Cold");
    expect(devEnvStatusLabel("warming")).toBe("Warming up");
    expect(devEnvStatusLabel("ready")).toBe("Ready");
    expect(devEnvStatusLabel("failed")).toBe("Failed");
    expect(devEnvStatusLabel("stopped")).toBe("Stopped");
  });

  it("passes through unknown statuses unchanged", () => {
    expect(devEnvStatusLabel("mystery")).toBe("mystery");
  });
});

describe("dev-env — normalizeMachineSize", () => {
  it("accepts the three valid sizes", () => {
    expect(normalizeMachineSize("small")).toBe("small");
    expect(normalizeMachineSize("medium")).toBe("medium");
    expect(normalizeMachineSize("large")).toBe("large");
  });

  it("defaults to 'small' for unknown / empty", () => {
    expect(normalizeMachineSize("")).toBe("small");
    expect(normalizeMachineSize(undefined)).toBe("small");
    expect(normalizeMachineSize(null)).toBe("small");
    expect(normalizeMachineSize("xlarge")).toBe("small");
  });
});

describe("dev-env — DEFAULT_IDLE_MINUTES constant", () => {
  it("is 30", () => {
    expect(DEFAULT_IDLE_MINUTES).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 2. Graceful no-ops — must not throw on empty inputs
// ---------------------------------------------------------------------------

describe("dev-env — graceful no-ops", () => {
  it("getDevEnv returns null for empty id", async () => {
    expect(await getDevEnv("")).toBeNull();
  });

  it("getDevEnvForOwner returns null for empty args", async () => {
    expect(await getDevEnvForOwner("", "")).toBeNull();
  });

  it("markReady / markFailed / stopDevEnv / recordActivity swallow empty ids", async () => {
    await markReady("");
    await markFailed("", "err");
    await stopDevEnv("");
    await recordActivity("");
    expect(true).toBe(true);
  });

  it("startDevEnv refuses invalid input", async () => {
    const r1 = await startDevEnv({
      repositoryId: "",
      ownerUserId: "user",
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("invalid_input");
    const r2 = await startDevEnv({
      repositoryId: "repo",
      ownerUserId: "",
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("invalid_input");
  });

  it("generateDevYml returns the default when AI is unavailable", async () => {
    // Without ANTHROPIC_API_KEY the helper falls back to the bundled
    // default YAML — never throws.
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const yml = await generateDevYml("alice/foo");
      expect(typeof yml).toBe("string");
      expect(yml.includes("image:")).toBe(true);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. DB-backed pipeline
// ---------------------------------------------------------------------------

const TEST_USER_PREFIX = "devenvtest_";

async function seedRepo(opts?: {
  devEnvsEnabled?: boolean;
}): Promise<{
  userId: string;
  repoId: string;
  ownerName: string;
  repoName: string;
}> {
  const username =
    TEST_USER_PREFIX + Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({
      username,
      email: `${username}@devenvtest.local`,
      passwordHash: "$2b$10$" + "x".repeat(53),
    })
    .returning();
  const repoName = "dev-test-" + Math.random().toString(36).slice(2, 8);
  const [repo] = await db
    .insert(repositories)
    .values({
      name: repoName,
      ownerId: user!.id,
      diskPath: "/tmp/dev-test-" + Math.random().toString(36).slice(2, 8),
      devEnvsEnabled: opts?.devEnvsEnabled ?? true,
    })
    .returning();
  return {
    userId: user!.id,
    repoId: repo!.id,
    ownerName: user!.username,
    repoName: repo!.name,
  };
}

async function cleanupUser(userId: string): Promise<void> {
  try {
    await db.delete(repositories).where(eq(repositories.ownerId, userId));
    await db.delete(users).where(eq(users.id, userId));
  } catch {
    /* best effort */
  }
}

describe.skipIf(!HAS_DB)("dev-env — DB pipeline", () => {
  let userId = "";

  afterEach(async () => {
    if (userId) await cleanupUser(userId);
    userId = "";
  });

  it("startDevEnv uses the provided dev.yml override (skips AI)", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const yml = "image: node:20-alpine\nports: [3000]\n";
    const result = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: yml,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.status).toBe("warming");
      expect(result.env.devYml).toBe(yml);
      expect(result.env.machineSize).toBe("small");
      expect(result.env.idleMinutes).toBe(30);
      expect(result.url.startsWith("https://dev-")).toBe(true);
      expect(result.env.previewUrl).toBe(result.url);
    }
  });

  it("startDevEnv generates a default when no override + no AI key", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await startDevEnv({
        repositoryId: seeded.repoId,
        ownerUserId: seeded.userId,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Default YAML contains an `image:` key.
        expect(result.env.devYml).toBeTruthy();
        expect(result.env.devYml!.toLowerCase()).toContain("image:");
      }
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("startDevEnv refuses if the repo hasn't opted in", async () => {
    const seeded = await seedRepo({ devEnvsEnabled: false });
    userId = seeded.userId;

    const result = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_opted_in");
    }

    // And no row was inserted.
    const after = await getDevEnvForOwner(seeded.repoId, seeded.userId);
    expect(after).toBeNull();
  });

  it("startDevEnv is idempotent: restart reuses the same row + URL", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const first = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n# v1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await markReady(first.env.id, "ctr-1");
    await stopDevEnv(first.env.id);

    const second = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n# v2",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Same row, status flipped back to warming, dev.yml refreshed.
    expect(second.env.id).toBe(first.env.id);
    expect(second.env.status).toBe("warming");
    expect(second.env.devYml).toContain("v2");
    expect(second.url).toBe(first.url);

    // Unique constraint enforces single row per (repo, user).
    const all = await db
      .select()
      .from(devEnvs)
      .where(eq(devEnvs.repositoryId, seeded.repoId));
    expect(all.length).toBe(1);
  });

  it("expireIdleEnvs only touches idle ready/warming rows", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const result = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await markReady(result.env.id, "ctr-x");

    // Fresh — sweep should leave it alone.
    const beforeFlip = await expireIdleEnvs();
    expect(beforeFlip).toBe(0);
    const stillReady = await getDevEnv(result.env.id);
    expect(stillReady!.status).toBe("ready");

    // Force last_active_at into the past beyond idle_minutes.
    await db
      .update(devEnvs)
      .set({
        lastActiveAt: new Date(Date.now() - 60 * 60_000), // 60min ago
        idleMinutes: 5,
      })
      .where(eq(devEnvs.id, result.env.id));

    const swept = await expireIdleEnvs();
    expect(swept).toBeGreaterThanOrEqual(1);

    const after = await getDevEnv(result.env.id);
    expect(after!.status).toBe("stopped");
  });

  it("expireIdleEnvs leaves stopped + failed rows alone", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const result = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await markFailed(result.env.id, "boom");
    // Pretend it's been failed for an hour.
    await db
      .update(devEnvs)
      .set({
        lastActiveAt: new Date(Date.now() - 60 * 60_000),
        idleMinutes: 5,
      })
      .where(eq(devEnvs.id, result.env.id));

    await expireIdleEnvs();
    const after = await getDevEnv(result.env.id);
    // Status is unchanged — only 'ready'/'warming' get swept.
    expect(after!.status).toBe("failed");
  });

  it("recordActivity bumps last_active_at", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const result = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Force last_active_at into the past.
    const oldDate = new Date(Date.now() - 60 * 60_000);
    await db
      .update(devEnvs)
      .set({ lastActiveAt: oldDate })
      .where(eq(devEnvs.id, result.env.id));

    await recordActivity(result.env.id);
    const after = await getDevEnv(result.env.id);
    expect(after!.lastActiveAt.getTime()).toBeGreaterThan(oldDate.getTime());
  });

  it("markFailed truncates absurdly long error messages", async () => {
    const seeded = await seedRepo();
    userId = seeded.userId;

    const result = await startDevEnv({
      repositoryId: seeded.repoId,
      ownerUserId: seeded.userId,
      devYml: "image: node:20\n",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const longError = "boom\n".repeat(10_000);
    await markFailed(result.env.id, longError);
    const after = await getDevEnv(result.env.id);
    expect(after!.status).toBe("failed");
    expect(after!.errorMessage).not.toBeNull();
    expect(after!.errorMessage!.length).toBeLessThanOrEqual(2_000);
  });
});
