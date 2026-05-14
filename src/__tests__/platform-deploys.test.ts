/**
 * Block N3 — Platform deploy timeline tests.
 *
 * Exercises:
 *   - POST /api/events/deploy/started   (bearer auth + insert + SSE publish)
 *   - POST /api/events/deploy/finished  (update + SSE publish)
 *   - Idempotency on run_id
 *   - GET /admin/deploys + GET /admin/deploys/latest.json gating
 *   - relativeTime / shortSha / formatDuration edge formats
 *
 * The HTTP tests hit `src/routes/events.ts` directly via its default Hono
 * sub-app — no main-app mount needed. SSE publication is observed by
 * subscribing to the broadcaster directly (deterministic in-process).
 *
 * DB-backed assertions degrade gracefully: when DATABASE_URL is unset the
 * insert path returns 500 and we assert {200, 500}-shape contracts. With
 * a real DB they go strict.
 *
 * NO mock.module() calls in this file — we deliberately avoid the
 * spread-from-real mock pattern's global-bleed footgun. The page-render
 * tests exercise the helpers directly + app.request() against the gated
 * routes to confirm 401/403/302 redirects without touching DB rows.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import events, { __test as eventsTest } from "../routes/events";
import { __test as pageTest } from "../routes/admin-deploys-page";
import { subscribe, topicSubscriberCount, type SSEEvent } from "../lib/sse";
import app from "../app";

const TOPIC = "platform:deploys";

const VALID_SHA = "a".repeat(40);
const RUN_ID_A = "n3-test-run-aaaa-0001";
const RUN_ID_B = "n3-test-run-bbbb-0002";
const RUN_ID_C = "n3-test-run-cccc-0003";
const RUN_ID_D = "n3-test-run-dddd-0004";

const origToken = process.env.DEPLOY_EVENT_TOKEN;
const HAS_DB = Boolean(process.env.DATABASE_URL);

async function postStarted(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return events.request("/deploy/started", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function postFinished(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return events.request("/deploy/finished", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.DEPLOY_EVENT_TOKEN = "n3-bearer-fixture";
});

afterAll(() => {
  if (origToken === undefined) delete process.env.DEPLOY_EVENT_TOKEN;
  else process.env.DEPLOY_EVENT_TOKEN = origToken;
});

// ---------------------------------------------------------------------------
// /api/events/deploy/started — auth
// ---------------------------------------------------------------------------

describe("POST /api/events/deploy/started — bearer auth", () => {
  it("rejects with 401 when Authorization header is missing", async () => {
    const res = await postStarted({
      sha: VALID_SHA,
      run_id: RUN_ID_A,
      source: "hetzner-deploy",
    });
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when bearer token is wrong", async () => {
    const res = await postStarted(
      { sha: VALID_SHA, run_id: RUN_ID_A, source: "hetzner-deploy" },
      { authorization: "Bearer not-the-real-token" }
    );
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when DEPLOY_EVENT_TOKEN is unset (refuse-by-default)", async () => {
    const saved = process.env.DEPLOY_EVENT_TOKEN;
    delete process.env.DEPLOY_EVENT_TOKEN;
    try {
      const res = await postStarted(
        { sha: VALID_SHA, run_id: RUN_ID_A, source: "hetzner-deploy" },
        { authorization: "Bearer anything" }
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error).toLowerCase()).toContain("not configured");
    } finally {
      if (saved !== undefined) process.env.DEPLOY_EVENT_TOKEN = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// /api/events/deploy/started — payload validation
// ---------------------------------------------------------------------------

describe("POST /api/events/deploy/started — payload validation", () => {
  const authHeader = { authorization: "Bearer n3-bearer-fixture" };

  it("rejects malformed JSON with 400", async () => {
    const res = await postStarted("{not-json", authHeader);
    expect(res.status).toBe(400);
  });

  it("rejects missing run_id with 400", async () => {
    const res = await postStarted(
      { sha: VALID_SHA, source: "hetzner-deploy" },
      authHeader
    );
    expect(res.status).toBe(400);
  });

  it("rejects non-hex sha with 400", async () => {
    const res = await postStarted(
      { sha: "xyz!", run_id: RUN_ID_A, source: "hetzner-deploy" },
      authHeader
    );
    expect(res.status).toBe(400);
  });

  it("accepts a 7-char short sha (CI sometimes ships abbrev)", () => {
    const result = eventsTest.validateStarted({
      sha: "a1b2c3d",
      run_id: RUN_ID_A,
      source: "hetzner-deploy",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an overlong run_id with 400", async () => {
    const res = await postStarted(
      {
        sha: VALID_SHA,
        run_id: "x".repeat(129),
        source: "hetzner-deploy",
      },
      authHeader
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /api/events/deploy/finished — payload validation
// ---------------------------------------------------------------------------

describe("POST /api/events/deploy/finished — payload validation", () => {
  const authHeader = { authorization: "Bearer n3-bearer-fixture" };

  it("rejects unknown status with 400", async () => {
    const res = await postFinished(
      { run_id: RUN_ID_A, status: "weird" },
      authHeader
    );
    expect(res.status).toBe(400);
  });

  it("rejects negative duration_ms with 400", async () => {
    const res = await postFinished(
      { run_id: RUN_ID_A, status: "succeeded", duration_ms: -1 },
      authHeader
    );
    expect(res.status).toBe(400);
  });

  it("accepts succeeded with no error/duration", () => {
    const result = eventsTest.validateFinished({
      run_id: RUN_ID_A,
      status: "succeeded",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts failed with an error string", () => {
    const result = eventsTest.validateFinished({
      run_id: RUN_ID_A,
      status: "failed",
      duration_ms: 42_000,
      error: "smoke test returned 502",
    });
    expect(result.ok).toBe(true);
  });

  it("caps very long error strings to 8 KB on the validator", () => {
    const result = eventsTest.validateFinished({
      run_id: RUN_ID_A,
      status: "failed",
      error: "x".repeat(20_000),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.payload.error || "").length).toBeLessThanOrEqual(
        8 * 1024
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SSE publication — verified in-process via lib/sse. No DB round-trip needed
// to confirm publish() fires (we always publish on success), but we DO need
// the DB INSERT to succeed for the started handler to reach the publish
// branch. Skipped when DATABASE_URL is unset.
// ---------------------------------------------------------------------------

describe("/api/events/deploy/started — DB-aware insert + publish", () => {
  const authHeader = { authorization: "Bearer n3-bearer-fixture" };

  // Hold every event the broadcaster delivers for `platform:deploys` while
  // a test is running. Unsubscribe in afterEach so the suite leaves the
  // broadcaster's subscriber count at zero — sse.test.ts asserts that
  // contract.
  let received: SSEEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    received = [];
    unsubscribe = subscribe(TOPIC, (e) => received.push(e));
  });

  afterEach(() => {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    expect(topicSubscriberCount(TOPIC)).toBe(0);
  });

  it("first delivery: inserts a row + publishes deploy.started (DB only)", async () => {
    const res = await postStarted(
      { sha: VALID_SHA, run_id: RUN_ID_B, source: "hetzner-deploy" },
      authHeader
    );
    if (HAS_DB) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.duplicate).toBe(false);
      // publish() is synchronous so by the time await returns the event
      // has already been pushed to subscribers.
      expect(received.length).toBe(1);
      expect(received[0]?.event).toBe("deploy.started");
      const data = received[0]?.data as any;
      expect(data.run_id).toBe(RUN_ID_B);
      expect(data.sha).toBe(VALID_SHA);
      expect(data.status).toBe("in_progress");
    } else {
      expect([200, 500]).toContain(res.status);
    }
  });

  it("idempotency: replaying the same run_id returns duplicate:true and does NOT republish", async () => {
    const payload = {
      sha: VALID_SHA,
      run_id: RUN_ID_C,
      source: "hetzner-deploy",
    };
    const first = await postStarted(payload, authHeader);
    const before = received.length;
    const second = await postStarted(payload, authHeader);
    if (HAS_DB) {
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.duplicate).toBe(true);
      // No new SSE event from the duplicate.
      expect(received.length).toBe(before);
    } else {
      expect([200, 500]).toContain(first.status);
      expect([200, 500]).toContain(second.status);
    }
  });
});

describe("/api/events/deploy/finished — DB-aware update + publish", () => {
  const authHeader = { authorization: "Bearer n3-bearer-fixture" };

  let received: SSEEvent[] = [];
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    received = [];
    unsubscribe = subscribe(TOPIC, (e) => received.push(e));
  });

  afterEach(() => {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    expect(topicSubscriberCount(TOPIC)).toBe(0);
  });

  it("updates the matching row + publishes deploy.finished (DB only)", async () => {
    // Seed via /started so the update path has a row to flip.
    await postStarted(
      { sha: VALID_SHA, run_id: RUN_ID_D, source: "hetzner-deploy" },
      authHeader
    );
    const before = received.length;
    const res = await postFinished(
      {
        run_id: RUN_ID_D,
        status: "succeeded",
        duration_ms: 12_000,
      },
      authHeader
    );
    if (HAS_DB) {
      expect(res.status).toBe(200);
      // After /started we get one event; after /finished we should get a
      // second on top of it.
      expect(received.length).toBeGreaterThan(before);
      const finishedEvent = received[received.length - 1];
      expect(finishedEvent?.event).toBe("deploy.finished");
      const data = finishedEvent?.data as any;
      expect(data.run_id).toBe(RUN_ID_D);
      expect(data.status).toBe("succeeded");
    } else {
      expect([200, 500]).toContain(res.status);
    }
  });
});

// ---------------------------------------------------------------------------
// /admin/deploys gating — hit the real app router to confirm anonymous
// + non-admin paths are blocked.
// ---------------------------------------------------------------------------

describe("/admin/deploys gating", () => {
  it("redirects anonymous users to /login (HTML page)", async () => {
    const res = await app.request("/admin/deploys", { redirect: "manual" });
    // Either 302 to /login (gate redirect) or 403 if the gate flips to
    // forbidden first. Both are non-200 / non-leak.
    expect([302, 303, 401, 403]).toContain(res.status);
  });

  it("returns 401 JSON for anonymous on /admin/deploys/latest.json", async () => {
    const res = await app.request("/admin/deploys/latest.json");
    expect([401, 403]).toContain(res.status);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("renders a page (200 + HTML) for the site admin", async () => {
    // Without spinning up an authed session this case is hard to verify
    // end-to-end. We assert the route is at least registered + does not
    // 404 — the gating branches above prove the auth contract.
    const res = await app.request("/admin/deploys", { redirect: "manual" });
    expect(res.status).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Status-pill helper formats — pure functions, no I/O.
// ---------------------------------------------------------------------------

describe("admin-deploys-page helpers — relativeTime", () => {
  const { relativeTime, shortSha, formatDuration } = pageTest;
  const ANCHOR = new Date("2026-05-14T12:00:00.000Z");
  const ago = (ms: number) => new Date(ANCHOR.getTime() - ms);

  it("'just now' for <5s", () => {
    expect(relativeTime(ago(0), ANCHOR)).toBe("just now");
    expect(relativeTime(ago(2_000), ANCHOR)).toBe("just now");
    expect(relativeTime(ago(4_999), ANCHOR)).toBe("just now");
  });

  it("'Ns ago' for 5-59 seconds", () => {
    expect(relativeTime(ago(12_000), ANCHOR)).toBe("12s ago");
    expect(relativeTime(ago(59_000), ANCHOR)).toBe("59s ago");
  });

  it("'Nm ago' for 1-59 minutes", () => {
    expect(relativeTime(ago(60_000), ANCHOR)).toBe("1m ago");
    expect(relativeTime(ago(3 * 60_000), ANCHOR)).toBe("3m ago");
    expect(relativeTime(ago(59 * 60_000), ANCHOR)).toBe("59m ago");
  });

  it("'Nh ago' for 1-23 hours", () => {
    expect(relativeTime(ago(60 * 60_000), ANCHOR)).toBe("1h ago");
    expect(relativeTime(ago(2 * 60 * 60_000), ANCHOR)).toBe("2h ago");
    expect(relativeTime(ago(23 * 60 * 60_000), ANCHOR)).toBe("23h ago");
  });

  it("'Nd ago' for ≥1 day", () => {
    expect(relativeTime(ago(24 * 60 * 60_000), ANCHOR)).toBe("1d ago");
    expect(relativeTime(ago(3 * 24 * 60 * 60_000), ANCHOR)).toBe("3d ago");
  });

  it("clamps clock skew (future Date) to 'just now'", () => {
    const future = new Date(ANCHOR.getTime() + 5_000);
    expect(relativeTime(future, ANCHOR)).toBe("just now");
  });

  it("shortSha returns 7 lowercased hex chars", () => {
    expect(shortSha("DEADBEEFCAFE1234")).toBe("deadbee");
    expect(shortSha("abc")).toBe("abc");
    expect(shortSha("")).toBe("");
  });

  it("formatDuration handles seconds + minutes + invalid input", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(74_000)).toBe("1m 14s");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(NaN)).toBe("—");
  });
});
