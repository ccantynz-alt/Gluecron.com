/**
 * Block D9 — Copilot-style code completion engine.
 *
 * Exposes a single async function `completeCode` that turns a prefix (+ optional
 * suffix) into the characters that should be inserted at the cursor. Used by
 * the `/api/copilot/completions` endpoint, which IDE plugins (VS Code, Neovim,
 * JetBrains) call on every keystroke.
 *
 * Design notes:
 *   - Uses Haiku because latency matters more than depth for inline suggestions.
 *   - Input is clipped aggressively (8k chars before, 2k chars after) so a huge
 *     file doesn't blow the token budget.
 *   - Never throws. On any error (bad key, timeout, rate limit) we return an
 *     empty completion so the editor just stays silent rather than popping a
 *     scary modal at the user.
 *   - Inline LRU keeps identical requests (the editor firing the same
 *     completion twice in rapid succession) from each burning an API call.
 *   - We log prefix.length only — never the content itself, which may contain
 *     API keys, private tokens, or proprietary source.
 */

import {
  getAnthropic,
  MODEL_HAIKU,
  extractText,
  isAiAvailable,
} from "./ai-client";
import { createHash } from "crypto";

export interface CompleteArgs {
  prefix: string;
  suffix?: string;
  language?: string;
  maxTokens?: number;
  repoHint?: string;
}

export interface CompleteResult {
  completion: string;
  model: string;
  cached: boolean;
}

// ---------- Inline LRU (size cap 200, TTL ~5 min) ----------
// Intentionally standalone rather than reusing src/lib/cache.ts: completion
// cache entries have a very different shape + access pattern (write-heavy,
// short-lived, never invalidated by repo events) and keeping the logic local
// makes the file easier to reason about and test.

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const CACHE_MAX = 200;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cacheStore = new Map<string, CacheEntry>();

function cacheKey(prefix: string, suffix: string, language: string): string {
  return createHash("sha256")
    .update(prefix)
    .update("\0")
    .update(suffix)
    .update("\0")
    .update(language)
    .digest("hex");
}

function cacheGet(key: string): string | undefined {
  const entry = cacheStore.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return undefined;
  }
  // Move to end (MRU).
  cacheStore.delete(key);
  cacheStore.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  cacheStore.delete(key);
  if (cacheStore.size >= CACHE_MAX) {
    const oldest = cacheStore.keys().next().value;
    if (oldest !== undefined) cacheStore.delete(oldest);
  }
  cacheStore.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Strip leading/trailing markdown code fences that Claude sometimes emits
 * despite the system prompt forbidding them. Handles:
 *   ```lang\n...\n```
 *   ```\n...\n```
 * Leaves un-fenced content untouched.
 */
function stripCodeFences(text: string): string {
  let out = text;
  // Leading fence (optionally with language label)
  out = out.replace(/^\s*```[A-Za-z0-9_+-]*\s*\n?/, "");
  // Trailing fence
  out = out.replace(/\n?\s*```\s*$/, "");
  return out;
}

export async function completeCode(
  args: CompleteArgs
): Promise<CompleteResult> {
  const prefix = (args.prefix || "").slice(-8000);
  const suffix = (args.suffix || "").slice(0, 2000);
  const language = args.language || "unknown";
  const repoHint = args.repoHint || "unknown";
  const maxTokens = args.maxTokens ?? 256;

  if (!isAiAvailable()) {
    return { completion: "", model: "fallback", cached: false };
  }

  const key = cacheKey(prefix, suffix, language);
  const hit = cacheGet(key);
  if (hit !== undefined) {
    return { completion: hit, model: MODEL_HAIKU, cached: true };
  }

  try {
    const client = getAnthropic();
    const response = await client.messages.create({
      model: MODEL_HAIKU,
      max_tokens: maxTokens,
      system:
        "You are a code completion engine. Given a prefix and optional suffix, output ONLY the characters that should be inserted at the cursor. No explanations. No markdown fences. No commentary.",
      messages: [
        {
          role: "user",
          content:
            `Language: ${language}\n` +
            `Repo: ${repoHint}\n\n` +
            `PREFIX:\n${prefix}\n\n` +
            `SUFFIX:\n${suffix}`,
        },
      ],
    });

    const raw = extractText(response);
    const completion = stripCodeFences(raw);
    cacheSet(key, completion);
    return { completion, model: MODEL_HAIKU, cached: false };
  } catch (err) {
    // Never throw — the editor should degrade silently. Log length only, not
    // the prefix itself, which can contain secrets.
    console.error(
      "[ai-completion] completeCode failed (prefix.length=" +
        prefix.length +
        "):",
      (err as Error)?.message || err
    );
    return { completion: "", model: "error", cached: false };
  }
}

/**
 * Test-only helpers. Not part of the public API — tests use these to seed
 * entries so they can exercise the cache without hitting the real Anthropic
 * endpoint, and to reset state between runs.
 */
export const __test = {
  cacheKey,
  cacheGet,
  cacheSet,
  clear() {
    cacheStore.clear();
  },
  size() {
    return cacheStore.size;
  },
  stripCodeFences,
};
