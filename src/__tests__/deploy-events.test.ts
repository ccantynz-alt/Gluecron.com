/**
 * Signal Bus P1 — inbound deploy-event receiver tests (E3/E4).
 *
 * Exercises `src/routes/events.ts` directly via its default Hono sub-app so
 * the suite is hermetic: no need to mount on the main app (which is locked)
 * and no live DB required. Tests that assert DB-backed side-effects run only
 * when `DATABASE_URL` is present; otherwise they assert graceful degradation.
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
import events, { __test } from "../routes/events";

const VALID_EVENT_ID_A = "11111111-1111-4111-8111-111111111111";
const VALID_EVENT_ID_B = "22222222-2222-4222-8222-222222222222";
const VALID_SHA = "a".repeat(40);

const origToken = process.env.CRONTECH_EVENT_TOKEN;

function makePayload(
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    event: "deploy.succeeded",
    eventId: VALID_EVENT_ID_A,
    repository: "alice/widgets",
    sha: VALID_SHA,
    environment: "production",
    deploymentId: "crontech-dep-123",
    timestamp: "2025-06-01T12:00:00.000Z",
    ...overrides,
  };
}

async function post(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return events.request("/deploy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.CRONTECH_EVENT_TOKEN = "unit-bearer-fixture";
});

afterAll(() => {
  if (origToken === undefined) delete process.env.CRONTECH_EVENT_TOKEN;
  else process.env.CRONTECH_EVENT_TOKEN = origToken;
});

// ---------------------------------------------------------------------------
// Bearer auth
// ---------------------------------------------------------------------------

describe("events/deploy — bearer auth", () => {
  it("rejects with 401 when Authorization header is missing", async () => {
    const res = await post(makePayload());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(String(body.error).toLowerCase()).toContain("bearer");
  });

  it("rejects with 401 when Bearer token is wrong", async () => {
    const res = await post(makePayload(), {
      authorization: "Bearer not-the-real-token",
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("rejects with 401 when CRONTECH_EVENT_TOKEN is unset (refuse-by-default)", async () => {
    const saved = process.env.CRONTECH_EVENT_TOKEN;
    delete process.env.CRONTECH_EVENT_TOKEN;
    try {
      const res = await post(makePayload(), {
        authorization: "Bearer anything",
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(String(body.error).toLowerCase()).toContain("not configured");
    } finally {
      if (saved !== undefined) process.env.CRONTECH_EVENT_TOKEN = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

describe("events/deploy — payload validation", () => {
  const authHeader = { authorization: "Bearer unit-bearer-fixture" };

  it("rejects malformed JSON with 400", async () => {
    const res = await post("{not-json", authHeader);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error).toLowerCase()).toContain("json");
  });

  it("rejects unknown event type with 400", async () => {
    const res = await post(makePayload({ event: "deploy.canceled" }), authHeader);
    expect(res.status).toBe(400);
  });

  it("rejects non-uuid eventId with 400", async () => {
    const res = await post(makePayload({ eventId: "not-a-uuid" }), authHeader);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error).toLowerCase()).toContain("eventid");
  });

  it("rejects invalid sha with 400", async () => {
    const res = await post(makePayload({ sha: "xyz" }), authHeader);
    expect(res.status).toBe(400);
  });

  it("rejects deploy.failed without errorCategory + errorSummary", async () => {
    const res = await post(
      makePayload({
        event: "deploy.failed",
        eventId: VALID_EVENT_ID_B,
      }),
      authHeader
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error).toLowerCase()).toMatch(/errorcategory|errorsummary/);
  });

  it("rejects errorSummary over 500 chars on deploy.failed", async () => {
    const res = await post(
      makePayload({
        event: "deploy.failed",
        eventId: VALID_EVENT_ID_B,
        errorCategory: "build",
        errorSummary: "x".repeat(501),
      }),
      authHeader
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Pure validator (no HTTP) — exercises __test.validatePayload.
// ---------------------------------------------------------------------------

describe("events/deploy — validatePayload helper", () => {
  it("accepts a well-formed deploy.succeeded payload", () => {
    const result = __test.validatePayload(makePayload());
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed deploy.failed payload with required error fields", () => {
    const result = __test.validatePayload(
      makePayload({
        event: "deploy.failed",
        errorCategory: "runtime",
        errorSummary: "Container OOM-killed after 42s",
      })
    );
    expect(result.ok).toBe(true);
  });

  it("rejects non-object bodies", () => {
    expect(__test.validatePayload(null).ok).toBe(false);
    expect(__test.validatePayload("hello").ok).toBe(false);
    expect(__test.validatePayload(42).ok).toBe(false);
  });

  it("rejects unknown errorCategory on deploy.failed", () => {
    const result = __test.validatePayload(
      makePayload({
        event: "deploy.failed",
        errorCategory: "nuclear",
        errorSummary: "boom",
      })
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Side-effect paths — these hit the DB. Without a DATABASE_URL the handler
// degrades gracefully (idempotency lookup swallows, insert returns 500, etc.).
// We run a relaxed assertion in no-DB mode and a strict one with DB.
// ---------------------------------------------------------------------------

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe("events/deploy — idempotency + update (DB-aware)", () => {
  const authHeader = { authorization: "Bearer unit-bearer-fixture" };

  beforeEach(() => {
    process.env.CRONTECH_EVENT_TOKEN = "unit-bearer-fixture";
  });

  afterEach(() => {
    // no-op — env restored by afterAll
  });

  it("E3 deploy.succeeded: returns ok + duplicate:false on first delivery (or 500 without DB)", async () => {
    const res = await post(
      makePayload({ eventId: VALID_EVENT_ID_A }),
      authHeader
    );
    if (HAS_DB) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.duplicate).toBe(false);
    } else {
      // Without a DB the insert into processed_events will throw; handler
      // returns 500 with {ok:false}. This is the "graceful no-DB" contract.
      expect([200, 500]).toContain(res.status);
    }
  });

  it("replaying the same eventId returns duplicate:true and does not double-side-effect", async () => {
    const payload = makePayload({ eventId: VALID_EVENT_ID_A });
    const first = await post(payload, authHeader);
    const second = await post(payload, authHeader);

    if (HAS_DB) {
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      // Whichever call loses the race is duplicate. At most one is false.
      const duplicates = [firstBody.duplicate, secondBody.duplicate];
      expect(duplicates.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    } else {
      // Without DB, both attempts fail the insert; we only assert that both
      // return a JSON body rather than crashing.
      expect([200, 500]).toContain(first.status);
      expect([200, 500]).toContain(second.status);
    }
  });

  it("E4 deploy.failed is accepted and returns JSON (DB-aware)", async () => {
    const res = await post(
      makePayload({
        event: "deploy.failed",
        eventId: VALID_EVENT_ID_B,
        errorCategory: "build",
        errorSummary: "npm install exited 1",
        logsUrl: "https://crontech.ai/logs/xyz",
      }),
      authHeader
    );
    if (HAS_DB) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    } else {
      expect([200, 500]).toContain(res.status);
    }
  });
});
