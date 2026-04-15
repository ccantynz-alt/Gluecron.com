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
  isTeamToken,
  expandOwnerTokens,
} from "../lib/codeowners";
import { generateCommitMessage } from "../lib/ai-generators";
import { isAiAvailable } from "../lib/ai-client";
import {
  isAllowedEmoji,
  isAllowedTarget,
  ALLOWED_EMOJIS,
  EMOJI_GLYPH,
} from "../lib/reactions";
import { sendEmail, absoluteUrl } from "../lib/email";
import { __internal as notifyInternal } from "../lib/notify";
import {
  isValidSlug,
  normalizeSlug,
  orgRoleAtLeast,
  isValidOrgRole,
  isValidTeamRole,
  __test as orgsInternal,
} from "../lib/orgs";
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotpCode,
  otpauthUrl,
  generateRecoveryCodes,
  hashRecoveryCode,
} from "../lib/totp";

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

  it("preserves @org/team tokens (B3)", () => {
    const rules = parseCodeowners(
      "api/**  @acme/backend @alice\nweb/**  @acme/frontend\n"
    );
    expect(rules[0].owners).toEqual(["acme/backend", "alice"]);
    expect(rules[1].owners).toEqual(["acme/frontend"]);
    expect(isTeamToken("acme/backend")).toBe(true);
    expect(isTeamToken("alice")).toBe(false);
  });

  it("expandOwnerTokens passes plain usernames through and drops unknown teams gracefully", async () => {
    // Real team lookup requires DB rows. Without DB the helper must still
    // resolve without throwing; plain usernames must always pass through.
    const result = await expandOwnerTokens([
      "alice",
      "bob",
      "nonexistent-org-xyz/some-team",
    ]);
    expect(result).toContain("alice");
    expect(result).toContain("bob");
    // Unknown team silently drops (no throw, no crash).
    expect(result).not.toContain("nonexistent-org-xyz/some-team");
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

describe("email", () => {
  it("sendEmail in log mode never throws and returns ok", async () => {
    const prev = process.env.EMAIL_PROVIDER;
    process.env.EMAIL_PROVIDER = "log";
    const res = await sendEmail({
      to: "test@gluecron.local",
      subject: "hello",
      text: "body",
    });
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("log");
    if (prev === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = prev;
  });

  it("sendEmail rejects invalid recipient without throwing", async () => {
    const res = await sendEmail({
      to: "not-an-email",
      subject: "x",
      text: "y",
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBeTruthy();
  });

  it("sendEmail rejects empty subject/body without throwing", async () => {
    const res = await sendEmail({ to: "a@b.co", subject: "", text: "" });
    expect(res.ok).toBe(false);
  });

  it("absoluteUrl joins paths against APP_BASE_URL", () => {
    const prev = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = "https://gluecron.example/";
    expect(absoluteUrl("/x")).toBe("https://gluecron.example/x");
    expect(absoluteUrl("x")).toBe("https://gluecron.example/x");
    expect(absoluteUrl("https://other/y")).toBe("https://other/y");
    if (prev === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prev;
  });

  it("notify email-eligible set only includes user-opt-in kinds", () => {
    // Any kind in EMAIL_ELIGIBLE must map to a preference column
    for (const k of notifyInternal.EMAIL_ELIGIBLE) {
      expect(notifyInternal.prefFor(k)).not.toBeNull();
    }
    // gate_passed is not eligible (too spammy; only gate_failed is)
    expect(notifyInternal.EMAIL_ELIGIBLE.has("gate_passed" as any)).toBe(false);
    expect(notifyInternal.EMAIL_ELIGIBLE.has("deploy_failed" as any)).toBe(
      false
    );
  });

  it("notify email subject is tagged and truncated", () => {
    const subj = notifyInternal.subjectFor("gate_failed", "x".repeat(300));
    expect(subj.startsWith("[gate failed]")).toBe(true);
    expect(subj.length).toBeLessThanOrEqual(180);
  });
});

describe("settings email preferences", () => {
  it("GET /settings redirects unauthenticated users to /login", async () => {
    const res = await app.request("/settings");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /settings/notifications redirects unauthenticated users to /login", async () => {
    const res = await app.request("/settings/notifications", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "notify_email_on_mention=1",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("orgs helpers (B1)", () => {
  describe("isValidSlug", () => {
    it("accepts simple slugs", () => {
      expect(isValidSlug("acme")).toBe(true);
      expect(isValidSlug("acme-corp")).toBe(true);
      expect(isValidSlug("a1")).toBe(true);
      expect(isValidSlug("a-b-c-1-2-3")).toBe(true);
    });

    it("rejects too-short or too-long", () => {
      expect(isValidSlug("")).toBe(false);
      expect(isValidSlug("a")).toBe(false);
      expect(isValidSlug("a".repeat(40))).toBe(false);
    });

    it("rejects leading/trailing hyphen", () => {
      expect(isValidSlug("-acme")).toBe(false);
      expect(isValidSlug("acme-")).toBe(false);
    });

    it("rejects consecutive hyphens", () => {
      expect(isValidSlug("foo--bar")).toBe(false);
    });

    it("rejects uppercase + invalid chars", () => {
      expect(isValidSlug("Acme")).toBe(false);
      expect(isValidSlug("acme_corp")).toBe(false);
      expect(isValidSlug("acme.corp")).toBe(false);
      expect(isValidSlug("acme corp")).toBe(false);
    });

    it("rejects reserved words", () => {
      expect(isValidSlug("api")).toBe(false);
      expect(isValidSlug("admin")).toBe(false);
      expect(isValidSlug("settings")).toBe(false);
      expect(isValidSlug("orgs")).toBe(false);
      expect(isValidSlug("new")).toBe(false);
    });
  });

  describe("normalizeSlug", () => {
    it("lowercases and trims", () => {
      expect(normalizeSlug("  ACME  ")).toBe("acme");
      expect(normalizeSlug("Acme-Corp")).toBe("acme-corp");
    });
  });

  describe("orgRoleAtLeast", () => {
    it("owner beats admin beats member", () => {
      expect(orgRoleAtLeast("owner", "member")).toBe(true);
      expect(orgRoleAtLeast("owner", "admin")).toBe(true);
      expect(orgRoleAtLeast("owner", "owner")).toBe(true);
      expect(orgRoleAtLeast("admin", "member")).toBe(true);
      expect(orgRoleAtLeast("admin", "admin")).toBe(true);
      expect(orgRoleAtLeast("admin", "owner")).toBe(false);
      expect(orgRoleAtLeast("member", "admin")).toBe(false);
      expect(orgRoleAtLeast("member", "owner")).toBe(false);
    });

    it("treats unknown role as rank 0", () => {
      expect(orgRoleAtLeast("", "member")).toBe(false);
      expect(orgRoleAtLeast("banana", "member")).toBe(false);
    });
  });

  describe("role type guards", () => {
    it("isValidOrgRole", () => {
      expect(isValidOrgRole("owner")).toBe(true);
      expect(isValidOrgRole("admin")).toBe(true);
      expect(isValidOrgRole("member")).toBe(true);
      expect(isValidOrgRole("maintainer")).toBe(false);
      expect(isValidOrgRole("banana")).toBe(false);
    });

    it("isValidTeamRole", () => {
      expect(isValidTeamRole("maintainer")).toBe(true);
      expect(isValidTeamRole("member")).toBe(true);
      expect(isValidTeamRole("owner")).toBe(false);
      expect(isValidTeamRole("banana")).toBe(false);
    });
  });

  describe("internal", () => {
    it("rank table orders correctly", () => {
      const r = orgsInternal.ORG_ROLE_RANK;
      expect(r.owner).toBeGreaterThan(r.admin);
      expect(r.admin).toBeGreaterThan(r.member);
    });

    it("reserved set contains the app's top-level paths", () => {
      expect(orgsInternal.RESERVED_SLUGS.has("api")).toBe(true);
      expect(orgsInternal.RESERVED_SLUGS.has("settings")).toBe(true);
      expect(orgsInternal.RESERVED_SLUGS.has("login")).toBe(true);
    });
  });
});

describe("orgs routes (B1)", () => {
  it("GET /orgs redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("GET /orgs/new redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/new");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /orgs/new redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "slug=acme&name=Acme",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("GET /orgs/:slug redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/some-org");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /orgs/:slug/people/add redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/some-org/people/add", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "username=alice&role=member",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});

describe("org-owned repos (B2)", () => {
  it("GET /orgs/:slug/repos redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/some-org/repos");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("GET /orgs/:slug/repos/new redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/some-org/repos/new");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /orgs/:slug/repos/new redirects unauthenticated users to /login", async () => {
    const res = await app.request("/orgs/some-org/repos/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=web",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /api/repos with orgSlug still validates required fields", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "acme" }),
    });
    // Missing name + owner → 400 before any DB access.
    expect(res.status).toBe(400);
  });

  it("POST /api/repos rejects invalid repo names before DB access", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad name with spaces",
        owner: "alice",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("TOTP / 2FA (B4)", () => {
  it("base32 round-trips bytes", () => {
    const bytes = new Uint8Array([0x74, 0x65, 0x73, 0x74]); // "test"
    const enc = base32Encode(bytes);
    const dec = base32Decode(enc);
    expect(Array.from(dec)).toEqual(Array.from(bytes));
  });

  it("generateTotpSecret returns 32-char Base32", () => {
    const s = generateTotpSecret();
    expect(s.length).toBe(32);
    expect(/^[A-Z2-7]+$/.test(s)).toBe(true);
  });

  it("totpCode is 6 digits", async () => {
    const s = generateTotpSecret();
    const c = await totpCode(s);
    expect(/^\d{6}$/.test(c)).toBe(true);
  });

  it("verifyTotpCode accepts a freshly-generated code", async () => {
    const s = generateTotpSecret();
    const c = await totpCode(s);
    expect(await verifyTotpCode(s, c)).toBe(true);
  });

  it("verifyTotpCode tolerates a ±30s drift", async () => {
    const s = generateTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const past = await totpCode(s, now - 30);
    const future = await totpCode(s, now + 30);
    expect(await verifyTotpCode(s, past, now)).toBe(true);
    expect(await verifyTotpCode(s, future, now)).toBe(true);
  });

  it("verifyTotpCode rejects a wrong code", async () => {
    const s = generateTotpSecret();
    expect(await verifyTotpCode(s, "000000")).toBe(false);
  });

  it("verifyTotpCode rejects non-6-digit input", async () => {
    const s = generateTotpSecret();
    expect(await verifyTotpCode(s, "abc")).toBe(false);
    expect(await verifyTotpCode(s, "12345")).toBe(false);
    expect(await verifyTotpCode(s, "1234567")).toBe(false);
  });

  it("otpauthUrl has the expected shape", () => {
    const u = otpauthUrl({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "alice@example.com",
      issuer: "gluecron",
    });
    expect(u.startsWith("otpauth://totp/")).toBe(true);
    expect(u).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(u).toContain("issuer=gluecron");
    expect(u).toContain("period=30");
    expect(u).toContain("digits=6");
  });

  it("generateRecoveryCodes returns the expected count + format", () => {
    const codes = generateRecoveryCodes(5);
    expect(codes.length).toBe(5);
    for (const c of codes) {
      expect(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(c)).toBe(true);
    }
    // Uniqueness: ~70 bits of entropy each, collisions should be astronomical.
    expect(new Set(codes).size).toBe(5);
  });

  it("hashRecoveryCode is deterministic + normalised", async () => {
    const a = await hashRecoveryCode("ABCD-1234-efgh");
    const b = await hashRecoveryCode("abcd-1234-efgh");
    const c = await hashRecoveryCode("  abcd-1234-efgh  ");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a.length).toBe(64); // SHA-256 hex
  });
});

describe("2FA routes (B4)", () => {
  it("GET /settings/2fa redirects unauthenticated users to /login", async () => {
    const res = await app.request("/settings/2fa");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("POST /settings/2fa/enroll redirects unauthenticated users to /login", async () => {
    const res = await app.request("/settings/2fa/enroll", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });

  it("GET /login/2fa redirects to /login when no session cookie", async () => {
    const res = await app.request("/login/2fa");
    expect([301, 302, 303, 307]).toContain(res.status);
    const loc = res.headers.get("location") || "";
    expect(loc.startsWith("/login")).toBe(true);
  });
});
