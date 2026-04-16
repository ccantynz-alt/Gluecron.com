/**
 * Memory API routes — read/write platform memory for AI continuity.
 *
 * These endpoints let the AI subsystem (and admin tools) persist and
 * retrieve learned context across sessions and requests.
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";
import { memoryStore, memoryRecall, memorySummary } from "../lib/memory";

const memory = new Hono<AuthEnv>();

memory.get("/api/memory/recall", requireAuth, async (c) => {
  const query = c.req.query("q") || "*";
  const category = c.req.query("category");
  const limit = parseInt(c.req.query("limit") || "10", 10);

  const results = await memoryRecall(query, { category, limit });
  return c.json({ results });
});

memory.post("/api/memory/store", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { key, value, category, confidence, scope, language } = body as Record<
    string,
    string | number | undefined
  >;

  if (!key || !value) {
    return c.json({ error: "key and value are required" }, 400);
  }

  await memoryStore(String(key), String(value), {
    category: category ? String(category) : undefined,
    confidence: typeof confidence === "number" ? confidence : undefined,
    scope: scope ? String(scope) : undefined,
    language: language ? String(language) : undefined,
  });

  return c.json({ stored: true });
});

memory.get("/api/memory/summary", requireAuth, async (c) => {
  const summary = await memorySummary();
  return c.json({ summary });
});

export default memory;
