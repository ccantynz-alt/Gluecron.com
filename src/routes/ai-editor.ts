/**
 * AI editor API routes — inline suggestions, code explanation, and fix generation.
 *
 * All endpoints require an authenticated session and `ANTHROPIC_API_KEY`.
 * Rate-limited to 30 suggestion requests per user per hour (in-memory).
 *
 * Routes:
 *   POST /api/ai/suggest  — code completion (ghost text)
 *   POST /api/ai/explain  — explain selected code
 *   POST /api/ai/fix      — fix code given a GateTest / error message
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { isAiAvailable, getAnthropic, MODEL_HAIKU, MODEL_SONNET, extractText } from "../lib/ai-client";
import type { AuthEnv } from "../middleware/auth";

const aiEditor = new Hono<AuthEnv>();

// ─── Rate-limit store ────────────────────────────────────────────────────────
// Simple in-memory map: userId → array of request timestamps (ms).
// Cleaned lazily to avoid unbounded growth on high-traffic servers.
const QUOTA_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
const QUOTA_MAX = 30;

const suggestQuota = new Map<string, number[]>();

function checkQuota(userId: string): { allowed: boolean; resetInMinutes: number } {
  const now = Date.now();
  const cutoff = now - QUOTA_WINDOW_MS;
  let timestamps = suggestQuota.get(userId) ?? [];
  // Purge expired entries
  timestamps = timestamps.filter((t) => t > cutoff);

  if (timestamps.length >= QUOTA_MAX) {
    const oldest = timestamps[0]!;
    const resetInMs = oldest + QUOTA_WINDOW_MS - now;
    const resetInMinutes = Math.ceil(resetInMs / 60_000);
    suggestQuota.set(userId, timestamps);
    return { allowed: false, resetInMinutes };
  }

  timestamps.push(now);
  suggestQuota.set(userId, timestamps);
  return { allowed: true, resetInMinutes: 0 };
}

// ─── POST /api/ai/suggest ────────────────────────────────────────────────────
aiEditor.post("/api/ai/suggest", requireAuth, async (c) => {
  if (!isAiAvailable()) {
    return c.json(
      { error: "AI suggestions unavailable — ANTHROPIC_API_KEY not configured." },
      503
    );
  }

  const user = c.get("user")!;
  const quota = checkQuota(user.id);
  if (!quota.allowed) {
    return c.json(
      {
        error: `AI suggestion quota reached. Resets in ${quota.resetInMinutes} minute${quota.resetInMinutes === 1 ? "" : "s"}.`,
      },
      429
    );
  }

  let body: { code?: string; language?: string; cursor?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const code = String(body.code ?? "").slice(0, 2000);
  const language = String(body.language ?? "plaintext");
  const cursor = Number(body.cursor ?? code.length);

  const beforeCursor = code.slice(0, cursor);
  const afterCursor = code.slice(cursor);

  const prompt =
    `Language: ${language}\n\n` +
    `Code before cursor:\n${beforeCursor}\n\n` +
    (afterCursor.trim()
      ? `Code after cursor (context only — do NOT repeat it):\n${afterCursor}\n\n`
      : "") +
    "Complete the code at the cursor position. Return ONLY the completion text to insert, no explanation, no markdown, no code fences.";

  try {
    const anthropic = getAnthropic();
    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 256,
      system:
        "You are a code completion AI. Complete the code snippet at the cursor. " +
        "Return ONLY the completion text — no explanation, no markdown, no code fences. " +
        "Keep completions concise (prefer single-line or a few lines). " +
        "If you have nothing useful to add, return an empty string.",
      messages: [{ role: "user", content: prompt }],
    });

    const suggestion = extractText(message).trimEnd();
    return c.json({ suggestion });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed.";
    return c.json({ error: msg }, 500);
  }
});

// ─── POST /api/ai/explain ────────────────────────────────────────────────────
aiEditor.post("/api/ai/explain", requireAuth, async (c) => {
  if (!isAiAvailable()) {
    return c.json(
      { error: "AI explanations unavailable — ANTHROPIC_API_KEY not configured." },
      503
    );
  }

  let body: { code?: string; language?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const code = String(body.code ?? "").slice(0, 4000);
  const language = String(body.language ?? "plaintext");

  if (!code.trim()) {
    return c.json({ error: "No code provided." }, 400);
  }

  try {
    const anthropic = getAnthropic();
    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 512,
      system:
        "You are a senior engineer explaining code to a fellow developer. " +
        "Be concise and precise. Use plain text (no markdown headers). " +
        "One or two short paragraphs maximum.",
      messages: [
        {
          role: "user",
          content: `Language: ${language}\n\nExplain this code:\n\`\`\`\n${code}\n\`\`\``,
        },
      ],
    });

    const explanation = extractText(message).trim();
    return c.json({ explanation });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed.";
    return c.json({ error: msg }, 500);
  }
});

// ─── POST /api/ai/fix ────────────────────────────────────────────────────────
aiEditor.post("/api/ai/fix", requireAuth, async (c) => {
  if (!isAiAvailable()) {
    return c.json(
      { error: "AI fix unavailable — ANTHROPIC_API_KEY not configured." },
      503
    );
  }

  let body: { code?: string; error?: string; language?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const code = String(body.code ?? "").slice(0, 4000);
  const errorMsg = String(body.error ?? "").slice(0, 1000);
  const language = String(body.language ?? "plaintext");

  if (!code.trim()) {
    return c.json({ error: "No code provided." }, 400);
  }

  const prompt =
    `Language: ${language}\n\n` +
    `Error message:\n${errorMsg}\n\n` +
    `Code with the problem:\n\`\`\`\n${code}\n\`\`\`\n\n` +
    "Return a JSON object with two fields: " +
    '"fix" (the corrected code, complete file content) and ' +
    '"explanation" (one short sentence describing what was wrong).';

  try {
    const anthropic = getAnthropic();
    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      system:
        "You are an expert code fixer. Given an error and code, return valid JSON with " +
        '"fix" (corrected code, no markdown fences) and "explanation" (one-sentence reason). ' +
        "Return ONLY the JSON object, nothing else.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = extractText(message).trim();

    // Try to parse the JSON response
    let fix = "";
    let explanation = "";
    try {
      // Strip possible ```json fences
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      fix = String(parsed.fix ?? "");
      explanation = String(parsed.explanation ?? "");
    } catch {
      // Fallback: return raw as fix text
      fix = raw;
      explanation = "AI returned a fix but could not parse structured response.";
    }

    return c.json({ fix, explanation });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI request failed.";
    return c.json({ error: msg }, 500);
  }
});

export default aiEditor;
