import {
  pgTable,
  uuid,
  integer,
  text,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { eq, and, desc, gte, or, sql, inArray } from "drizzle-orm";
import { db } from "../db/index";
import {
  repositories,
  gateRuns,
  pullRequests,
  prComments,
  repoAdvisoryAlerts,
  securityAdvisories,
  repoDependencies,
  branchProtection,
  commitVerifications,
} from "../db/schema";
import { getTree } from "../git/repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthIssue {
  category: "security" | "gates" | "ai_review" | "dependencies" | "code_quality";
  message: string;
  severity: "critical" | "high" | "medium" | "low";
}

export interface HealthRecommendation {
  category: "security" | "gates" | "ai_review" | "dependencies" | "code_quality";
  message: string;
  priority: "high" | "medium" | "low";
}

export interface HealthScoreResult {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  securityScore: number;
  gatesScore: number;
  aiReviewScore: number;
  dependenciesScore: number;
  codeQualityScore: number;
  issues: HealthIssue[];
  recommendations: HealthRecommendation[];
  breakdown: {
    security: { label: string; value: string }[];
    gates: { label: string; value: string }[];
    aiReview: { label: string; value: string }[];
    dependencies: { label: string; value: string }[];
    codeQuality: { label: string; value: string }[];
  };
}

export interface StoredHealthScore extends HealthScoreResult {
  id: string;
  repositoryId: string;
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// Drizzle table definition (inline — not in schema.ts)
// ---------------------------------------------------------------------------

export const repoHealthScores = pgTable("repo_health_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id").notNull(),
  score: integer("score").notNull(),
  grade: text("grade").notNull(),
  securityScore: integer("security_score").notNull(),
  gatesScore: integer("gates_score").notNull(),
  aiReviewScore: integer("ai_review_score").notNull(),
  dependenciesScore: integer("dependencies_score").notNull(),
  codeQualityScore: integer("code_quality_score").notNull(),
  recommendations: jsonb("recommendations")
    .$type<HealthRecommendation[]>()
    .notNull()
    .default([]),
  issuesFound: jsonb("issues_found")
    .$type<HealthIssue[]>()
    .notNull()
    .default([]),
  computedAt: timestamp("computed_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ---------------------------------------------------------------------------
// Grade helpers
// ---------------------------------------------------------------------------

function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 45) return "D";
  return "F";
}

export function getBadgeColor(grade: string): string {
  switch (grade) {
    case "A":
      return "#2ea44f";
    case "B":
      return "#44cc11";
    case "C":
      return "#dfb317";
    case "D":
      return "#fe7d37";
    case "F":
      return "#e05d44";
    default:
      return "#9f9f9f";
  }
}

// ---------------------------------------------------------------------------
// Severity / priority sort helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_ORDER: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// ---------------------------------------------------------------------------
// Category scorers
// ---------------------------------------------------------------------------

