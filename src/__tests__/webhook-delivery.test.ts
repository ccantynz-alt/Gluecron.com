/**
 * Reliable webhook delivery — retry queue + dead-letter coverage.
 *
 * Pins down `src/lib/webhook-delivery.ts`:
 *   - 2xx response on the first attempt → status='succeeded' + succeeded_at
 *   - 5xx response → row stays 'pending', attempt_count increments,
 *     next_attempt_at lands ~30s out (first backoff step)
 *   - After MAX_ATTEMPTS-1 consecutive failures the next attempt flips the
 *     row to status='dead' (no further retries)
 *
 * Strategy: each test spins up a tiny Bun.serve() on a random port and points
 * a freshly-created `webhooks` row at it, then drives `attemptDelivery()`
 * directly so we don't depend on worker timing.
 *
 * DB-backed only — gated on `DATABASE_URL` to keep CI green without
 * Postgres, matching the `HAS_DB` skipIf pattern used elsewhere.
 */

import { describe, it, expect } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Pure logic — backoff table shape (runs without a DB).
// ---------------------------------------------------------------------------

describe("webhook-delivery — backoff schedule", () => {
  it("defines MAX_ATTEMPTS=6 and monotonically increasing backoffs", async () => {
    const { MAX_ATTEMPTS, BACKOFF_MS } = await import(
      "../lib/webhook-delivery"
    );
    expect(MAX_ATTEMPTS).toBe(6);
    // Indices 1..5 hold the schedule (slot 0 is the unused immediate slot).
    expect(BACKOFF_MS[1]).toBe(30_000);
    expect(BACKOFF_MS[2]).toBe(120_000);
    expect(BACKOFF_MS[3]).toBe(600_000);
    expect(BACKOFF_MS[4]).toBe(3_600_000);
    expect(BACKOFF_MS[5]).toBe(21_600_000);
    for (let i = 2; i < BACKOFF_MS.length; i++) {
      expect(BACKOFF_MS[i]).toBeGreaterThan(BACKOFF_MS[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------
// DB-backed end-to-end: spins up a tiny target server per case.
// ---------------------------------------------------------------------------

interface Fixture {
  userId: string;
  repoId: string;
  webhookId: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(targetUrl: string): Promise<Fixture> {
  const { db } = await import("../db");
  const { users, repositories, webhooks } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");

  const uname = "whd-" + Math.random().toString(36).slice(2, 10);
  const [user] = await db
    .insert(users)
    .values({
      username: uname,
      email: `${uname}@example.com`,
      passwordHash: "x",
    })
    .returning();

  const [repo] = await db
    .insert(repositories)
    .values({
      name: "whd-repo-" + Math.random().toString(36).slice(2, 8),
      ownerId: user.id,
      diskPath: `/tmp/whd-${user.id}`,
    })
    .returning();

  const [hook] = await db
    .insert(webhooks)
    .values({
      repositoryId: repo.id,
      url: targetUrl,
      secret: "test-secret",
      events: "push",
      isActive: true,
    })
    .returning();

  return {
    userId: user.id,
    repoId: repo.id,
    webhookId: hook.id,
    cleanup: async () => {
      // Cascade: deleting the user wipes the repo (FK) which wipes the
      // hook (FK) which wipes the deliveries (FK).
      try {
        await db.delete(users).where(eq(users.id, user.id));
      } catch {
        /* swallow */
      }
    },
  };
}

describe("webhook-delivery — successful first attempt", () => {
  it.skipIf(!HAS_DB)("2xx → status='succeeded' + succeeded_at set", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok", { status: 200 }),
    });
    const url = `http://localhost:${server.port}/hook`;
    const fx = await makeFixture(url);

    try {
      const { db } = await import("../db");
      const { webhookDeliveries } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");
      const { enqueueWebhookDelivery, attemptDelivery } = await import(
        "../lib/webhook-delivery"
      );

      const id = await enqueueWebhookDelivery({
        webhookId: fx.webhookId,
        secret: "test-secret",
        event: "push",
        payload: { hello: "world" },
      });
      expect(id).toBeTruthy();

      const result = await attemptDelivery(id!);
      expect(result).toBe("succeeded");

      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, id!));
      expect(row.status).toBe("succeeded");
      expect(row.attemptCount).toBe(1);
      expect(row.lastStatusCode).toBe(200);
      expect(row.succeededAt).toBeTruthy();
      expect(row.nextAttemptAt).toBeNull();
      expect(row.lastError).toBeNull();
    } finally {
      await fx.cleanup();
      server.stop(true);
    }
  });
});

describe("webhook-delivery — retry on 5xx", () => {
  it.skipIf(!HAS_DB)(
    "500 → status stays 'pending', attempt_count=1, next_attempt_at ~30s out",
    async () => {
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response("boom", { status: 500 }),
      });
      const url = `http://localhost:${server.port}/hook`;
      const fx = await makeFixture(url);

      try {
        const { db } = await import("../db");
        const { webhookDeliveries } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");
        const { enqueueWebhookDelivery, attemptDelivery, BACKOFF_MS } =
          await import("../lib/webhook-delivery");

        const id = await enqueueWebhookDelivery({
          webhookId: fx.webhookId,
          secret: "test-secret",
          event: "push",
          payload: { fail: true },
        });
        expect(id).toBeTruthy();

        const before = Date.now();
        const result = await attemptDelivery(id!);
        expect(result).toBe("retry");

        const [row] = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, id!));
        expect(row.status).toBe("pending");
        expect(row.attemptCount).toBe(1);
        expect(row.lastStatusCode).toBe(500);
        expect(row.lastError).toContain("500");
        expect(row.succeededAt).toBeNull();
        // next_attempt_at should land in the future, roughly at +BACKOFF_MS[1]
        // (allow generous slack for slow test runners + DB rounding).
        expect(row.nextAttemptAt).toBeTruthy();
        const nextMs = new Date(row.nextAttemptAt!).getTime();
        const expected = before + BACKOFF_MS[1]!;
        expect(nextMs).toBeGreaterThanOrEqual(expected - 5_000);
        expect(nextMs).toBeLessThanOrEqual(expected + 60_000);
      } finally {
        await fx.cleanup();
        server.stop(true);
      }
    }
  );
});

