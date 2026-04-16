/**
 * SSE event stream routes — real-time updates for gate runs, PRs, and notifications.
 *
 * GET /api/events/stream?channels=gate:repoId,pr:prId,notification
 */

import { Hono } from "hono";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { createSSEStream, getActiveConnections } from "../lib/sse";

const events = new Hono<AuthEnv>();

events.get("/api/events/stream", softAuth, (c) => {
  const user = c.get("user");
  const channelParam = c.req.query("channels") || "";
  const requestedChannels = channelParam
    .split(",")
    .map((ch) => ch.trim())
    .filter(Boolean);

  if (requestedChannels.length === 0) {
    return c.json({ error: "No channels specified" }, 400);
  }

  // Auto-add user-specific notification channel if authenticated
  const channels = [...requestedChannels];
  if (user && !channels.some((ch) => ch.startsWith("notification"))) {
    channels.push(`notification:${user.id}`);
  }

  return createSSEStream(channels, user?.id);
});

events.get("/api/events/health", (c) => {
  return c.json({ connections: getActiveConnections() });
});

export default events;
