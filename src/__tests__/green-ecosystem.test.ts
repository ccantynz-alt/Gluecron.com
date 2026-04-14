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
import {
  isAllowedEmoji,
  isAllowedTarget,
  ALLOWED_EMOJIS,
  EMOJI_GLYPH,
} from "../lib/reactions";

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

describe("theme toggle", () => {
  it("GET /theme/toggle sets a cookie and redirects", async () => {
    const res = await app.request("/theme/toggle");
    // 302 redirect; no cookie yet means we flip from the default (dark) → light
    expect([301, 302, 303, 307]).toContain(res.status);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(/theme=light/.test(setCookie)).toBe(true);
  });

  it("GET /theme/toggle flips an existing 'light' cookie back to dark", async () => {
    const res = await app.request("/theme/toggle", {
      headers: { cookie: "theme=light" },
    });
    const setCookie = res.headers.get("set-cookie") || "";
    expect(/theme=dark/.test(setCookie)).toBe(true);
  });

  it("GET /theme/set?mode=light returns JSON when asked", async () => {
    const res = await app.request("/theme/set?mode=light", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.theme).toBe("light");
  });

  it("GET /theme/set rejects unknown modes", async () => {
    const res = await app.request("/theme/set?mode=neon", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("home page includes the pre-paint theme script + data-theme attribute", async () => {
    const res = await app.request("/");
    const html = await res.text();
    expect(html).toContain("data-theme");
    expect(html).toContain("theme-icon-");
    // The pre-paint script reads the cookie.
    expect(html).toContain("document.cookie");
  });
});

describe("reactions", () => {
  it("allowed emojis and targets are self-consistent", () => {
    expect(ALLOWED_EMOJIS.length).toBeGreaterThanOrEqual(6);
    for (const e of ALLOWED_EMOJIS) {
      expect(isAllowedEmoji(e)).toBe(true);
      expect(EMOJI_GLYPH[e]).toBeTruthy();
    }
    expect(isAllowedEmoji("nope")).toBe(false);
    expect(isAllowedTarget("issue")).toBe(true);
    expect(isAllowedTarget("martian")).toBe(false);
  });

  it("POST /api/reactions/.../toggle requires auth", async () => {
    const res = await app.request(
      "/api/reactions/issue/00000000-0000-0000-0000-000000000000/thumbs_up/toggle",
      { method: "POST" }
    );
    // Unauthenticated -> redirect to /login (302)
    expect([301, 302, 303, 307]).toContain(res.status);
  });

  it("GET /api/reactions/:type/:id returns empty summary when no reactions exist", async () => {
    const res = await app.request(
      "/api/reactions/issue/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.reactions)).toBe(true);
  });

  it("rejects unknown target type on the listing endpoint", async () => {
    const res = await app.request(
      "/api/reactions/martian/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(400);
  });
});

describe("audit log UI", () => {
  it("GET /settings/audit redirects unauthenticated users to /login", async () => {
    const res = await app.request("/settings/audit");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});
