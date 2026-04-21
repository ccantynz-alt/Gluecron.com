/**
 * In-process topic-based pub/sub broadcaster for Server-Sent Events.
 *
 * Module-level `Map<topic, Set<handler>>`. `publish` iterates subscribers
 * synchronously (fire-and-forget). Handlers are expected not to throw — we
 * swallow exceptions defensively so one misbehaving subscriber cannot take
 * down the publisher or starve its peers.
 *
 * TODO(scale): this is deliberately single-process / in-memory. Horizontally
 * scaled deploys (multiple Bun instances behind a load balancer) will need
 * a cross-node fanout layer — likely Redis pub/sub or NATS — that feeds this
 * local broadcaster on each node. Until then, SSE subscribers only receive
 * events published by the same process handling their connection.
 */

export type SSEEvent = {
  event?: string;
  data: unknown;
  id?: string;
};

type Handler = (event: SSEEvent) => void;

const topics = new Map<string, Set<Handler>>();

/**
 * Publish an event to every subscriber of `topic`. No-op if the topic has
 * no subscribers. Handler exceptions are caught and swallowed so a single
 * broken subscriber cannot break fanout for its peers.
 */
export function publish(topic: string, event: SSEEvent): void {
  const subs = topics.get(topic);
  if (!subs || subs.size === 0) return;
  for (const handler of subs) {
    try {
      handler(event);
    } catch {
      // Swallow — handlers are fire-and-forget and must not disrupt fanout.
    }
  }
}

/**
 * Register a handler for `topic`. Returns a cleanup function that removes
 * the handler (and drops the topic's entry when its last subscriber leaves).
 */
export function subscribe(
  topic: string,
  handler: Handler
): () => void {
  let subs = topics.get(topic);
  if (!subs) {
    subs = new Set<Handler>();
    topics.set(topic, subs);
  }
  subs.add(handler);

  return () => {
    const current = topics.get(topic);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      topics.delete(topic);
    }
  };
}

/** Number of active subscribers on a topic (0 if unknown). */
export function topicSubscriberCount(topic: string): number {
  return topics.get(topic)?.size ?? 0;
}
