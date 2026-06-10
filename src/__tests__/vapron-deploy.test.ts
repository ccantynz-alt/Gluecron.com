/**
 * BLK-016 — Vapron deploy webhook sender.
 *
 * Asserts that `triggerVapronDeploy` (in `src/hooks/post-receive.ts`)
 * matches the wire contract documented at the top of that helper, which
 * is the inbound contract for Vapron's
 * `apps/api/src/webhooks/gluecron-push.ts` receiver:
 *
 *   POST  https://vapron.ai/api/webhooks/gluecron-push
 *   Content-Type: application/json
 *   X-Gluecron-Signature: sha256=<hex(hmac-sha256(body, secret))>
 *
 *   body = {
 *     event: "push",
 *     repository: { full_name },
 *     ref, after, before,
 *     pusher: { name, email },
 *     commits: [...]
 *   }
 *
 * Plus at-least-once delivery: 5 attempts on 5xx with exponential backoff,
 * stop on first 2xx or unrecoverable 4xx.
 *
 * The helper swallows DB errors, so these tests work without a real DB.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "crypto";
import { __test } from "../hooks/post-receive";
import { config } from "../lib/config";

const { triggerVapronDeploy, signBody } = __test;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

const origSecret = process.env.GLUECRON_WEBHOOK_SECRET;
const origUrl = process.env.VAPRON_DEPLOY_URL;
const origRepo = process.env.VAPRON_REPO;

const NULL_REPO_ID = "00000000-0000-0000-0000-000000000000";
const ZERO_SHA = "0000000000000000000000000000000000000000";

function makeArgs(overrides: Partial<{
  owner: string;
  repo: string;
  before: string;
  after: string;
  ref: string;
  branch: string;
  repositoryId: string;
}> = {}) {
  return {
    owner: "ccantynz-alt",
    repo: "vapron",
    before: ZERO_SHA,
    after: "a".repeat(40),
    ref: "refs/heads/Main",
    branch: "Main",
    repositoryId: NULL_REPO_ID,
    ...overrides,
  };
}

function captureFetch(
  responder: (callIdx: number) => Response | Promise<Response> = () =>
    new Response(
      JSON.stringify({ ok: true, deploymentId: "d1" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
): { calls: CapturedCall[]; fn: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fn = (async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    const i = calls.length;
    calls.push({ url: String(input), init });
    return responder(i);
  }) as unknown as typeof fetch;
  return { calls, fn };
}

const noSleep = async (_ms: number) => {};

describe("hooks/post-receive — signBody", () => {
  it("returns null when no secret", () => {
    expect(signBody("any body", "")).toBeNull();
  });

  it("produces sha256=<hex hmac>", () => {
    const body = '{"event":"push"}';
    const secret = "topsecret";
    const expected =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(signBody(body, secret)).toBe(expected);
  });

  it("is deterministic for the same input", () => {
    const a = signBody("body", "k");
    const b = signBody("body", "k");
    expect(a).toBe(b);
  });

  it("changes when the body changes", () => {
    const a = signBody("body1", "k");
    const b = signBody("body2", "k");
    expect(a).not.toBe(b);
  });
});

describe("hooks/post-receive — triggerVapronDeploy (BLK-016 sender)", () => {
  beforeEach(() => {
    delete process.env.GLUECRON_WEBHOOK_SECRET;
    delete process.env.VAPRON_DEPLOY_URL;
    delete process.env.VAPRON_REPO;
    delete process.env.VAPRON_HMAC_SECRET;
    // legacy names must not leak into the default-URL assertions
    delete process.env.CRONTECH_DEPLOY_URL;
    delete process.env.CRONTECH_REPO;
    delete process.env.CRONTECH_HMAC_SECRET;
  });

  afterEach(() => {
    if (origSecret === undefined) delete process.env.GLUECRON_WEBHOOK_SECRET;
    else process.env.GLUECRON_WEBHOOK_SECRET = origSecret;
    if (origUrl === undefined) delete process.env.VAPRON_DEPLOY_URL;
    else process.env.VAPRON_DEPLOY_URL = origUrl;
    if (origRepo === undefined) delete process.env.VAPRON_REPO;
    else process.env.VAPRON_REPO = origRepo;
  });

  it("is exported from __test", () => {
    expect(typeof triggerVapronDeploy).toBe("function");
  });

  it("POSTs to /api/webhooks/gluecron-push (matches Vapron receiver path)", async () => {
    const { calls, fn } = captureFetch();

    await triggerVapronDeploy(makeArgs(), { fetchImpl: fn, sleep: noSleep });

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://vapron.ai/api/webhooks/gluecron-push"
    );
    expect(calls[0]!.url).not.toContain("/api/hooks/gluecron/push");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("posts a GitHub-shaped push payload (event, repository, ref, before/after, pusher, commits, sent_at, source)", async () => {
    const after = "b".repeat(40);
    const before = "c".repeat(40);
    const { calls, fn } = captureFetch();

    await triggerVapronDeploy(
      makeArgs({
        owner: "acme",
        repo: "api",
        after,
        before,
        ref: "refs/heads/Main",
        branch: "Main",
      }),
      { fetchImpl: fn, sleep: noSleep }
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.event).toBe("push");
    expect(body.repository).toEqual({ full_name: "acme/api" });
    expect(body.ref).toBe("refs/heads/Main");
    expect(body.after).toBe(after);
    expect(body.before).toBe(before);
    expect(body.pusher).toBeDefined();
    expect(typeof body.pusher.name).toBe("string");
    expect(typeof body.pusher.email).toBe("string");
    expect(Array.isArray(body.commits)).toBe(true);
    expect(typeof body.sent_at).toBe("string");
    expect(new Date(body.sent_at).toString()).not.toBe("Invalid Date");
    expect(body.source).toBe("gluecron");
  });

  it("signs the body with HMAC-SHA256 in X-Gluecron-Signature when secret is set", async () => {
    process.env.GLUECRON_WEBHOOK_SECRET = "shared-vultr-secret";
    const { calls, fn } = captureFetch();

    await triggerVapronDeploy(makeArgs(), { fetchImpl: fn, sleep: noSleep });

    const headers = calls[0]!.init.headers as Record<string, string>;
    const sentBody = String(calls[0]!.init.body);
    const expected =
      "sha256=" +
      createHmac("sha256", "shared-vultr-secret")
        .update(sentBody)
        .digest("hex");
    expect(headers["X-Gluecron-Signature"]).toBe(expected);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits X-Gluecron-Signature when no secret is configured", async () => {
    const { calls, fn } = captureFetch();

    await triggerVapronDeploy(makeArgs(), { fetchImpl: fn, sleep: noSleep });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Gluecron-Signature"]).toBeUndefined();
  });

  it("attaches X-Gluecron-Event=push and a non-empty X-Gluecron-Delivery id", async () => {
    const { calls, fn } = captureFetch();

    await triggerVapronDeploy(makeArgs(), { fetchImpl: fn, sleep: noSleep });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Gluecron-Event"]).toBe("push");
    expect(headers["X-Gluecron-Delivery"]).toBeDefined();
    expect(headers["X-Gluecron-Delivery"]!.length).toBeGreaterThan(0);
  });

  it("ref carries the actual case of the branch (Main, not main)", async () => {
    const { calls, fn } = captureFetch();

    await triggerVapronDeploy(
      makeArgs({ ref: "refs/heads/Main", branch: "Main" }),
      { fetchImpl: fn, sleep: noSleep }
    );

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.ref).toBe("refs/heads/Main");
    expect(body.ref).not.toBe("refs/heads/main");
  });

  it("retries on 5xx with provided backoff schedule, stops on first 2xx", async () => {
    const responses = [
      new Response("", { status: 502 }),
      new Response("", { status: 503 }),
      new Response("", { status: 200 }),
    ];
    const { calls, fn } = captureFetch((i) => responses[i]!);
    const sleeps: number[] = [];

    await triggerVapronDeploy(makeArgs(), {
      fetchImpl: fn,
      sleep: async (ms) => { sleeps.push(ms); },
      retryDelaysMs: [10, 20, 30, 40, 50],
    });

    expect(calls.length).toBe(3);
    // Two waits — between attempt 1→2 and 2→3. None after the successful 3rd.
    expect(sleeps).toEqual([10, 20]);
  });

  it("gives up after the configured number of attempts on persistent 5xx", async () => {
    const { calls, fn } = captureFetch(() => new Response("", { status: 500 }));
    const sleeps: number[] = [];

    await triggerVapronDeploy(makeArgs(), {
      fetchImpl: fn,
      sleep: async (ms) => { sleeps.push(ms); },
      retryDelaysMs: [1, 2, 3, 4, 5],
    });

    // 5 delays + 1 initial = 6 total attempts (consistent with at-least-once).
    expect(calls.length).toBe(6);
    expect(sleeps).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not retry on unrecoverable 4xx (e.g. 401 invalid signature)", async () => {
    const { calls, fn } = captureFetch(() => new Response("", { status: 401 }));
    const sleeps: number[] = [];

    await triggerVapronDeploy(makeArgs(), {
      fetchImpl: fn,
      sleep: async (ms) => { sleeps.push(ms); },
      retryDelaysMs: [1, 2, 3, 4, 5],
    });

    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("does retry 408 (request timeout) and 429 (rate limit)", async () => {
    const responses = [
      new Response("", { status: 429 }),
      new Response("", { status: 408 }),
      new Response("", { status: 200 }),
    ];
    const { calls, fn } = captureFetch((i) => responses[i]!);

    await triggerVapronDeploy(makeArgs(), {
      fetchImpl: fn,
      sleep: noSleep,
      retryDelaysMs: [1, 2, 3, 4, 5],
    });

    expect(calls.length).toBe(3);
  });

  it("retries on network errors (fetch throws)", async () => {
    let callCount = 0;
    const fn = (async () => {
      callCount++;
      if (callCount < 3) throw new Error("ECONNREFUSED");
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await triggerVapronDeploy(makeArgs(), {
      fetchImpl: fn,
      sleep: noSleep,
      retryDelaysMs: [1, 2, 3, 4, 5],
    });

    expect(callCount).toBe(3);
  });

  it("does not throw when receiver responds 401 (unconfigured-secret path)", async () => {
    const { fn } = captureFetch(() => new Response("", { status: 401 }));
    await expect(
      triggerVapronDeploy(makeArgs(), { fetchImpl: fn, sleep: noSleep })
    ).resolves.toBeUndefined();
  });

  it("uses a default exponential-backoff schedule of 1s/4s/16s/64s/256s", () => {
    expect(__test.RETRY_DELAYS_MS).toEqual([1_000, 4_000, 16_000, 64_000, 256_000]);
  });
});

describe("vapron config — legacy CRONTECH_* env fallback", () => {
  const KEYS = [
    "VAPRON_DEPLOY_URL", "CRONTECH_DEPLOY_URL",
    "VAPRON_REPO", "CRONTECH_REPO",
    "VAPRON_HMAC_SECRET", "CRONTECH_HMAC_SECRET", "GLUECRON_WEBHOOK_SECRET",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("defaults to the vapron.ai webhook URL and ccantynz-alt/vapron repo", () => {
    expect(config.vapronDeployUrl).toBe("https://vapron.ai/api/webhooks/gluecron-push");
    expect(config.vapronRepo).toBe("ccantynz-alt/vapron");
  });

  it("VAPRON_* wins over legacy CRONTECH_*", () => {
    process.env.VAPRON_DEPLOY_URL = "https://vapron.ai/hook-a";
    process.env.CRONTECH_DEPLOY_URL = "https://crontech.ai/hook-b";
    process.env.VAPRON_REPO = "o/new";
    process.env.CRONTECH_REPO = "o/old";
    process.env.VAPRON_HMAC_SECRET = "new-secret";
    process.env.CRONTECH_HMAC_SECRET = "old-secret";
    expect(config.vapronDeployUrl).toBe("https://vapron.ai/hook-a");
    expect(config.vapronRepo).toBe("o/new");
    expect(config.vapronHmacSecret).toBe("new-secret");
  });

  it("legacy CRONTECH_* still works when VAPRON_* is unset", () => {
    process.env.CRONTECH_DEPLOY_URL = "https://crontech.ai/hook-b";
    process.env.CRONTECH_REPO = "o/old";
    process.env.CRONTECH_HMAC_SECRET = "old-secret";
    expect(config.vapronDeployUrl).toBe("https://crontech.ai/hook-b");
    expect(config.vapronRepo).toBe("o/old");
    expect(config.vapronHmacSecret).toBe("old-secret");
  });

  it("HMAC secret falls back to GLUECRON_WEBHOOK_SECRET last", () => {
    process.env.GLUECRON_WEBHOOK_SECRET = "oldest-secret";
    expect(config.vapronHmacSecret).toBe("oldest-secret");
  });
});
