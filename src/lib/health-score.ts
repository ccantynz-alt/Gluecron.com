import { db } from "../db";
import { gateRuns, pullRequests, issues, repoAdvisoryAlerts } from "../db/schema";
import { eq, and, gte, sql, count } from "drizzle-orm";

export interface HealthComponent {
  score: number;
  max: number;
  label: string;
  hint: string;
}

export interface HealthScore {
  total: number;
  grade: "elite" | "strong" | "improving" | "needs-attention";
  components: {
    security: HealthComponent;
    greenGates: HealthComponent;
    velocity: HealthComponent;
    maintenance: HealthComponent;
  };
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export async function computeHealthScore(repoId: string): Promise<HealthScore> {
  const since30d = new Date(Date.now() - 30 * 86400e3);
  const since90d = new Date(Date.now() - 90 * 86400e3);

  const [advisoryCount, gateResult, prResult, issueResult] = await Promise.all([
    db
      .select({ n: count() })
      .from(repoAdvisoryAlerts)
      .where(and(eq(repoAdvisoryAlerts.repositoryId, repoId), eq(repoAdvisoryAlerts.status, "open")))
      .then(r => Number(r[0]?.n ?? 0))
      .catch(() => 0),

    db
      .select({
        total: count(),
        passed: sql<number>`count(*) filter (where ${gateRuns.status} in ('passed','repaired'))`,
      })
      .from(gateRuns)
      .where(and(eq(gateRuns.repositoryId, repoId), gte(gateRuns.createdAt, since30d)))
      .then(r => r[0] ?? { total: 0, passed: 0 })
      .catch(() => ({ total: 0, passed: 0 })),

    db
      .select({
        avgMinutes: sql<number>`avg(extract(epoch from (${pullRequests.mergedAt} - ${pullRequests.createdAt})) / 60)`,
      })
      .from(pullRequests)
      .where(and(eq(pullRequests.repositoryId, repoId), eq(pullRequests.state, "merged"), gte(pullRequests.mergedAt, since90d)))
      .then(r => r[0]?.avgMinutes ?? null)
      .catch(() => null),

    db
      .select({
        avgDays: sql<number>`avg(extract(epoch from (now() - ${issues.createdAt})) / 86400)`,
      })
      .from(issues)
      .where(and(eq(issues.repositoryId, repoId), eq(issues.state, "open")))
      .then(r => r[0]?.avgDays ?? null)
      .catch(() => null),
  ]);

  // Security (0-30)
  const secScore = advisoryCount === 0 ? 30 : advisoryCount === 1 ? 20 : advisoryCount <= 2 ? 15 : advisoryCount <= 4 ? 8 : 0;
  const secHint = advisoryCount === 0 ? "No open advisories" : `${advisoryCount} open advisor${advisoryCount === 1 ? "y" : "ies"}`;

  // Green gates (0-25)
  const total = Number(gateResult.total);
  const passed = Number(gateResult.passed);
  const rate = total > 0 ? passed / total : 1;
  const gateScore = total > 0 ? Math.round(rate * 25) : 12;
  const gateHint = total > 0 ? `${Math.round(rate * 100)}% passed (${total} runs, 30d)` : "No gate runs yet";

  // Velocity (0-25)
  const avgHours = prResult !== null ? Number(prResult) / 60 : null;
  let velScore = 12;
  let velHint = "No merged PRs (90d)";
  if (avgHours !== null) {
    if (avgHours <= 4)        { velScore = 25; velHint = `Avg TTM ${formatDuration(avgHours)} — Elite`; }
    else if (avgHours <= 24)  { velScore = 20; velHint = `Avg TTM ${formatDuration(avgHours)}`; }
    else if (avgHours <= 72)  { velScore = 14; velHint = `Avg TTM ${formatDuration(avgHours)}`; }
    else if (avgHours <= 168) { velScore = 7;  velHint = `Avg TTM ${formatDuration(avgHours)}`; }
    else                      { velScore = 0;  velHint = `Avg TTM ${formatDuration(avgHours)} — PRs sit too long`; }
  }

  // Maintenance (0-20)
  const avgDays = issueResult !== null ? Number(issueResult) : null;
  let maintScore = 20;
  let maintHint = "Issue backlog healthy";
  if (avgDays !== null) {
    if (avgDays > 90)      { maintScore = 0;  maintHint = `Avg open issue age ${Math.round(avgDays)}d — stale backlog`; }
    else if (avgDays > 30) { maintScore = 8;  maintHint = `Avg open issue age ${Math.round(avgDays)}d`; }
    else if (avgDays > 14) { maintScore = 14; maintHint = `Avg open issue age ${Math.round(avgDays)}d`; }
    else                   { maintScore = 20; maintHint = `Avg open issue age ${Math.round(avgDays)}d`; }
  }

  const total2 = secScore + gateScore + velScore + maintScore;
  return {
    total: total2,
    grade: total2 >= 85 ? "elite" : total2 >= 70 ? "strong" : total2 >= 50 ? "improving" : "needs-attention",
    components: {
      security:    { score: secScore,   max: 30, label: "Security",    hint: secHint },
      greenGates:  { score: gateScore,  max: 25, label: "Green Gates", hint: gateHint },
      velocity:    { score: velScore,   max: 25, label: "Velocity",    hint: velHint },
      maintenance: { score: maintScore, max: 20, label: "Maintenance", hint: maintHint },
    },
  };
}
