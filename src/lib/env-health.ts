/**
 * Environment / feature health — makes silently-disabled features visible.
 *
 * A dozen major features quietly turn off when their env vars are unset
 * (no ANTHROPIC_API_KEY → every AI feature is a no-op, no RESEND_API_KEY →
 * verification emails go to stderr, …). This module turns that implicit
 * state into an explicit, renderable checklist for /admin/env-health.
 *
 *   collectEnvHealth(env?)        — pure + synchronous, env-only checks.
 *   collectEnvHealthWithDb()      — augments the pure result with DB-backed
 *                                   toggles (currently: Google OAuth rows
 *                                   saved via /admin/google-oauth).
 *
 * SECURITY: items only ever carry set/unset booleans — never the values.
 * Keep it that way; this page is rendered into HTML for site admins and
 * the JSON shape may end up in logs or screenshots.
 */

import { getGoogleOauthConfig } from "./sso";

export type EnvHealthSeverity = "critical" | "recommended" | "optional";

export interface EnvHealthItem {
  /** Human-facing feature name, e.g. "AI features (review, incidents, …)". */
  feature: string;
  /** Env vars that control the feature — names only, never values. */
  envVars: string[];
  /** True when the feature is live in the current environment. */
  configured: boolean;
  /** One-liner: what silently turns off when this is missing. */
  impact: string;
  severity: EnvHealthSeverity;
}

/** Render order for the grouped table. */
export const SEVERITY_ORDER: EnvHealthSeverity[] = [
  "critical",
  "recommended",
  "optional",
];

/** Truthy = non-empty after trim. Never returns the value itself. */
function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return (env[name] || "").trim().length > 0;
}

/**
 * Pure, synchronous snapshot of every env-gated feature. Pass a synthetic
 * env object in tests; defaults to `process.env` at call time (matching
 * the getter-based pattern in `src/lib/config.ts` — values are read at
 * access time, never cached at import).
 */