async function computeSecurityScore(
  repositoryId: string
): Promise<{
  score: number;
  issues: HealthIssue[];
  recommendations: HealthRecommendation[];
  breakdown: { label: string; value: string }[];
}> {
  const issues: HealthIssue[] = [];
  const recommendations: HealthRecommendation[] = [];
  const breakdown: { label: string; value: string }[] = [];

  let score = 30;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Query open advisory alerts joined with security_advisories
  const alerts = await db
    .select({
      id: repoAdvisoryAlerts.id,
      status: repoAdvisoryAlerts.status,
      severity: securityAdvisories.severity,
      summary: securityAdvisories.summary,
    })
    .from(repoAdvisoryAlerts)
    .innerJoin(
      securityAdvisories,
      eq(repoAdvisoryAlerts.advisoryId, securityAdvisories.id)
    )
    .where(
      and(
        eq(repoAdvisoryAlerts.repositoryId, repositoryId),
        eq(repoAdvisoryAlerts.status, "open")
      )
    );

  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  const highAlerts = alerts.filter((a) => a.severity === "high");
  const moderateAlerts = alerts.filter((a) => a.severity === "moderate");
  const lowAlerts = alerts.filter((a) => a.severity === "low");

  // Deduct for critical alerts
  if (criticalAlerts.length > 0) {
    score -= 15;
    for (const a of criticalAlerts) {
      issues.push({
        category: "security",
        message: `Open critical security advisory: ${a.summary}`,
        severity: "critical",
      });
    }
  } else if (highAlerts.length > 0) {
    // Only deduct for high if no critical
    score -= 10;
  }

  // Deduct for high alerts (issues recorded regardless of critical presence)
  for (const a of highAlerts) {
    issues.push({
      category: "security",
      message: `Open high-severity advisory: ${a.summary}`,
      severity: "high",
    });
  }

  // Deduct for moderate: -5 per alert, max -10
  const moderatePenalty = Math.min(moderateAlerts.length * 5, 10);
  score -= moderatePenalty;

  // Deduct for low: -3 per alert, max -6
  const lowPenalty = Math.min(lowAlerts.length * 3, 6);
  score -= lowPenalty;

  // Security gate runs in last 30 days
  const securityGateRuns = await db
    .select({
      id: gateRuns.id,
      status: gateRuns.status,
      createdAt: gateRuns.createdAt,
    })
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.repositoryId, repositoryId),
        gte(gateRuns.createdAt, thirtyDaysAgo),
        or(
          sql`lower(${gateRuns.gateName}) like '%security%'`,
          sql`lower(${gateRuns.gateName}) like '%scan%'`,
          sql`lower(${gateRuns.gateName}) like '%secret%'`
        )
      )
    )
    .orderBy(desc(gateRuns.createdAt));

  if (securityGateRuns.length > 0) {
    const latest = securityGateRuns[0];
    if (latest.status === "failed") {
      score -= 8;
    } else if (latest.status === "repaired") {
      score -= 2;
    }
    breakdown.push({
      label: "Latest security gate",
      value: latest.status,
    });
  } else {
    breakdown.push({ label: "Latest security gate", value: "none" });
  }

  breakdown.push({
    label: "Open advisories",
    value: String(criticalAlerts.length + highAlerts.length + moderateAlerts.length + lowAlerts.length),
  });

  score = Math.max(0, Math.min(30, score));

  if (score < 25) {
    recommendations.push({
      category: "security",
      message:
        "Run a security scan — go to Gates → Security to trigger one",
      priority: score < 15 ? "high" : "medium",
    });
  }

  return { score, issues, recommendations, breakdown };
}

async function computeGatesScore(
  repositoryId: string
): Promise<{
  score: number;
  issues: HealthIssue[];
  recommendations: HealthRecommendation[];
  breakdown: { label: string; value: string }[];
}> {
  const issues: HealthIssue[] = [];
  const recommendations: HealthRecommendation[] = [];
  const breakdown: { label: string; value: string }[] = [];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const runs = await db
    .select({
      id: gateRuns.id,
      status: gateRuns.status,
    })
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.repositoryId, repositoryId),
        gte(gateRuns.createdAt, thirtyDaysAgo)
      )
    )
    .orderBy(desc(gateRuns.createdAt));

  const total_count = runs.length;

  if (total_count === 0) {
    breakdown.push({ label: "Green rate (30d)", value: "N/A" });
    breakdown.push({ label: "Total gate runs", value: "0" });
    return { score: 20, issues, recommendations, breakdown };
  }

  const green_count = runs.filter(
    (r) => r.status === "passed" || r.status === "repaired"
  ).length;

  const rate = green_count / total_count;
  const score = Math.round(rate * 25);

  breakdown.push({
    label: "Green rate (30d)",
    value: `${Math.round(rate * 100)}%`,
  });
  breakdown.push({ label: "Total gate runs", value: String(total_count) });

  if (rate < 0.5) {
    issues.push({
      category: "gates",
      message: `Gate green rate is ${Math.round(rate * 100)}% over the last 30 days`,
      severity: "high",
    });
  }

  if (score < 20) {
    recommendations.push({
      category: "gates",
      message:
        "Enable gate enforcement on push to catch failures before they merge",
      priority: "medium",
    });
  }

  return { score, issues, recommendations, breakdown };
}

