/**
 * Topic-based pub/sub broadcaster for Server-Sent Events.
 *
 * Two modes, selected at startup:
 *
 *   IN-MEMORY (no REDIS_URL set)
 *     Module-level `Map<topic, Set<handler>>`.  `publish` iterates
 *     subscribers synchronously (fire-and-forget).  Handlers are expected
 *     not to throw — we swallow exceptions defensively so one misbehaving
 *     subscriber cannot take down the publisher or starve its peers.
 *
 *   REDIS PUB/SUB (REDIS_URL is set)
 *     Two dedicated `Bun.RedisClient` instances — one for subscribing
 *     (which enters pub/sub mode and can't issue normal commands) and one
 *     for publishing.  Both are lazy-connected and auto-reconnect on
 *     disconnect via the built-in `autoReconnect` option.
 *
 *     Architecture on each server instance:
 *       • Local `topics` map tracks handlers just like the in-memory path.
 *       • When the first handler subscribes to a topic, the Redis subscriber
 *         client issues SUBSCRIBE for that channel.
 *       • When the last handler unsubscribes, UNSUBSCRIBE is issued.
 *       • Incoming Redis messages fan out to all local handlers via
 *         `localDeliver`.
 *       • `publish` serialises the event to JSON and calls PUBLISH on the
 *         publisher client.  It does NOT also call `localDeliver` — the
 *         Redis message that bounces back from the broker does that, so
 *         every instance (including the publisher) receives it exactly once
 *         through the subscriber path.
 *
 *     Error handling: Redis errors are caught and logged to stderr; they
 *     never throw into callers.  If Redis is temporarily unavailable,
 *     `publish` silently drops the cross-instance delivery (local handlers
 *     on the same instance still receive the event because `localDeliver`
 *     is always called, see NOTE below).
 *
 * NOTE on publish-with-no-Redis fallback:
 *   When REDIS_URL is set but the broker is unreachable at publish time,
 *   we fall back to local-only delivery so SSE streams on the same process
 *   are never broken.  This matches the in-memory semantics exactly on
 *   single-instance deploys and degrades gracefully on multi-instance ones.
 *
 * Public API (unchanged from the original in-memory implementation):
 *   publish(topic, event)   → void
 *   subscribe(topic, cb)    → () => void   (cleanup / unsubscribe)
 *   topicSubscriberCount(topic) → number
 */

export type SSEEvent = {
  event?: string;
  data: unknown;
  id?: string;
};

type Handler = (event: SSEEvent) => void;

// ---------------------------------------------------------------------------
// In-memory local state (shared by both modes)
// ---------------------------------------------------------------------------

const topics = new Map<string, Set<Handler>>();

