/**
 * Repository Health Dashboard — the page GitHub doesn't have.
 *
 * Shows a live health score, security scan results, test coverage estimate,
 * dependency freshness, complexity analysis, and actionable insights.
 *
 * This runs EVERY TIME someone views the repo. No config needed.
 * No yaml. No CI setup. Just push code and gluecron tells you what's wrong.
 */

import { Hono } from "hono";
import { Layout } from "../views/layout";
import { RepoHeader, RepoNav } from "../views/components";
import {
  computeHealthScore,
  detectCIConfig,
  type RepoHealthReport,
  type SecurityIssue,
} from "../lib/intelligence";
import { repoExists, getDefaultBranch } from "../git/repository";
import { softAuth } from "../middleware/auth";
import type { AuthEnv } from "../middleware/auth";

const health = new Hono<AuthEnv>();

health.use("*", softAuth);

health.get("/:owner/:repo/health", async (c) => {
  const { owner, repo } = c.req.param();
  const user = c.get("user");

  if (!(await repoExists(owner, repo))) return c.notFound();

  const ref = (await getDefaultBranch(owner, repo)) || "main";

  // Run analysis in parallel
  const [report, ciConfig] = await Promise.all([
    computeHealthScore(owner, repo),
    detectCIConfig(owner, repo, ref),
  ]);

  const gradeColor =
    report.grade === "A+" || report.grade === "A"
      ? "var(--green)"
      : report.grade === "B"
        ? "#58a6ff"
        : report.grade === "C"
          ? "var(--yellow)"
          : "var(--red)";

  return c.html(
    <Layout title={`Health — ${owner}/${repo}`} user={user}>
      <RepoHeader owner={owner} repo={repo} />
      <HealthNav owner={owner} repo={repo} active="health" />

      <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 32px">
        <div
          style={`text-align: center; padding: 24px 40px; background: var(--bg-secondary); border: 2px solid ${gradeColor}; border-radius: var(--radius);`}
        >
          <div style={`font-size: 48px; font-weight: 800; color: ${gradeColor}`}>
            {report.grade}
          </div>
          <div style="font-size: 32px; font-weight: 600; color: var(--text)">
            {report.score}/100
          </div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px">
            Health Score
          </div>
        </div>

        <div style="flex: 1; min-width: 300px">
          <h3 style="margin-bottom: 12px">Insights</h3>
          {report.insights.map((insight) => (
            <div style="padding: 8px 0; font-size: 14px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: start">
              <span style="color: var(--text-link); flex-shrink: 0">*</span>
              <span>{insight}</span>
            </div>
          ))}
        </div>
      </div>

      <div class="card-grid" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))">
        <ScoreCard
          title="Security"
          score={report.breakdown.security.score}
          details={[
            `${report.breakdown.security.issues.length} issue${report.breakdown.security.issues.length !== 1 ? "s" : ""} found`,
            `${report.breakdown.security.issues.filter((i) => i.severity === "critical").length} critical`,
            `${report.breakdown.security.issues.filter((i) => i.severity === "high").length} high`,
          ]}
        />
        <ScoreCard
          title="Testing"
          score={report.breakdown.testing.score}
          details={[
            report.breakdown.testing.hasTests ? `${report.breakdown.testing.testFileCount} test files` : "No tests found",
            `Coverage estimate: ${report.breakdown.testing.estimatedCoverage}`,
          ]}
        />
        <ScoreCard
          title="Complexity"
          score={report.breakdown.complexity.score}
          details={[
            `${report.breakdown.complexity.totalFiles} source files`,
            `Avg file size: ${report.breakdown.complexity.avgFileSize} bytes`,
          ]}
        />
        <ScoreCard
          title="Dependencies"
          score={report.breakdown.dependencies.score}
          details={[
            `${report.breakdown.dependencies.total} dependencies`,
            report.breakdown.dependencies.lockfileExists ? "Lockfile present" : "No lockfile",
          ]}
        />
        <ScoreCard
          title="Documentation"
          score={report.breakdown.documentation.score}
          details={[
            report.breakdown.documentation.hasReadme ? "README found" : "No README",
            report.breakdown.documentation.hasLicense ? "License present" : "No license",
            `${report.breakdown.documentation.docFileCount} doc files`,
          ]}
        />
        <ScoreCard
          title="Activity"
          score={report.breakdown.activity.score}
          details={[
            `${report.breakdown.activity.recentCommits} commits (30d)`,
            `${report.breakdown.activity.uniqueContributors} contributors`,
            `Last push: ${report.breakdown.activity.lastPushDaysAgo}d ago`,
          ]}
        />
      </div>

      {report.breakdown.security.issues.length > 0 && (
        <div style="margin-top: 32px">
          <h3 style="margin-bottom: 12px">Security Issues</h3>
          <div class="issue-list">
            {report.breakdown.security.issues.map((issue) => (
              <div class="issue-item">
                <div style="display: flex; gap: 8px; align-items: center">
                  <SeverityBadge severity={issue.severity} />
                  <div>
                    <div style="font-size: 14px; font-weight: 500">
                      {issue.message}
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); font-family: var(--font-mono)">
                      {issue.file}
                      {issue.line ? `:${issue.line}` : ""} — {issue.rule}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {ciConfig.commands.length > 0 && (
        <div style="margin-top: 32px">
          <h3 style="margin-bottom: 12px">
            Zero-Config CI
            <span style="font-size: 13px; color: var(--text-muted); font-weight: 400; margin-left: 8px">
              Auto-detected
            </span>
          </h3>
          <div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px">
            <div style="margin-bottom: 12px; font-size: 13px; color: var(--text-muted)">
              {ciConfig.detected.join(" | ")}
            </div>
            {ciConfig.commands.map((cmd) => (
              <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); align-items: center">
                <span style="font-size: 14px; font-weight: 500">
                  {cmd.name}
                </span>
                <code style="font-size: 12px; background: var(--bg-tertiary); padding: 4px 8px; border-radius: 3px">
                  {cmd.command}
                </code>
              </div>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
});

const HealthNav = ({
  owner,
  repo,
  active,
}: {
  owner: string;
  repo: string;
  active: string;
}) => (
  <div class="repo-nav">
    <a href={`/${owner}/${repo}`} class={active === "code" ? "active" : ""}>
      Code
    </a>
    <a
      href={`/${owner}/${repo}/issues`}
      class={active === "issues" ? "active" : ""}
    >
      Issues
    </a>
    <a
      href={`/${owner}/${repo}/pulls`}
      class={active === "pulls" ? "active" : ""}
    >
      Pull Requests
    </a>
    <a
      href={`/${owner}/${repo}/health`}
      class={active === "health" ? "active" : ""}
    >
      Health
    </a>
    <a
      href={`/${owner}/${repo}/commits`}
      class={active === "commits" ? "active" : ""}
    >
      Commits
    </a>
  </div>
);

const ScoreCard = ({
  title,
  score,
  details,
}: {
  title: string;
  score: number;
  details: string[];
}) => {
  const color =
    score >= 80 ? "var(--green)" : score >= 50 ? "var(--yellow)" : "var(--red)";
  return (
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
        <h3 style="font-size: 15px">{title}</h3>
        <span
          style={`font-size: 18px; font-weight: 700; color: ${color}`}
        >
          {score}
        </span>
      </div>
      <div
        style="height: 4px; background: var(--bg-tertiary); border-radius: 2px; margin-bottom: 8px; overflow: hidden"
      >
        <div
          style={`height: 100%; width: ${score}%; background: ${color}; border-radius: 2px; transition: width 0.3s;`}
        />
      </div>
      {details.map((d) => (
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px">
          {d}
        </div>
      ))}
    </div>
  );
};

const SeverityBadge = ({
  severity,
}: {
  severity: SecurityIssue["severity"];
}) => {
  const colors: Record<string, string> = {
    critical: "var(--red)",
    high: "#ff7b72",
    medium: "var(--yellow)",
    low: "var(--text-muted)",
    info: "var(--text-link)",
  };
  return (
    <span
      class="badge"
      style={`color: ${colors[severity]}; border-color: ${colors[severity]}; font-size: 11px; text-transform: uppercase`}
    >
      {severity}
    </span>
  );
};

export default health;
