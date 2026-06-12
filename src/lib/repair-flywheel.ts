/**
 * Repair Flywheel — the learning loop that makes auto-repair faster + cheaper
 * with every successful fix.
 *
 *     ┌─────────── Tier 0: cache hit ────────┐
 *     │  query repair_flywheel by signature  │ ← THIS module
 *     │  → reuse the patch that worked       │
 *     └──────────┬───────────────────────────┘
 *                │ miss
 *                ▼
 *     ┌─────────── Tier 1: mechanical ───────┐
 *     │  bun install / biome / prettier      │
 *     └──────────┬───────────────────────────┘
 *                │ no match / failed
 *                ▼
 *     ┌─────────── Tier 2: Claude Sonnet ────┐
 *     │  AI-generated patches                │
 *     └──────────┬───────────────────────────┘
 *                │
 *                ▼
 *           record outcome → flywheel
 *
 * After ~5000 entries the cache dominates: most failures hit a known pattern
 * and get fixed without an AI call. That's the moat — the longer gluecron
 * runs, the more the platform learns about real-world failures.
 *
 * Storage: postgres `repair_flywheel` (drizzle migration 0039).
 *
 * Privacy: per-repo by default. `is_public_pattern=true` opts into cross-repo
 * learning (off by default). Owners can flip the flag per-repo or per-pattern
 * via /admin/repair-flywheel.
 */

import { createHash } from "crypto";
import { and, desc, eq, ne, sql, isNotNull, or } from "drizzle-orm";
import { db } from "../db";
import { repairFlywheel } from "../db/schema";

export type RepairTier = "cached" | "mechanical" | "ai-sonnet" | "human";
export type RepairOutcome = "pending" | "success" | "failed" | "reverted";

export interface CachedRepair {
  id: string;
  patchSummary: string;
  /** Full unified-diff patch (migration 0105). Null on pre-0105 rows — those
   * entries can't be replayed and callers must fall through to the AI tier. */
  patch: string | null;
  filesChanged: string[];
  commitSha: string | null;
  hitCount: number;
  successRate: number; // 0..1
  classification: string | null;
  appliedCount: number;
}

/** Cap on the stored full patch — anything bigger isn't worth replaying. */
const MAX_PATCH_CHARS = 64 * 1024;

// The full-patch column postdates the locked schema.ts (migration 0105), so
// it isn't on the drizzle table object — read it with a raw fragment. If the
// migration hasn't run yet the query throws; callers treat that as a miss.
const patchColumn = sql<string | null>`${repairFlywheel}."patch"`;

// ─────────────────────────────────────────────────────────────────────────
// Fingerprinting — turn any failure text into a stable signature.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalise a failure message so two semantically-identical failures collapse
 * to the same hash. Strips:
 *   - variable line numbers / column numbers (`:42:13`)
 *   - timestamps (any ISO-8601 fragment, any 12-char hex SHA, any UUID)
 *   - absolute paths (`/tmp/...`, `/home/...`, `/opt/...`)
 *   - quoted strings (often contain user data)
 *   - terminal escape sequences
 *   - extra whitespace
 *
 * Trade-off: this is intentionally aggressive. Two failures with the same
 * normalised form ARE considered the same problem. If we get false-collisions
 * later we narrow the rules. Erring on "match more, share more" wins for the
 * flywheel's learning.
 */