async function computeAiReviewScore(
  repositoryId: string
): Promise<{
  score: number;
  issues: HealthIssue[];
  recommendations: HealthRecommendation[];
  breakdown: { label: string; value: string }[];
}> {
  const issues: HealthIssue[] = [];
  const recommendations: HealthRecommendation[] = [];
  const breakdown: { label: string; value: string }[] = [];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // PRs in last 30 days that are not draft
  const prs = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        gte(pullRequests.createdAt, thirtyDaysAgo),
        eq(pullRequests.isDraft, false)
      )
    );

  const total_prs = prs.length;

  if (total_prs === 0) {
    breakdown.push({ label: "PRs reviewed by AI", value: "0/0" });
    return { score: 18, issues, recommendations, breakdown };
  }

  const prIds = prs.map((p) => p.id);

  // AI review comments on those PRs
  const aiComments = await db
    .select({
      pullRequestId: prComments.pullRequestId,
      body: prComments.body,
    })
    .from(prComments)
    .where(
      and(
        inArray(prComments.pullRequestId, prIds),
        eq(prComments.isAiReview, true)
      )
    );

  if (aiComments.length === 0) {
    breakdown.push({ label: "PRs reviewed by AI", value: `0/${total_prs}` });
    recommendations.push({
      category: "ai_review",
      message:
        "Enable AI code review — it triggers automatically on every new PR",
      priority: "high",
    });
    return { score: 8, issues, recommendations, breakdown };
  }

  // Group AI comments by PR
  const prCommentMap = new Map<string, string[]>();
  for (const c of aiComments) {
    const existing = prCommentMap.get(c.pullRequestId) ?? [];
    existing.push(c.body);
    prCommentMap.set(c.pullRequestId, existing);
  }

  const reviewed_count = prCommentMap.size;
  const review_rate = reviewed_count / total_prs;

  // Count approved: AI review comment body contains "✓ Approved" or "approved" (case-insensitive)
  let approved_count = 0;
  for (const [, bodies] of prCommentMap) {
    const hasApproval = bodies.some(
      (b) =>
        b.includes("✓ Approved") ||
        b.toLowerCase().includes("approved")
    );
    if (hasApproval) approved_count++;
  }

  const approval_rate = approved_count / Math.max(reviewed_count, 1);
  const score = Math.round(review_rate * 10 + approval_rate * 10);

  breakdown.push({
    label: "PRs reviewed by AI",
    value: `${reviewed_count}/${total_prs}`,
  });

  return { score, issues, recommendations, breakdown };
}

