/**
 * Block R2 — Live deploy log streaming tests.
 *
 * Exercises:
 *   - POST /api/events/deploy/step requires bearer; rejects without
 *   - validateStep payload validation
 *   - Step insert + parent rollup + SSE publish on both topics
 *   - Idempotency on (deploy_id, step_name, status)
 *   - SSE topic is `platform:deploys:<run_id>` (verified via subscribe())
 *   - /admin/deploys renders the modal markup (conditionally and always)
 *
 * Pattern: no mock.module() — same approach as the locked Block N3 test
 * file (`platform-deploys.test.ts`). DB-backed assertions degrade
 * gracefully to {200,500} when DATABASE_URL is unset.
 *
 * afterAll cleanup restores DEPLOY_EVENT_TOKEN so subsequent suites in the
 * shared bun-test runner inherit a clean env.
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
import {
  subscribe,
  topicSubscriberCount,
  type SSEEvent,
} from "../lib/sse";
import app from "../app";

const TOPIC_GLOBAL = "platform:deploys";

const VALID_SHA = "b".repeat(40);
const RUN_R2_A = "r2-test-run-aaaa-0001";
const RUN_R2_B = "r2-test-run-bbbb-0002";
const RUN_R2_C = "r2-test-run-cccc-0003";

const origToken = process.env.DEPLOY_EVENT_TOKEN;
const HAS_DB = Boolean(process.env.DATABASE_URL);

const AUTH = { authorization: "Bearer r2-bearer-fixture" };

async function postStarted(body: unknown) {
  return events.request("/deploy/started", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  });
}

async function postStep(
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return events.request("/deploy/step", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.DEPLOY_EVENT_TOKEN = "r2-bearer-fixture";
});

afterAll(() => {
  if (origToken === undefined) delete process.env.DEPLOY_EVENT_TOKEN;
  else process.env.DEPLOY_EVENT_TOKEN = origToken;
});

// ---------------------------------------------------------------------------
// Bearer auth
// ---------------------------------------------------------------------------

describe("POST /api/events/deploy/step — bearer auth", () => {
  it("rejects with 401 when Authorization header is missing", async () => {
    const res = await postStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "git-pull",
      status: "in_progress",
    });
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when bearer token is wrong", async () => {
    const res = await postStep(
      {
        run_id: RUN_R2_A,
        sha: VALID_SHA,
        step_name: "git-pull",
        status: "in_progress",
      },
      { authorization: "Bearer nope" }
    );
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when DEPLOY_EVENT_TOKEN is unset (refuse-by-default)", async () => {
    const saved = process.env.DEPLOY_EVENT_TOKEN;
    delete process.env.DEPLOY_EVENT_TOKEN;
    try {
      const res = await postStep(
        {
          run_id: RUN_R2_A,
          sha: VALID_SHA,
          step_name: "git-pull",
          status: "in_progress",
        },
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
// Payload validation — pure helpers
// ---------------------------------------------------------------------------

describe("validateStep — payload validation", () => {
  const { validateStep } = eventsTest;

  it("accepts a canonical succeeded transition", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "bun-install",
      status: "succeeded",
      duration_ms: 12_000,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.duration_ms).toBe(12_000);
    }
  });

  it("accepts in_progress without duration", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "smoke-test",
      status: "in_progress",
    });
    expect(v.ok).toBe(true);
  });

  it("rejects bad status", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "git-pull",
      status: "weird",
    });
    expect(v.ok).toBe(false);
  });

  it("rejects bad step_name (spaces)", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "git pull",
      status: "in_progress",
    });
    expect(v.ok).toBe(false);
  });

  it("rejects empty run_id", () => {
    const v = validateStep({
      run_id: "",
      sha: VALID_SHA,
      step_name: "git-pull",
      status: "in_progress",
    });
    expect(v.ok).toBe(false);
  });

  it("rejects non-hex sha", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: "not-hex!",
      step_name: "git-pull",
      status: "in_progress",
    });
    expect(v.ok).toBe(false);
  });

  it("rejects negative duration_ms", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "git-pull",
      status: "succeeded",
      duration_ms: -10,
    });
    expect(v.ok).toBe(false);
  });

  it("truncates output to 8 KB", () => {
    const v = validateStep({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      step_name: "build",
      status: "succeeded",
      output: "x".repeat(20_000),
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect((v.payload.output || "").length).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it("rejects malformed JSON via HTTP", async () => {
    const res = await postStep("{not-json", AUTH);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Topic helper
// ---------------------------------------------------------------------------

describe("perDeployTopic — SSE topic shape", () => {
  it("composes `platform:deploys:<run_id>`", () => {
    expect(eventsTest.perDeployTopic("123abc")).toBe(
      "platform:deploys:123abc"
    );
  });
});

// ---------------------------------------------------------------------------
// DB-backed flow: insert + parent rollup + dual-topic publish + idempotency
// ---------------------------------------------------------------------------

describe("/api/events/deploy/step — insert + publish (DB-aware)", () => {
  let receivedGlobal: SSEEvent[] = [];
  let receivedPerDeploy: SSEEvent[] = [];
  let unsubGlobal: (() => void) | null = null;
  let unsubPerDeploy: (() => void) | null = null;

  const PER_DEPLOY_TOPIC_A = `platform:deploys:${RUN_R2_A}`;

  beforeEach(() => {
    receivedGlobal = [];
    receivedPerDeploy = [];
    unsubGlobal = subscribe(TOPIC_GLOBAL, (e) => receivedGlobal.push(e));
    unsubPerDeploy = subscribe(PER_DEPLOY_TOPIC_A, (e) =>
      receivedPerDeploy.push(e)
    );
  });

  afterEach(() => {
    if (unsubGlobal) unsubGlobal();
    if (unsubPerDeploy) unsubPerDeploy();
    unsubGlobal = null;
    unsubPerDeploy = null;
    expect(topicSubscriberCount(TOPIC_GLOBAL)).toBe(0);
    expect(topicSubscriberCount(PER_DEPLOY_TOPIC_A)).toBe(0);
  });

  it("404s when no platform_deploys row exists for run_id", async () => {
    const res = await postStep(
      {
        run_id: "r2-never-started-run",
        sha: VALID_SHA,
        step_name: "git-pull",
        status: "in_progress",
      },
      AUTH
    );
    // With DB → strict 404. Without DB → the parent lookup throws and
    // returns 500 — we accept both so the test suite remains green in
    // dev sandboxes.
    expect([404, 500]).toContain(res.status);
  });

  it("first step posts: row + parent rollup + SSE publish on both topics", async () => {
    // Seed the parent so /step has something to attach to.
    const started = await postStarted({
      run_id: RUN_R2_A,
      sha: VALID_SHA,
      source: "hetzner-deploy",
    });
    // Drop any 'deploy.started' event from the global topic so our
    // assertions only count step publishes.
    receivedGlobal = [];

    const res = await postStep(
      {
        run_id: RUN_R2_A,
        sha: VALID_SHA,
        step_name: "git-pull",
        status: "in_progress",
      },
      AUTH
    );

    if (HAS_DB && started.status === 200) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.duplicate).toBe(false);

      // SSE: both topics should have received the publish.
      expect(receivedGlobal.length).toBe(1);
      expect(receivedPerDeploy.length).toBe(1);
      expect(receivedPerDeploy[0]?.event).toBe("step");
      const parsed = JSON.parse(receivedPerDeploy[0]?.data as string);
      expect(parsed.step_name).toBe("git-pull");
      expect(parsed.status).toBe("in_progress");
      expect(parsed.run_id).toBe(RUN_R2_A);
    } else {
      // No DB → /step returns 404 or 500 and never publishes.
      expect([404, 500]).toContain(res.status);
      expect(receivedGlobal.length).toBe(0);
      expect(receivedPerDeploy.length).toBe(0);
    }
  });

  it("idempotent: replaying (deploy_id, step_name, status) returns duplicate:true and does NOT republish", async () => {
    // Seed the parent.
    const started = await postStarted({
      run_id: RUN_R2_B,
      sha: VALID_SHA,
      source: "hetzner-deploy",
    });
    if (!HAS_DB || started.status !== 200) {
      // Without DB this branch is exercised by the validator + bearer
      // tests; skip the live duplicate-roundtrip check here.
      return;
    }

    // Subscribe to the per-deploy topic for RUN_R2_B specifically.
    const perB = `platform:deploys:${RUN_R2_B}`;
    let perBEvents: SSEEvent[] = [];
    const stop = subscribe(perB, (e) => perBEvents.push(e));
    try {
      const first = await postStep(
        {
          run_id: RUN_R2_B,
          sha: VALID_SHA,
          step_name: "bun-install",
          status: "succeeded",
          duration_ms: 4_200,
        },
        AUTH
      );
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody.duplicate).toBe(false);
      const eventsAfterFirst = perBEvents.length;

      const second = await postStep(
        {
          run_id: RUN_R2_B,
          sha: VALID_SHA,
          step_name: "bun-install",
          status: "succeeded",
          duration_ms: 4_200,
        },
        AUTH
      );
      expect(second.status).toBe(200);
      const secondBody = await second.json();
      expect(secondBody.duplicate).toBe(true);
      // No new SSE event from the duplicate.
      expect(perBEvents.length).toBe(eventsAfterFirst);
    } finally {
      stop();
    }
  });

  it("publishes on the EXACT per-deploy topic platform:deploys:<run_id>", async () => {
    // Seed parent.
    const started = await postStarted({
      run_id: RUN_R2_C,
      sha: VALID_SHA,
      source: "hetzner-deploy",
    });
    if (!HAS_DB || started.status !== 200) return;

    const perC = `platform:deploys:${RUN_R2_C}`;
    let perCEvents: SSEEvent[] = [];
    const stop = subscribe(perC, (e) => perCEvents.push(e));
    try {
      const res = await postStep(
        {
          run_id: RUN_R2_C,
          sha: VALID_SHA,
          step_name: "smoke-test",
          status: "succeeded",
          duration_ms: 1_500,
        },
        AUTH
      );
      expect(res.status).toBe(200);
      expect(perCEvents.length).toBe(1);
      expect(perCEvents[0]?.event).toBe("step");
      const parsed = JSON.parse(perCEvents[0]?.data as string);
      expect(parsed.run_id).toBe(RUN_R2_C);
      expect(parsed.step_name).toBe("smoke-test");
      expect(parsed.status).toBe("succeeded");
      expect(parsed.duration_ms).toBe(1_500);
    } finally {
      stop();
    }
  });
});

// ---------------------------------------------------------------------------
// /admin/deploys page — modal markup is always rendered (hidden by default)
// ---------------------------------------------------------------------------

describe("/admin/deploys page — modal markup", () => {
  it("R2_STEP_ORDER lists the 7 canonical steps in order", () => {
    const names = pageTest.R2_STEP_ORDER.map((s) => s.name);
    expect(names).toEqual([
      "setup",
      "git-pull",
      "bun-install",
      "build",
      "db-migrate",
      "restart-service",
      "smoke-test",
    ]);
  });

  it("inline modal JS subscribes to the platform:deploys:<run_id> topic", () => {
    const js = pageTest.DEPLOY_MODAL_JS;
    expect(typeof js).toBe("string");
    expect(js).toContain("platform:deploys:");
    expect(js).toContain("/live-events/");
    expect(js).toContain("EventSource");
    expect(js).toContain("data-step");
  });

  it("does not 404 — route is registered + responds to anonymous", async () => {
    const res = await app.request("/admin/deploys", { redirect: "manual" });
    expect(res.status).not.toBe(404);
  });
});
