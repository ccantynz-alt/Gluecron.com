/**
 * Server-Sent Events (SSE) infrastructure.
 *
 * Manages live connections so gate runs, notifications, and CI updates
 * stream to the browser in real time instead of requiring page refreshes.
 */

type SSEChannel = "gate" | "notification" | "pr" | "ci";

interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController;
  userId?: string;
  channels: Set<string>; // e.g. "gate:repoId", "pr:prId", "notification:userId"
  connectedAt: number;
}

const clients = new Map<string, SSEClient>();

let clientIdCounter = 0;

function nextClientId(): string {
  return `sse_${++clientIdCounter}_${Date.now().toString(36)}`;
}

/**
 * Create an SSE Response for a Hono handler.
 * The caller subscribes to channels, and this function returns a streaming Response.
 */
export function createSSEStream(
  channels: string[],
  userId?: string
): Response {
  const clientId = nextClientId();

  const stream = new ReadableStream({
    start(controller) {
      const client: SSEClient = {
        id: clientId,
        controller,
        userId,
        channels: new Set(channels),
        connectedAt: Date.now(),
      };
      clients.set(clientId, client);

      // Send initial connection event
      const data = `event: connected\ndata: ${JSON.stringify({ clientId, channels })}\n\n`;
      controller.enqueue(new TextEncoder().encode(data));
    },
    cancel() {
      clients.delete(clientId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Broadcast an event to all clients subscribed to a channel.
 */
export function broadcast(
  channel: string,
  event: string,
  data: unknown
): number {
  const encoded = new TextEncoder();
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const bytes = encoded.encode(payload);
  let sent = 0;

  for (const [id, client] of clients) {
    if (client.channels.has(channel)) {
      try {
        client.controller.enqueue(bytes);
        sent++;
      } catch {
        clients.delete(id);
      }
    }
  }

  return sent;
}

/**
 * Send an event to a specific user (by userId) across all their connections.
 */
export function sendToUser(
  userId: string,
  event: string,
  data: unknown
): number {
  const encoded = new TextEncoder();
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const bytes = encoded.encode(payload);
  let sent = 0;

  for (const [id, client] of clients) {
    if (client.userId === userId) {
      try {
        client.controller.enqueue(bytes);
        sent++;
      } catch {
        clients.delete(id);
      }
    }
  }

  return sent;
}

/**
 * Get active connection count (for monitoring).
 */
export function getActiveConnections(): number {
  return clients.size;
}

/**
 * Clean up stale connections (call periodically).
 */
export function cleanupStaleConnections(maxAgeMs = 30 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  for (const [id, client] of clients) {
    if (client.connectedAt < cutoff) {
      try {
        client.controller.close();
      } catch {}
      clients.delete(id);
      removed++;
    }
  }

  return removed;
}

// Periodic cleanup every 5 minutes
setInterval(() => cleanupStaleConnections(), 5 * 60 * 1000);
