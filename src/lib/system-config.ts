/**
 * DB-backed runtime config for `/admin/integrations`.
 *
 * Operators used to SSH into the box, edit `/etc/gluecron.env`, and
 * `systemctl restart gluecron` to rotate keys like `ANTHROPIC_API_KEY`,
 * `RESEND_API_KEY`, `GITHUB_TOKEN`. This module replaces that workflow:
 *
 *   - `getConfigValue(key, fallbackEnv)` — DB first, env fallback,
 *     empty string if neither is set.
 *   - `setConfigValue(key, value, userId)` — upsert + write `process.env`
 *     so existing synchronous callers (e.g. `config.anthropicApiKey`)
 *     pick up the new value immediately, with no restart.
 *   - `loadConfigIntoEnv()` — boot hook (called from `src/index.ts`)
 *     that copies every saved row into `process.env` before other
 *     modules read it.
 *   - `maskSecret(s)` — `re_••••••...XYZ`-style display helper.
 *
 * A small in-memory LRU (60s TTL) avoids hitting the DB on every read.
 * Cache is invalidated on any `setConfigValue` so admins see their
 * changes immediately in subsequent renders.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { systemConfig } from "../db/schema";

const CACHE_TTL_MS = 60_000;

type CacheEntry = { value: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Mask "re_abc123xyz789" → "re_••••••89". Used for safe display in the UI. */
export function maskSecret(s: string | null | undefined): string {
  const v = (s ?? "").trim();
  if (!v) return "";
  // Keep the prefix (up to first underscore, max 4 chars) and last 2 chars.
  const underscore = v.indexOf("_");
  const prefixLen =
    underscore > 0 && underscore <= 4 ? underscore + 1 : Math.min(2, v.length);
  const prefix = v.slice(0, prefixLen);
  const tail = v.length > prefixLen + 4 ? v.slice(-2) : "";
  return `${prefix}••••••${tail}`;
}

/**
 * Heuristic: is this value the mask string we showed on the form, rather
 * than a freshly-typed secret? Used by the POST handler so a re-submit of
 * the rendered form doesn't overwrite the real secret with the mask.
 */
export function isMaskedValue(s: string | null | undefined): boolean {
  if (!s) return false;
  return s.includes("••••••");
}

/**
 * Read a config value. DB wins; falls back to `process.env[fallbackEnv]`;
 * empty string if neither is set. Cached for 60s.
 */
export async function getConfigValue(
  key: string,
  fallbackEnv: string
): Promise<string> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value || process.env[fallbackEnv] || "";
  }

  let dbValue = "";
  try {
    const [row] = await db
      .select({ value: systemConfig.value })
      .from(systemConfig)
      .where(eq(systemConfig.key, key))
      .limit(1);
    dbValue = (row?.value ?? "").trim();
  } catch (err) {
    console.warn(
      "[system-config] getConfigValue read failed:",
      err instanceof Error ? err.message : err
    );
  }

  cache.set(key, { value: dbValue, expiresAt: Date.now() + CACHE_TTL_MS });
  return dbValue || process.env[fallbackEnv] || "";
}

/**
 * Upsert a config value. Also writes `process.env[key]` so existing
 * synchronous `config.X` getters pick it up immediately — no restart.
 * Throws on DB failure so the route handler can surface an error banner.
 */
export async function setConfigValue(
  key: string,
  value: string,
  userId: string | null
): Promise<void> {
  const trimmed = (value ?? "").trim();
  await db
    .insert(systemConfig)
    .values({ key, value: trimmed, updatedByUserId: userId || null })
    .onConflictDoUpdate({
      target: systemConfig.key,
      set: {
        value: trimmed,
        updatedByUserId: userId || null,
        updatedAt: new Date(),
      },
    });
  cache.set(key, { value: trimmed, expiresAt: Date.now() + CACHE_TTL_MS });
  // Make the new value visible to sync getters across the process.
  if (trimmed) process.env[key] = trimmed;
  else delete process.env[key];
}

