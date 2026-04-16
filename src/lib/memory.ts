/**
 * Platform memory store.
 *
 * Persistent key-value memory for the AI subsystem. Stores facts,
 * decisions, and learned context that should survive across requests
 * and server restarts. Uses the database as backing store.
 *
 * Categories:
 *  - "pattern"   — learned code review patterns
 *  - "decision"  — architectural decisions and their rationale
 *  - "context"   — project-specific context (conventions, tech debt, etc.)
 *  - "metric"    — performance baselines and thresholds
 *  - "feedback"  — user feedback signals
 */

import { eq, and, desc, gte, ilike, sql } from "drizzle-orm";
import { db } from "../db";
import { reviewPatterns } from "../db/schema";

interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

// In-memory cache for hot-path lookups (pattern context injection)
const memoryCache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Store a memory entry. Upserts by key.
 */
export async function memoryStore(
  key: string,
  value: string,
  opts: {
    category?: string;
    confidence?: number;
    scope?: string;
    language?: string;
  } = {}
): Promise<void> {
  const category = opts.category ?? "context";
  const confidence = opts.confidence ?? 70;

  try {
    const existing = await db
      .select()
      .from(reviewPatterns)
      .where(
        and(
          eq(reviewPatterns.pattern, key),
          eq(reviewPatterns.category, category)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(reviewPatterns)
        .set({
          pattern: value,
          confidence,
          lastSeenAt: new Date(),
        })
        .where(eq(reviewPatterns.id, existing[0].id));
    } else {
      await db.insert(reviewPatterns).values({
        scope: opts.scope ?? "global",
        language: opts.language ?? null,
        category,
        pattern: value,
        confidence,
        evidenceCount: 1,
      });
    }

    // Update cache
    memoryCache.set(`${category}:${key}`, {
      value,
      expiresAt: Date.now() + CACHE_TTL,
    });
  } catch (err) {
    console.error("[memory] store failed:", err);
  }
}

/**
 * Recall memory entries by category or keyword search.
 */
export async function memoryRecall(
  query: string,
  opts: {
    category?: string;
    limit?: number;
    minConfidence?: number;
  } = {}
): Promise<Array<{ pattern: string; category: string; confidence: number }>> {
  const limit = opts.limit ?? 10;
  const minConfidence = opts.minConfidence ?? 30;

  try {
    const conditions = [
      eq(reviewPatterns.active, true),
      gte(reviewPatterns.confidence, minConfidence),
    ];

    if (opts.category) {
      conditions.push(eq(reviewPatterns.category, opts.category));
    }

    if (query && query !== "*") {
      conditions.push(ilike(reviewPatterns.pattern, `%${query}%`));
    }

    const results = await db
      .select({
        pattern: reviewPatterns.pattern,
        category: reviewPatterns.category,
        confidence: reviewPatterns.confidence,
      })
      .from(reviewPatterns)
      .where(and(...conditions))
      .orderBy(desc(reviewPatterns.confidence))
      .limit(limit);

    return results;
  } catch (err) {
    console.error("[memory] recall failed:", err);
    return [];
  }
}

/**
 * Get a specific memory by category:key from cache, falling back to DB.
 */
export async function memoryGet(
  category: string,
  key: string
): Promise<string | null> {
  const cacheKey = `${category}:${key}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const [row] = await db
      .select()
      .from(reviewPatterns)
      .where(
        and(
          eq(reviewPatterns.category, category),
          ilike(reviewPatterns.pattern, `%${key}%`),
          eq(reviewPatterns.active, true)
        )
      )
      .orderBy(desc(reviewPatterns.confidence))
      .limit(1);

    if (row) {
      memoryCache.set(cacheKey, {
        value: row.pattern,
        expiresAt: Date.now() + CACHE_TTL,
      });
      return row.pattern;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get a summary of all stored memories by category.
 */
export async function memorySummary(): Promise<
  Array<{ category: string; count: number; avgConfidence: number }>
> {
  try {
    const results = await db
      .select({
        category: reviewPatterns.category,
        count: sql<number>`count(*)::int`,
        avgConfidence: sql<number>`avg(${reviewPatterns.confidence})::int`,
      })
      .from(reviewPatterns)
      .where(eq(reviewPatterns.active, true))
      .groupBy(reviewPatterns.category);

    return results;
  } catch {
    return [];
  }
}
