/**
 * Org-level team health computation.
 *
 * Aggregates per-repo health scores across every active repo in an org,
 * produces a worst-first ranked list, and generates an AI summary.
 *
 * Cache: in-memory, 1h TTL per orgId. Call invalidateOrgHealth(orgId) to
 * force a fresh computation on the next request.
 */

import { eq, and, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, repoHealthCache } from "../db/schema";
import { getHealthScore, invalidateHealthScore, type HealthScoreBreakdown } from "./repo-health";
import { getAnthropic, isAiAvailable, extractText, MODEL_SONNET } from "./ai-client";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OrgRepoHealth {
  repoId: string;
  repoName: string;
  ownerName: string;
  score: number;            // 0-100
  trend: "up" | "down" | "stable";  // compare to last week's cached score
  breakdown: HealthScoreBreakdown;
}

export interface OrgHealthReport {
  orgSlug: string;
  orgName: string;
  avgScore: number;
  repos: OrgRepoHealth[];   // sorted by score asc (worst first)
  aiSummary: string;        // Claude paragraph: org health state + top 3 actions
  generatedAt: Date;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

interface OrgCacheEntry {
  report: OrgHealthReport;
  expiresAt: number; // Date.now() ms
}

const ORG_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const orgCache = new Map<string, OrgCacheEntry>();

export function invalidateOrgHealth(orgId: string): void {
  orgCache.delete(orgId);
}

// ---------------------------------------------------------------------------
// Trend detection: compare current score to last week's DB-cached score
// ---------------------------------------------------------------------------

async function getTrendForRepo(
  repoId: string,
  currentScore: number
): Promise<"up" | "down" | "stable"> {
  try {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Look for a cached entry computed more than 7 days ago as the prior-week baseline
    const rows = await db
      .select({ score: repoHealthCache.score, computedAt: repoHealthCache.computedAt })
      .from(repoHealthCache)
      .where(
        and(
          eq(repoHealthCache.repoId, repoId),
          lt(repoHealthCache.computedAt, oneWeekAgo)
        )
      )
      .limit(1);

    if (rows.length === 0) return "stable";

    const priorScore = rows[0].score;
    if (currentScore > priorScore + 2) return "up";
    if (currentScore < priorScore - 2) return "down";
    return "stable";
  } catch {
    return "stable";
  }
}

// ---------------------------------------------------------------------------
// AI summary generation
// ---------------------------------------------------------------------------

async function generateAiSummary(
  orgName: string,
  repos: OrgRepoHealth[]
): Promise<string> {
  if (!isAiAvailable() || repos.length === 0) return "";

  try {
    const repoLines = repos
      .map((r) => {
        const bd = r.breakdown;
        return (
          `${r.repoName}: ${r.score}/100 ` +
          `(CI:${bd.ciGreenRate.score}, BusFactor:${bd.busFactor.score}, ` +
          `CVEs:${bd.openCves.score}, ReviewSpeed:${bd.reviewVelocity.score}, Debt:${bd.techDebt.score})`
        );
      })
      .join("\n");

    const prompt =
      `You are an engineering manager. Given these repository health scores for org ${orgName}, ` +
      `write 2-3 sentences summarising the overall health and exactly 3 concrete action items ` +
      `numbered 1-3. Be direct. No fluff.\n\nRepos (worst first):\n${repoLines}`;

    const anthropic = getAnthropic();
    const message = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    return extractText(message);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Core computation
// ---------------------------------------------------------------------------

export async function computeOrgHealth(
  orgId: string,
  orgSlug: string
): Promise<OrgHealthReport> {
  // Check in-memory cache first
  const now = Date.now();
  const cached = orgCache.get(orgId);
  if (cached && cached.expiresAt > now) {
    return cached.report;
  }

  const emptyReport: OrgHealthReport = {
    orgSlug,
    orgName: orgSlug,
    avgScore: 0,
    repos: [],
    aiSummary: "",
    generatedAt: new Date(),
  };

  try {
    // 1. Load all non-archived repos in the org
    const repos = await db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, orgId),
          eq(repositories.isArchived, false)
        )
      )
      .orderBy(repositories.name);

    if (repos.length === 0) {
      const report = { ...emptyReport };
      orgCache.set(orgId, { report, expiresAt: now + ORG_CACHE_TTL_MS });
      return report;
    }

    // 2. Compute health scores in parallel (cap at 20 repos)
    const capped = repos.slice(0, 20);
    const breakdowns = await Promise.all(
      capped.map((r) => getHealthScore(r.id))
    );

    // 3. Get trends in parallel
    const trends = await Promise.all(
      capped.map((r, i) => getTrendForRepo(r.id, breakdowns[i].total))
    );

    // 4. Build OrgRepoHealth array
    const repoHealthList: OrgRepoHealth[] = capped.map((r, i) => ({
      repoId: r.id,
      repoName: r.name,
      ownerName: orgSlug,
      score: breakdowns[i].total,
      trend: trends[i],
      breakdown: breakdowns[i],
    }));

    // 5. Sort by score ascending (worst first — action list)
    repoHealthList.sort((a, b) => a.score - b.score);

    // 6. Compute average score
    const sum = repoHealthList.reduce((acc, r) => acc + r.score, 0);
    const avgScore = Math.round(sum / repoHealthList.length);

    // 7. Generate AI summary
    const aiSummary = await generateAiSummary(orgSlug, repoHealthList);

    const report: OrgHealthReport = {
      orgSlug,
      orgName: orgSlug,
      avgScore,
      repos: repoHealthList,
      aiSummary,
      generatedAt: new Date(),
    };

    orgCache.set(orgId, { report, expiresAt: now + ORG_CACHE_TTL_MS });
    return report;
  } catch (err) {
    const errorSummary =
      err instanceof Error ? `Error computing org health: ${err.message}` : "Error computing org health.";
    const report: OrgHealthReport = {
      ...emptyReport,
      aiSummary: errorSummary,
    };
    return report;
  }
}

/**
 * Invalidate health caches for all repos in an org and clear the org cache.
 * Called from the POST /orgs/:slug/health/recompute endpoint.
 */
export async function invalidateOrgHealthAndRepos(
  orgId: string
): Promise<void> {
  invalidateOrgHealth(orgId);
  try {
    const repos = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.orgId, orgId),
          eq(repositories.isArchived, false)
        )
      );
    for (const r of repos) {
      invalidateHealthScore(r.id);
    }
  } catch {
    // best effort
  }
}
