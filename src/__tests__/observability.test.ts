/**
 * Observability layer (src/lib/observability.ts).
 *
 * `reportError` MUST never throw, regardless of env configuration or whether
 * the configured webhook is reachable. These tests pin that contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { reportError } from "../lib/observability";

const origFetch = globalThis.fetch;
const origWebhook = process.env.ERROR_WEBHOOK_URL;
const origSentry = process.env.SENTRY_DSN;

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function installFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  // @ts-expect-error — override global fetch
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return impl(url, init);
  };
  return calls;
}

function restore(): void {
  globalThis.fetch = origFetch;
  if (origWebhook === undefined) delete process.env.ERROR_WEBHOOK_URL;
  else process.env.ERROR_WEBHOOK_URL = origWebhook;
  if (origSentry === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = origSentry;
}

describe("lib/observability — reportError", () => {
  beforeEach(() => {
    delete process.env.ERROR_WEBHOOK_URL;
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    restore();
  });

  it("does not throw when no env vars are set (logs only)", () => {
    expect(() => reportError(new Error("boom"))).not.toThrow();
    expect(() => reportError(new Error("boom"), { path: "/x" })).not.toThrow();
    // Non-Error inputs must also be safe.
    expect(() => reportError("string error")).not.toThrow();
    expect(() => reportError({ weird: true })).not.toThrow();
    expect(() => reportError(undefined)).not.toThrow();
  });

  it("does not throw when ERROR_WEBHOOK_URL is set but fetch rejects", async () => {
    process.env.ERROR_WEBHOOK_URL = "http://127.0.0.1:1/unreachable";
    const calls = installFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    expect(() =>
      reportError(new Error("prod bug"), { requestId: "r1", path: "/p", method: "GET" })
    ).not.toThrow();

    // Give the fire-and-forget promise a tick to run and its .catch to execute.
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:1/unreachable");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.message).toBe("prod bug");
    expect(body.context).toEqual({ requestId: "r1", path: "/p", method: "GET" });
    expect(typeof body.timestamp).toBe("string");
  });

  it("does not throw when fetch itself throws synchronously", () => {
    process.env.ERROR_WEBHOOK_URL = "http://example.test/hook";
    // @ts-expect-error — override to throw synchronously
    globalThis.fetch = () => {
      throw new Error("synchronous boom");
    };
    expect(() => reportError(new Error("err"))).not.toThrow();
  });
});
