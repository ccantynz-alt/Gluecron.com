/**
 * Proactive AI pair programmer HTTP surface.
 *
 *   GET  /api/pair/ping            — health check (unauthed)
 *   POST /api/pair/context         — requireAuth; assemble PairContext for a file
 *   POST /api/pair/suggest         — requireAuth; context + AI suggestion for a file
 *
 * Rate limit: 30/min per user (separate counter from the copilot 60/min).
 * Suggestion responses are cached 30 s per (userId, repoId, filePath, prefixSlice).
 *
 * For reactive completions triggered on every keystroke, see:
 *   POST /api/copilot/completions (src/routes/copilot.ts)
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { rateLimit } from "../middleware/rate-limit";
import { isAiAvailable } from "../lib/ai-client";
import {
  assemblePairContext,
  generatePairSuggestion,
  suggestCacheKey,
  suggestCache,
  cacheGet,
  cacheSet,
  SUGGEST_TTL_MS,
} from "../lib/ai-pair";
import type { PairContext, PairSuggestion } from "../lib/ai-pair";

const router = new Hono<AuthEnv>();

// Separate rate-limit bucket from copilot (30 req/min).
const pairLimit = rateLimit(30, 60_000, "pair");

// ---------------------------------------------------------------------------
// GET /api/pair/ping — health check
// ---------------------------------------------------------------------------
router.get("/api/pair/ping", (c) => {
  return c.json({ ok: true, aiAvailable: isAiAvailable() });
});

// ---------------------------------------------------------------------------
// POST /api/pair/context
// ---------------------------------------------------------------------------
router.post("/api/pair/context", pairLimit, requireAuth, async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }

  const { repoId, filePath } = body as { repoId?: unknown; filePath?: unknown };

  if (typeof repoId !== "string" || repoId.trim() === "") {
    return c.json({ error: "repoId (non-empty string) is required" }, 400);
  }
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return c.json({ error: "filePath (non-empty string) is required" }, 400);
  }

  const ctx: PairContext = await assemblePairContext(repoId, filePath, user.id);
  return c.json(ctx);
});

// ---------------------------------------------------------------------------
// POST /api/pair/suggest
// ---------------------------------------------------------------------------
router.post("/api/pair/suggest", pairLimit, requireAuth, async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }

  const {
    repoId,
    filePath,
    prefix,
    suffix,
  } = body as {
    repoId?: unknown;
    filePath?: unknown;
    prefix?: unknown;
    suffix?: unknown;
  };

  if (typeof repoId !== "string" || repoId.trim() === "") {
    return c.json({ error: "repoId (non-empty string) is required" }, 400);
  }
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return c.json({ error: "filePath (non-empty string) is required" }, 400);
  }
  if (typeof prefix !== "string" || prefix.length === 0) {
    return c.json({ error: "prefix (non-empty string) is required" }, 400);
  }

  const suffixStr = typeof suffix === "string" ? suffix : "";

  // Check 30-second suggestion cache.
  const ck = suggestCacheKey(user.id, repoId, filePath, prefix);
  const hit = cacheGet(suggestCache, ck);
  if (hit !== undefined) {
    return c.json({ ...hit, cached: true });
  }

  // Assemble context then generate suggestion (both are individually cached).
  const ctx: PairContext = await assemblePairContext(repoId, filePath, user.id);
  const suggestion: PairSuggestion = await generatePairSuggestion(
    prefix,
    suffixStr,
    filePath,
    ctx
  );

  // Cache the suggestion.
  cacheSet(suggestCache, ck, suggestion, SUGGEST_TTL_MS);

  return c.json(suggestion);
});

export const pairProgrammerRoutes = router;
export default router;
