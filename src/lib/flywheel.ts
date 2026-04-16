/**
 * Flywheel — the learning engine that makes every AI review smarter.
 *
 * Aggregates review_outcomes and gate_runs into patterns, then injects
 * those patterns into future AI prompts so the system learns from every
 * review, every merge, every failure.
 */

import { eq, and, desc, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  reviewOutcomes,
  reviewPatterns,
  gateRuns,
  gateMetrics,
  prComments,
  repositories,
  users,
} from "../db/schema";
import type { ReviewPattern } from "../db/schema";
import { config } from "./config";

// ── Outcome Recording ───────────────────────────────────────────────────────

/**
 * Record how a developer responded to an AI review comment.
 * Called when a PR comment is resolved, dismissed, or the PR is merged.
 */
export async function recordReviewOutcome(opts: {
  repositoryId: string;
  pullRequestId: string;
  commentId: string;
  outcome: "accepted" | "dismissed" | "modified" | "ignored";
  category: string;
  filePath?: string;
  language?: string;
  wasUseful?: boolean;
}): Promise<void> {
  try {
    await db.insert(reviewOutcomes).values({
      repositoryId: opts.repositoryId,
      pullRequestId: opts.pullRequestId,
      commentId: opts.commentId,
      outcome: opts.outcome,
      category: opts.category,
      filePath: opts.filePath,
      language: opts.language ?? deriveLanguage(opts.filePath),
      wasUseful: opts.wasUseful,
    });
  } catch (err) {
    console.error("[flywheel] recordReviewOutcome failed:", err);
  }
}

function deriveLanguage(filePath?: string): string | null {
  if (!filePath) return null;
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    swift: "swift",
    php: "php",
    sql: "sql",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    json: "json",
    toml: "toml",
  };
  return map[ext ?? ""] ?? ext ?? null;
}

// ── Pattern Extraction ──────────────────────────────────────────────────────

/**
 * Extract patterns from recent review outcomes. Looks for:
 * - Categories that are consistently accepted (boost confidence)
 * - Categories that are consistently dismissed (reduce confidence / deactivate)
 * - New recurring patterns that should become rules
 *
 * Called periodically (e.g. after every N merges) or on demand.
 */
export async function extractPatterns(
  repositoryId?: string
): Promise<{ created: number; updated: number; deactivated: number }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let stats = { created: 0, updated: 0, deactivated: 0 };

  try {
    const whereClause = repositoryId
      ? and(
          eq(reviewOutcomes.repositoryId, repositoryId),
          gte(reviewOutcomes.createdAt, thirtyDaysAgo)
        )
      : gte(reviewOutcomes.createdAt, thirtyDaysAgo);

    const outcomes = await db
      .select({
        category: reviewOutcomes.category,
        language: reviewOutcomes.language,
        outcome: reviewOutcomes.outcome,
        count: sql<number>`count(*)::int`,
      })
      .from(reviewOutcomes)
      .where(whereClause)
      .groupBy(
        reviewOutcomes.category,
        reviewOutcomes.language,
        reviewOutcomes.outcome
      );

    // Group by category+language to compute acceptance rates
    const grouped = new Map<
      string,
      { accepted: number; dismissed: number; total: number; language: string | null; category: string }
    >();

    for (const row of outcomes) {
      const key = `${row.category}:${row.language ?? "all"}`;
      const entry = grouped.get(key) ?? {
        accepted: 0,
        dismissed: 0,
        total: 0,
        language: row.language,
        category: row.category,
      };
      entry.total += row.count;
      if (row.outcome === "accepted" || row.outcome === "modified") {
        entry.accepted += row.count;
      } else if (row.outcome === "dismissed") {
        entry.dismissed += row.count;
      }
      grouped.set(key, entry);
    }

    for (const [, data] of grouped) {
      if (data.total < 3) continue; // need minimum evidence

      const acceptRate = data.accepted / data.total;
      const confidence = Math.round(acceptRate * 100);

      const scope = repositoryId ? "repo" : "global";
      const existing = await db
        .select()
        .from(reviewPatterns)
        .where(
          and(
            eq(reviewPatterns.scope, scope),
            eq(reviewPatterns.category, data.category),
            repositoryId
              ? eq(reviewPatterns.repositoryId, repositoryId)
              : sql`${reviewPatterns.repositoryId} IS NULL`,
            data.language
              ? eq(reviewPatterns.language, data.language)
              : sql`${reviewPatterns.language} IS NULL`
          )
        )
        .limit(1);

      if (existing.length > 0) {
        const pattern = existing[0];
        if (confidence < 20 && data.total >= 5) {
          // Consistently dismissed — deactivate this pattern
          await db
            .update(reviewPatterns)
            .set({ active: false, confidence, evidenceCount: data.total, lastSeenAt: new Date() })
            .where(eq(reviewPatterns.id, pattern.id));
          stats.deactivated++;
        } else {
          await db
            .update(reviewPatterns)
            .set({ confidence, evidenceCount: data.total, lastSeenAt: new Date() })
            .where(eq(reviewPatterns.id, pattern.id));
          stats.updated++;
        }
      } else if (confidence >= 40) {
        // New pattern worth tracking
        const patternText = generatePatternDescription(data.category, data.language, acceptRate);
        await db.insert(reviewPatterns).values({
          repositoryId: repositoryId ?? null,
          scope,
          language: data.language,
          category: data.category,
          pattern: patternText,
          confidence,
          evidenceCount: data.total,
        });
        stats.created++;
      }
    }
  } catch (err) {
    console.error("[flywheel] extractPatterns failed:", err);
  }

  return stats;
}