/**
 * Boot hook: copy every saved row into `process.env` before other modules
 * read it. Called once from `src/index.ts` near startup. Fire-and-forget —
 * if the DB is unreachable at boot, existing env vars stay as the fallback.
 */
export async function loadConfigIntoEnv(): Promise<number> {
  try {
    const rows = await db
      .select({ key: systemConfig.key, value: systemConfig.value })
      .from(systemConfig);
    let n = 0;
    for (const r of rows) {
      const v = (r.value ?? "").trim();
      if (!v) continue;
      // DB wins over env at boot. Existing process.env values are
      // overridden — that's the whole point: the admin saved a newer
      // value in the UI, and they want it to take effect.
      process.env[r.key] = v;
      cache.set(r.key, { value: v, expiresAt: Date.now() + CACHE_TTL_MS });
      n++;
    }
    return n;
  } catch (err) {
    console.warn(
      "[system-config] loadConfigIntoEnv skipped:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

/** Test-only — flush the in-memory cache. */
export function __resetCache(): void {
  cache.clear();
}

/**
 * Canonical integration list rendered by /admin/integrations. Keeping it
 * here (not in the route) so other modules (e.g. /admin/health) can read
 * which keys are user-managed without importing JSX.
 */
export interface IntegrationField {
  key: string;
  envFallback: string;
  label: string;
  helper: string;
  helperLink?: { href: string; text: string };
  isSecret: boolean;
  group: "ai" | "email" | "scm" | "security" | "observability" | "webhook";
}

export const INTEGRATION_FIELDS: IntegrationField[] = [
  {
    key: "ANTHROPIC_API_KEY",
    envFallback: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    helper:
      "Powers AI PR review, incident responder, commit messages, and auto-merge approval.",
    helperLink: { href: "https://console.anthropic.com/", text: "console.anthropic.com" },
    isSecret: true,
    group: "ai",
  },
  {
    key: "RESEND_API_KEY",
    envFallback: "RESEND_API_KEY",
    label: "Resend API key",
    helper: "Verification emails, password reset, magic link sign-in.",
    helperLink: { href: "https://resend.com/api-keys", text: "resend.com/api-keys" },
    isSecret: true,
    group: "email",
  },
  {
    key: "EMAIL_FROM",
    envFallback: "EMAIL_FROM",
    label: "Email sender address",
    helper: 'Format: `Gluecron <no-reply@your-domain>`.',
    isSecret: false,
    group: "email",
  },
  {
    key: "GITHUB_TOKEN",
    envFallback: "GITHUB_TOKEN",
    label: "GitHub personal access token",
    helper: "Used by the auto-merge sweep and GitHub-side API calls.",
    helperLink: { href: "https://github.com/settings/tokens", text: "github.com/settings/tokens" },
    isSecret: true,
    group: "scm",
  },
  {
    key: "GATETEST_URL",
    envFallback: "GATETEST_URL",
    label: "GateTest endpoint URL",
    helper: "Push-time security scanner — leave blank to disable scans.",
    isSecret: false,
    group: "security",
  },
  {
    key: "GATETEST_API_KEY",
    envFallback: "GATETEST_API_KEY",
    label: "GateTest API key",
    helper: "Auth token sent with each scan request.",
    isSecret: true,
    group: "security",
  },
  {
    key: "DEPLOY_EVENT_TOKEN",
    envFallback: "DEPLOY_EVENT_TOKEN",
    label: "Deploy events token",
    helper:
      "Shared secret for the live deploy timeline and AI incident responder.",
    isSecret: true,
    group: "observability",
  },
  {
    key: "CRONTECH_DEPLOY_URL",
    envFallback: "CRONTECH_DEPLOY_URL",
    label: "Crontech webhook URL",
    helper: "Optional: notify Crontech on every push to the canonical repo.",
    isSecret: false,
    group: "webhook",
  },
  {
    key: "CRONTECH_HMAC_SECRET",
    envFallback: "CRONTECH_HMAC_SECRET",
    label: "Crontech HMAC secret",
    helper: "Used to sign outbound Crontech webhook payloads.",
    isSecret: true,
    group: "webhook",
  },
];
