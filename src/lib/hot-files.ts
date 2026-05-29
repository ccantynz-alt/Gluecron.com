/**
 * Hot Files analysis — git log --numstat based file churn.
 *
 * Spawns git to count how frequently each file has been modified within
 * a sliding time window.  Returns the top 50 files ranked by churn
 * (total lines added + deleted), annotated with a risk level.
 */

import { join } from "path";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface HotFile {
  /** Repo-relative path */
  path: string;
  /** Number of commits in which this file appears */
  changes: number;
  /** Total lines added across all commits */
  added: number;
  /** Total lines deleted across all commits */
  deleted: number;
  /** added + deleted */
  churn: number;
  /** Computed risk tier */
  riskLevel: "high" | "medium" | "low";
  /** File extension without leading dot (e.g. "ts", "py") */
  ext: string;
}

// ─── Risk heuristic ───────────────────────────────────────────────────────────

const HIGH_RISK_PATTERNS = [
  "auth",
  "security",
  "schema",
  "db/",
  "middleware",
  "routes/git",
  "crypto",
];

const MEDIUM_RISK_PATTERNS = ["route", "api", "lib/", ".sql"];

function classifyRisk(filePath: string): "high" | "medium" | "low" {
  const lower = filePath.toLowerCase();
  if (HIGH_RISK_PATTERNS.some((p) => lower.includes(p))) return "high";
  if (MEDIUM_RISK_PATTERNS.some((p) => lower.includes(p))) return "medium";
  return "low";
}

function extractExt(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1 || dot === filePath.length - 1) return "";
  return filePath.slice(dot + 1);
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Returns the top ≤50 most-churned files in the repo within the last
 * `windowDays` days, ordered by churn (lines added + deleted) descending.
 *
 * The result is empty when the git repo path does not exist, git fails,
 * or there are no commits in the window.
 */
export async function getHotFiles(
  ownerName: string,
  repoName: string,
  windowDays: number
): Promise<HotFile[]> {
  const repoBase = process.env.GIT_REPOS_PATH || "./repos";
  const diskPath = join(repoBase, `${ownerName}/${repoName}.git`);

  // ─── Spawn git ──────────────────────────────────────────────────────────

  let raw = "";
  try {
    const proc = Bun.spawn(
      [
        "git",
        "--git-dir",
        diskPath,
        "log",
        "--numstat",
        `--since=${windowDays}.days.ago`,
        "--format=",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    raw = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  // ─── Parse --numstat lines ───────────────────────────────────────────────
  //
  // git --numstat emits lines of the form:
  //   <added>\t<deleted>\t<path>
  //
  // When --format= is used the commit header lines are blank, so we only
  // see the numstat data lines (non-blank lines starting with a digit or "-").
  // Binary files show "-\t-\t<path>"; we treat those as 0/0.

  /** Per-file aggregation keyed by file path. */
  const fileMap = new Map<
    string,
    { changes: number; added: number; deleted: number }
  >();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;

    const [rawAdded, rawDeleted, ...pathParts] = parts;
    const filePath = pathParts.join("\t"); // guard against tabs in filenames
    if (!filePath) continue;

    const added = rawAdded === "-" ? 0 : parseInt(rawAdded, 10);
    const deleted = rawDeleted === "-" ? 0 : parseInt(rawDeleted, 10);

    if (isNaN(added) || isNaN(deleted)) continue;

    const existing = fileMap.get(filePath);
    if (existing) {
      existing.changes += 1;
      existing.added += added;
      existing.deleted += deleted;
    } else {
      fileMap.set(filePath, { changes: 1, added, deleted });
    }
  }

  if (fileMap.size === 0) return [];

  // ─── Sort and cap ────────────────────────────────────────────────────────

  const results: HotFile[] = [];
  for (const [path, agg] of fileMap) {
    const churn = agg.added + agg.deleted;
    results.push({
      path,
      changes: agg.changes,
      added: agg.added,
      deleted: agg.deleted,
      churn,
      riskLevel: classifyRisk(path),
      ext: extractExt(path),
    });
  }

  results.sort((a, b) => b.churn - a.churn);

  return results.slice(0, 50);
}
