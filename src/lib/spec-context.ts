/**
 * Spec context reader for spec-to-PR.
 *
 * Given a bare repo on disk and a natural-language spec, produce a bounded
 * "prompt context" package: a capped file list plus the highest-scoring
 * source files (by keyword overlap with the spec), each content-truncated.
 *
 * Design:
 * - All git access is via `Bun.spawn(["git", "-C", repoDiskPath, ...])` —
 *   argv form, no shell.
 * - We never throw: any git/IO failure is returned as `{ok:false, error}`.
 * - Scoring is deliberately cheap (token overlap + a couple of small boosts)
 *   because this runs synchronously before an LLM call on every request and
 *   must stay predictable/cheap.
 * - Binary files are skipped by the classic NUL-byte heuristic so we don't
 *   waste token budget on images/archives.
 */
export type SpecContext = {
  fileList: string[];
  relevantFiles: Array<{ path: string; content: string }>;
  defaultBranch: string;
  totalSizeBytes: number;
};

export type BuildSpecContextArgs = {
  repoDiskPath: string;
  spec: string;
  defaultBranch?: string;
  maxRelevantFiles?: number;
  maxFileBytes?: number;
};

export type BuildSpecContextResult =
  | { ok: true; context: SpecContext }
  | { ok: false; error: string };

const STOP_WORDS = new Set([
  "add",
  "the",
  "and",
  "for",
  "from",
  "with",
  "this",
  "that",
]);

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "php",
]);

const BOOST_NAMES = new Set(["readme", "index", "main", "app"]);

const MAX_FILE_LIST = 500;
const DEFAULT_MAX_RELEVANT = 20;
const DEFAULT_MAX_BYTES = 3000;
const BINARY_SNIFF_BYTES = 8000;

/** Tokenize a spec into lowercase alphanumeric words of length ≥3, stop-words removed. */
function tokenize(spec: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of spec.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Score a path against a set of spec tokens. Higher = more relevant.
 *
 * Exported so the unit tests can exercise scoring without building a real
 * git repo on disk.
 */
export function scoreFile(path: string, tokens: string[]): number {
  const lower = path.toLowerCase();
  const parts = lower.split(/[\/\\._-]+/).filter(Boolean);
  let score = 0;
  for (const tok of tokens) {
    for (const part of parts) {
      if (part === tok) score += 2;
      else if (part.includes(tok)) score += 1;
    }
  }
  // Boost well-known "entry-point"-ish filenames.
  for (const part of parts) {
    if (BOOST_NAMES.has(part)) {
      score += 1;
      break;
    }
  }
  // Boost common code-file extensions.
  const dot = lower.lastIndexOf(".");
  if (dot !== -1) {
    const ext = lower.slice(dot + 1);
    if (CODE_EXTENSIONS.has(ext)) score += 0.5;
  }
  return score;
}

async function runGit(
  repoDiskPath: string,
  args: string[]
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", repoDiskPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return {
        ok: false,
        error: (stderr || `git ${args[0]} exited ${exitCode}`).trim(),
      };
    }
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runGitBytes(
  repoDiskPath: string,
  args: string[]
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", repoDiskPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [bytes, stderr] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return {
        ok: false,
        error: (stderr || `git ${args[0]} exited ${exitCode}`).trim(),
      };
    }
    return { ok: true, bytes: new Uint8Array(bytes) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export async function buildSpecContext(
  args: BuildSpecContextArgs
): Promise<BuildSpecContextResult> {
  const {
    repoDiskPath,
    spec,
    maxRelevantFiles = DEFAULT_MAX_RELEVANT,
    maxFileBytes = DEFAULT_MAX_BYTES,
  } = args;

  // 1. Resolve default branch. We trust `defaultBranch` if passed, otherwise
  //    ask the repo for its symbolic HEAD.
  let defaultBranch = args.defaultBranch;
  if (!defaultBranch) {
    const head = await runGit(repoDiskPath, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    if (!head.ok) return { ok: false, error: head.error };
    defaultBranch = head.stdout.trim();
    if (!defaultBranch) {
      return { ok: false, error: "could not resolve default branch" };
    }
  }

  // 2. Full file list on the branch. Cap before scoring to keep work bounded
  //    on monorepos.
  const tree = await runGit(repoDiskPath, [
    "ls-tree",
    "-r",
    defaultBranch,
    "--name-only",
  ]);
  if (!tree.ok) return { ok: false, error: tree.error };

  const allPaths = tree.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const fileList = allPaths.slice(0, MAX_FILE_LIST);

  // 3. Score & rank. Ties broken by shorter path (likely more central).
  const tokens = tokenize(spec);
  const scored = fileList
    .map((path) => ({ path, score: scoreFile(path, tokens) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.length - b.path.length;
    });

  // 4. Fetch content for the top N. Skip binaries, truncate oversized files.
  const relevantFiles: Array<{ path: string; content: string }> = [];
  let totalSizeBytes = 0;
  const TRUNC_MARKER = "\n...[truncated]";

  for (const { path } of scored) {
    if (relevantFiles.length >= maxRelevantFiles) break;
    const blob = await runGitBytes(repoDiskPath, [
      "show",
      `${defaultBranch}:${path}`,
    ]);
    if (!blob.ok) continue; // submodule, missing, etc. — just skip
    if (looksBinary(blob.bytes)) continue;

    let content = new TextDecoder("utf-8", { fatal: false }).decode(blob.bytes);
    if (content.length > maxFileBytes) {
      content = content.slice(0, maxFileBytes) + TRUNC_MARKER;
    }
    relevantFiles.push({ path, content });
    totalSizeBytes += content.length;
  }

  return {
    ok: true,
    context: {
      fileList,
      relevantFiles,
      defaultBranch,
      totalSizeBytes,
    },
  };
}
