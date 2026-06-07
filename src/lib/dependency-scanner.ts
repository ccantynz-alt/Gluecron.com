/**
 * Dependency CVE Scanner — auto-opens security issues on push.
 *
 * When a push touches package.json, requirements.txt, Cargo.toml, go.mod,
 * or Gemfile, this module:
 *   1. Reads the dependency file from the pushed commit via `git show`.
 *   2. Queries the OSV (Open Source Vulnerabilities) API for each package.
 *   3. For critical/high findings: opens an issue per CVE (deduplicates via
 *      title ILIKE check so the same CVE never gets a second open issue).
 *   4. For medium/low findings: batches them into a weekly digest issue.
 *
 * Integrates into post-receive.ts as a fire-and-forget call guarded by
 * `DEPENDENCY_SCAN_ENABLED=1`. Never throws — every external call is wrapped.
 */

import { and, eq, ilike, or } from "drizzle-orm";
import { db } from "../db";
import {
  issueLabels,
  issues,
  labels,
  repositories,
  users,
} from "../db/schema";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VulnFinding {
  packageName: string;
  installedVersion: string;
  severity: "critical" | "high" | "medium" | "low";
  cveId: string;
  description: string;
  fixVersion?: string;
}

// ---------------------------------------------------------------------------
// Ecosystem map — maps manifest filename to OSV ecosystem string
// ---------------------------------------------------------------------------

const DEPENDENCY_FILES = [
  "package.json",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
] as const;

type DependencyFile = (typeof DEPENDENCY_FILES)[number];