function generatePatternDescription(
  category: string,
  language: string | null,
  acceptRate: number
): string {
  const langSuffix = language ? ` in ${language} files` : "";
  const emphasis = acceptRate > 0.8 ? "high priority" : "moderate priority";

  const descriptions: Record<string, string> = {
    bug: `Bug detection${langSuffix} — ${emphasis}. Developers consistently fix flagged bugs.`,
    security: `Security vulnerability detection${langSuffix} — ${emphasis}. Flag injection, auth bypass, and data exposure.`,
    perf: `Performance issue detection${langSuffix} — ${emphasis}. Watch for N+1 queries, blocking I/O, unnecessary allocations.`,
    logic: `Logic error detection${langSuffix} — ${emphasis}. Check for off-by-one, null derefs, race conditions.`,
    breaking: `Breaking change detection${langSuffix} — ${emphasis}. Flag API contract violations and removed public interfaces.`,
  };

  return descriptions[category] ?? `${category} detection${langSuffix} — ${emphasis}.`;
}

// ── Gate Metrics Aggregation ────────────────────────────────────────────────

/**
 * Aggregate gate_runs into monthly metrics for trend analysis.
 * Called after gate checks complete.
 */
export async function updateGateMetrics(
  repositoryId: string,
  gateName: string,
  status: "passed" | "failed" | "skipped" | "repaired",
  durationMs?: number
): Promise<void> {
  const period = new Date().toISOString().slice(0, 7); // YYYY-MM

  try {
    const [existing] = await db
      .select()
      .from(gateMetrics)
      .where(
        and(
          eq(gateMetrics.repositoryId, repositoryId),
          eq(gateMetrics.gateName, gateName),
          eq(gateMetrics.period, period)
        )
      )
      .limit(1);

    if (existing) {
      const updates: Record<string, unknown> = {
        totalRuns: existing.totalRuns + 1,
        updatedAt: new Date(),
      };

      if (status === "passed") updates.passed = existing.passed + 1;
      else if (status === "failed") updates.failed = existing.failed + 1;
      else if (status === "repaired") updates.repaired = existing.repaired + 1;
      else if (status === "skipped") updates.skipped = existing.skipped + 1;

      if (durationMs != null && existing.avgDurationMs != null) {
        updates.avgDurationMs = Math.round(
          (existing.avgDurationMs * existing.totalRuns + durationMs) / (existing.totalRuns + 1)
        );
      } else if (durationMs != null) {
        updates.avgDurationMs = durationMs;
      }

      await db
        .update(gateMetrics)
        .set(updates)
        .where(eq(gateMetrics.id, existing.id));
    } else {
      await db.insert(gateMetrics).values({
        repositoryId,
        gateName,
        period,
        totalRuns: 1,
        passed: status === "passed" ? 1 : 0,
        failed: status === "failed" ? 1 : 0,
        repaired: status === "repaired" ? 1 : 0,
        skipped: status === "skipped" ? 1 : 0,
        avgDurationMs: durationMs ?? null,
      });
    }
  } catch (err) {
    console.error("[flywheel] updateGateMetrics failed:", err);
  }
}

// ── Context Injection (the actual "learning") ───────────────────────────────

/**
 * Build a context block for AI review prompts based on learned patterns.
 * This is what makes the flywheel turn — historical patterns inform future reviews.
 */
