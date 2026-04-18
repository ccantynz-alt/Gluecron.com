/**
 * Repository Intelligence Engine
 *
 * The brain of gluecron. Runs on every push and computes:
 * - Health score (0-100)
 * - Security signals
 * - Complexity trends
 * - Dependency freshness
 * - Test coverage estimate
 * - Documentation coverage
 * - Hot file detection (churn)
 *
 * This is what makes gluecron 30 years ahead of GitHub.
 * GitHub shows you code. Gluecron UNDERSTANDS your code.
 */

import { getRepoPath, getDefaultBranch } from "../git/repository";

export interface RepoHealthReport {
  score: number; // 0-100
  grade: "A+" | "A" | "B" | "C" | "D" | "F";
  breakdown: {
    security: { score: number; issues: SecurityIssue[] };
    testing: { score: number; hasTests: boolean; testFileCount: number; estimatedCoverage: string };
    complexity: { score: number; avgFileSize: number; largestFiles: FileMetric[]; totalFiles: number };
    dependencies: { score: number; total: number; outdatedEstimate: number; lockfileExists: boolean };
    documentation: { score: number; hasReadme: boolean; hasLicense: boolean; hasContributing: boolean; hasChangelog: boolean; docFileCount: number };
    activity: { score: number; recentCommits: number; uniqueContributors: number; lastPushDaysAgo: number };
  };
  insights: string[];
  generatedAt: string;
}

export interface SecurityIssue {
  severity: "critical" | "high" | "medium" | "low" | "info";
  file: string;
  line?: number;
  message: string;
  rule: string;
}

interface FileMetric {
  path: string;
  lines: number;
}

interface PushAnalysis {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  riskScore: number; // 0-100
  riskFactors: string[];
  breakingChangeSignals: string[];
  securityIssues: SecurityIssue[];
  hotFiles: string[];
  summary: string;
}

