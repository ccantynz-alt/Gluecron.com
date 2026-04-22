/**
 * Crontech deploy-webhook sender — Finding 1.
 *
 * Asserts that the outbound `triggerCrontechDeploy` call sent from
 * `src/hooks/post-receive.ts` matches the wire contract documented at the
 * top of that helper:
 *
 *   POST  https://crontech.ai/api/hooks/gluecron/push
 *   Authorization: Bearer ${GLUECRON_WEBHOOK_SECRET}
 *   Content-Type: application/json
 *   body = { repository, sha, branch, ref, source, timestamp }
 *
 * The helper swallows DB errors, so these tests work without a real DB.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __test } from "../hooks/post-receive";

const { triggerCrontechDeploy } = __test;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

const origFetch = globalThis.fetch;
const origSecret = process.env.GLUECRON_WEBHOOK_SECRET;
const origUrl = process.env.CRONTECH_DEPLOY_URL;

function installFetchCapture(
  respond: () => Response = () =>
    new Response(
      JSON.stringify({ ok: true, deploymentId: "d1", status: "queued" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  // @ts-expect-error — override global fetch for test
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return calls;
}

function restoreFetch(): void {
  globalThis.fetch = origFetch;
}

describe("hooks/post-receive — triggerCrontechDeploy (Finding 1 sender)", () => {
  beforeEach(() => {
    // Unset overrides so each test owns its env state.
    delete process.env.GLUECRON_WEBHOOK_SECRET;
    delete process.env.CRONTECH_DEPLOY_URL;
  });

  afterEach(() => {
    restoreFetch();
    if (origSecret === undefined) delete process.env.GLUECRON_WEBHOOK_SECRET;
    else process.env.GLUECRON_WEBHOOK_SECRET = origSecret;
    if (origUrl === undefined) delete process.env.CRONTECH_DEPLOY_URL;
    else process.env.CRONTECH_DEPLOY_URL = origUrl;
  });

  it("is exported from __test", () => {
    expect(typeof triggerCrontechDeploy).toBe("function");
  });

  it("POSTs to the new Crontech hooks endpoint (not the old tRPC URL)", async () => {
    const calls = installFetchCapture();

    await triggerCrontechDeploy(
      "alice",
      "widgets",
      "a".repeat(40),
      "00000000-0000-0000-0000-000000000000"
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://crontech.ai/api/hooks/gluecron/push"
    );
    expect(calls[0]!.url).not.toContain("/api/trpc/tenant.deploy");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("sends Authorization: Bearer <secret> when GLUECRON_WEBHOOK_SECRET is set", async () => {
    process.env.GLUECRON_WEBHOOK_SECRET = "webhook-test-value";
    const calls = installFetchCapture();

    await triggerCrontechDeploy(
      "alice",
      "widgets",
      "b".repeat(40),
      "00000000-0000-0000-0000-000000000000"
    );

    expect(calls.length).toBe(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer s3cret-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits the Authorization header when no secret is configured", async () => {
    // GLUECRON_WEBHOOK_SECRET deliberately unset by beforeEach.
    const calls = installFetchCapture();

    await triggerCrontechDeploy(
      "alice",
      "widgets",
      "c".repeat(40),
      "00000000-0000-0000-0000-000000000000"
    );

    expect(calls.length).toBe(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends the wire-contract body shape (repository, sha, branch, ref, source, timestamp)", async () => {
    const calls = installFetchCapture();
    const sha = "d".repeat(40);

    await triggerCrontechDeploy(
      "acme",
      "api",
      sha,
      "00000000-0000-0000-0000-000000000000"
    );

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.repository).toBe("acme/api");
    expect(body.sha).toBe(sha);
    expect(body.branch).toBe("main");
    expect(body.ref).toBe("refs/heads/main");
    expect(body.source).toBe("gluecron");
    expect(typeof body.timestamp).toBe("string");
    // ISO-8601 sanity check
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("respects CRONTECH_DEPLOY_URL override", async () => {
    process.env.CRONTECH_DEPLOY_URL =
      "https://staging.crontech.ai/api/hooks/gluecron/push";
    const calls = installFetchCapture();

    await triggerCrontechDeploy(
      "alice",
      "widgets",
      "e".repeat(40),
      "00000000-0000-0000-0000-000000000000"
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://staging.crontech.ai/api/hooks/gluecron/push"
    );
  });

  it("does not throw when Crontech responds 401 (unset secret path)", async () => {
    const calls = installFetchCapture(() => new Response("", { status: 401 }));
    await expect(
      triggerCrontechDeploy(
        "alice",
        "widgets",
        "f".repeat(40),
        "00000000-0000-0000-0000-000000000000"
      )
    ).resolves.toBeUndefined();
    expect(calls.length).toBe(1);
  });
});
