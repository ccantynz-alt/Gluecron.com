/**
 * AI Technical Debt Analyzer.
 *
 * Scans a repository's files, extracts static metrics, then uses Claude
 * Sonnet to score the top 20 files by technical debt. Returns a DebtReport
 * with per-file scores, issue lists, and estimated cleanup hours.
 */

import { join } from "path";
import { config } from "./config";
import { getAnthropic, MODEL_SONNET, extractText, parseJsonResponse } from "./ai-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DebtNode {
  path: string;
  lines: number;
  debtScore: number;       // 0-100, higher = more debt
  issues: string[];        // e.g. ["Long functions (avg 87 lines)", "Deep nesting"]
  estimatedHours: number;  // Claude's estimate to clean up
  imports: string[];       // files this file imports (resolved relative paths)
}

export interface DebtReport {
  repoId: string;
  commitSha: string;
  nodes: DebtNode[];
  totalDebtHours: number;
  analyzedAt: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".go", ".rs", ".java", ".rb", ".php",
]);

const SKIP_PATTERNS = ["node_modules/", "dist/", ".min.", "vendor/"];

const MAX_FILES = 150;
const MAX_AI_FILES = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run a git command inside the bare repo directory for `owner/repo`. */
async function gitExec(
  repoPath: string,
  args: string[]
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text;
}

/** Return true if a file path should be skipped. */
function shouldSkip(path: string): boolean {
  for (const pat of SKIP_PATTERNS) {
    if (path.includes(pat)) return true;
  }
  return false;
}

/** Return true if the file has a code extension we want to analyze. */
function isCodeFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return CODE_EXTENSIONS.has(path.slice(dot));
}

/** Count lines in a string. */
function countLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").length;
}

/** Count TODO/FIXME/HACK/XXX occurrences. */
function countTodos(content: string): number {
  return (content.match(/\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b/g) || []).length;
}

