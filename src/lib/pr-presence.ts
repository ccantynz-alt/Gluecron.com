/**
 * Real-time collaborative PR review presence.
 *
 * Maintains an in-memory room map keyed by PR id. Each room tracks every
 * connected reviewer's current line hover and typing state. The module is
 * self-contained: no DB, no Redis — purely ephemeral per-process state.
 *
 * Rooms are automatically created on first join and swept clean when the
 * last user leaves. A background sweep evicts sessions whose lastSeen
 * timestamp is older than STALE_THRESHOLD_MS (30 seconds).
 *
 * Public API:
 *   joinRoom(prId, sessionId, user)
 *   leaveRoom(prId, sessionId)
 *   updatePresence(prId, sessionId, line, typing)
 *   getRoomUsers(prId)
 *   broadcastToRoom(prId, message, excludeSession?)
 *   registerSocket(prId, sessionId, ws)
 *   unregisterSocket(prId, sessionId)
 */

export type PresenceUser = {
  userId: string;
  username: string;
  colour: string;
  line: number | null;
  typing: boolean;
  lastSeen: number; // Date.now()
};

type WsLike = {
  send: (data: string) => void;
  readyState?: number;
};

// Room: sessionId → PresenceUser
const rooms = new Map<string, Map<string, PresenceUser>>();

// Socket registry: prId → sessionId → WebSocket
const sockets = new Map<string, Map<string, WsLike>>();

const COLOURS = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#34495e",
];

const STALE_THRESHOLD_MS = 30_000;
const SWEEP_INTERVAL_MS = 15_000;

/** Stable colour assignment: hash userId → one of 8 preset colours. */
function assignColour(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return COLOURS[hash % COLOURS.length];
}

function getRoom(prId: string): Map<string, PresenceUser> {
  let room = rooms.get(prId);
  if (!room) {
    room = new Map();
    rooms.set(prId, room);
  }
  return room;
}

function getSockets(prId: string): Map<string, WsLike> {
  let map = sockets.get(prId);
  if (!map) {
    map = new Map();
    sockets.set(prId, map);
  }
  return map;
}

/** Add or refresh a user's presence in a room. */
export function joinRoom(
  prId: string,
  sessionId: string,
  user: { userId: string; username: string }
): PresenceUser {
  const room = getRoom(prId);
  const existing = room.get(sessionId);
  const entry: PresenceUser = {
    userId: user.userId,
    username: user.username,
    colour: existing?.colour ?? assignColour(user.userId),
    line: existing?.line ?? null,
    typing: existing?.typing ?? false,
    lastSeen: Date.now(),
  };
  room.set(sessionId, entry);
  return entry;
}

/** Remove a session from a room; prune empty rooms. */
export function leaveRoom(prId: string, sessionId: string): void {
  const room = rooms.get(prId);
  if (!room) return;
  room.delete(sessionId);
  if (room.size === 0) rooms.delete(prId);

  const ss = sockets.get(prId);
  if (ss) {
    ss.delete(sessionId);
    if (ss.size === 0) sockets.delete(prId);
  }
}

/** Update cursor line / typing state and refresh lastSeen. */
export function updatePresence(
  prId: string,
  sessionId: string,
  line: number | null,
  typing: boolean
): PresenceUser | null {
  const room = rooms.get(prId);
  if (!room) return null;
  const entry = room.get(sessionId);
  if (!entry) return null;
  entry.line = line;
  entry.typing = typing;
  entry.lastSeen = Date.now();
  return entry;
}

/** Ping-only: refresh lastSeen without changing line/typing. */
export function pingSession(prId: string, sessionId: string): void {
  const room = rooms.get(prId);
  if (!room) return;
  const entry = room.get(sessionId);
  if (entry) entry.lastSeen = Date.now();
}

/** Snapshot of all current users in a room (excluding stale sessions). */
export function getRoomUsers(prId: string): Array<PresenceUser & { sessionId: string }> {
  const room = rooms.get(prId);
  if (!room) return [];
  const now = Date.now();
  return Array.from(room.entries())
    .filter(([, u]) => now - u.lastSeen < STALE_THRESHOLD_MS)
    .map(([sessionId, u]) => ({ ...u, sessionId }));
}

/** Register a WebSocket connection for a session. */
export function registerSocket(prId: string, sessionId: string, ws: WsLike): void {
  getSockets(prId).set(sessionId, ws);
}

/** Remove a WebSocket registration for a session. */
export function unregisterSocket(prId: string, sessionId: string): void {
  const ss = sockets.get(prId);
  if (!ss) return;
  ss.delete(sessionId);
  if (ss.size === 0) sockets.delete(prId);
}

/**
 * Broadcast a JSON message to every connected WebSocket in a room.
 * If excludeSession is set, that session's socket is skipped (suppress echo).
 */
export function broadcastToRoom(
  prId: string,
  message: unknown,
  excludeSession?: string
): void {
  const ss = sockets.get(prId);
  if (!ss) return;
  const payload = JSON.stringify(message);
  for (const [sessionId, ws] of ss) {
    if (excludeSession && sessionId === excludeSession) continue;
    // 1 = OPEN
    if (ws.readyState !== undefined && ws.readyState !== 1) continue;
    try {
      ws.send(payload);
    } catch {
      // Stale socket — will be cleaned up by sweep or disconnect handler.
    }
  }
}

// ---------------------------------------------------------------------------
// Background sweep — evict stale sessions every 15 s
// ---------------------------------------------------------------------------

function sweep(): void {
  const now = Date.now();
  for (const [prId, room] of rooms) {
    for (const [sessionId, user] of room) {
      if (now - user.lastSeen >= STALE_THRESHOLD_MS) {
        // Notify room peers before evicting.
        broadcastToRoom(prId, { type: "leave", sessionId }, sessionId);
        room.delete(sessionId);
        const ss = sockets.get(prId);
        if (ss) ss.delete(sessionId);
      }
    }
    if (room.size === 0) rooms.delete(prId);
  }
}

// Start sweep loop — fire-and-forget, never throws.
const _sweepInterval = setInterval(sweep, SWEEP_INTERVAL_MS);
// Allow Bun/Node to exit cleanly even if this interval is live.
if (typeof _sweepInterval === "object" && _sweepInterval !== null) {
  (_sweepInterval as NodeJS.Timeout).unref?.();
}
