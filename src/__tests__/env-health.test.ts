/**
 * Environment / feature health tests (src/lib/env-health.ts).
 *
 * Pure-function checks against synthetic env objects — no DB, no real
 * process.env mutation. Also smoke-tests the /admin/env-health route's
 * auth gate against the standalone Hono module (the route is mounted in
 * app.tsx, but testing the module directly keeps this independent of
 * mount order).
 */

import { describe, it, expect } from "bun:test";
import {
  collectEnvHealth,
  groupBySeverity,
  SEVERITY_ORDER,
  type EnvHealthItem,
} from "../lib/env-health";
import envHealthRoutes from "../routes/admin-env-health";

/** A fully-wired synthetic env — every feature should report configured. */
const FULL_ENV: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: "sk-ant-secret-aaa",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_secret_bbb",
  APP_BASE_URL: "https://gluecron.com",
  VOYAGE_API_KEY: "pa-secret-ccc",
  GATETEST_URL: "https://gatetest.ai/api/events/push",
  GATETEST_API_KEY: "gt_secret_ddd",
  GLUECRON_WEBHOOK_SECRET: "whsec_secret_eee",
  PREVIEW_DOMAIN: "https://previews.gluecron.com",
  SENTRY_DSN: "https://abc@o1.ingest.sentry.io/1",
  ERROR_WEBHOOK_URL: "https://hooks.example.com/errors",
  SSH_HOST_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----secret-fff",
  REDIS_URL: "redis://:redis-secret-ggg@localhost:6379",
  GOOGLE_OAUTH_CLIENT_ID: "abc.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-secret-hhh",
  AI_AUTO_ISSUES: "1",
  DEPENDENCY_SCAN_ENABLED: "1",
};

describe("collectEnvHealth — configured detection", () => {
  it("reports every feature missing on an empty env", () => {
    const items = collectEnvHealth({});
    expect(items.length).toBeGreaterThanOrEqual(12);
    expect(items.every((i) => i.configured === false)).toBe(true);
  });

  it("reports every feature configured on a fully-wired env", () => {
    const items = collectEnvHealth(FULL_ENV);
    expect(items.every((i) => i.configured === true)).toBe(true);
  });

  it("email needs EMAIL_PROVIDER=resend, not just the key", () => {
    const find = (env: NodeJS.ProcessEnv) =>
      collectEnvHealth(env).find((i) => i.envVars.includes("RESEND_API_KEY"))!;
    // Key alone: still the dev "log" provider — mail goes to stderr.
    expect(find({ RESEND_API_KEY: "re_x" }).configured).toBe(false);
    // Provider alone: nothing to authenticate with.
    expect(find({ EMAIL_PROVIDER: "resend" }).configured).toBe(false);
    expect(
      find({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x" }).configured
    ).toBe(true);
  });

  it("APP_BASE_URL pointing at localhost does not count", () => {
    const find = (env: NodeJS.ProcessEnv) =>
      collectEnvHealth(env).find((i) => i.envVars.includes("APP_BASE_URL"))!;
    expect(find({}).configured).toBe(false);
    expect(find({ APP_BASE_URL: "http://localhost:3000" }).configured).toBe(
      false
    );
    expect(find({ APP_BASE_URL: "https://gluecron.com" }).configured).toBe(
      true
    );
  });

  it("either-or pairs: REDIS_URL/VALKEY_URL and SENTRY_DSN/ERROR_WEBHOOK_URL", () => {
    const sse = (env: NodeJS.ProcessEnv) =>
      collectEnvHealth(env).find((i) => i.envVars.includes("REDIS_URL"))!;
    expect(sse({ REDIS_URL: "redis://x" }).configured).toBe(true);
    expect(sse({ VALKEY_URL: "redis://y" }).configured).toBe(true);
    expect(sse({}).configured).toBe(false);

    const errs = (env: NodeJS.ProcessEnv) =>
      collectEnvHealth(env).find((i) => i.envVars.includes("SENTRY_DSN"))!;
    expect(errs({ SENTRY_DSN: "https://x" }).configured).toBe(true);
    expect(errs({ ERROR_WEBHOOK_URL: "https://y" }).configured).toBe(true);
    expect(errs({}).configured).toBe(false);
  });

  it("opt-in flags require the literal \"1\"", () => {
    const auto = (env: NodeJS.ProcessEnv) =>
      collectEnvHealth(env).find((i) => i.envVars.includes("AI_AUTO_ISSUES"))!;
    expect(auto({ AI_AUTO_ISSUES: "1" }).configured).toBe(true);
    expect(auto({ AI_AUTO_ISSUES: "true" }).configured).toBe(false);
    expect(auto({ AI_AUTO_ISSUES: "0" }).configured).toBe(false);
  });

  it("whitespace-only values count as unset", () => {
    const items = collectEnvHealth({ ANTHROPIC_API_KEY: "   " });
    const ai = items.find((i) => i.envVars.includes("ANTHROPIC_API_KEY"))!;
    expect(ai.configured).toBe(false);
  });
});

describe("collectEnvHealth — shape + severity", () => {
  it("every item has the full shape and a valid severity", () => {
    for (const item of collectEnvHealth(FULL_ENV)) {
      expect(typeof item.feature).toBe("string");
      expect(item.feature.length).toBeGreaterThan(0);
      expect(Array.isArray(item.envVars)).toBe(true);
      expect(item.envVars.length).toBeGreaterThan(0);
      expect(typeof item.configured).toBe("boolean");
      expect(typeof item.impact).toBe("string");
      expect(item.impact.length).toBeGreaterThan(0);
      expect(SEVERITY_ORDER).toContain(item.severity);
    }
  });

  it("groupBySeverity returns critical → recommended → optional, no empties", () => {
    const groups = groupBySeverity(collectEnvHealth({}));
    expect(groups.map((g) => g.severity)).toEqual([
      "critical",
      "recommended",
      "optional",
    ]);
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
      expect(g.items.every((i) => i.severity === g.severity)).toBe(true);
    }
  });

  it("groupBySeverity drops empty buckets", () => {
    const only: EnvHealthItem[] = [
      {
        feature: "x",
        envVars: ["X"],
        configured: false,
        impact: "y",
        severity: "optional",
      },
    ];
    const groups = groupBySeverity(only);
    expect(groups.length).toBe(1);
    expect(groups[0]!.severity).toBe("optional");
  });
});

describe("collectEnvHealth — never leaks values", () => {
  it("no secret value from the env appears anywhere in the output", () => {
    const serialized = JSON.stringify(collectEnvHealth(FULL_ENV));
    // Short non-secret knobs ("1", "resend") legitimately appear in the
    // impact prose — only assert on values long enough to be secrets/URLs.
    for (const value of Object.values(FULL_ENV)) {
      if (!value || value.length < 8) continue;
      expect(serialized).not.toContain(value);
    }
  });
});

describe("/admin/env-health — auth gate", () => {
  it("GET without auth → 302 /login", async () => {
    const res = await envHealthRoutes.request("/admin/env-health");
    expect(res.status).toBe(302);
    expect(res.headers.get("location") || "").toContain("/login");
  });
});
