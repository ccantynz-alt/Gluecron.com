/**
 * SSE endpoint: `GET /live-events/:topic`.
 *
 * Topic format: `repo:{repoId}`, `pr:{prId}`, `user:{userId}`. The regex
 * `^[a-z]+:[a-zA-Z0-9\-]+$` is enforced; anything else is a 400.
 *
 * Auth / authorization:
 *   - Runs behind softAuth so we have the viewer (or null).
 *   - For `repo:{repoId}` topics, we do a cheap DB check that the viewer has
 *     read access via `resolveRepoAccess`. `pr:` and `user:` topics currently
 *     only require a valid topic string — when we add PR-level privacy we'll
 *     extend this handler in place.
 *
 * Transport:
 *   - `text/event-stream` with keep-alive + nginx-friendly `X-Accel-Buffering`.
 *   - We write `id:` / `event:` / `data:` blocks per SSEEvent and send a
 *     `: ping` comment every 25s to keep intermediaries from timing out.
 *   - On stream close we unsubscribe and clear the heartbeat timer.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { db } from "../db";
import { repositories } from "../db/schema";
import { resolveRepoAccess, satisfiesAccess } from "../middleware/repo-access";
import { subscribe, type SSEEvent } from "../lib/sse";

const app = new Hono<AuthEnv>();

/**
 * Topic shape — `kind:id(:segment)*`. The first colon separates the kind
 * (lowercase, used for the read-gate dispatch) from the id; subsequent
 * colon-segments are scoping suffixes the publisher chose, e.g.
 * `repo:<uuid>:issue:7`. Each segment is alphanumerics + dash so the
 * URL path stays predictable.
 */
const TOPIC_RE = /^[a-z]+:[a-zA-Z0-9\-]+(?::[a-zA-Z0-9\-]+)*$/;
const HEARTBEAT_MS = 25_000;

app.get("/live-events/:topic", softAuth, async (c) => {
  const topic = c.req.param("topic");
  if (!topic || !TOPIC_RE.test(topic)) {
    return c.json({ error: "Invalid topic" }, 400);
  }

  const user = c.get("user") ?? null;
  // Topic is `kind:primaryId(:scope)*`. Slice on the first two colons so a
  // multi-segment topic like `repo:<uuid>:issue:7` resolves to
  //   kind = "repo", primaryId = "<uuid>"
  // and the trailing `:issue:7` is treated as scoping that the publisher
  // chose (the broadcaster is keyed on the full topic string, so the suffix
  // is preserved across publish/subscribe).
  const firstColon = topic.indexOf(":");
  const secondColon = topic.indexOf(":", firstColon + 1);
  const kind = topic.slice(0, firstColon);
  const primaryId =
    secondColon === -1
      ? topic.slice(firstColon + 1)
      : topic.slice(firstColon + 1, secondColon);

  // For repo topics, gate on read access. Other topic kinds pass through.
  if (kind === "repo") {
    try {
      const [repo] = await db
        .select({ id: repositories.id, isPrivate: repositories.isPrivate })
        .from(repositories)
        .where(eq(repositories.id, primaryId))
        .limit(1);

      if (!repo) {
        return c.json({ error: "Not found" }, 404);
      }

      const access = await resolveRepoAccess({
        repoId: repo.id,
        userId: user?.id ?? null,
        isPublic: !repo.isPrivate,
      });

      if (!satisfiesAccess(access, "read")) {
        return c.json({ error: "Forbidden" }, 403);
      }
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed — mark local state so we stop trying.
          closed = true;
        }
      };

      // Initial comment flushes headers on some proxies.
      safeEnqueue(": open\n\n");

      const unsubscribe = subscribe(topic, (event: SSEEvent) => {
        let payload = "";
        if (event.id !== undefined) payload += `id: ${event.id}\n`;
        if (event.event !== undefined) payload += `event: ${event.event}\n`;
        const data =
          typeof event.data === "string"
            ? event.data
            : JSON.stringify(event.data);
        // SSE `data:` lines must not contain raw newlines — split if present.
        for (const line of data.split("\n")) {
          payload += `data: ${line}\n`;
        }
        payload += "\n";
        safeEnqueue(payload);
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(": ping\n\n");
      }, HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed — nothing to do.
        }
      };

      // Client-side abort (navigation, tab close) surfaces via the request's
      // AbortSignal. Bun's fetch-style request exposes this on `c.req.raw`.
      const signal = c.req.raw.signal;
      if (signal) {
        if (signal.aborted) {
          cleanup();
        } else {
          signal.addEventListener("abort", cleanup, { once: true });
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

export default app;
