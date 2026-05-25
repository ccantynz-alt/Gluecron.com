/**
 * Live co-editing transport — SSE stream + REST control plane.
 *
 *   GET  /api/v2/pulls/:prId/live
 *     SSE feed of presence + cursor + edit events for one PR. Auto-
 *     joins on connect (if authed) and auto-leaves on stream close.
 *
 *   POST /api/v2/pulls/:prId/live/cursor
 *     { sessionId, position } — broadcast a cursor move.
 *
 *   POST /api/v2/pulls/:prId/live/edit
 *     { sessionId, patch } — broadcast a content patch.
 *
 *   POST /api/v2/pulls/:prId/live/heartbeat
 *     { sessionId } — keep-alive ping.
 *
 *   POST /api/v2/pulls/:prId/live/leave
 *     { sessionId } — explicit leave (the browser also fires this on
 *     `beforeunload` via sendBeacon).
 *
 * Unauthed connections still receive the SSE feed (so anonymous repo
 * viewers see presence), but the POST control plane requires auth.
 * Agent tokens (`agt_*`) are accepted via the optional `?agent=1`
 * query string + Authorization header path — left to the writeup;
 * v1 wires humans only and falls back gracefully on missing principal.
 */

import { Hono } from "hono";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { subscribe, type SSEEvent } from "../lib/sse";
import {
  joinSession,
  leaveSession,
  updateCursor,
  heartbeat,
  broadcastEdit,
  listLive,
  prLiveTopic,
  type CursorPosition,
  type EditPatch,
} from "../lib/pr-live";

const app = new Hono<AuthEnv>();

// SSE heartbeat from the server side (separate from client-side
// heartbeat broadcasts). Keeps intermediaries from idle-timing the
// connection.
const SSE_PING_MS = 25_000;

/** Strict UUID-ish guard (we don't lock to a specific RFC variant). */
const ID_RE = /^[a-zA-Z0-9\-]{1,64}$/;

app.get("/api/v2/pulls/:prId/live", softAuth, async (c) => {
  const prId = c.req.param("prId");
  if (!prId || !ID_RE.test(prId)) {
    return c.json({ error: "Invalid pr id" }, 400);
  }

  const user = c.get("user") ?? null;
  const topic = prLiveTopic(prId);

  // Auto-join — only humans for v1; agents will get an explicit
  // POST /join endpoint when the harness wants them on the stream.
  let sessionId: string | null = null;
  let sessionColor: string | null = null;
  if (user) {
    const joined = await joinSession({ prId, userId: user.id });
    if (joined) {
      sessionId = joined.sessionId;
      sessionColor = joined.color;
    }
  }

  // Snapshot of current presence — sent as the first event so the
  // client can render avatars without an extra round-trip.
  const presence = await listLive(prId);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const sendEvent = (event: SSEEvent) => {
        let payload = "";
        if (event.id !== undefined) payload += `id: ${event.id}\n`;
        if (event.event !== undefined) payload += `event: ${event.event}\n`;
        const data =
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data);
        for (const line of data.split("\n")) {
          payload += `data: ${line}\n`;
        }
        payload += "\n";
        safeEnqueue(payload);
      };

      // Flush headers on proxies that buffer.
      safeEnqueue(": open\n\n");

      // Initial "hello" with the snapshot + the joined session id (so
      // the client knows which row is theirs and can suppress echo
      // events from itself).
      sendEvent({
        event: "hello",
        data: {
          sessionId,
          color: sessionColor,
          presence,
        },
      });

      const unsubscribe = subscribe(topic, sendEvent);

      const ping = setInterval(() => {
        safeEnqueue(": ping\n\n");
      }, SSE_PING_MS);

      const cleanup = async () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        if (sessionId) {
          // Fire-and-forget. The autopilot sweep is the durable
          // fallback if this never runs (process crash).
          try {
            await leaveSession(sessionId, prId);
          } catch {
            /* best-effort */
          }
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const signal = c.req.raw.signal;
      if (signal) {
        if (signal.aborted) {
          void cleanup();
        } else {
          signal.addEventListener("abort", () => void cleanup(), { once: true });
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ---------- Control plane ----------

async function parseJsonBody(c: import("hono").Context): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

app.post("/api/v2/pulls/:prId/live/cursor", softAuth, async (c) => {
  const prId = c.req.param("prId");
  if (!prId || !ID_RE.test(prId)) return c.json({ error: "Invalid pr id" }, 400);
  const body = await parseJsonBody(c);
  const sessionId = String(body?.sessionId || "");
  const position = body?.position as CursorPosition | undefined;
  if (!sessionId || !position || typeof position.field !== "string") {
    return c.json({ error: "Invalid body" }, 400);
  }
  await updateCursor(sessionId, prId, position);
  return c.json({ ok: true });
});

app.post("/api/v2/pulls/:prId/live/edit", softAuth, async (c) => {
  const prId = c.req.param("prId");
  if (!prId || !ID_RE.test(prId)) return c.json({ error: "Invalid pr id" }, 400);
  const body = await parseJsonBody(c);
  const sessionId = String(body?.sessionId || "");
  const patch = body?.patch as EditPatch | undefined;
  if (!sessionId || !patch || typeof patch.field !== "string") {
    return c.json({ error: "Invalid body" }, 400);
  }
  await broadcastEdit(sessionId, prId, patch);
  return c.json({ ok: true });
});

app.post("/api/v2/pulls/:prId/live/heartbeat", softAuth, async (c) => {
  const prId = c.req.param("prId");
  if (!prId || !ID_RE.test(prId)) return c.json({ error: "Invalid pr id" }, 400);
  const body = await parseJsonBody(c);
  const sessionId = String(body?.sessionId || "");
  if (!sessionId) return c.json({ error: "Invalid body" }, 400);
  await heartbeat(sessionId, prId);
  return c.json({ ok: true });
});

app.post("/api/v2/pulls/:prId/live/leave", softAuth, async (c) => {
  const prId = c.req.param("prId");
  if (!prId || !ID_RE.test(prId)) return c.json({ error: "Invalid pr id" }, 400);
  // Accept JSON body OR a sendBeacon Blob — sendBeacon sets
  // content-type to text/plain;charset=UTF-8 by default. Try JSON
  // first, fall back to reading raw text and parsing it.
  let body = await parseJsonBody(c);
  if (!body) {
    try {
      const raw = await c.req.text();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
  }
  const sessionId = String(body?.sessionId || "");
  if (!sessionId) return c.json({ error: "Invalid body" }, 400);
  await leaveSession(sessionId, prId);
  return c.json({ ok: true });
});

export default app;
