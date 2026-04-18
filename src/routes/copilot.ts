/**
 * Block D9 — Copilot-style completion HTTP surface.
 *
 *   POST /api/copilot/completions  (authed — PAT / OAuth / session)
 *     Body: { prefix, suffix?, language?, repo? }
 *     Returns: { completion, model, cached }
 *
 *   GET  /api/copilot/ping  (unauthed)
 *     Returns: { ok: true, aiAvailable: boolean }
 *
 * Keep per-user limits tight: IDE plugins call this on every keystroke, so a
 * misbehaving client can otherwise exhaust the shared Anthropic quota fast.
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { completeCode } from "../lib/ai-completion";
import { isAiAvailable } from "../lib/ai-client";

const copilot = new Hono<AuthEnv>();

// Tight per-caller limit: 60/min. NOTE: `rateLimit` keys by bearer-token
// prefix when Authorization is present, otherwise by IP — so session-cookie
// callers share a single IP bucket. That's acceptable for an IDE endpoint
// where the expected caller is almost always a PAT/OAuth token.
const completionLimit = rateLimit(60, 60_000, "copilot");

copilot.get("/api/copilot/ping", (c) => {
  return c.json({ ok: true, aiAvailable: isAiAvailable() });
});

copilot.post(
  "/api/copilot/completions",
  completionLimit,
  requireAuth,
  async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be a JSON object" }, 400);
    }

    const { prefix, suffix, language, repo } = body as {
      prefix?: unknown;
      suffix?: unknown;
      language?: unknown;
      repo?: unknown;
    };

    if (typeof prefix !== "string" || prefix.length === 0) {
      return c.json({ error: "prefix (non-empty string) is required" }, 400);
    }

    const result = await completeCode({
      prefix,
      suffix: typeof suffix === "string" ? suffix : undefined,
      language: typeof language === "string" ? language : undefined,
      repoHint: typeof repo === "string" ? repo : undefined,
    });

    return c.json(result);
  }
);

export default copilot;