async function computeDependenciesScore(
  repositoryId: string
): Promise<{
  score: number;
  issues: HealthIssue[];
  recommendations: HealthRecommendation[];
  breakdown: { label: string; value: string }[];
}> {
  const issues: HealthIssue[] = [];
  const recommendations: HealthRecommendation[] = [];
  const breakdown: { label: string; value: string }[] = [];

  // Count dependencies
  const deps = await db
    .select({ id: repoDependencies.id })
    .from(repoDependencies)
    .where(eq(repoDependencies.repositoryId, repositoryId));

  const dep_count = deps.length;

  if (dep_count === 0) {
    breakdown.push({ label: "Dependencies tracked", value: "0" });
    breakdown.push({ label: "Open advisories", value: "0" });
    return { score: 15, issues, recommendations, breakdown };
  }

  // All open advisory alerts for this repo
  const alerts = await db
    .select({
      severity: securityAdvisories.severity,
      status: repoAdvisoryAlerts.status,
    })
    .from(repoAdvisoryAlerts)
    .innerJoin(
      securityAdvisories,
      eq(repoAdvisoryAlerts.advisoryId, securityAdvisories.id)
    )
    .where(
      and(
        eq(repoAdvisoryAlerts.repositoryId, repositoryId),
        eq(repoAdvisoryAlerts.status, "open")
      )
    );

  const open_critical = alerts.filter((a) => a.severity === "critical").length;
  const open_high = alerts.filter((a) => a.severity === "high").length;
  const open_moderate = alerts.filter((a) => a.severity === "moderate").length;

  let score = 15 - open_critical * 5 - open_high * 3 - open_moderate * 1;
  score = Math.max(0, Math.min(15, score));

  breakdown.push({
    label: "Dependencies tracked",
    value: String(dep_count),
  });
  breakdown.push({
    label: "Open advisories",
    value: String(open_critical + open_high + open_moderate),
  });

  if (open_critical + open_high > 0) {
    recommendations.push({
      category: "dependencies",
      message:
        "Update vulnerable dependencies — check Security → Advisories for details",
      priority: "high",
    });
  }

  return { score, issues, recommendations, breakdown };
}

async function computeCodeQualityScore(
  repositoryId: string,
  owner: string,
  repoName: string
): Promise<{
  score: number;
  issues: HealthIssue[];
  recommendations: HealthRecommendation[];
  breakdown: { label: string; value: string }[];
}> {
  const issues: HealthIssue[] = [];
  const recommendations: HealthRecommendation[] = [];
  const breakdown: { label: string; value: string }[] = [];

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let score = 0;

  // 1. Branch protection for default branch
  const repo = await db
    .select({ defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);

  const defaultBranch = repo[0]?.defaultBranch ?? "main";

  const protection = await db
    .select({ id: branchProtection.id })
    .from(branchProtection)
    .where(
      and(
        eq(branchProtection.repositoryId, repositoryId),
        eq(branchProtection.pattern, defaultBranch)
      )
    )
    .limit(1);

  const hasBranchProtection = protection.length > 0;

  if (hasBranchProtection) {
    score += 3;
    breakdown.push({ label: "Branch protection", value: "enabled" });
  } else {
    breakdown.push({ label: "Branch protection", value: "none" });
    recommendations.push({
      category: "code_quality",
      message: "Enable branch protection on your default branch",
      priority: "medium",
    });
  }

  // 2. CODEOWNERS — check gate runs first, then git tree
  let hasCodeowners = false;

  const codeownersGateRun = await db
    .select({ id: gateRuns.id, status: gateRuns.status })
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.repositoryId, repositoryId),
        gte(gateRuns.createdAt, thirtyDaysAgo),
        sql`lower(${gateRuns.gateName}) = 'codeowners'`
      )
    )
    .orderBy(desc(gateRuns.createdAt))
    .limit(1);

  if (codeownersGateRun.length > 0 && codeownersGateRun[0].status === "passed") {
    hasCodeowners = true;
  } else {
    // Check git tree for CODEOWNERS file
    try {
      const tree = await getTree(owner, repoName, defaultBranch);
      hasCodeowners = tree.some(
        (entry) => entry.name === "CODEOWNERS" && entry.type === "blob"
      );
    } catch {
      hasCodeowners = false;
    }
  }

  if (hasCodeowners) {
    score += 2;
    breakdown.push({ label: "CODEOWNERS", value: "found" });
  } else {
    breakdown.push({ label: "CODEOWNERS", value: "not found" });
    recommendations.push({
      category: "code_quality",
      message:
        "Set up a CODEOWNERS file to automatically request reviews",
      priority: "low",
    });
  }

  // 3. Commit verifications — last 10 commits
  const verifications = await db
    .select({ verified: commitVerifications.verified })
    .from(commitVerifications)
    .where(eq(commitVerifications.repositoryId, repositoryId))
    .orderBy(desc(commitVerifications.verifiedAt))
    .limit(10);

  const verified_count = verifications.filter((v) => v.verified).length;

  if (verified_count >= 5) {
    score += 2;
    breakdown.push({
      label: "Verified commits (last 10)",
      value: `${verified_count}/10`,
    });
  } else if (verified_count >= 1) {
    score += 1;
    breakdown.push({
      label: "Verified commits (last 10)",
      value: `${verified_count}/10`,
    });
  } else {
    breakdown.push({
      label: "Verified commits (last 10)",
      value: `${verified_count}/10`,
    });
  }

  // 4. CI activity — any gate/workflow run in last 7 days
  const recentActivity = await db
    .select({ id: gateRuns.id })
    .from(gateRuns)
    .where(
      and(
        eq(gateRuns.repositoryId, repositoryId),
        gte(gateRuns.createdAt, sevenDaysAgo)
      )
    )
    .limit(1);

  if (recentActivity.length > 0) {
    score += 3;
    breakdown.push({ label: "CI activity (7d)", value: "active" });
  } else {
    breakdown.push({ label: "CI activity (7d)", value: "none" });
  }

  score = Math.max(0, Math.min(10, score));

  return { score, issues, recommendations, breakdown };
}

// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

export async function computeHealthScore(
  repositoryId: string,
  owner: string,
  repoName: string
): Promise<HealthScoreResult> {
  try {
    const [security, gates, aiReview, dependencies, codeQuality] =
      await Promise.all([
        computeSecurityScore(repositoryId),
        computeGatesScore(repositoryId),
        computeAiReviewScore(repositoryId),
        computeDependenciesScore(repositoryId),
        computeCodeQualityScore(repositoryId, owner, repoName),
      ]);

    const totalScore =
      security.score +
      gates.score +
      aiReview.score +
      dependencies.score +
      codeQuality.score;

    const allIssues: HealthIssue[] = [
      ...security.issues,
      ...gates.issues,
      ...aiReview.issues,
      ...dependencies.issues,
      ...codeQuality.issues,
    ].sort(
      (a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 99) -
        (SEVERITY_ORDER[b.severity] ?? 99)
    );

    const allRecommendations: HealthRecommendation[] = [
      ...security.recommendations,
      ...gates.recommendations,
      ...aiReview.recommendations,
      ...dependencies.recommendations,
      ...codeQuality.recommendations,
    ].sort(
      (a, b) =>
        (PRIORITY_ORDER[a.priority] ?? 99) -
        (PRIORITY_ORDER[b.priority] ?? 99)
    );

    return {
      score: totalScore,
      grade: scoreToGrade(totalScore),
      securityScore: security.score,
      gatesScore: gates.score,
      aiReviewScore: aiReview.score,
      dependenciesScore: dependencies.score,
      codeQualityScore: codeQuality.score,
      issues: allIssues,
      recommendations: allRecommendations,
      breakdown: {
        security: security.breakdown,
        gates: gates.breakdown,
        aiReview: aiReview.breakdown,
        dependencies: dependencies.breakdown,
        codeQuality: codeQuality.breakdown,
      },
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error during health score computation";
    return {
      score: 0,
      grade: "F",
      securityScore: 0,
      gatesScore: 0,
      aiReviewScore: 0,
      dependenciesScore: 0,
      codeQualityScore: 0,
      issues: [
        {
          category: "code_quality",
          message: `Health score computation failed: ${errorMessage}`,
          severity: "critical",
        },
      ],
      recommendations: [],
      breakdown: {
        security: [],
        gates: [],
        aiReview: [],
        dependencies: [],
        codeQuality: [],
      },
    };
  }
}

export async function computeAndStoreHealthScore(
  repositoryId: string,
  owner: string,
  repoName: string
): Promise<StoredHealthScore> {
  const result = await computeHealthScore(repositoryId, owner, repoName);

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Check if a record already exists for this repo today
  const existing = await db
    .select({ id: repoHealthScores.id })
    .from(repoHealthScores)
    .where(
      and(
        eq(repoHealthScores.repositoryId, repositoryId),
        gte(repoHealthScores.computedAt, todayStart)
      )
    )
    .limit(1);

  const now = new Date();

  if (existing.length > 0) {
    // Update the existing row for today
    const updated = await db
      .update(repoHealthScores)
      .set({
        score: result.score,
        grade: result.grade,
        securityScore: result.securityScore,
        gatesScore: result.gatesScore,
        aiReviewScore: result.aiReviewScore,
        dependenciesScore: result.dependenciesScore,
        codeQualityScore: result.codeQualityScore,
        recommendations: result.recommendations,
        issuesFound: result.issues,
        computedAt: now,
      })
      .where(eq(repoHealthScores.id, existing[0].id))
      .returning();

    const row = updated[0];
    return rowToStoredScore(row, result);
  } else {
    // Insert a new row
    const inserted = await db
      .insert(repoHealthScores)
      .values({
        repositoryId,
        score: result.score,
        grade: result.grade,
        securityScore: result.securityScore,
        gatesScore: result.gatesScore,
        aiReviewScore: result.aiReviewScore,
        dependenciesScore: result.dependenciesScore,
        codeQualityScore: result.codeQualityScore,
        recommendations: result.recommendations,
        issuesFound: result.issues,
        computedAt: now,
      })
      .returning();

    const row = inserted[0];
    return rowToStoredScore(row, result);
  }
}

export async function getLatestHealthScore(
  repositoryId: string
): Promise<StoredHealthScore | null> {
  const rows = await db
    .select()
    .from(repoHealthScores)
    .where(eq(repoHealthScores.repositoryId, repositoryId))
    .orderBy(desc(repoHealthScores.computedAt))
    .limit(1);

  if (rows.length === 0) return null;

  return dbRowToStoredScore(rows[0]);
}

export async function getHealthScoreHistory(
  repositoryId: string,
  limit = 30
): Promise<StoredHealthScore[]> {
  const rows = await db
    .select()
    .from(repoHealthScores)
    .where(eq(repoHealthScores.repositoryId, repositoryId))
    .orderBy(desc(repoHealthScores.computedAt))
    .limit(limit);

  return rows.map(dbRowToStoredScore);
}

// ---------------------------------------------------------------------------
// Row → StoredHealthScore helpers
// ---------------------------------------------------------------------------

type DbRow = typeof repoHealthScores.$inferSelect;

function rowToStoredScore(
  row: DbRow,
  result: HealthScoreResult
): StoredHealthScore {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    computedAt: row.computedAt,
    score: row.score,
    grade: row.grade as "A" | "B" | "C" | "D" | "F",
    securityScore: row.securityScore,
    gatesScore: row.gatesScore,
    aiReviewScore: row.aiReviewScore,
    dependenciesScore: row.dependenciesScore,
    codeQualityScore: row.codeQualityScore,
    issues: (row.issuesFound as HealthIssue[]) ?? [],
    recommendations: (row.recommendations as HealthRecommendation[]) ?? [],
    breakdown: result.breakdown,
  };
}

function dbRowToStoredScore(row: DbRow): StoredHealthScore {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    computedAt: row.computedAt,
    score: row.score,
    grade: row.grade as "A" | "B" | "C" | "D" | "F",
    securityScore: row.securityScore,
    gatesScore: row.gatesScore,
    aiReviewScore: row.aiReviewScore,
    dependenciesScore: row.dependenciesScore,
    codeQualityScore: row.codeQualityScore,
    issues: (row.issuesFound as HealthIssue[]) ?? [],
    recommendations: (row.recommendations as HealthRecommendation[]) ?? [],
    // Breakdown is not stored — return empty skeleton when reading from DB
    breakdown: {
      security: [],
      gates: [],
      aiReview: [],
      dependencies: [],
      codeQuality: [],
    },
  };
}
