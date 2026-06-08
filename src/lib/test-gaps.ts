/**
 * Test Gap Detector — identify source files with no test coverage, ranked by risk.
 *
 * Steps:
 *  1. git ls-tree to enumerate source + test files
 *  2. Match source files against known test files to find uncovered candidates
 *  3. Read high-risk candidate content via getBlob
 *  4. Single Claude call to score each candidate's functions by risk
 *  5. git grep callsite counts in parallel
 *
 * Cached per-repo with a 2h TTL (in-memory Map).
 */

import { getRepoPath, getBlob } from "../git/repository";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TestGap {
  filePath: string;
  functionName: string;
  riskScore: number;
  riskReason: string;
  suggestedTestPath: string;
  calledByCount: number;
}

export interface TestGapReport {
  repoId: string;
  totalSourceFiles: number;
  totalTestFiles: number;
  coverageEstimate: number;
  gaps: TestGap[];
  analyzedAt: Date;
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  report: TestGapReport;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function execInRepo(
  args: string[],
  repoDir: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    cwd: repoDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

const SOURCE_EXTS = /\.(ts|tsx|js|jsx|py|go|rs)$/;
const TEST_PATTERN = /(\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__\/)/;
const SKIP_DIRS = /(node_modules|dist|build|\.next|vendor|__pycache__)/;

function isSourceFile(p: string): boolean {
  return SOURCE_EXTS.test(p) && !TEST_PATTERN.test(p) && !SKIP_DIRS.test(p);
}

function isTestFile(p: string): boolean {
  return TEST_PATTERN.test(p) && !SKIP_DIRS.test(p);
}

/**
 * Given a source file path, return the set of test-path patterns we'd expect
 * to find for it (basename.test.ts, basename.spec.ts, __tests__/basename.test.ts).
 */
function expectedTestPaths(filePath: string): string[] {
  const withoutExt = filePath.replace(/\.[^.]+$/, "");
  const basename = withoutExt.split("/").pop() ?? withoutExt;
  return [
    `${withoutExt}.test.ts`,
    `${withoutExt}.test.tsx`,
    `${withoutExt}.spec.ts`,
    `${withoutExt}.spec.tsx`,
    `${withoutExt}.test.js`,
    `${withoutExt}.spec.js`,
    `__tests__/${basename}.test.ts`,
    `__tests__/${basename}.test.tsx`,
    `__tests__/${basename}.spec.ts`,
    `${basename}.test.ts`,
    `${basename}.spec.ts`,
  ];
}

/**
 * Check if a source file has any associated test file in the known test set.
 */
function hasTestCoverage(filePath: string, testFileSet: Set<string>): boolean {
  // 1. Direct path match
  for (const pattern of expectedTestPaths(filePath)) {
    if (testFileSet.has(pattern)) return true;
  }
  // 2. Basename appears in any test file path
  const basename = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  if (basename.length < 3) return false; // too generic, skip
  for (const testFile of testFileSet) {
    if (testFile.toLowerCase().includes(basename.toLowerCase())) return true;
  }
  return false;
}

const EXPORT_REGEX =
  /(export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=)/gm;

function extractExportedNames(content: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = EXPORT_REGEX.exec(content)) !== null) {
    const name = match[2] ?? match[3];
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function suggestTestPath(filePath: string): string {
  const dir = filePath.includes("/")
    ? filePath.substring(0, filePath.lastIndexOf("/"))
    : "src";
  const basename = (filePath.split("/").pop() ?? filePath).replace(
    /\.[^.]+$/,
    ""
  );
  if (filePath.startsWith("src/")) {
    return `src/__tests__/${basename}.test.ts`;
  }
  return `${dir}/__tests__/${basename}.test.ts`;
}

// ─── Core detector ───────────────────────────────────────────────────────────

export async function detectTestGaps(
  ownerName: string,
  repoName: string,
  repoId: string
): Promise<TestGapReport> {
  const repoDir = getRepoPath(ownerName, repoName);

  // ── Step 1: get file tree ──────────────────────────────────────────────────
  const { stdout: lsOutput, exitCode } = await execInRepo(
    ["git", "ls-tree", "-r", "--name-only", "HEAD"],
    repoDir
  );

  if (exitCode !== 0) {
    return {
      repoId,
      totalSourceFiles: 0,
      totalTestFiles: 0,
      coverageEstimate: 0,
      gaps: [],
      analyzedAt: new Date(),
    };
  }

  const allFiles = lsOutput.trim().split("\n").filter(Boolean);
  let sourceFiles = allFiles.filter(isSourceFile).slice(0, 200);
  const testFiles = allFiles.filter(isTestFile);
  const testFileSet = new Set(testFiles);

  // ── Step 2: find uncovered source files ───────────────────────────────────
  const candidates = sourceFiles
    .filter((f) => !hasTestCoverage(f, testFileSet))
    .slice(0, 50);

  const coveredCount = sourceFiles.length - candidates.length;
  const coverageEstimate =
    sourceFiles.length > 0
      ? Math.round((coveredCount / sourceFiles.length) * 100)
      : 100;

  if (candidates.length === 0) {
    return {
      repoId,
      totalSourceFiles: sourceFiles.length,
      totalTestFiles: testFiles.length,
      coverageEstimate,
      gaps: [],
      analyzedAt: new Date(),
    };
  }

  // ── Step 3: read candidate content (cap 4KB each, 40KB total) ─────────────
  interface CandidateInfo {
    filePath: string;
    exports: string[];
    content: string;
  }

  const candidateInfos: CandidateInfo[] = [];
  let totalBytes = 0;

  for (const filePath of candidates) {
    if (totalBytes >= 40_000) break;
    try {
      const blob = await getBlob(ownerName, repoName, "HEAD", filePath);
      if (!blob || blob.isBinary || !blob.content) continue;
      const truncated = blob.content.slice(0, 4_096);
      const exports = extractExportedNames(truncated);
      if (exports.length === 0) {
        // Still include with a placeholder so we can score the file overall
        exports.push("<default>");
      }
      candidateInfos.push({ filePath, exports, content: truncated });
      totalBytes += truncated.length;
    } catch {
      // skip unreadable blobs
    }
  }

  if (candidateInfos.length === 0) {
    return {
      repoId,
      totalSourceFiles: sourceFiles.length,
      totalTestFiles: testFiles.length,
      coverageEstimate,
      gaps: [],
      analyzedAt: new Date(),
    };
  }

  // ── Step 4: risk scoring via Claude (or fallback) ─────────────────────────
  interface AiGap {
    filePath: string;
    functionName: string;
    riskScore: number;
    riskReason: string;
    suggestedTestPath: string;
  }

  interface AiResponse {
    gaps: AiGap[];
    coverageEstimate?: number;
  }

  let aiGaps: AiGap[] = [];

  if (isAiAvailable()) {
    const fileList = candidateInfos
      .map((c) => `${c.filePath}: ${c.exports.join(", ")}`)
      .join("\n");

    try {
      const anthropic = getAnthropic();
      const message = await anthropic.messages.create({
        model: MODEL_SONNET,
        max_tokens: 2048,
        system:
          "You are a senior engineer identifying test coverage risks. Rate each untested function by how critical it is to test (0-100 risk score). Higher scores for: auth/security logic, DB mutations, payment handling, public API endpoints, complex business logic. Lower for: pure utilities, string formatters, simple getters.",
        messages: [
          {
            role: "user",
            content: `Repository: ${repoName}
Untested files and their exported functions:
${fileList}

Return JSON:
{"gaps": [{"filePath": "...", "functionName": "...", "riskScore": 0, "riskReason": "...", "suggestedTestPath": "..."}], "coverageEstimate": 0}

Rules:
- One gap entry per function per file (or one per file if no named exports).
- riskScore: integer 0-100.
- suggestedTestPath: where a new test file should live (e.g. "src/__tests__/auth.test.ts").
- Keep gaps list ≤ 30 items total, prioritising highest risk.`,
          },
        ],
      });

      const text = extractText(message);
      const parsed = parseJsonResponse<AiResponse>(text);
      if (parsed && Array.isArray(parsed.gaps)) {
        aiGaps = parsed.gaps;
      }
    } catch {
      // fall through to fallback below
    }
  }

  // Fallback if AI unavailable or failed
  if (aiGaps.length === 0) {
    for (const c of candidateInfos) {
      for (const fn of c.exports.slice(0, 3)) {
        aiGaps.push({
          filePath: c.filePath,
          functionName: fn === "<default>" ? c.filePath.split("/").pop() ?? c.filePath : fn,
          riskScore: 50,
          riskReason: "No test file found for this module",
          suggestedTestPath: suggestTestPath(c.filePath),
        });
      }
    }
  }

  // ── Step 5: callsite counts via git grep ──────────────────────────────────
  const gapsFull: TestGap[] = await Promise.all(
    aiGaps.slice(0, 30).map(async (g) => {
      let calledByCount = 0;
      const fnName = g.functionName.replace(/[^a-zA-Z0-9_]/g, "");
      if (fnName && fnName !== "default") {
        try {
          const { stdout: grepOut } = await execInRepo(
            ["git", "grep", "-l", fnName],
            repoDir
          );
          const matchedFiles = grepOut
            .trim()
            .split("\n")
            .filter(Boolean);
          // Subtract 1 for the definition file itself
          calledByCount = Math.max(0, matchedFiles.length - 1);
        } catch {
          calledByCount = 0;
        }
      }
      return {
        filePath: g.filePath,
        functionName: g.functionName,
        riskScore: Math.min(100, Math.max(0, Math.round(g.riskScore))),
        riskReason: g.riskReason,
        suggestedTestPath: g.suggestedTestPath || suggestTestPath(g.filePath),
        calledByCount,
      };
    })
  );

  // Sort by riskScore desc
  gapsFull.sort((a, b) => b.riskScore - a.riskScore);

  return {
    repoId,
    totalSourceFiles: sourceFiles.length,
    totalTestFiles: testFiles.length,
    coverageEstimate,
    gaps: gapsFull,
    analyzedAt: new Date(),
  };
}

// ─── Cached wrapper ───────────────────────────────────────────────────────────

export async function getTestGaps(
  ownerName: string,
  repoName: string,
  repoId: string
): Promise<TestGapReport> {
  const cached = cache.get(repoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.report;
  }

  const report = await detectTestGaps(ownerName, repoName, repoId);
  cache.set(repoId, {
    report,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  return report;
}

export function clearTestGapsCache(repoId: string): void {
  cache.delete(repoId);
}