/** Rough complexity hint: count function/def/fn keywords vs line count. */
function complexityHint(content: string, lines: number): string {
  const fnCount = (
    content.match(/\b(function|def |fn |func |async function|const \w+ = \(|=> \{)/g) || []
  ).length;
  if (lines === 0) return "empty";
  if (lines > 800) return "very large file";
  if (lines > 400) return "large file";
  if (fnCount > 0) {
    const avgFnLen = Math.round(lines / fnCount);
    if (avgFnLen > 60) return `avg function ${avgFnLen} lines`;
  }
  return "normal";
}

/**
 * Extract import paths from a file's content.
 * Handles: import/from (ES modules), require() calls.
 * Returns only local relative imports (starting with . or /).
 */
function extractImports(content: string, filePath: string): string[] {
  const imports: string[] = [];
  const dir = filePath.includes("/")
    ? filePath.slice(0, filePath.lastIndexOf("/"))
    : "";

  // ES import: import ... from '...' or import '...'
  const esImports = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
  for (const m of esImports) {
    imports.push(m[1]);
  }
  // require(): require('...')
  const requireImports = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
  for (const m of requireImports) {
    imports.push(m[1]);
  }

  // Filter to relative/local only, resolve to plausible path
  const resolved: string[] = [];
  for (const imp of imports) {
    if (!imp.startsWith(".") && !imp.startsWith("/")) continue;
    // Simple resolution
    let resolved_path = imp.startsWith("/")
      ? imp.slice(1)
      : dir
      ? `${dir}/${imp}`
      : imp;
    // Normalize .. segments (very roughly)
    const parts = resolved_path.split("/").filter(Boolean);
    const stack: string[] = [];
    for (const p of parts) {
      if (p === "..") stack.pop();
      else if (p !== ".") stack.push(p);
    }
    resolved_path = stack.join("/");
    if (resolved_path) resolved.push(resolved_path);
  }
  return [...new Set(resolved)];
}

/** Heuristic debt score for files not sent to Claude. */
function heuristicScore(todos: number, lines: number): number {
  return Math.min(100, todos * 5 + Math.min(50, Math.round(lines / 20)));
}

// ─── Main analyzer ────────────────────────────────────────────────────────────

export async function analyzeRepo(
  repoId: string,
  owner: string,
  repo: string
): Promise<DebtReport> {
  const repoPath = join(config.gitReposPath, owner, `${repo}.git`);

  // 1. List all files at HEAD
  const lsOutput = await gitExec(repoPath, ["ls-tree", "-r", "--name-only", "HEAD"]);
  const allFiles = lsOutput
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && isCodeFile(f) && !shouldSkip(f))
    .slice(0, MAX_FILES);

  // 2. Get HEAD commit SHA
  const sha = (await gitExec(repoPath, ["rev-parse", "HEAD"])).trim();

  // 3. Read each file, gather static metrics
  interface FileInfo {
    path: string;
    content: string;
    lines: number;
    todos: number;
    hint: string;
    imports: string[];
  }

  const fileInfos: FileInfo[] = [];
  for (const path of allFiles) {
    const content = await gitExec(repoPath, ["show", `HEAD:${path}`]).catch(() => "");
    const lines = countLines(content);
    const todos = countTodos(content);
    const hint = complexityHint(content, lines);
    const imports = extractImports(content, path);
    fileInfos.push({ path, content, lines, todos, hint, imports });
  }

  // 4. Sort by line count desc; pick top 20 for Claude
  fileInfos.sort((a, b) => b.lines - a.lines);
  const topFiles = fileInfos.slice(0, MAX_AI_FILES);
  const restFiles = fileInfos.slice(MAX_AI_FILES);

  // 5. Call Claude for the top 20
  let aiResults: Map<string, { debtScore: number; issues: string[]; estimatedHours: number }> =
    new Map();

  if (topFiles.length > 0) {
    const prompt = `You are a senior engineer assessing technical debt. Rate each file's debt 0-100 and estimate cleanup hours.
Return a JSON array only, no prose: [{"path":"...","debtScore":N,"issues":["..."],"estimatedHours":N}, ...]

Files:
${JSON.stringify(
  topFiles.map((f) => ({
    path: f.path,
    lines: f.lines,
    todos: f.todos,
    complexityHint: f.hint,
  }))
)}`;

    try {
      const client = getAnthropic();
      const msg = await client.messages.create({
        model: MODEL_SONNET,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      const text = extractText(msg);
      type AiRow = { path: string; debtScore: number; issues: string[]; estimatedHours: number };
      const parsed = parseJsonResponse<AiRow[]>(text);
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (row && typeof row.path === "string") {
            aiResults.set(row.path, {
              debtScore: Math.min(100, Math.max(0, Number(row.debtScore) || 0)),
              issues: Array.isArray(row.issues)
                ? row.issues.map(String)
                : [],
              estimatedHours: Math.max(0, Number(row.estimatedHours) || 0),
            });
          }
        }
      }
    } catch {
      // Claude unavailable — fall through to heuristics for all
    }
  }

  // 6. Build nodes
  const nodes: DebtNode[] = [];

  for (const f of topFiles) {
    const ai = aiResults.get(f.path);
    if (ai) {
      nodes.push({
        path: f.path,
        lines: f.lines,
        debtScore: ai.debtScore,
        issues: ai.issues,
        estimatedHours: ai.estimatedHours,
        imports: f.imports,
      });
    } else {
      const score = heuristicScore(f.todos, f.lines);
      nodes.push({
        path: f.path,
        lines: f.lines,
        debtScore: score,
        issues: buildHeuristicIssues(f.todos, f.lines, f.hint),
        estimatedHours: Math.round(score / 10),
        imports: f.imports,
      });
    }
  }

  for (const f of restFiles) {
    const score = heuristicScore(f.todos, f.lines);
    nodes.push({
      path: f.path,
      lines: f.lines,
      debtScore: score,
      issues: buildHeuristicIssues(f.todos, f.lines, f.hint),
      estimatedHours: Math.round(score / 10),
      imports: f.imports,
    });
  }

  const totalDebtHours = nodes.reduce((sum, n) => sum + n.estimatedHours, 0);

  return {
    repoId,
    commitSha: sha,
    nodes,
    totalDebtHours,
    analyzedAt: new Date().toISOString(),
  };
}

function buildHeuristicIssues(todos: number, lines: number, hint: string): string[] {
  const issues: string[] = [];
  if (todos > 0) issues.push(`${todos} TODO/FIXME comment${todos > 1 ? "s" : ""}`);
  if (lines > 800) issues.push("Very large file (>800 lines)");
  else if (lines > 400) issues.push("Large file (>400 lines)");
  if (hint !== "normal" && hint !== "empty" && hint !== "large file" && hint !== "very large file") {
    issues.push(hint.charAt(0).toUpperCase() + hint.slice(1));
  }
  return issues;
}
