/**
 * Repository Health Score — composite 0-100 signal.
 *
 * Five signals (always totals 100 when fully populated):
 *   CI green rate     25 pts  gate_runs last 30 days
 *   Bus factor        20 pts  bus_factor_cache table
 *   Open CVEs         20 pts  repo_advisory_alerts table
 *   PR review velocity 15 pts pull_requests + pr_comments
 *   Tech debt         20 pts  repo_onboarding_data (neutral 15 if no data)
 *
 * Cached in-memory with a 6-hour TTL. Call invalidateHealthScore(repoId) on
 * every push to force a fresh computation on the next page load.
 */

import { db } from "../db";
import {
  gateRuns,
  busFactorCache,
  repoAdvisoryAlerts,
  pullRequests,
  prComments,
  repoOnboardingData,
} from "../db/schema";
import { eq, and, gte, lt, sql, count, min } from "drizzle-orm";
import type { BusFactorFile } from "./bus-factor";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HealthScoreBreakdown {
  total: number;
  ciGreenRate: {
    score: number;       // 0-25
    rate: number;        // 0.0-1.0
    totalRuns: number;
    passedRuns: number;
  };
  busFactor: {
    score: number;       // 0-20
    atRiskFileCount: number;
    criticalCount: number;
  };
  openCves: {
    score: number;       // 0-20
    count: number;
  };
  reviewVelocity: {
    score: number;       // 0-15
    avgHours: number | null;
    sampleSize: number;
  };
  techDebt: {
    score: number;       // 0-20
    available: boolean;
  };
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  breakdown: HealthScoreBreakdown;
  expiresAt: number; // Date.now() ms
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const memCache = new Map<string, CacheEntry>();

export function invalidateHealthScore(repoId: string): void {
  memCache.delete(repoId);
}

// ---------------------------------------------------------------------------
// Signal: CI green rate (0-25 pts)
// ---------------------------------------------------------------------------

async function ciGreenRate(repoId: string): Promise<HealthScoreBreakdown["ciGreenRate"]> {
  try {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await db
      .select({ status: gateRuns.status })
      .from(gateRuns)
      .where(and(eq(gateRuns.repositoryId, repoId), gte(gateRuns.createdAt, since)));

    if (rows.length === 0) {
      // No runs in last 30 days — benefit of the doubt
      return { score: 20, rate: 1, totalRuns: 0, passedRuns: 0 };
    }

    const totalRuns = rows.length;
    const passedRuns = rows.filter(
      (r) => r.status === "passed" || r.status === "repaired"
    ).length;
    const rate = passedRuns / totalRuns;
    const score = Math.round(rate * 25);
    return { score, rate, totalRuns, passedRuns };
  } catch {
    return { score: 20, rate: 1, totalRuns: 0, passedRuns: 0 };
  }
}

// ---------------------------------------------------------------------------
// Signal: Bus factor (0-20 pts)
// ---------------------------------------------------------------------------

async function busFactorSignal(repoId: string): Promise<HealthScoreBreakdown["busFactor"]> {
  try {
    const rows = await db
      .select()
      .from(busFactorCache)
      .where(eq(busFactorCache.repositoryId, repoId))
      .limit(1);

    if (rows.length === 0) {
      // No cache entry — neutral
      return { score: 15, atRiskFileCount: 0, criticalCount: 0 };
    }

    const atRiskFiles = (rows[0].atRiskFiles ?? []) as BusFactorFile[];
    const criticalCount = atRiskFiles.filter((f) => f.risk === "critical").length;
    const highCount = atRiskFiles.filter((f) => f.risk === "high").length;

    // Start at 20, subtract penalty per risky file (capped)
    const criticalPenalty = Math.min(criticalCount * 5, 20);
    const highPenalty = Math.min(highCount * 2, 10);
    const score = Math.max(0, 20 - criticalPenalty - highPenalty);

    return { score, atRiskFileCount: atRiskFiles.length, criticalCount };
  } catch {
    return { score: 15, atRiskFileCount: 0, criticalCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Signal: Open CVEs (0-20 pts)
// ---------------------------------------------------------------------------

async function openCvesSignal(repoId: string): Promise<HealthScoreBreakdown["openCves"]> {
  try {
    const rows = await db
      .select({ n: count() })
      .from(repoAdvisoryAlerts)
      .where(
        and(
          eq(repoAdvisoryAlerts.repositoryId, repoId),
          eq(repoAdvisoryAlerts.status, "open")
        )
      );

    const cveCount = Number(rows[0]?.n ?? 0);
    let score: number;
    if (cveCount === 0)      score = 20;
    else if (cveCount === 1) score = 15;
    else if (cveCount === 2) score = 10;
    else if (cveCount <= 4)  score = 5;
    else                     score = 0;

    return { score, count: cveCount };
  } catch {
    return { score: 20, count: 0 };
  }
}

// ---------------------------------------------------------------------------
// Signal: PR review velocity (0-15 pts)
// ---------------------------------------------------------------------------

async function reviewVelocitySignal(repoId: string): Promise<HealthScoreBreakdown["reviewVelocity"]> {
  try {
    const since = new Date(Date.now() - 30 * 86_400_000);

    // Get merged PRs from last 30 days with their first human review comment timestamp
    const rows = await db
      .select({
        prId: pullRequests.id,
        prCreatedAt: pullRequests.createdAt,
        firstReview: min(prComments.createdAt),
      })
      .from(pullRequests)
      .innerJoin(
        prComments,
        and(
          eq(prComments.pullRequestId, pullRequests.id),
          eq(prComments.isAiReview, false)
        )
      )
      .where(
        and(
          eq(pullRequests.repositoryId, repoId),
          eq(pullRequests.state, "merged"),
          gte(pullRequests.createdAt, since)
        )
      )
      .groupBy(pullRequests.id, pullRequests.createdAt)
      .limit(20);

    if (rows.length === 0) {
      return { score: 0, avgHours: null, sampleSize: 0 };
    }

    // Compute average hours from PR creation to first review
    let totalHours = 0;
    let validCount = 0;
    for (const row of rows) {
      if (row.firstReview && row.prCreatedAt) {
        const diffMs =
          new Date(row.firstReview).getTime() -
          new Date(row.prCreatedAt).getTime();
        if (diffMs >= 0) {
          totalHours += diffMs / 3_600_000;
          validCount++;
        }
      }
    }

    if (validCount === 0) {
      return { score: 0, avgHours: null, sampleSize: rows.length };
    }

    const avgHours = totalHours / validCount;
    let score: number;
    if (avgHours < 4)       score = 15;
    else if (avgHours < 8)  score = 12;
    else if (avgHours < 24) score = 8;
    else if (avgHours < 72) score = 4;
    else                    score = 0;

    return { score, avgHours, sampleSize: validCount };
  } catch {
    return { score: 0, avgHours: null, sampleSize: 0 };
  }
}

// ---------------------------------------------------------------------------
// Signal: Tech debt (0-20 pts)
// ---------------------------------------------------------------------------

async function techDebtSignal(repoId: string): Promise<HealthScoreBreakdown["techDebt"]> {
  try {
    const rows = await db
      .select()
      .from(repoOnboardingData)
      .where(eq(repoOnboardingData.repositoryId, repoId))
      .limit(1);

    if (rows.length === 0) {
      // No onboarding data — neutral
      return { score: 15, available: false };
    }

    // Onboarding data exists but doesn't carry a debtScore field in schema v1 —
    // give the neutral 15-pt benefit of the doubt.
    return { score: 15, available: true };
  } catch {
    return { score: 15, available: false };
  }
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export async function computeHealthScore(
  repoId: string
): Promise<HealthScoreBreakdown> {
  const [ci, bf, cve, vel, debt] = await Promise.all([
    ciGreenRate(repoId),
    busFactorSignal(repoId),
    openCvesSignal(repoId),
    reviewVelocitySignal(repoId),
    techDebtSignal(repoId),
  ]);

  const total = Math.min(
    100,
    ci.score + bf.score + cve.score + vel.score + debt.score
  );

  return {
    total,
    ciGreenRate: ci,
    busFactor: bf,
    openCves: cve,
    reviewVelocity: vel,
    techDebt: debt,
    computedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Cached version (6h TTL)
// ---------------------------------------------------------------------------

export async function getHealthScore(
  repoId: string
): Promise<HealthScoreBreakdown> {
  const now = Date.now();
  const cached = memCache.get(repoId);
  if (cached && cached.expiresAt > now) {
    return cached.breakdown;
  }

  const breakdown = await computeHealthScore(repoId);
  memCache.set(repoId, {
    breakdown,
    expiresAt: now + CACHE_TTL_MS,
  });
  return breakdown;
}