/** Fan out an event to every local handler registered for `topic`. */
function localDeliver(topic: string, event: SSEEvent): void {
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

// ---------------------------------------------------------------------------
// Redis layer (only initialised when REDIS_URL is present)
// ---------------------------------------------------------------------------

/** True when REDIS_URL is configured and the Redis layer has been set up. */
let redisMode = false;

// Bun.RedisClient instances — typed loosely to avoid issues when running in
// environments where the Bun global is absent (e.g., pure Node test runners).
// We access them through the `Bun` global at runtime so no import is needed.
let redisPub: InstanceType<typeof Bun.RedisClient> | null = null;
let redisSub: InstanceType<typeof Bun.RedisClient> | null = null;

/** Redis channels (topics) the subscriber client is currently subscribed to. */
const redisSubscribed = new Set<string>();

/** Initialise the Redis pub and sub clients (called once, lazily). */
function initRedis(url: string): void {
  if (redisMode) return;
  redisMode = true;

  const opts = {
    autoReconnect: true,
    maxRetries: Infinity as unknown as number,
    enableOfflineQueue: true,
  };

  redisPub = new Bun.RedisClient(url, opts);
  redisSub = new Bun.RedisClient(url, opts);

  // Log disconnections to stderr but do not crash.
  redisPub.onclose = (err: Error) => {
    if (err) console.error("[sse] Redis pub connection closed:", err.message);
  };
  redisSub.onclose = (err: Error) => {
    if (err) console.error("[sse] Redis sub connection closed:", err.message);
  };

  // When the subscriber reconnects it must re-subscribe to all tracked
  // channels because Redis discards subscriptions on disconnect.
  redisSub.onconnect = function (this: InstanceType<typeof Bun.RedisClient>) {
    for (const ch of redisSubscribed) {
      this.subscribe(ch, redisMessageHandler).catch((e: unknown) => {
        console.error("[sse] Redis re-subscribe failed for", ch, e);
      });
    }
  };
}

/**
 * Called by the Redis subscriber client for every incoming message.
 * The `channel` is the topic name; `message` is a JSON-encoded SSEEvent.
 */
function redisMessageHandler(message: string, channel: string): void {
  try {
    const event = JSON.parse(message) as SSEEvent;
    localDeliver(channel, event);
  } catch {
    // Malformed payload — ignore.
  }
}

/**
 * Ensure the Redis subscriber is subscribed to `topic`.
 * Called when the first local handler registers for a topic.
 */
function redisEnsureSubscribed(topic: string): void {
  if (redisSubscribed.has(topic) || !redisSub) return;
  redisSubscribed.add(topic);
  redisSub.subscribe(topic, redisMessageHandler).catch((e: unknown) => {
    console.error("[sse] Redis subscribe failed for", topic, e);
  });
}

/**
 * Remove the Redis subscription for `topic` when the last local handler
 * leaves.  Silently ignored if not subscribed.
 */
function redisEnsureUnsubscribed(topic: string): void {
  if (!redisSubscribed.has(topic) || !redisSub) return;
  redisSubscribed.delete(topic);
  redisSub.unsubscribe(topic).catch((e: unknown) => {
    console.error("[sse] Redis unsubscribe failed for", topic, e);
  });
}

// ---------------------------------------------------------------------------
// Lazy Redis initialisation guard
// ---------------------------------------------------------------------------

let redisInitialised = false;

function maybeInitRedis(): void {
  if (redisInitialised) return;
  redisInitialised = true;
  const url = process.env.REDIS_URL || process.env.VALKEY_URL;
  if (url) {
    try {
      initRedis(url);
    } catch (e) {
      console.error("[sse] Failed to initialise Redis clients:", e);
      redisMode = false;
    }
  }
}

// Initialise eagerly at module load so reconnect logic is set up before the
// first request arrives.  The clients themselves are lazy-connected by Bun.
maybeInitRedis();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Publish an event to every subscriber of `topic`.
 *
 * In Redis mode the event is serialised to JSON and PUBLISH-ed to the Redis
 * channel; the subscriber client on every instance (including this one)
 * receives the message and fans it out to local handlers.  If Redis is
 * unavailable the event is delivered locally so SSE streams on this process
 * are never silently broken.
 *
 * In in-memory mode subscribers are called synchronously.
 */
export function publish(topic: string, event: SSEEvent): void {
  if (redisMode && redisPub) {
    const payload = JSON.stringify(event);
    redisPub.publish(topic, payload).catch((e: unknown) => {
      // Redis unavailable — fall back to local delivery so in-process SSE
      // streams remain functional on single-instance deploys.
      console.error("[sse] Redis publish failed, delivering locally:", e);
      localDeliver(topic, event);
    });
    // Do NOT call localDeliver here: the Redis subscriber path does it so
    // the publisher instance doesn't double-deliver.
    return;
  }
  // In-memory path.
  localDeliver(topic, event);
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
  const isFirst = subs.size === 0;
  subs.add(handler);

  // Ensure the Redis subscriber is tracking this channel.
  if (redisMode && isFirst) {
    redisEnsureSubscribed(topic);
  }

  return () => {
    const current = topics.get(topic);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      topics.delete(topic);
      // Release the Redis subscription when no local handlers remain.
      if (redisMode) {
        redisEnsureUnsubscribed(topic);
      }
    }
  };
}

/** Number of active subscribers on a topic (0 if unknown). */
export function topicSubscriberCount(topic: string): number {
  return topics.get(topic)?.size ?? 0;
}