const FILE_ECOSYSTEM: Record<DependencyFile, string> = {
  "package.json": "npm",
  "requirements.txt": "PyPI",
  "Cargo.toml": "crates.io",
  "go.mod": "Go",
  "Gemfile": "RubyGems",
};

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Reads a file at a specific commit SHA via `git show`. Returns null on failure. */
async function gitShow(
  owner: string,
  repoName: string,
  sha: string,
  filePath: string
): Promise<string | null> {
  try {
    const cwd = getRepoPath(owner, repoName);
    const proc = Bun.spawn(
      ["git", "show", `${sha}:${filePath}`],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return text;
  } catch {
    return null;
  }
}

/** Returns the list of files changed between oldSha and newSha. */
async function gitDiffNames(
  owner: string,
  repoName: string,
  oldSha: string,
  newSha: string
): Promise<string[]> {
  try {
    const cwd = getRepoPath(owner, repoName);
    const allZero = /^0+$/.test(oldSha);
    const cmd = allZero
      ? ["git", "ls-tree", "-r", "--name-only", newSha]
      : ["git", "diff", "--name-only", oldSha, newSha];
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Manifest parsers
// ---------------------------------------------------------------------------

interface ParsedPackage {
  name: string;
  version: string;
  ecosystem: string;
}

function parsePackageJson(content: string, ecosystem: string): ParsedPackage[] {
  try {
    const json = JSON.parse(content) as Record<string, unknown>;
    const deps: Record<string, string> = {};
    const raw = json["dependencies"];
    const rawDev = json["devDependencies"];
    if (raw && typeof raw === "object") {
      Object.assign(deps, raw as Record<string, string>);
    }
    if (rawDev && typeof rawDev === "object") {
      Object.assign(deps, rawDev as Record<string, string>);
    }
    return Object.entries(deps)
      .filter(([, v]) => typeof v === "string")
      .map(([name, versionSpec]) => ({
        name,
        // Strip leading ^~>< to get a bare version for the OSV query.
        // If the spec is something like "workspace:*" we'll still query
        // with the empty string; OSV returns all advisories for the package.
        version: versionSpec.replace(/^[^0-9]*/, "").split(" ")[0] || "",
        ecosystem,
      }));
  } catch {
    return [];
  }
}

function parseRequirementsTxt(content: string, ecosystem: string): ParsedPackage[] {
  const result: ParsedPackage[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    // Lines like: requests==2.28.0, Django>=4.1, flask
    const match = line.match(/^([A-Za-z0-9_.\-]+)\s*(?:[=<>!]+\s*([0-9][^\s,;#]*))?/);
    if (!match) continue;
    const name = match[1];
    const version = match[2] || "";
    result.push({ name, version, ecosystem });
  }
  return result;
}

function parseCargoToml(content: string, ecosystem: string): ParsedPackage[] {
  const result: ParsedPackage[] = [];
  let inDeps = false;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inDeps =
        line === "[dependencies]" ||
        line === "[dev-dependencies]" ||
        line === "[build-dependencies]";
      continue;
    }
    if (!inDeps) continue;
    if (!line || line.startsWith("#")) continue;
    // name = "1.2.3"
    const simpleMatch = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*"([0-9][^"]*)"$/);
    if (simpleMatch) {
      result.push({ name: simpleMatch[1], version: simpleMatch[2], ecosystem });
      continue;
    }
    // name = { version = "1.2.3", ... }
    const tableMatch = line.match(/^([A-Za-z0-9_\-]+)\s*=\s*\{.*version\s*=\s*"([0-9][^"]*)".*\}$/);
    if (tableMatch) {
      result.push({ name: tableMatch[1], version: tableMatch[2], ecosystem });
    }
  }
  return result;
}

function parseGoMod(content: string, ecosystem: string): ParsedPackage[] {
  const result: ParsedPackage[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    // Matches both block form:    github.com/foo/bar v1.2.3
    // and standalone require:     require github.com/foo/bar v1.2.3
    // Strip a leading "require " if present.
    const stripped = line.startsWith("require ") ? line.slice("require ".length).trim() : line;
    const match = stripped.match(/^([A-Za-z0-9_.\-\/]+)\s+(v[0-9][^\s]*)/);
    if (match && match[1] !== "go" && match[1] !== "module" && match[1] !== "toolchain") {
      result.push({ name: match[1], version: match[2].replace(/^v/, ""), ecosystem });
    }
  }
  return result;
}

function parseGemfile(content: string, ecosystem: string): ParsedPackage[] {
  const result: ParsedPackage[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("gem ")) continue;
    // gem 'rails', '~> 7.0'
    const nameMatch = line.match(/gem\s+['"]([A-Za-z0-9_\-]+)['"]/);
    if (!nameMatch) continue;
    const versionMatch = line.match(/,\s*['"]([~><=!^]?\s*[0-9][^\s,'"]*)['"]/);
    const version = versionMatch
      ? versionMatch[1].replace(/[^0-9.].*/, "").trim()
      : "";
    result.push({ name: nameMatch[1], version, ecosystem });
  }
  return result;
}

function parseManifest(
  file: DependencyFile,
  content: string
): ParsedPackage[] {
  const ecosystem = FILE_ECOSYSTEM[file];
  switch (file) {
    case "package.json":
      return parsePackageJson(content, ecosystem);
    case "requirements.txt":
      return parseRequirementsTxt(content, ecosystem);
    case "Cargo.toml":
      return parseCargoToml(content, ecosystem);
    case "go.mod":
      return parseGoMod(content, ecosystem);
    case "Gemfile":
      return parseGemfile(content, ecosystem);
  }
}

// ---------------------------------------------------------------------------
// OSV API
// ---------------------------------------------------------------------------

interface OsvVuln {
  id: string;
  summary?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    ranges?: Array<{ type: string; events?: Array<{ introduced?: string; fixed?: string }> }>;
    versions?: string[];
  }>;
}

interface OsvResult {
  vulns?: OsvVuln[];
}

/** Batch-query OSV for a list of packages. Returns per-package vulnerability arrays. */
async function queryOsv(
  packages: ParsedPackage[]
): Promise<OsvResult[]> {
  if (packages.length === 0) return [];
  try {
    const response = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: packages.map((p) => ({
          version: p.version,
          package: { name: p.name, ecosystem: p.ecosystem },
        })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return packages.map(() => ({}));
    const data = await response.json() as { results?: OsvResult[] };
    return data.results || packages.map(() => ({}));
  } catch {
    return packages.map(() => ({}));
  }
}

/** Map OSV severity (CVSS score or type) to our severity enum. */
function mapSeverity(
  vuln: OsvVuln
): "critical" | "high" | "medium" | "low" {
  if (!vuln.severity || vuln.severity.length === 0) return "medium";
  // Try CVSS score first
  for (const sev of vuln.severity) {
    if (sev.score) {
      const score = parseFloat(sev.score);
      if (!isNaN(score)) {
        if (score >= 9.0) return "critical";
        if (score >= 7.0) return "high";
        if (score >= 4.0) return "medium";
        return "low";
      }
      // Some OSV entries use CRITICAL/HIGH/MEDIUM/LOW strings
      const upper = sev.score.toUpperCase();
      if (upper === "CRITICAL") return "critical";
      if (upper === "HIGH") return "high";
      if (upper === "MEDIUM" || upper === "MODERATE") return "medium";
      if (upper === "LOW") return "low";
    }
  }
  return "medium";
}

/** Extract the fix version from the OSV affected ranges. */
function extractFixVersion(vuln: OsvVuln): string | undefined {
  for (const affected of vuln.affected || []) {
    for (const range of affected.ranges || []) {
      for (const event of range.events || []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return undefined;
}

/** Convert OSV results into VulnFindings. */
function osvResultsToFindings(
  packages: ParsedPackage[],
  results: OsvResult[]
): VulnFinding[] {
  const findings: VulnFinding[] = [];
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const result = results[i] || {};
    for (const vuln of result.vulns || []) {
      const cveId = vuln.id || "UNKNOWN";
      const severity = mapSeverity(vuln);
      findings.push({
        packageName: pkg.name,
        installedVersion: pkg.version || "unknown",
        severity,
        cveId,
        description: vuln.summary || "No description available.",
        fixVersion: extractFixVersion(vuln),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Issue creation helpers
// ---------------------------------------------------------------------------

const WEEKLY_DIGEST_MARKER = "<!-- gluecron:dep-scan-digest:v1 -->";
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Returns the repo owner's user ID for issue attribution. */
async function getRepoOwnerId(repoId: number | string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(eq(repositories.id, repoId as string))
      .limit(1);
    return row?.ownerId || null;
  } catch {
    return null;
  }
}

/**
 * Find or create a `security` label for the repo.
 * Returns the label ID or null on failure.
 */
async function getOrCreateSecurityLabel(
  repoId: string
): Promise<string | null> {
  try {
    const [existing] = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(eq(labels.repositoryId, repoId), eq(labels.name, "security"))
      )
      .limit(1);
    if (existing) return existing.id;

    const [inserted] = await db
      .insert(labels)
      .values({
        repositoryId: repoId,
        name: "security",
        color: "#d73a4a",
        description: "Security vulnerability",
      })
      .onConflictDoNothing()
      .returning();
    return inserted?.id || null;
  } catch {
    return null;
  }
}

/** Attach a label to an issue. Best-effort; swallows errors. */
async function attachLabel(issueId: string, labelId: string): Promise<void> {
  try {
    await db
      .insert(issueLabels)
      .values({ issueId, labelId })
      .onConflictDoNothing();
  } catch {
    /* best-effort */
  }
}

/** Bump the repo's issue count. Best-effort. */
async function bumpIssueCount(repoId: string): Promise<void> {
  try {
    await db
      .update(repositories)
      .set({
        issueCount: db.$with("cte").as(
          db
            .select({ v: repositories.issueCount })
            .from(repositories)
            .where(eq(repositories.id, repoId))
        ) as any,
      })
      .where(eq(repositories.id, repoId));
  } catch {
    /* best-effort */
  }
}

/**
 * Check whether an issue for this CVE already exists (open or recently closed).
 * Avoids spamming duplicate issues on every push.
 */
async function cveIssueExists(
  repoId: string,
  cveId: string
): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repoId),
          or(
            ilike(issues.title, `%${cveId}%`),
            ilike(issues.body, `%${cveId}%`)
          )
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Render an issue body for a critical/high finding. */
function renderVulnIssueBody(f: VulnFinding): string {
  const fix = f.fixVersion
    ? `Upgrade to **${f.fixVersion}** or later.`
    : "No fix version is currently available. Monitor the advisory for updates.";

  const impact = severityImpactText(f.severity);

  return [
    `> **Automated security scan.** This issue was opened by GlueCron's dependency scanner after detecting a vulnerable dependency in a recent push.`,
    "",
    `## Vulnerability details`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Package | \`${f.packageName}\` |`,
    `| Installed version | \`${f.installedVersion}\` |`,
    `| Severity | **${f.severity.toUpperCase()}** |`,
    `| CVE / Advisory | [${f.cveId}](https://osv.dev/vulnerability/${f.cveId}) |`,
    "",
    `## Description`,
    "",
    f.description,
    "",
    `## Remediation`,
    "",
    fix,
    "",
    `## Impact & urgency`,
    "",
    impact,
    "",
    `---`,
    `_This issue was auto-generated by the GlueCron dependency scanner. Close it once the vulnerability is resolved or confirmed not applicable._`,
  ].join("\n");
}

function severityImpactText(severity: VulnFinding["severity"]): string {
  switch (severity) {
    case "critical":
      return (
        "This is a **CRITICAL** vulnerability. It should be addressed immediately — " +
        "critical CVEs are commonly exploited in the wild and can lead to full system compromise, " +
        "data exfiltration, or remote code execution. Treat this as an emergency patch."
      );
    case "high":
      return (
        "This is a **HIGH** severity vulnerability. It should be patched in the next sprint at the latest. " +
        "High severity issues often allow privilege escalation, authentication bypass, or significant data leakage."
      );
    case "medium":
      return (
        "This is a **MEDIUM** severity vulnerability. It should be addressed in the next maintenance window. " +
        "Medium issues typically require specific conditions to exploit but should not be ignored."
      );
    case "low":
      return (
        "This is a **LOW** severity vulnerability. While lower risk, it should be tracked " +
        "and resolved as part of routine dependency maintenance."
      );
  }
}

/**
 * Open a single issue for a critical/high CVE finding.
 * Returns the issue number, or null if skipped/failed.
 */
async function openVulnIssue(
  repoId: string,
  authorId: string,
  finding: VulnFinding,
  labelId: string | null
): Promise<number | null> {
  // Dedup: skip if an issue for this CVE already exists.
  const exists = await cveIssueExists(repoId, finding.cveId);
  if (exists) return null;

  const title = `[CVE] ${finding.packageName} ${finding.installedVersion} — ${finding.severity.toUpperCase()} vulnerability (${finding.cveId})`;
  const body = renderVulnIssueBody(finding);

  try {
    const [inserted] = await db
      .insert(issues)
      .values({ repositoryId: repoId, authorId, title, body, state: "open" })
      .returning();
    if (!inserted) return null;

    if (labelId) await attachLabel(inserted.id, labelId);

    // Bump issue count.
    try {
      const [repo] = await db
        .select({ issueCount: repositories.issueCount })
        .from(repositories)
        .where(eq(repositories.id, repoId))
        .limit(1);
      if (repo) {
        await db
          .update(repositories)
          .set({ issueCount: (repo.issueCount || 0) + 1 })
          .where(eq(repositories.id, repoId));
      }
    } catch {
      /* best-effort */
    }

    return inserted.number;
  } catch {
    return null;
  }
}

/**
 * Find the weekly digest issue for this repo, if one was already opened this week.
 * Returns the issue ID or null.
 */
async function findThisWeeksDigestIssue(
  repoId: string
): Promise<{ id: string; number: number } | null> {
  try {
    const weekAgo = new Date(Date.now() - MS_PER_WEEK);
    const rows = await db
      .select({ id: issues.id, number: issues.number, body: issues.body, createdAt: issues.createdAt })
      .from(issues)
      .where(
        and(
          eq(issues.repositoryId, repoId),
          eq(issues.state, "open"),
          ilike(issues.title, "%Dependency scan digest%")
        )
      )
      .limit(5);

    for (const row of rows) {
      if (
        row.body?.includes(WEEKLY_DIGEST_MARKER) &&
        row.createdAt >= weekAgo
      ) {
        return { id: row.id, number: row.number };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Render the digest body for medium/low findings. */
function renderDigestBody(findings: VulnFinding[]): string {
  const rows = findings
    .map(
      (f) =>
        `| \`${f.packageName}\` | \`${f.installedVersion}\` | ${f.severity.toUpperCase()} | [${f.cveId}](https://osv.dev/vulnerability/${f.cveId}) | ${f.fixVersion ? `\`${f.fixVersion}\`` : "None available"} |`
    )
    .join("\n");

  return [
    WEEKLY_DIGEST_MARKER,
    "",
    `> Automated weekly digest of medium/low severity dependency vulnerabilities detected by GlueCron.`,
    "",
    `## Findings`,
    "",
    `| Package | Version | Severity | Advisory | Fix |`,
    `|---|---|---|---|---|`,
    rows,
    "",
    `---`,
    `_This digest is updated by GlueCron on each push that touches dependency files. Close once all findings are resolved or accepted._`,
  ].join("\n");
}

/**
 * Open or update the weekly digest issue for medium/low findings.
 */
async function upsertDigestIssue(
  repoId: string,
  authorId: string,
  findings: VulnFinding[],
  labelId: string | null
): Promise<void> {
  if (findings.length === 0) return;

  const existing = await findThisWeeksDigestIssue(repoId);
  const title = `Dependency scan digest — ${new Date().toISOString().slice(0, 10)}`;
  const body = renderDigestBody(findings);

  try {
    if (existing) {
      // Update the existing digest issue body.
      await db
        .update(issues)
        .set({ body, updatedAt: new Date() })
        .where(eq(issues.id, existing.id));
    } else {
      // Open a new digest issue.
      const [inserted] = await db
        .insert(issues)
        .values({ repositoryId: repoId, authorId, title, body, state: "open" })
        .returning();
      if (inserted && labelId) await attachLabel(inserted.id, labelId);
      if (inserted) {
        try {
          const [repo] = await db
            .select({ issueCount: repositories.issueCount })
            .from(repositories)
            .where(eq(repositories.id, repoId))
            .limit(1);
          if (repo) {
            await db
              .update(repositories)
              .set({ issueCount: (repo.issueCount || 0) + 1 })
              .where(eq(repositories.id, repoId));
          }
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Scans the dependency files changed in a push and opens/updates security issues.
 *
 * @param repoId      - DB repository UUID
 * @param owner       - Repository owner username
 * @param repoName    - Repository name
 * @param headSha     - The new commit SHA (used to read dependency files)
 * @param oldSha      - The previous commit SHA (used to detect changed files)
 * @param pusherUserId - The user who pushed (used as issue author)
 * @returns Array of VulnFindings found (may be empty)
 */
export async function scanDependencies(
  repoId: string,
  owner: string,
  repoName: string,
  headSha: string,
  oldSha: string,
  pusherUserId: string
): Promise<VulnFinding[]> {
  try {
    // 1. Detect which dependency files changed in this push.
    const changedFiles = await gitDiffNames(owner, repoName, oldSha, headSha);
    const relevantFiles = DEPENDENCY_FILES.filter((f) =>
      changedFiles.includes(f)
    );
    if (relevantFiles.length === 0) return [];

    // 2. Parse all changed dependency files into a package list.
    const allPackages: ParsedPackage[] = [];
    for (const file of relevantFiles) {
      const content = await gitShow(owner, repoName, headSha, file);
      if (!content) continue;
      const parsed = parseManifest(file, content);
      allPackages.push(...parsed);
    }
    if (allPackages.length === 0) return [];

    // 3. Deduplicate by (name, version, ecosystem) to avoid redundant OSV queries.
    const seen = new Set<string>();
    const uniquePackages = allPackages.filter((p) => {
      const key = `${p.ecosystem}:${p.name}@${p.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 4. Query OSV in batches of 200 (API limit).
    const BATCH = 200;
    const findings: VulnFinding[] = [];
    for (let i = 0; i < uniquePackages.length; i += BATCH) {
      const batch = uniquePackages.slice(i, i + BATCH);
      const results = await queryOsv(batch);
      findings.push(...osvResultsToFindings(batch, results));
    }

    if (findings.length === 0) return [];

    // 5. Ensure the security label exists.
    const labelId = await getOrCreateSecurityLabel(repoId);

    // 6. Use pusherUserId as author; fall back to repo owner if not available.
    const authorId = pusherUserId || (await getRepoOwnerId(repoId)) || "";
    if (!authorId) return findings;

    // 7. Separate critical/high from medium/low.
    const urgent = findings.filter(
      (f) => f.severity === "critical" || f.severity === "high"
    );
    const digest = findings.filter(
      (f) => f.severity === "medium" || f.severity === "low"
    );

    // 8. Open one issue per critical/high CVE (idempotent via dedup check).
    for (const f of urgent) {
      await openVulnIssue(repoId, authorId, f, labelId).catch(() => {});
    }

    // 9. Upsert the weekly digest for medium/low findings.
    await upsertDigestIssue(repoId, authorId, digest, labelId).catch(() => {});

    return findings;
  } catch (err) {
    console.error("[dependency-scanner] unexpected error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

export const __internal = {
  parsePackageJson,
  parseRequirementsTxt,
  parseCargoToml,
  parseGoMod,
  parseGemfile,
  mapSeverity,
  extractFixVersion,
  osvResultsToFindings,
  renderVulnIssueBody,
  renderDigestBody,
  WEEKLY_DIGEST_MARKER,
  FILE_ECOSYSTEM,
  DEPENDENCY_FILES,
};