export function collectEnvHealth(
  env: NodeJS.ProcessEnv = process.env
): EnvHealthItem[] {
  const appBaseUrl = (env.APP_BASE_URL || "").trim();

  return [
    // ─── Critical — core product surface degrades without these ───
    {
      feature: "AI features (PR review, incidents, commit messages, …)",
      envVars: ["ANTHROPIC_API_KEY"],
      configured: isSet(env, "ANTHROPIC_API_KEY"),
      impact:
        "Every AI surface silently no-ops: AI PR review, incident responder, commit messages, changelogs, test generation.",
      severity: "critical",
    },
    {
      feature: "Email delivery (verification, password reset)",
      envVars: ["EMAIL_PROVIDER", "RESEND_API_KEY"],
      // The provider must be "resend" AND the key present — the default
      // "log" provider only writes outbound mail to stderr (dev mode).
      configured:
        (env.EMAIL_PROVIDER || "").trim().toLowerCase() === "resend" &&
        isSet(env, "RESEND_API_KEY"),
      impact:
        "Outbound email goes to stderr instead of users — email verification, password resets, and digests never arrive.",
      severity: "critical",
    },
    {
      feature: "Canonical base URL (APP_BASE_URL)",
      envVars: ["APP_BASE_URL"],
      // Set AND not pointing at localhost — the default breaks OAuth
      // redirects and every link in outbound email.
      configured: appBaseUrl.length > 0 && !appBaseUrl.includes("localhost"),
      impact:
        "Links in emails/webhooks point at http://localhost:3000 and OAuth fails with redirect_uri_mismatch.",
      severity: "critical",
    },

    // ─── Recommended — feature works but in a degraded mode ───
    {
      feature: "Semantic code search (real embeddings)",
      envVars: ["VOYAGE_API_KEY"],
      configured: isSet(env, "VOYAGE_API_KEY"),
      impact:
        "Code search falls back to the hash-based local embedder instead of voyage-code-3 — noticeably worse relevance.",
      severity: "recommended",
    },
    {
      feature: "GateTest push-time security scans",
      envVars: ["GATETEST_URL", "GATETEST_API_KEY"],
      // GATETEST_URL has a baked-in default in config.ts, so the API key
      // is the real on/off switch.
      configured: isSet(env, "GATETEST_API_KEY"),
      impact:
        "Pushes are not scanned by GateTest; gate enforcement at push time is off.",
      severity: "recommended",
    },
    {
      feature: "Signed deploy webhook (Crontech)",
      envVars: ["GLUECRON_WEBHOOK_SECRET"],
      configured: isSet(env, "GLUECRON_WEBHOOK_SECRET"),
      impact:
        "Outbound deploy webhook fires without an HMAC signature header — the receiver rejects it with 401 (treated as a failed deploy).",
      severity: "recommended",
    },
    {
      feature: "PR preview builds",
      envVars: ["PREVIEW_DOMAIN"],
      configured: isSet(env, "PREVIEW_DOMAIN"),
      impact:
        "PR previews are URL-only — the preview-builder never runs and no static files are served.",
      severity: "recommended",
    },
    {
      feature: "Error tracking",
      envVars: ["SENTRY_DSN", "ERROR_WEBHOOK_URL"],
      // Either sink counts — both are fire-and-forget exporters.
      configured: isSet(env, "SENTRY_DSN") || isSet(env, "ERROR_WEBHOOK_URL"),
      impact:
        "Unhandled errors are only visible in server logs — nothing is exported to Sentry or a webhook.",
      severity: "recommended",
    },
    {
      feature: "Stable SSH host key",
      envVars: ["SSH_HOST_KEY"],
      configured: isSet(env, "SSH_HOST_KEY"),
      impact:
        "An ephemeral host key is generated on every restart — git-over-SSH clients see 'host key changed' warnings.",
      severity: "recommended",
    },

    // ─── Optional — opt-ins and scale-out knobs ───
    {
      feature: "Multi-instance SSE fan-out",
      envVars: ["REDIS_URL", "VALKEY_URL"],
      configured: isSet(env, "REDIS_URL") || isSet(env, "VALKEY_URL"),
      impact:
        "SSE events are delivered in-process only — live updates miss users connected to other instances behind a load balancer.",
      severity: "optional",
    },
    {
      feature: "Google login (env bootstrap)",
      envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      configured:
        isSet(env, "GOOGLE_OAUTH_CLIENT_ID") &&
        isSet(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
      impact:
        "'Sign in with Google' is unavailable — unless credentials were saved at /admin/google-oauth, which also satisfies this check.",
      severity: "optional",
    },
    {
      feature: "AI auto-issue opener",
      envVars: ["AI_AUTO_ISSUES"],
      configured: (env.AI_AUTO_ISSUES || "").trim() === "1",
      impact:
        "Pushes are not scanned for TODOs / hardcoded secrets / SQL-injection patterns; no issues are auto-opened. Opt-in: set to \"1\".",
      severity: "optional",
    },
    {
      feature: "Dependency CVE scanner",
      envVars: ["DEPENDENCY_SCAN_ENABLED"],
      configured: (env.DEPENDENCY_SCAN_ENABLED || "").trim() === "1",
      impact:
        "Manifest changes (package.json, requirements.txt, …) are not scanned for known CVEs on push. Opt-in: set to \"1\".",
      severity: "optional",
    },
  ];
}

/**
 * Async variant that augments the pure env snapshot with DB-backed toggles.
 * v1 only checks Google OAuth: a row saved via /admin/google-oauth enables
 * Google login even when the env pair is unset. DB failures degrade to the
 * env-only result — this must never take the admin page down.
 */
export async function collectEnvHealthWithDb(
  env: NodeJS.ProcessEnv = process.env
): Promise<EnvHealthItem[]> {
  const items = collectEnvHealth(env);

  try {
    // getGoogleOauthConfig() already merges DB row + env fallback.
    const google = await getGoogleOauthConfig();
    if (google?.clientId && google?.clientSecret) {
      const item = items.find((i) =>
        i.envVars.includes("GOOGLE_OAUTH_CLIENT_ID")
      );
      if (item) item.configured = true;
    }
  } catch {
    // DB unreachable — keep the env-only answer.
  }

  return items;
}

/** Group items by severity in render order (critical → recommended → optional). */
export function groupBySeverity(
  items: EnvHealthItem[]
): Array<{ severity: EnvHealthSeverity; items: EnvHealthItem[] }> {
  return SEVERITY_ORDER.map((severity) => ({
    severity,
    items: items.filter((i) => i.severity === severity),
  })).filter((g) => g.items.length > 0);
}
