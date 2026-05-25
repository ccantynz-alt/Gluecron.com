/**
 * PR live co-editing — presence, cursors, and content patches.
 *
 * One row per active browser tab (human) or agent runtime in
 * `pr_live_sessions`. The HTTP layer (src/routes/pr-live.ts) opens a
 * topic-based SSE stream `pr-live:<prId>`; this lib drives the writes:
 *
 *   joinSession    — register a session, return id + colour
 *   updateCursor   — debounce-friendly cursor broadcast
 *   broadcastEdit  — content patch fan-out (last-write-wins for v1)
 *   leaveSession   — explicit "this tab is closing" marker
 *   sweepStale     — autopilot task: idle/left state machine
 *
 * Everything that talks to subscribers funnels through `publish()` on
 * topic `pr-live:<prId>` so the route file stays a thin transport. DB
 * writes are best-effort — if the database is offline the broadcast
 * still reaches the in-process subscribers, which is the happy path
 * for production where ephemeral presence rarely needs durability.
 */

import { eq, and, lt, sql, ne } from "drizzle-orm";
import { createHash } from "crypto";
import { db } from "../db";
import { prLiveSessions } from "../db/schema";
import { publish } from "./sse";

/** Field identifiers the client may attach a cursor / patch to. */
export type LiveField =
  | "description"
  | `comment_${string}`
  | `line_${string}:${number}`;

/** Cursor range — character offsets within the named field's content. */
export interface CursorPosition {
  field: LiveField | string;
  range: { start: number; end: number };
}

/** Patch payload — opaque to the lib; the client picks the dialect. */
export interface EditPatch {
  field: LiveField | string;
  /** Op shape — replace, insert, delete. */
  op: "replace" | "insert" | "delete";
  /** Position (char offset) the op applies at. */
  at: number;
  /** Inserted/replaced text (omit for delete). */
  value?: string;
  /** Length to remove (replace/delete only). */
  length?: number;
}

/** Public session view — the shape SSE consumers see. */
export interface PublicLiveSession {
  id: string;
  prId: string;
  userId: string | null;
  agentSessionId: string | null;
  color: string;
  status: "active" | "idle" | "left";
  cursor: CursorPosition | null;
  joinedAt: string;
  lastSeenAt: string;
}

/** Tuned per the spec: idle after 60s, dropped after 5m of silence. */
export const IDLE_AFTER_MS = 60_000;
export const LEFT_AFTER_MS = 5 * 60_000;
/** Heartbeat the client is expected to send. */
export const HEARTBEAT_MS = 15_000;

/** Deterministic colour palette — picked by hashing the principal id. */
const COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635",
  "#34d399", "#22d3ee", "#60a5fa", "#a78bfa",
  "#f472b6", "#fb7185",
] as const;

/**
 * Deterministic colour for a principal (user id or agent session id).
 * Hash → modulo palette so concurrent tabs of the same user share the
 * same hue and the UI stays steady.
 */
export function colorFor(principalId: string): string {
  const h = createHash("sha256").update(principalId).digest();
  const idx = h[0] % COLORS.length;
  return COLORS[idx];
}

/** SSE topic name for one PR. */
export function prLiveTopic(prId: string): string {
  return `pr-live:${prId}`;
}

/**
 * Best-effort DB write. If the DB is unreachable we still want presence
 * to work in-process — production already runs autopilot cleanup that
 * heals from drift. Returns the value or `null` on error.
 */
async function tryDb<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Begin a session. Exactly one of `userId` / `agentSessionId` should be
 * non-null; the DB stores both as nullable so a single table represents
 * both principals.
 */
export async function joinSession(args: {
  prId: string;
  userId?: string | null;
  agentSessionId?: string | null;
}): Promise<{ sessionId: string; color: string } | null> {
  const principalId =
    args.userId ?? args.agentSessionId ?? null;
  if (!principalId) return null;
  const color = colorFor(principalId);

  const row = await tryDb(async () => {
    const [inserted] = await db
      .insert(prLiveSessions)
      .values({
        prId: args.prId,
        userId: args.userId ?? null,
        agentSessionId: args.agentSessionId ?? null,
        color,
        status: "active",
      })
      .returning();
    return inserted ?? null;
  });

  // Even if the DB write failed, mint a synthetic id so the in-process
  // broadcaster has something to key on for this tab.
  const sessionId = row?.id ?? `tmp-${principalId}-${Date.now()}`;

  publish(prLiveTopic(args.prId), {
    event: "presence-join",
    data: {
      sessionId,
      prId: args.prId,
      userId: args.userId ?? null,
      agentSessionId: args.agentSessionId ?? null,
      color,
      status: "active",
      joinedAt: row?.joinedAt?.toISOString() ?? new Date().toISOString(),
    },
  });

  return { sessionId, color };
}

/**
 * Update cursor position + touch heartbeat. Caller is expected to
 * debounce (~100ms) — this function does not internally throttle.
 */
export async function updateCursor(
  sessionId: string,
  prId: string,
  position: CursorPosition
): Promise<void> {
  await tryDb(async () => {
    await db
      .update(prLiveSessions)
      .set({
        cursorPosition: position as unknown as Record<string, unknown>,
        lastSeenAt: new Date(),
        status: "active",
      })
      .where(eq(prLiveSessions.id, sessionId));
  });

  publish(prLiveTopic(prId), {
    event: "cursor",
    data: { sessionId, position },
  });
}