describe("webhook-delivery — dead-letter after max attempts", () => {
  it.skipIf(!HAS_DB)(
    "after MAX_ATTEMPTS consecutive failures → status='dead'",
    async () => {
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response("nope", { status: 503 }),
      });
      const url = `http://localhost:${server.port}/hook`;
      const fx = await makeFixture(url);

      try {
        const { db } = await import("../db");
        const { webhookDeliveries } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");
        const { enqueueWebhookDelivery, attemptDelivery, MAX_ATTEMPTS } =
          await import("../lib/webhook-delivery");

        const id = await enqueueWebhookDelivery({
          webhookId: fx.webhookId,
          secret: "test-secret",
          event: "push",
          payload: { will: "die" },
        });
        expect(id).toBeTruthy();

        // Drive every attempt back-to-back. We bypass the wall-clock backoff
        // by calling attemptDelivery() directly — the schedule check lives
        // in the *worker*, not in the per-attempt path.
        let last: string = "";
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          last = await attemptDelivery(id!);
        }
        expect(last).toBe("dead");

        const [row] = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.id, id!));
        expect(row.status).toBe("dead");
        expect(row.attemptCount).toBe(MAX_ATTEMPTS);
        expect(row.lastStatusCode).toBe(503);
        expect(row.nextAttemptAt).toBeNull();
        expect(row.succeededAt).toBeNull();
      } finally {
        await fx.cleanup();
        server.stop(true);
      }
    }
  );
});
