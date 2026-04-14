/**
 * Tests for the green ecosystem: secret scanner, codeowners parser,
 * auto-repair helpers, notification + audit log helpers, health routes,
 * and rate limiting.
 *
 * These unit-level tests avoid DB + git subprocess work so they run fast.
 */

import { describe, it, expect } from "bun:test";
import app from "../app";
import { scanForSecrets, SECRET_PATTERNS } from "../lib/security-scan";
import {
  parseCodeowners,
  ownersForPath,
} from "../lib/codeowners";
import { generateCommitMessage } from "../lib/ai-generators";
import { isAiAvailable } from "../lib/ai-client";

describe("secret scanner", () => {
  it("detects AWS access keys", () => {
    const findings = scanForSecrets([
      {
        path: "config.env",
        content: "AWS_ACCESS_KEY=AKIAZ2J4NPQR5LTMWXYZ\n",
      },
    ]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /AWS/i.test(f.type))).toBe(true);
  });

  it("detects Anthropic API keys", () => {
    const findings = scanForSecrets([
      {
        path: "app.ts",
        content:
          'const key = "sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ-AAAAAA";',
      },
    ]);
    expect(findings.some((f) => /anthropic/i.test(f.type))).toBe(true);
  });

  it("ignores binary/lock paths", () => {
    const findings = scanForSecrets([
      {
        path: "package-lock.json",
        content: "AKIAZ2J4NPQR5LTMWXYZ secret content",
      },
    ]);
    expect(findings.length).toBe(0);
  });

  it("does not match placeholder strings in test fixtures", () => {
    const findings = scanForSecrets([
      {
        path: "test.js",
        content:
          '// example: AKIA" + "XAMPLE_PLACEHOLDER_KEY_FIXTURE"\nconst k = "FAKE_TEST_PLACEHOLDER";',
      },
    ]);
    // all findings should be filtered by the placeholder heuristic
    expect(findings.every((f) => !/placeholder|fixture/i.test(f.snippet))).toBe(true);
  });

  it("has a rich library of rules", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("codeowners parser", () => {
  it("parses simple rules", () => {
    const rules = parseCodeowners(
      "# top-level owner\n*  @alice\nsrc/api/**  @bob @carol\n/docs/  @alice\n"
    );
    expect(rules.length).toBe(3);
    expect(rules[0].owners).toEqual(["alice"]);
    expect(rules[1].owners).toEqual(["bob", "carol"]);
  });

  it("resolves last-matching rule wins", () => {
    const rules = parseCodeowners("*  @alice\nsrc/api/**  @bob\n");
    expect(ownersForPath("README.md", rules)).toEqual(["alice"]);
    expect(ownersForPath("src/api/users.ts", rules)).toEqual(["bob"]);
  });

  it("anchors leading-slash patterns to repo root", () => {
    const rules = parseCodeowners("/docs/  @alice\n");
    expect(ownersForPath("docs/readme.md", rules)).toEqual(["alice"]);
    expect(ownersForPath("src/docs/readme.md", rules)).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    const rules = parseCodeowners(
      "# comment\n\n   \n# another\n* @ghost # trailing comment\n"
    );
    expect(rules.length).toBe(1);
    expect(rules[0].owners).toEqual(["ghost"]);
  });
});

describe("AI generator fallbacks", () => {
  it("returns a safe fallback commit message when AI is unavailable", async () => {
    if (isAiAvailable()) {
      // API key is set — skip fallback assertion
      return;
    }
    const msg = await generateCommitMessage("");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toMatch(/^\S+/);
  });
});

describe("health + metrics endpoints", () => {
  it("GET /healthz returns 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /metrics returns process metrics", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.uptimeMs).toBe("number");
    expect(typeof body.heapUsed).toBe("number");
  });

  it("response carries X-Request-Id header", async () => {
    const res = await app.request("/healthz");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});

describe("rate limiting", () => {
  it("rate-limit headers appear on /api requests", async () => {
    const res = await app.request("/api/users/nonexistent/repos");
    // Headers should exist even though user is missing
    const limit = res.headers.get("X-RateLimit-Limit");
    expect(limit).toBeTruthy();
  });
});

describe("shortcuts + search page", () => {
  it("GET /shortcuts is public", async () => {
    const res = await app.request("/shortcuts");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Keyboard shortcuts");
  });

  it("GET /search with no query shows the type tabs", async () => {
    const res = await app.request("/search");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Repositories");
    expect(html).toContain("Users");
  });
});

describe("GateTest inbound hook", () => {
  it("GET /api/hooks/ping is unauthenticated and reports service", async () => {
    const res = await app.request("/api/hooks/ping");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gluecron");
    expect(Array.isArray(body.hooks)).toBe(true);
  });

  it("POST /api/hooks/gatetest rejects when no secret configured", async () => {
    const prev = process.env.GATETEST_CALLBACK_SECRET;
    const prevH = process.env.GATETEST_HMAC_SECRET;
    delete process.env.GATETEST_CALLBACK_SECRET;
    delete process.env.GATETEST_HMAC_SECRET;
    const res = await app.request("/api/hooks/gatetest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "a/b", sha: "x", status: "passed" }),
    });
    expect(res.status).toBe(401);
    if (prev) process.env.GATETEST_CALLBACK_SECRET = prev;
    if (prevH) process.env.GATETEST_HMAC_SECRET = prevH;
  });

  it("POST /api/hooks/gatetest rejects bad bearer token", async () => {
    const prev = process.env.GATETEST_CALLBACK_SECRET;
    process.env.GATETEST_CALLBACK_SECRET = "real-secret-abc123";
    const res = await app.request("/api/hooks/gatetest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ repository: "a/b", sha: "x", status: "passed" }),
    });
    expect(res.status).toBe(401);
    if (prev === undefined) delete process.env.GATETEST_CALLBACK_SECRET;
    else process.env.GATETEST_CALLBACK_SECRET = prev;
  });

  it("POST /api/hooks/gatetest rejects malformed payload even when authed", async () => {
    const prev = process.env.GATETEST_CALLBACK_SECRET;
    process.env.GATETEST_CALLBACK_SECRET = "real-secret-abc123";
    const res = await app.request("/api/hooks/gatetest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer real-secret-abc123",
      },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    if (prev === undefined) delete process.env.GATETEST_CALLBACK_SECRET;
    else process.env.GATETEST_CALLBACK_SECRET = prev;
  });

  it("POST /api/v1/gate-runs (backup) rejects without bearer", async () => {
    const res = await app.request("/api/v1/gate-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "a/b", sha: "x", status: "passed" }),
    });
    expect(res.status).toBe(401);
  });
});
