/**
 * Unit tests for src/lib/sse.ts — the in-process pub/sub broadcaster.
 *
 * These tests exercise the pure module-level state. Because the registry is
 * a module-level `Map`, each test uses a unique topic name so cross-test
 * leakage is impossible; we also explicitly unsubscribe everything we
 * subscribe.
 */

import { describe, it, expect } from "bun:test";
import {
  publish,
  subscribe,
  topicSubscriberCount,
  type SSEEvent,
} from "../lib/sse";

describe("sse broadcaster", () => {
  it("publish with no subscribers is a no-op", () => {
    // No throw, no side effect. topicSubscriberCount stays zero.
    expect(() =>
      publish("repo:no-subs", { data: { hello: "world" } })
    ).not.toThrow();
    expect(topicSubscriberCount("repo:no-subs")).toBe(0);
  });

  it("a subscriber receives events published to its topic", () => {
    const received: SSEEvent[] = [];
    const unsub = subscribe("repo:alpha", (e) => received.push(e));

    expect(topicSubscriberCount("repo:alpha")).toBe(1);

    publish("repo:alpha", { event: "push", data: { sha: "deadbeef" } });
    publish("repo:alpha", { event: "star", data: { count: 7 }, id: "42" });

    expect(received).toHaveLength(2);
    expect(received[0]?.event).toBe("push");
    expect((received[0]?.data as any).sha).toBe("deadbeef");
    expect(received[1]?.id).toBe("42");

    unsub();
    expect(topicSubscriberCount("repo:alpha")).toBe(0);
  });

  it("multiple subscribers on the same topic all receive each event", () => {
    const a: SSEEvent[] = [];
    const b: SSEEvent[] = [];
    const c: SSEEvent[] = [];
    const unsubA = subscribe("pr:beta", (e) => a.push(e));
    const unsubB = subscribe("pr:beta", (e) => b.push(e));
    const unsubC = subscribe("pr:beta", (e) => c.push(e));

    expect(topicSubscriberCount("pr:beta")).toBe(3);

    publish("pr:beta", { event: "review", data: "submitted" });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(a[0]?.data).toBe("submitted");

    unsubA();
    unsubB();
    unsubC();
    expect(topicSubscriberCount("pr:beta")).toBe(0);
  });

  it("unsubscribe stops delivery for that handler only", () => {
    const keeper: SSEEvent[] = [];
    const leaver: SSEEvent[] = [];
    const unsubKeeper = subscribe("user:gamma", (e) => keeper.push(e));
    const unsubLeaver = subscribe("user:gamma", (e) => leaver.push(e));

    publish("user:gamma", { data: "first" });
    expect(keeper).toHaveLength(1);
    expect(leaver).toHaveLength(1);

    unsubLeaver();
    expect(topicSubscriberCount("user:gamma")).toBe(1);

    publish("user:gamma", { data: "second" });
    expect(keeper).toHaveLength(2);
    expect(leaver).toHaveLength(1); // unchanged — leaver is gone

    unsubKeeper();
    expect(topicSubscriberCount("user:gamma")).toBe(0);

    // Topic entry should be cleaned up after last unsubscribe.
    publish("user:gamma", { data: "third" });
    expect(keeper).toHaveLength(2);
  });

  it("a throwing handler does not prevent other handlers from receiving", () => {
    const good: SSEEvent[] = [];
    const unsubBad = subscribe("repo:delta", () => {
      throw new Error("boom");
    });
    const unsubGood = subscribe("repo:delta", (e) => good.push(e));

    expect(() =>
      publish("repo:delta", { data: "payload" })
    ).not.toThrow();
    expect(good).toHaveLength(1);

    unsubBad();
    unsubGood();
  });
});
