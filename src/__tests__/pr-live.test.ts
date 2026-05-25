/**
 * PR live co-editing — session lifecycle, cursor fan-out, stale sweep.
 *
 * Two layers:
 *   - Pure helpers (colorFor determinism, topic naming) run
 *     unconditionally.
 *   - DB-backed flows (join/leave, listLive, sweepStale) and the
 *     in-process broadcast fan-out are gated behind HAS_DB so the
 *     suite stays green on machines without Postgres.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { randomBytes } from "crypto";
import {
  colorFor,
  prLiveTopic,
  type CursorPosition,
} from "../lib/pr-live";
import { subscribe, type SSEEvent } from "../lib/sse";

const HAS_DB = Boolean(process.env.DATABASE_URL);

beforeAll(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL || "";
});

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

describe("pr-live — colour helper", () => {
  it("returns a stable colour for the same principal", () => {
    const id = "user-abc-123";
    expect(colorFor(id)).toBe(colorFor(id));
  });

  it("returns a hex colour from the curated palette", () => {
    const c = colorFor("user-x");
    expect(/^#[0-9a-f]{6}$/i.test(c)).toBe(true);
  });

  it("disjoint principals usually map to different colours", () => {
    // Hash-mod over a 10-entry palette: two random ids land on
    // different bins ~90% of the time. We probe 20 pairs and only
    // assert that *most* differ — the property we care about is
    // distribution, not strict pairwise inequality.
    let differ = 0;
    for (let i = 0; i < 20; i++) {
      const a = colorFor(`p-${i}-a`);
      const b = colorFor(`p-${i}-b`);
      if (a !== b) differ++;
    }
    expect(differ).toBeGreaterThanOrEqual(14);
  });
});

describe("pr-live — topic naming", () => {
  it("prefixes pr-live: + prId", () => {
    expect(prLiveTopic("abc-123")).toBe("pr-live:abc-123");
  });
});

// ---------------------------------------------------------------------------
// Broadcast fan-out — pure pub/sub layer, no DB needed.
// ---------------------------------------------------------------------------

describe("pr-live — broadcast fan-out (no DB)", () => {
  it("publishes a cursor event to subscribers on the same topic", async () => {
    const { updateCursor } = await import("../lib/pr-live");
    const prId = `tmp-pr-${randomBytes(4).toString("hex")}`;
    const events: SSEEvent[] = [];
    const unsub = subscribe(prLiveTopic(prId), (e) => events.push(e));

    const position: CursorPosition = {
      field: "description",
      range: { start: 4, end: 4 },
    };
    // sessionId can be a synthetic value — the in-process broadcaster
    // does not require the row to exist in the DB.
    await updateCursor(`tmp-${randomBytes(4).toString("hex")}`, prId, position);

    expect(events.length).toBeGreaterThan(0);
    const cursorEvt = events.find((e) => e.event === "cursor");
    expect(cursorEvt).toBeDefined();
    const data = cursorEvt!.data as { position: CursorPosition };
    expect(data.position.field).toBe("description");
    expect(data.position.range.start).toBe(4);

    unsub();
  });

  it("publishes presence-leave on leaveSession", async () => {
    const { leaveSession } = await import("../lib/pr-live");
    const prId = `tmp-pr-${randomBytes(4).toString("hex")}`;
    const events: SSEEvent[] = [];
    const unsub = subscribe(prLiveTopic(prId), (e) => events.push(e));

    await leaveSession(`tmp-${randomBytes(4).toString("hex")}`, prId);
    expect(events.some((e) => e.event === "presence-leave")).toBe(true);
    unsub();
  });

  it("publishes an edit event on broadcastEdit", async () => {
    const { broadcastEdit } = await import("../lib/pr-live");
    const prId = `tmp-pr-${randomBytes(4).toString("hex")}`;
    const events: SSEEvent[] = [];
    const unsub = subscribe(prLiveTopic(prId), (e) => events.push(e));

    await broadcastEdit(`tmp-${randomBytes(4).toString("hex")}`, prId, {
      field: "comment_new",
      op: "replace",
      at: 0,
      value: "hi",
    });

    const editEvt = events.find((e) => e.event === "edit");
    expect(editEvt).toBeDefined();
    const data = editEvt!.data as { patch: { value: string } };
    expect(data.patch.value).toBe("hi");
    unsub();
  });
});

// ---------------------------------------------------------------------------
// DB-backed lifecycle + stale sweep.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("pr-live — DB lifecycle", () => {
  /**
   * Seed a real user + repository + PR so foreign keys are satisfied.
   * Returns the PR id (which is what the live-session table joins on).
   */
  async function seedPr(): Promise<string | null> {
    const { db } = await import("../db");
    const { users, repositories, pullRequests } = await import("../db/schema");
    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `prlive-${stamp}`,
        email: `prlive-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return null;

    const [r] = await db
      .insert(repositories)
      .values({
        name: `prlive-repo-${stamp}`,
        ownerId: u.id,
        diskPath: `/tmp/prlive-${stamp}`,
        defaultBranch: "main",
      })
      .returning();
    if (!r) return null;

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: r.id,
        authorId: u.id,
        title: "live edit test",
        baseBranch: "main",
        headBranch: `feat-${stamp}`,
      })
      .returning();
    return pr?.id ?? null;
  }

  it("joinSession inserts a row and returns sessionId + colour", async () => {
    const { joinSession, getSession } = await import("../lib/pr-live");
    const { db } = await import("../db");
    const { users } = await import("../db/schema");

    const prId = await seedPr();
    expect(prId).not.toBeNull();
    if (!prId) return;

    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `joiner-${stamp}`,
        email: `joiner-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const joined = await joinSession({ prId, userId: u.id });
    expect(joined).not.toBeNull();
    if (!joined) return;
    expect(joined.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(joined.sessionId.length).toBeGreaterThan(0);

    const row = await getSession(joined.sessionId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("active");
    expect(row?.prId).toBe(prId);
  });

  it("leaveSession transitions status to 'left'", async () => {
    const { joinSession, leaveSession, getSession } = await import(
      "../lib/pr-live"
    );
    const { db } = await import("../db");
    const { users } = await import("../db/schema");

    const prId = await seedPr();
    if (!prId) return;
    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `leaver-${stamp}`,
        email: `leaver-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const joined = await joinSession({ prId, userId: u.id });
    if (!joined) return;
    await leaveSession(joined.sessionId, prId);
    const row = await getSession(joined.sessionId);
    expect(row?.status).toBe("left");
  });

  it("listLive omits left sessions but keeps active + idle", async () => {
    const { joinSession, leaveSession, listLive } = await import(
      "../lib/pr-live"
    );
    const { db } = await import("../db");
    const { users } = await import("../db/schema");

    const prId = await seedPr();
    if (!prId) return;
    const mk = async () => {
      const stamp = randomBytes(4).toString("hex");
      const [u] = await db
        .insert(users)
        .values({
          username: `m-${stamp}`,
          email: `m-${stamp}@test.local`,
          passwordHash: "x",
        })
        .returning();
      return u?.id ?? null;
    };
    const u1 = await mk();
    const u2 = await mk();
    if (!u1 || !u2) return;

    const j1 = await joinSession({ prId, userId: u1 });
    const j2 = await joinSession({ prId, userId: u2 });
    expect(j1).not.toBeNull();
    expect(j2).not.toBeNull();

    let list = await listLive(prId);
    expect(list.length).toBeGreaterThanOrEqual(2);

    if (j2) await leaveSession(j2.sessionId, prId);
    list = await listLive(prId);
    const ids = list.map((s) => s.id);
    if (j2) expect(ids.includes(j2.sessionId)).toBe(false);
    if (j1) expect(ids.includes(j1.sessionId)).toBe(true);
  });

  it("sweepStale marks idle (>60s) and left (>5m) rows", async () => {
    const { joinSession, sweepStale, getSession } = await import(
      "../lib/pr-live"
    );
    const { db } = await import("../db");
    const { users, prLiveSessions } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const prId = await seedPr();
    if (!prId) return;
    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `stale-${stamp}`,
        email: `stale-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;

    const joined = await joinSession({ prId, userId: u.id });
    if (!joined) return;
    // Back-date last_seen_at by 70s so the next sweep transitions to
    // 'idle'.
    const idleStamp = new Date(Date.now() - 70_000);
    await db
      .update(prLiveSessions)
      .set({ lastSeenAt: idleStamp })
      .where(eq(prLiveSessions.id, joined.sessionId));

    const r1 = await sweepStale();
    expect(r1.idled).toBeGreaterThanOrEqual(1);
    const idleRow = await getSession(joined.sessionId);
    expect(idleRow?.status).toBe("idle");

    // Push past 5 minutes; next sweep should mark 'left'.
    const leftStamp = new Date(Date.now() - 6 * 60_000);
    await db
      .update(prLiveSessions)
      .set({ lastSeenAt: leftStamp })
      .where(eq(prLiveSessions.id, joined.sessionId));

    const r2 = await sweepStale();
    expect(r2.left).toBeGreaterThanOrEqual(1);
    const leftRow = await getSession(joined.sessionId);
    expect(leftRow?.status).toBe("left");
  });

  it("updateCursor persists position + touches last_seen_at", async () => {
    const { joinSession, updateCursor, getSession } = await import(
      "../lib/pr-live"
    );
    const { db } = await import("../db");
    const { users } = await import("../db/schema");

    const prId = await seedPr();
    if (!prId) return;
    const stamp = randomBytes(4).toString("hex");
    const [u] = await db
      .insert(users)
      .values({
        username: `cursor-${stamp}`,
        email: `cursor-${stamp}@test.local`,
        passwordHash: "x",
      })
      .returning();
    if (!u) return;
    const joined = await joinSession({ prId, userId: u.id });
    if (!joined) return;

    await updateCursor(joined.sessionId, prId, {
      field: "description",
      range: { start: 12, end: 18 },
    });

    const row = await getSession(joined.sessionId);
    expect(row?.cursor?.field).toBe("description");
    expect(row?.cursor?.range.start).toBe(12);
    expect(row?.cursor?.range.end).toBe(18);
    expect(row?.status).toBe("active");
  });
});