export async function buildReviewContext(
  repositoryId: string | null,
  language?: string
): Promise<string> {
  try {
    const patterns: ReviewPattern[] = [];

    // Fetch repo-specific patterns
    if (repositoryId) {
      const repoPatterns = await db
        .select()
        .from(reviewPatterns)
        .where(
          and(
            eq(reviewPatterns.repositoryId, repositoryId),
            eq(reviewPatterns.active, true)
          )
        )
        .orderBy(desc(reviewPatterns.confidence))
        .limit(10);
      patterns.push(...repoPatterns);
    }

    // Fetch global patterns
    const globalPatterns = await db
      .select()
      .from(reviewPatterns)
      .where(
        and(
          sql`${reviewPatterns.repositoryId} IS NULL`,
          eq(reviewPatterns.scope, "global"),
          eq(reviewPatterns.active, true)
        )
      )
      .orderBy(desc(reviewPatterns.confidence))
      .limit(10);
    patterns.push(...globalPatterns);

    // Fetch language-specific patterns
    if (language) {
      const langPatterns = await db
        .select()
        .from(reviewPatterns)
        .where(
          and(
            eq(reviewPatterns.language, language),
            eq(reviewPatterns.active, true)
          )
        )
        .orderBy(desc(reviewPatterns.confidence))
        .limit(5);
      patterns.push(...langPatterns);
    }

    if (patterns.length === 0) return "";

    // Deduplicate by id
    const seen = new Set<string>();
    const unique = patterns.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    // Build context string
    const lines = unique
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 15)
      .map(
        (p) =>
          `- [${p.category}] (confidence: ${p.confidence}%) ${p.pattern}`
      );

    return `\n\nBased on historical review data for this codebase, pay extra attention to:\n${lines.join("\n")}`;
  } catch (err) {
    console.error("[flywheel] buildReviewContext failed:", err);
    return "";
  }
}

// ── Repo-level Stats ────────────────────────────────────────────────────────

export interface FlywheelStats {
  totalReviews: number;
  acceptedRate: number;
  topCategories: Array<{ category: string; count: number; acceptRate: number }>;
  gateHealth: Array<{
    gateName: string;
    passRate: number;
    avgDurationMs: number;
    totalRuns: number;
  }>;
  activePatterns: number;
}

/**
 * Get flywheel learning stats for a repository.
 * Useful for the settings/dashboard page.
 */
export async function getFlywheelStats(
  repositoryId: string
): Promise<FlywheelStats> {
  try {
    const [outcomeStats, metrics, patternCount] = await Promise.all([
      db
        .select({
          category: reviewOutcomes.category,
          outcome: reviewOutcomes.outcome,
          count: sql<number>`count(*)::int`,
        })
        .from(reviewOutcomes)
        .where(eq(reviewOutcomes.repositoryId, repositoryId))
        .groupBy(reviewOutcomes.category, reviewOutcomes.outcome),
      db
        .select()
        .from(gateMetrics)
        .where(eq(gateMetrics.repositoryId, repositoryId))
        .orderBy(desc(gateMetrics.period))
        .limit(20),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reviewPatterns)
        .where(
          and(
            eq(reviewPatterns.repositoryId, repositoryId),
            eq(reviewPatterns.active, true)
          )
        ),
    ]);

    // Aggregate outcome stats
    let totalReviews = 0;
    let totalAccepted = 0;
    const catMap = new Map<string, { count: number; accepted: number }>();

    for (const row of outcomeStats) {
      totalReviews += row.count;
      if (row.outcome === "accepted" || row.outcome === "modified") {
        totalAccepted += row.count;
      }
      const cat = catMap.get(row.category) ?? { count: 0, accepted: 0 };
      cat.count += row.count;
      if (row.outcome === "accepted" || row.outcome === "modified") {
        cat.accepted += row.count;
      }
      catMap.set(row.category, cat);
    }

    const topCategories = Array.from(catMap.entries())
      .map(([category, data]) => ({
        category,
        count: data.count,
        acceptRate: data.count > 0 ? data.accepted / data.count : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Aggregate gate health (most recent period per gate)
    const latestGates = new Map<string, (typeof metrics)[0]>();
    for (const m of metrics) {
      if (!latestGates.has(m.gateName)) latestGates.set(m.gateName, m);
    }

    const gateHealth = Array.from(latestGates.values()).map((m) => ({
      gateName: m.gateName,
      passRate: m.totalRuns > 0 ? (m.passed + m.repaired) / m.totalRuns : 1,
      avgDurationMs: m.avgDurationMs ?? 0,
      totalRuns: m.totalRuns,
    }));

    return {
      totalReviews,
      acceptedRate: totalReviews > 0 ? totalAccepted / totalReviews : 0,
      topCategories,
      gateHealth,
      activePatterns: patternCount[0]?.count ?? 0,
    };
  } catch (err) {
    console.error("[flywheel] getFlywheelStats failed:", err);
    return {
      totalReviews: 0,
      acceptedRate: 0,
      topCategories: [],
      gateHealth: [],
      activePatterns: 0,
    };
  }
}