export function normaliseFailure(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "") // ANSI colour codes
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.+:Z-]*\b/g, "<TS>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<UUID>",
    )
    .replace(/\b[0-9a-f]{40}\b/gi, "<SHA1>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<SHA256>")
    .replace(/\b[0-9a-f]{12,16}\b/gi, "<HEX>")
    .replace(/\/(?:tmp|home|var|opt|root|usr)[^\s'":,\)\]]+/g, "<PATH>")
    .replace(/[A-Z]:\\[^\s'":,\)\]]+/g, "<PATH>")
    .replace(/:\d+(:\d+)?\b/g, ":<L>")
    .replace(/'[^']*'/g, "'<S>'")
    .replace(/"[^"]*"/g, '"<S>"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** SHA-256 of the normalised failure text. 32 hex chars used as the signature. */
export function fingerprint(failureText: string): string {
  const norm = normaliseFailure(failureText);
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

// ─────────────────────────────────────────────────────────────────────────
// Cache lookup — find a successful past repair for this failure
// ─────────────────────────────────────────────────────────────────────────

/**
 * Find the best cached repair for a given failure signature.
 *
 * Lookup priority:
 *   1. Same repo + same signature + outcome=success — strongest signal
 *   2. Cross-repo with is_public_pattern=true + outcome=success — fallback
 *
 * Returns null if no usable cache entry exists.
 */
export async function findCachedRepair(
  repositoryId: string,
  failureText: string,
): Promise<CachedRepair | null> {
  const sig = fingerprint(failureText);

  // First try: same repo, same signature, prefer the most recent success
  const sameRepo = await db
    .select({ row: repairFlywheel, patch: patchColumn })
    .from(repairFlywheel)
    .where(
      and(
        eq(repairFlywheel.repositoryId, repositoryId),
        eq(repairFlywheel.failureSignature, sig),
        eq(repairFlywheel.outcome, "success"),
      ),
    )
    .orderBy(desc(repairFlywheel.appliedAt))
    .limit(1);

  if (sameRepo.length > 0) {
    return await hydrate(sameRepo[0]!.row, sameRepo[0]!.patch);
  }

  // Fallback: any public pattern with this signature
  const cross = await db
    .select({ row: repairFlywheel, patch: patchColumn })
    .from(repairFlywheel)
    .where(
      and(
        eq(repairFlywheel.failureSignature, sig),
        eq(repairFlywheel.outcome, "success"),
        eq(repairFlywheel.isPublicPattern, true),
      ),
    )
    .orderBy(desc(repairFlywheel.cacheHitCount))
    .limit(1);

  if (cross.length > 0) {
    return await hydrate(cross[0]!.row, cross[0]!.patch);
  }

  return null;
}

async function hydrate(
  row: typeof repairFlywheel.$inferSelect,
  patch: string | null,
): Promise<CachedRepair> {
  // Confidence: count successes vs failures across all entries that share
  // this signature (or its cache lineage). Quick computation, sub-ms in
  // typical use; we'll cache later if this becomes hot. Pending rows are
  // excluded — in-flight repairs haven't settled, and counting them as
  // non-successes would let queued attempts depress a good pattern's score.
  const stats = await db
    .select({
      total: sql<number>`count(*)::int`,
      successes: sql<number>`sum(case when outcome = 'success' then 1 else 0 end)::int`,
    })
    .from(repairFlywheel)
    .where(
      and(
        or(
          eq(repairFlywheel.failureSignature, row.failureSignature),
          eq(repairFlywheel.parentPatternId, row.id),
        ),
        ne(repairFlywheel.outcome, "pending"),
      ),
    );

  const total = Number(stats[0]?.total ?? 0);
  const successes = Number(stats[0]?.successes ?? 0);
  const successRate = total > 0 ? successes / total : 0;

  return {
    id: row.id,
    patchSummary: row.patchSummary,
    patch,
    filesChanged: (row.filesChanged as string[]) ?? [],
    commitSha: row.commitSha,
    hitCount: row.cacheHitCount,
    successRate,
    classification: row.failureClassification,
    appliedCount: total,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Recording — write outcomes back to the flywheel
// ─────────────────────────────────────────────────────────────────────────

export interface RecordRepairInput {
  repositoryId: string | null;
  failureText: string;
  classification: string | null;
  tier: RepairTier;
  patchSummary: string;
  /** Full unified-diff patch so Tier-0 cache hits can replay it. Optional —
   * mechanical repairs have no diff to store. Capped at ~64KB. */
  patch?: string | null;
  filesChanged: string[];
  commitSha: string | null;
  parentPatternId?: string | null;
  outcome?: RepairOutcome; // defaults to 'pending'
  isPublicPattern?: boolean;
}

/**
 * Append a row to the flywheel. Returns the new entry's id so the caller
 * can later updateOutcome() once the smoke test settles.
 *
 * Caps failureText at ~4KB and patchSummary at 400 chars at the write-site.
 */
export async function recordRepair(input: RecordRepairInput): Promise<string> {
  const sig = fingerprint(input.failureText);
  const failureText = input.failureText.slice(0, 4096);
  const patchSummary = input.patchSummary.slice(0, 400);

  const [row] = await db
    .insert(repairFlywheel)
    .values({
      repositoryId: input.repositoryId,
      failureSignature: sig,
      failureText,
      failureClassification: input.classification,
      repairTier: input.tier,
      patchSummary,
      filesChanged: input.filesChanged,
      commitSha: input.commitSha,
      outcome: input.outcome ?? "pending",
      parentPatternId: input.parentPatternId ?? null,
      isPublicPattern: input.isPublicPattern ?? false,
    })
    .returning({ id: repairFlywheel.id });

  // The full patch goes in via raw UPDATE: the "patch" column (migration
  // 0105) postdates the locked schema.ts so it can't ride the drizzle
  // insert above. Best-effort — if it fails (e.g. migration not yet
  // applied) the audit row is still intact, the entry just can't be
  // replayed by the Tier-0 cache.
  if (input.patch) {
    const patch = input.patch.slice(0, MAX_PATCH_CHARS);
    try {
      await db.execute(
        sql`update "repair_flywheel" set "patch" = ${patch} where "id" = ${row!.id}`,
      );
    } catch (err) {
      console.warn(
        "[repair-flywheel] patch write failed (is migration 0105 applied?):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // If this was a cache hit (Tier 0), bump the parent pattern's hit count.
  if (input.parentPatternId) {
    await db
      .update(repairFlywheel)
      .set({ cacheHitCount: sql`${repairFlywheel.cacheHitCount} + 1` })
      .where(eq(repairFlywheel.id, input.parentPatternId));
  }

  return row!.id;
}

/**
 * Update the outcome of a previously-recorded repair. Called after the
 * smoke test or when a human reverts a repair commit.
 */
export async function updateOutcome(
  id: string,
  outcome: Exclude<RepairOutcome, "pending">,
): Promise<void> {
  await db
    .update(repairFlywheel)
    .set({ outcome, outcomeAt: new Date() })
    .where(eq(repairFlywheel.id, id));
}

// ─────────────────────────────────────────────────────────────────────────
// Stats — for /admin/repair-flywheel dashboard
// ─────────────────────────────────────────────────────────────────────────

export interface FlywheelStats {
  totalRepairs: number;
  byTier: Record<RepairTier, number>;
  byClassification: Record<string, number>;
  successRate: number;
  cacheHitRate: number;
  estimatedAiCallsSaved: number;
  topPatterns: Array<{
    signature: string;
    classification: string | null;
    hitCount: number;
    summary: string;
  }>;
}

/**
 * Summary stats across the entire flywheel (or scoped to a single repo).
 * Used by the admin dashboard. Numbers are computed live; cheap enough that
 * we don't need a materialised view yet.
 */
export async function getFlywheelStats(
  repositoryId?: string,
): Promise<FlywheelStats> {
  const repoFilter = repositoryId
    ? eq(repairFlywheel.repositoryId, repositoryId)
    : undefined;

  // Total + per-tier counts in one round trip
  const tierBreakdown = await db
    .select({
      tier: repairFlywheel.repairTier,
      n: sql<number>`count(*)::int`,
    })
    .from(repairFlywheel)
    .where(repoFilter)
    .groupBy(repairFlywheel.repairTier);

  const byTier: Record<RepairTier, number> = {
    cached: 0,
    mechanical: 0,
    "ai-sonnet": 0,
    human: 0,
  };
  let total = 0;
  for (const r of tierBreakdown) {
    byTier[r.tier as RepairTier] = Number(r.n);
    total += Number(r.n);
  }

  // Per-classification counts
  const classBreakdown = await db
    .select({
      cls: repairFlywheel.failureClassification,
      n: sql<number>`count(*)::int`,
    })
    .from(repairFlywheel)
    .where(repoFilter)
    .groupBy(repairFlywheel.failureClassification);

  const byClassification: Record<string, number> = {};
  for (const r of classBreakdown) {
    byClassification[r.cls ?? "ai-patch"] = Number(r.n);
  }

  // Success rate
  const okCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(repairFlywheel)
    .where(
      repoFilter
        ? and(repoFilter, eq(repairFlywheel.outcome, "success"))
        : eq(repairFlywheel.outcome, "success"),
    );
  const successes = Number(okCount[0]?.n ?? 0);
  const successRate = total > 0 ? successes / total : 0;

  // Cache hit rate — % of repairs that came from Tier 0
  const cacheHitRate = total > 0 ? byTier.cached / total : 0;

  // Estimated AI calls saved: each cached + mechanical repair would have
  // been an AI call in the old world.
  const estimatedAiCallsSaved = byTier.cached + byTier.mechanical;

  // Top reused patterns (most cache hits)
  const topPatterns = await db
    .select({
      signature: repairFlywheel.failureSignature,
      classification: repairFlywheel.failureClassification,
      hitCount: repairFlywheel.cacheHitCount,
      summary: repairFlywheel.patchSummary,
    })
    .from(repairFlywheel)
    .where(
      repoFilter
        ? and(repoFilter, sql`${repairFlywheel.cacheHitCount} > 0`)
        : sql`${repairFlywheel.cacheHitCount} > 0`,
    )
    .orderBy(desc(repairFlywheel.cacheHitCount))
    .limit(10);

  return {
    totalRepairs: total,
    byTier,
    byClassification,
    successRate,
    cacheHitRate,
    estimatedAiCallsSaved,
    topPatterns: topPatterns.map((r) => ({
      signature: r.signature,
      classification: r.classification,
      hitCount: r.hitCount,
      summary: r.summary,
    })),
  };
}