/**
 * Touch a session's heartbeat without changing the cursor. The client
 * pings every 15s; missing pings transition the row to idle/left.
 */
export async function heartbeat(
  sessionId: string,
  prId: string
): Promise<void> {
  await tryDb(async () => {
    await db
      .update(prLiveSessions)
      .set({ lastSeenAt: new Date(), status: "active" })
      .where(eq(prLiveSessions.id, sessionId));
  });

  publish(prLiveTopic(prId), {
    event: "heartbeat",
    data: { sessionId },
  });
}

/**
 * Broadcast a content patch. v1 is last-write-wins — the client applies
 * received patches directly to its textarea. A proper OT engine is the
 * v2 follow-up, which is why the patch shape is intentionally open.
 */
export async function broadcastEdit(
  sessionId: string,
  prId: string,
  patch: EditPatch
): Promise<void> {
  // Touch last_seen so an editing tab doesn't go stale.
  await tryDb(async () => {
    await db
      .update(prLiveSessions)
      .set({ lastSeenAt: new Date(), status: "active" })
      .where(eq(prLiveSessions.id, sessionId));
  });

  publish(prLiveTopic(prId), {
    event: "edit",
    data: { sessionId, patch },
  });
}

/** Mark a session as explicitly left (tab close, navigation, etc.). */
export async function leaveSession(
  sessionId: string,
  prId: string
): Promise<void> {
  await tryDb(async () => {
    await db
      .update(prLiveSessions)
      .set({ status: "left", lastSeenAt: new Date() })
      .where(eq(prLiveSessions.id, sessionId));
  });

  publish(prLiveTopic(prId), {
    event: "presence-leave",
    data: { sessionId },
  });
}

/** List the live presence on a PR (active + idle, drops 'left'). */
export async function listLive(prId: string): Promise<PublicLiveSession[]> {
  const rows = await tryDb(() =>
    db
      .select()
      .from(prLiveSessions)
      .where(
        and(
          eq(prLiveSessions.prId, prId),
          ne(prLiveSessions.status, "left")
        )
      )
  );
  if (!rows) return [];
  return rows.map((r) => ({
    id: r.id,
    prId: r.prId,
    userId: r.userId,
    agentSessionId: r.agentSessionId,
    color: r.color,
    status: (r.status as PublicLiveSession["status"]) ?? "active",
    cursor: (r.cursorPosition as CursorPosition | null) ?? null,
    joinedAt: r.joinedAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));
}

/**
 * Autopilot sweep — transition stale rows to idle / left based on the
 * configured thresholds. Returns { idled, left } counts so the task
 * row can log them. Safe to call on an empty DB.
 */
export async function sweepStale(
  now: Date = new Date()
): Promise<{ idled: number; left: number }> {
  const idleCutoff = new Date(now.getTime() - IDLE_AFTER_MS);
  const leftCutoff = new Date(now.getTime() - LEFT_AFTER_MS);

  const idledRes = await tryDb(async () => {
    const updated = await db
      .update(prLiveSessions)
      .set({ status: "idle" })
      .where(
        and(
          eq(prLiveSessions.status, "active"),
          lt(prLiveSessions.lastSeenAt, idleCutoff)
        )
      )
      .returning({ id: prLiveSessions.id, prId: prLiveSessions.prId });
    return updated;
  });
  const idled = idledRes ?? [];

  const leftRes = await tryDb(async () => {
    const updated = await db
      .update(prLiveSessions)
      .set({ status: "left" })
      .where(
        and(
          // Sweeping anything not already 'left' covers both active and
          // idle rows that have crossed the 5-minute threshold.
          ne(prLiveSessions.status, "left"),
          lt(prLiveSessions.lastSeenAt, leftCutoff)
        )
      )
      .returning({ id: prLiveSessions.id, prId: prLiveSessions.prId });
    return updated;
  });
  const left = leftRes ?? [];

  // Fire presence-update / leave events for any peers still listening.
  for (const row of idled) {
    publish(prLiveTopic(row.prId), {
      event: "presence-update",
      data: { sessionId: row.id, status: "idle" },
    });
  }
  for (const row of left) {
    publish(prLiveTopic(row.prId), {
      event: "presence-leave",
      data: { sessionId: row.id },
    });
  }

  return { idled: idled.length, left: left.length };
}

/**
 * Lookup a single session row by id — used by the SSE endpoint to
 * verify a heartbeat/leave request matches a real row before
 * broadcasting.
 */
export async function getSession(
  sessionId: string
): Promise<PublicLiveSession | null> {
  const row = await tryDb(async () => {
    const [r] = await db
      .select()
      .from(prLiveSessions)
      .where(eq(prLiveSessions.id, sessionId))
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;
  return {
    id: row.id,
    prId: row.prId,
    userId: row.userId,
    agentSessionId: row.agentSessionId,
    color: row.color,
    status: (row.status as PublicLiveSession["status"]) ?? "active",
    cursor: (row.cursorPosition as CursorPosition | null) ?? null,
    joinedAt: row.joinedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

// Re-export so callers don't need to also import drizzle helpers. Kept
// at the bottom so the public surface is obvious when reading the file.
export { sql };