async function exec(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

// ─── HEALTH SCORE ────────────────────────────────────────────

export async function computeHealthScore(
  owner: string,
  repo: string
): Promise<RepoHealthReport> {
  const repoDir = getRepoPath(owner, repo);
  const ref = (await getDefaultBranch(owner, repo)) || "main";

  const [
    security,
    testing,
    complexity,
    dependencies,
    documentation,
    activity,
  ] = await Promise.all([
    analyzeSecurityScore(repoDir, ref),
    analyzeTestingScore(repoDir, ref),
    analyzeComplexityScore(repoDir, ref),
    analyzeDependencyScore(repoDir, ref),
    analyzeDocumentationScore(repoDir, ref),
    analyzeActivityScore(repoDir, ref),
  ]);

  const weights = {
    security: 0.25,
    testing: 0.20,
    complexity: 0.15,
    dependencies: 0.15,
    documentation: 0.10,
    activity: 0.15,
  };

  const score = Math.round(
    security.score * weights.security +
    testing.score * weights.testing +
    complexity.score * weights.complexity +
    dependencies.score * weights.dependencies +
    documentation.score * weights.documentation +
    activity.score * weights.activity
  );

  const grade = score >= 95 ? "A+" : score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";

  const insights = generateInsights({ security, testing, complexity, dependencies, documentation, activity });

  return {
    score,
    grade,
    breakdown: { security, testing, complexity, dependencies, documentation, activity },
    insights,
    generatedAt: new Date().toISOString(),
  };
}

// ─── SECURITY ANALYSIS ───────────────────────────────────────

const SECURITY_PATTERNS: Array<{
  pattern: RegExp;
  severity: SecurityIssue["severity"];
  message: string;
  rule: string;
}> = [
  // Hardcoded secrets
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}/i, severity: "critical", message: "Possible hardcoded password", rule: "no-hardcoded-secrets" },
  { pattern: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*["'][^"']{8,}/i, severity: "critical", message: "Possible hardcoded API key", rule: "no-hardcoded-secrets" },
  { pattern: /(?:AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/, severity: "critical", message: "Possible AWS access key", rule: "no-aws-keys" },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, severity: "critical", message: "Private key in source code", rule: "no-private-keys" },
  // Injection vulnerabilities
  { pattern: /eval\s*\(/, severity: "high", message: "Use of eval() — potential code injection", rule: "no-eval" },
  { pattern: /innerHTML\s*=/, severity: "medium", message: "Direct innerHTML assignment — potential XSS", rule: "no-inner-html" },
  { pattern: /document\.write\s*\(/, severity: "medium", message: "document.write usage — potential XSS", rule: "no-document-write" },
  { pattern: /exec\s*\(\s*[`"'].*\$\{/, severity: "high", message: "Shell command with template literal — potential injection", rule: "no-shell-injection" },
  // SQL injection
  { pattern: /query\s*\(\s*[`"'].*\$\{/, severity: "high", message: "SQL query with interpolation — potential SQL injection", rule: "no-sql-injection" },
  { pattern: /\.raw\s*\(\s*[`"'].*\$\{/, severity: "medium", message: "Raw query with interpolation", rule: "no-raw-sql-injection" },
  // Crypto issues
  { pattern: /createHash\s*\(\s*["']md5["']\)/, severity: "medium", message: "MD5 hash used — cryptographically weak", rule: "no-weak-crypto" },
  { pattern: /createHash\s*\(\s*["']sha1["']\)/, severity: "low", message: "SHA1 hash — consider SHA-256+", rule: "weak-hash" },
  // Misc
  { pattern: /TODO.*(?:security|hack|fixme|unsafe|vulnerable)/i, severity: "info", message: "Security-related TODO found", rule: "security-todo" },
  { pattern: /(?:disable|ignore).*(?:eslint|tslint|security)/i, severity: "low", message: "Security linter rule disabled", rule: "no-security-disable" },
];

async function analyzeSecurityScore(
  repoDir: string,
  ref: string
): Promise<{ score: number; issues: SecurityIssue[] }> {
  const issues: SecurityIssue[] = [];

  // Get all text files
  const { stdout: files } = await exec(
    ["git", "ls-tree", "-r", "--name-only", ref],
    repoDir
  );

  const filePaths = files.trim().split("\n").filter(Boolean);

  // Check for .env files committed
  for (const f of filePaths) {
    if (/^\.env(?:\.|$)/.test(f.split("/").pop() || "")) {
      issues.push({
        severity: "critical",
        file: f,
        message: "Environment file committed to repository",
        rule: "no-env-files",
      });
    }
  }

  // Scan source files for patterns (sample up to 100 files)
  const sourceFiles = filePaths
    .filter((f) => /\.(ts|tsx|js|jsx|py|rb|go|rs|java|php|sh|yaml|yml|json)$/.test(f))
    .slice(0, 100);

  for (const filePath of sourceFiles) {
    const { stdout: content, exitCode } = await exec(
      ["git", "show", `${ref}:${filePath}`],
      repoDir
    );
    if (exitCode !== 0) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const rule of SECURITY_PATTERNS) {
        if (rule.pattern.test(lines[i])) {
          // Don't flag test files for most rules
          if (filePath.includes("test") && rule.severity !== "critical") continue;
          issues.push({
            severity: rule.severity,
            file: filePath,
            line: i + 1,
            message: rule.message,
            rule: rule.rule,
          });
        }
      }
    }
  }

  const criticals = issues.filter((i) => i.severity === "critical").length;
  const highs = issues.filter((i) => i.severity === "high").length;
  const mediums = issues.filter((i) => i.severity === "medium").length;

  let score = 100;
  score -= criticals * 25;
  score -= highs * 10;
  score -= mediums * 3;

  return { score: Math.max(0, Math.min(100, score)), issues };
}

// ─── TESTING ─────────────────────────────────────────────────

async function analyzeTestingScore(
  repoDir: string,
  ref: string
): Promise<{
  score: number;
  hasTests: boolean;
  testFileCount: number;
  estimatedCoverage: string;
}> {
  const { stdout: files } = await exec(
    ["git", "ls-tree", "-r", "--name-only", ref],
    repoDir
  );
  const allFiles = files.trim().split("\n").filter(Boolean);
  const sourceFiles = allFiles.filter((f) =>
    /\.(ts|tsx|js|jsx|py|rb|go|rs|java|php)$/.test(f) && !f.includes("test") && !f.includes("spec")
  );
  const testFiles = allFiles.filter((f) =>
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) ||
    f.includes("__tests__/") ||
    f.includes("test_") ||
    f.endsWith("_test.go") ||
    f.endsWith("_test.py")
  );

  const hasTests = testFiles.length > 0;
  const ratio = sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0;

  let estimatedCoverage: string;
  let score: number;

  if (!hasTests) {
    estimatedCoverage = "None";
    score = 0;
  } else if (ratio >= 0.8) {
    estimatedCoverage = "High (>80%)";
    score = 95;
  } else if (ratio >= 0.5) {
    estimatedCoverage = "Good (50-80%)";
    score = 75;
  } else if (ratio >= 0.2) {
    estimatedCoverage = "Moderate (20-50%)";
    score = 50;
  } else {
    estimatedCoverage = "Low (<20%)";
    score = 25;
  }

  return { score, hasTests, testFileCount: testFiles.length, estimatedCoverage };
}

// ─── COMPLEXITY ──────────────────────────────────────────────

async function analyzeComplexityScore(
  repoDir: string,
  ref: string
): Promise<{
  score: number;
  avgFileSize: number;
  largestFiles: FileMetric[];
  totalFiles: number;
}> {
  const { stdout } = await exec(
    ["git", "ls-tree", "-r", "-l", ref],
    repoDir
  );

  const entries = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/);
      if (!match) return null;
      return { path: match[2], lines: parseInt(match[1], 10) };
    })
    .filter((e): e is FileMetric => e !== null)
    .filter((e) => /\.(ts|tsx|js|jsx|py|rb|go|rs|java|php|c|cpp|h)$/.test(e.path));

  if (entries.length === 0) {
    return { score: 100, avgFileSize: 0, largestFiles: [], totalFiles: 0 };
  }

  // Get actual line counts for top files by size
  const sorted = entries.sort((a, b) => b.lines - a.lines);
  const largestFiles = sorted.slice(0, 5);

  const avgSize = entries.reduce((s, e) => s + e.lines, 0) / entries.length;

  // Penalize large average file size and mega-files
  let score = 100;
  if (avgSize > 10000) score -= 30;
  else if (avgSize > 5000) score -= 20;
  else if (avgSize > 2000) score -= 10;
  else if (avgSize > 1000) score -= 5;

  // Penalize any file over 500 lines (by byte size as proxy)
  const megaFiles = entries.filter((e) => e.lines > 50000);
  score -= megaFiles.length * 10;

  return {
    score: Math.max(0, Math.min(100, score)),
    avgFileSize: Math.round(avgSize),
    largestFiles,
    totalFiles: entries.length,
  };
}

// ─── DEPENDENCIES ────────────────────────────────────────────

async function analyzeDependencyScore(
  repoDir: string,
  ref: string
): Promise<{
  score: number;
  total: number;
  outdatedEstimate: number;
  lockfileExists: boolean;
}> {
  const { stdout: tree } = await exec(
    ["git", "ls-tree", "--name-only", ref],
    repoDir
  );
  const files = tree.trim().split("\n");

  const hasLockfile =
    files.includes("bun.lock") ||
    files.includes("package-lock.json") ||
    files.includes("yarn.lock") ||
    files.includes("pnpm-lock.yaml") ||
    files.includes("Cargo.lock") ||
    files.includes("go.sum") ||
    files.includes("Gemfile.lock") ||
    files.includes("poetry.lock");

  const hasPackageJson = files.includes("package.json");
  const hasCargoToml = files.includes("Cargo.toml");
  const hasGoMod = files.includes("go.mod");
  const hasRequirements = files.includes("requirements.txt");

  let total = 0;

  if (hasPackageJson) {
    try {
      const { stdout: content } = await exec(
        ["git", "show", `${ref}:package.json`],
        repoDir
      );
      const pkg = JSON.parse(content);
      total =
        Object.keys(pkg.dependencies || {}).length +
        Object.keys(pkg.devDependencies || {}).length;
    } catch {
      // parse error
    }
  }

  let score = 100;
  if (!hasLockfile && total > 0) score -= 20; // No lockfile with deps is bad
  if (total > 100) score -= 10; // Too many deps
  if (total > 200) score -= 10;

  return {
    score: Math.max(0, score),
    total,
    outdatedEstimate: 0, // Would need network access to check
    lockfileExists: hasLockfile,
  };
}

// ─── DOCUMENTATION ───────────────────────────────────────────

async function analyzeDocumentationScore(
  repoDir: string,
  ref: string
): Promise<{
  score: number;
  hasReadme: boolean;
  hasLicense: boolean;
  hasContributing: boolean;
  hasChangelog: boolean;
  docFileCount: number;
}> {
  const { stdout: tree } = await exec(
    ["git", "ls-tree", "--name-only", ref],
    repoDir
  );
  const files = tree.trim().split("\n").map((f) => f.toLowerCase());

  const hasReadme = files.some((f) => f.startsWith("readme"));
  const hasLicense = files.some((f) => f.startsWith("license") || f.startsWith("licence"));
  const hasContributing = files.some((f) => f.startsWith("contributing"));
  const hasChangelog = files.some((f) => f.startsWith("changelog") || f.startsWith("changes"));

  const { stdout: allFiles } = await exec(
    ["git", "ls-tree", "-r", "--name-only", ref],
    repoDir
  );
  const docFiles = allFiles
    .trim()
    .split("\n")
    .filter((f) => /\.(md|rst|txt|adoc)$/i.test(f));

  let score = 0;
  if (hasReadme) score += 40;
  if (hasLicense) score += 20;
  if (hasContributing) score += 15;
  if (hasChangelog) score += 15;
  score += Math.min(10, docFiles.length * 2);

  return {
    score: Math.min(100, score),
    hasReadme,
    hasLicense,
    hasContributing,
    hasChangelog,
    docFileCount: docFiles.length,
  };
}

// ─── ACTIVITY ────────────────────────────────────────────────

async function analyzeActivityScore(
  repoDir: string,
  ref: string
): Promise<{
  score: number;
  recentCommits: number;
  uniqueContributors: number;
  lastPushDaysAgo: number;
}> {
  // Recent commits (last 30 days)
  const { stdout: recent } = await exec(
    ["git", "rev-list", "--count", "--since=30 days ago", ref],
    repoDir
  );
  const recentCommits = parseInt(recent.trim(), 10) || 0;

  // Unique contributors
  const { stdout: authors } = await exec(
    ["git", "shortlog", "-sn", ref],
    repoDir
  );
  const uniqueContributors = authors.trim().split("\n").filter(Boolean).length;

  // Last commit date
  const { stdout: lastDate } = await exec(
    ["git", "log", "-1", "--format=%aI", ref],
    repoDir
  );
  const lastPush = new Date(lastDate.trim());
  const lastPushDaysAgo = Math.floor(
    (Date.now() - lastPush.getTime()) / (1000 * 60 * 60 * 24)
  );

  let score = 0;
  // Recent activity
  if (recentCommits >= 20) score += 40;
  else if (recentCommits >= 10) score += 30;
  else if (recentCommits >= 3) score += 20;
  else if (recentCommits >= 1) score += 10;

  // Contributors
  if (uniqueContributors >= 5) score += 30;
  else if (uniqueContributors >= 3) score += 20;
  else if (uniqueContributors >= 2) score += 15;
  else score += 5;

  // Freshness
  if (lastPushDaysAgo <= 7) score += 30;
  else if (lastPushDaysAgo <= 30) score += 20;
  else if (lastPushDaysAgo <= 90) score += 10;

  return {
    score: Math.min(100, score),
    recentCommits,
    uniqueContributors,
    lastPushDaysAgo,
  };
}

// ─── PUSH ANALYSIS ───────────────────────────────────────────

export async function analyzePush(
  owner: string,
  repo: string,
  beforeSha: string,
  afterSha: string
): Promise<PushAnalysis> {
  const repoDir = getRepoPath(owner, repo);
  const isInitial = beforeSha.startsWith("0000");

  // Diff stats
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  if (!isInitial) {
    const { stdout: stat } = await exec(
      ["git", "diff", "--shortstat", `${beforeSha}..${afterSha}`],
      repoDir
    );
    const match = stat.match(
      /(\d+) files? changed(?:, (\d+) insertions?)?(?:, (\d+) deletions?)?/
    );
    if (match) {
      filesChanged = parseInt(match[1], 10) || 0;
      linesAdded = parseInt(match[2], 10) || 0;
      linesRemoved = parseInt(match[3], 10) || 0;
    }
  }

  const riskFactors: string[] = [];
  const breakingChangeSignals: string[] = [];
  const securityIssues: SecurityIssue[] = [];

  // Get changed files
  let changedFiles: string[] = [];
  if (!isInitial) {
    const { stdout: diff } = await exec(
      ["git", "diff", "--name-only", `${beforeSha}..${afterSha}`],
      repoDir
    );
    changedFiles = diff.trim().split("\n").filter(Boolean);
  }

  // Risk factors
  if (filesChanged > 50) riskFactors.push(`Large changeset: ${filesChanged} files`);
  if (linesAdded + linesRemoved > 2000) riskFactors.push(`High churn: ${linesAdded + linesRemoved} lines`);

  // Check for high-risk file changes
  const riskFiles = changedFiles.filter((f) =>
    /^(\.env|docker-compose|Dockerfile|\.github\/workflows|package\.json|Cargo\.toml|go\.mod)/i.test(f)
  );
  if (riskFiles.length > 0) {
    riskFactors.push(`Infrastructure files changed: ${riskFiles.join(", ")}`);
  }

  // Breaking change detection
  if (!isInitial) {
    const { stdout: diffContent } = await exec(
      ["git", "diff", `${beforeSha}..${afterSha}`],
      repoDir
    );

    // Detect removed exports
    const removedExports = (diffContent.match(/^-export /gm) || []).length;
    const addedExports = (diffContent.match(/^\+export /gm) || []).length;
    if (removedExports > addedExports) {
      breakingChangeSignals.push(
        `${removedExports - addedExports} exports removed — potential breaking change`
      );
    }

    // Detect renamed/removed public functions
    const removedFunctions = (diffContent.match(/^-(?:export )?(?:async )?function \w+/gm) || []).length;
    if (removedFunctions > 0) {
      breakingChangeSignals.push(`${removedFunctions} function(s) removed or renamed`);
    }

    // Detect API route changes
    const routeChanges = (diffContent.match(/^[+-].*\.(get|post|put|delete|patch)\s*\(/gm) || []).length;
    if (routeChanges > 0) {
      breakingChangeSignals.push(`API route changes detected (${routeChanges} modifications)`);
    }

    // Security scan the diff
    for (const rule of SECURITY_PATTERNS) {
      const matches = diffContent.match(new RegExp(`^\\+.*${rule.pattern.source}`, "gm"));
      if (matches && matches.length > 0) {
        securityIssues.push({
          severity: rule.severity,
          file: "diff",
          message: rule.message,
          rule: rule.rule,
        });
      }
    }
  }

  // Hot files (most changed in last 30 days)
  const { stdout: hotOutput } = await exec(
    [
      "git",
      "log",
      "--since=30 days ago",
      "--format=",
      "--name-only",
      afterSha,
    ],
    repoDir
  );
  const fileCounts: Record<string, number> = {};
  for (const f of hotOutput.trim().split("\n").filter(Boolean)) {
    fileCounts[f] = (fileCounts[f] || 0) + 1;
  }
  const hotFiles = Object.entries(fileCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f]) => f);

  // Risk score
  let riskScore = 0;
  riskScore += Math.min(30, filesChanged * 0.5);
  riskScore += Math.min(20, (linesAdded + linesRemoved) * 0.005);
  riskScore += riskFactors.length * 10;
  riskScore += breakingChangeSignals.length * 15;
  riskScore += securityIssues.filter((i) => i.severity === "critical").length * 25;
  riskScore += securityIssues.filter((i) => i.severity === "high").length * 10;
  riskScore = Math.min(100, Math.round(riskScore));

  const summary = generatePushSummary(
    filesChanged,
    linesAdded,
    linesRemoved,
    riskScore,
    breakingChangeSignals,
    securityIssues
  );

  return {
    filesChanged,
    linesAdded,
    linesRemoved,
    riskScore,
    riskFactors,
    breakingChangeSignals,
    securityIssues,
    hotFiles,
    summary,
  };
}

// ─── ZERO-CONFIG CI ──────────────────────────────────────────

export interface CIConfig {
  projectType: string;
  runtime: string;
  commands: { name: string; command: string }[];
  detected: string[];
}

export async function detectCIConfig(
  owner: string,
  repo: string,
  ref: string
): Promise<CIConfig> {
  const repoDir = getRepoPath(owner, repo);

  const { stdout: tree } = await exec(
    ["git", "ls-tree", "--name-only", ref],
    repoDir
  );
  const rootFiles = tree.trim().split("\n");

  const detected: string[] = [];
  const commands: { name: string; command: string }[] = [];
  let projectType = "unknown";
  let runtime = "unknown";

  // Node.js / Bun
  if (rootFiles.includes("package.json")) {
    const { stdout: pkg } = await exec(
      ["git", "show", `${ref}:package.json`],
      repoDir
    );
    try {
      const parsed = JSON.parse(pkg);
      const scripts = parsed.scripts || {};

      if (rootFiles.includes("bun.lock") || rootFiles.includes("bunfig.toml")) {
        runtime = "bun";
        detected.push("Bun project detected");
      } else if (rootFiles.includes("yarn.lock")) {
        runtime = "yarn";
        detected.push("Yarn project detected");
      } else if (rootFiles.includes("pnpm-lock.yaml")) {
        runtime = "pnpm";
        detected.push("pnpm project detected");
      } else {
        runtime = "npm";
        detected.push("Node.js project detected");
      }

      projectType = "javascript";

      // TypeScript?
      if (rootFiles.includes("tsconfig.json") || parsed.devDependencies?.typescript) {
        detected.push("TypeScript detected");
        projectType = "typescript";
        commands.push({ name: "Type check", command: `${runtime === "bun" ? "bun" : "npx"} tsc --noEmit` });
      }

      // Framework detection
      if (parsed.dependencies?.hono) detected.push("Hono framework");
      if (parsed.dependencies?.next) detected.push("Next.js framework");
      if (parsed.dependencies?.react) detected.push("React");
      if (parsed.dependencies?.vue) detected.push("Vue.js");
      if (parsed.dependencies?.express) detected.push("Express.js");

      // Add available scripts
      if (scripts.lint) commands.push({ name: "Lint", command: `${runtime} run lint` });
      if (scripts.test) commands.push({ name: "Test", command: `${runtime} ${runtime === "bun" ? "test" : "run test"}` });
      if (scripts.build) commands.push({ name: "Build", command: `${runtime} run build` });
      if (scripts.typecheck) commands.push({ name: "Type check", command: `${runtime} run typecheck` });

      // If no lint but eslint exists
      if (!scripts.lint && (parsed.devDependencies?.eslint || parsed.dependencies?.eslint)) {
        commands.push({ name: "Lint", command: `${runtime === "bun" ? "bun" : "npx"} eslint .` });
      }

      // If no test script but test framework exists
      if (!scripts.test) {
        if (parsed.devDependencies?.vitest) {
          commands.push({ name: "Test", command: `${runtime === "bun" ? "bun" : "npx"} vitest run` });
        } else if (parsed.devDependencies?.jest) {
          commands.push({ name: "Test", command: `${runtime === "bun" ? "bun" : "npx"} jest` });
        }
      }
    } catch {
      // JSON parse error
    }
  }

  // Rust
  if (rootFiles.includes("Cargo.toml")) {
    projectType = "rust";
    runtime = "cargo";
    detected.push("Rust project detected");
    commands.push({ name: "Check", command: "cargo check" });
    commands.push({ name: "Test", command: "cargo test" });
    commands.push({ name: "Clippy", command: "cargo clippy -- -D warnings" });
    commands.push({ name: "Format check", command: "cargo fmt -- --check" });
  }

  // Go
  if (rootFiles.includes("go.mod")) {
    projectType = "go";
    runtime = "go";
    detected.push("Go project detected");
    commands.push({ name: "Build", command: "go build ./..." });
    commands.push({ name: "Test", command: "go test ./..." });
    commands.push({ name: "Vet", command: "go vet ./..." });
  }

  // Python
  if (
    rootFiles.includes("requirements.txt") ||
    rootFiles.includes("pyproject.toml") ||
    rootFiles.includes("setup.py")
  ) {
    projectType = "python";
    runtime = "python";
    detected.push("Python project detected");
    if (rootFiles.includes("pyproject.toml")) {
      detected.push("pyproject.toml found");
    }
    commands.push({ name: "Test", command: "python -m pytest" });
    commands.push({ name: "Type check", command: "python -m mypy ." });
  }

  return { projectType, runtime, commands, detected };
}

// ─── HELPERS ─────────────────────────────────────────────────

function generateInsights(breakdown: RepoHealthReport["breakdown"]): string[] {
  const insights: string[] = [];

  if (breakdown.security.issues.length === 0) {
    insights.push("No security issues detected — clean codebase");
  } else {
    const criticals = breakdown.security.issues.filter((i) => i.severity === "critical").length;
    if (criticals > 0) {
      insights.push(`${criticals} critical security issue${criticals > 1 ? "s" : ""} found — immediate action recommended`);
    }
  }

  if (!breakdown.testing.hasTests) {
    insights.push("No tests found — adding tests would significantly improve code reliability");
  } else if (breakdown.testing.testFileCount > 10) {
    insights.push(`Strong test suite with ${breakdown.testing.testFileCount} test files`);
  }

  if (!breakdown.documentation.hasReadme) {
    insights.push("No README — new contributors won't know how to get started");
  }

  if (!breakdown.documentation.hasLicense) {
    insights.push("No LICENSE file — open source projects need a license to be usable");
  }

  if (!breakdown.dependencies.lockfileExists && breakdown.dependencies.total > 0) {
    insights.push("No lockfile — builds may not be reproducible");
  }

  if (breakdown.activity.lastPushDaysAgo > 90) {
    insights.push("No activity in 90+ days — project may be dormant");
  } else if (breakdown.activity.recentCommits > 20) {
    insights.push("Very active project — strong development momentum");
  }

  if (breakdown.activity.uniqueContributors === 1) {
    insights.push("Single contributor — consider inviting collaborators for code review");
  }

  return insights;
}

function generatePushSummary(
  filesChanged: number,
  linesAdded: number,
  linesRemoved: number,
  riskScore: number,
  breakingChanges: string[],
  securityIssues: SecurityIssue[]
): string {
  const parts: string[] = [];
  parts.push(`${filesChanged} files changed (+${linesAdded} -${linesRemoved})`);

  if (riskScore <= 20) parts.push("Low risk push");
  else if (riskScore <= 50) parts.push("Moderate risk — review recommended");
  else parts.push("High risk — careful review required");

  if (breakingChanges.length > 0) {
    parts.push(`${breakingChanges.length} potential breaking change(s)`);
  }

  const critSec = securityIssues.filter((i) => i.severity === "critical" || i.severity === "high").length;
  if (critSec > 0) {
    parts.push(`${critSec} security concern(s)`);
  }

  return parts.join(" | ");
}
