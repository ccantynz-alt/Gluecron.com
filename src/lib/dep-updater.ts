/**
 * Block D2 — AI-native dependency updater (Dependabot equivalent).
 *
 * Reads a repo's `package.json`, queries the npm registry for updates,
 * and (best-effort) opens a pull request with the bumped versions.
 *
 * Implementation notes:
 *   - Pure-function helpers (parseManifest / planUpdates / applyBumps) are
 *     fully covered by unit tests and make no network or disk I/O.
 *   - The git plumbing (creating a branch + commit + PR row) is wired in
 *     `runDepUpdateRun`. It uses `Bun.spawn` to drive `git hash-object`,
 *     `git mktree`, `git commit-tree`, `git update-ref` — the same pattern
 *     used by `src/routes/editor.tsx`. If any step fails, the run is
 *     recorded with `status:"failed"` and the function never throws.
 *   - If spawning git fails for any reason (missing binary, missing repo,
 *     etc.), the run still records the planned bumps in `attemptedBumps`
 *     so the UI can show what *would* have been done.
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "../db";
import {
  depUpdateRuns,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import {
  getBlob,
  getDefaultBranch,
  getRepoPath,
  resolveRef,
} from "../git/repository";

export type Bump = {
  name: string;
  from: string;
  to: string;
  kind: "dep" | "dev";
  major: boolean;
};

export type ParsedManifest = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  name?: string;
};

/**
 * Tolerant JSON parser. Returns empty structures on any parse error.
 */
export function parseManifest(text: string): ParsedManifest {
  const empty: ParsedManifest = { dependencies: {}, devDependencies: {} };
  if (!text || typeof text !== "string") return empty;
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object") return empty;
    const deps =
      raw.dependencies && typeof raw.dependencies === "object"
        ? (raw.dependencies as Record<string, string>)
        : {};
    const dev =
      raw.devDependencies && typeof raw.devDependencies === "object"
        ? (raw.devDependencies as Record<string, string>)
        : {};
    // Filter to string values only.
    const dependencies: Record<string, string> = {};
    for (const [k, v] of Object.entries(deps)) {
      if (typeof v === "string") dependencies[k] = v;
    }
    const devDependencies: Record<string, string> = {};
    for (const [k, v] of Object.entries(dev)) {
      if (typeof v === "string") devDependencies[k] = v;
    }
    return {
      dependencies,
      devDependencies,
      name: typeof raw.name === "string" ? raw.name : undefined,
    };
  } catch {
    return empty;
  }
}

/**
 * Query the npm registry for the latest version of a package.
 * Returns null on any network / parse error.
 */
export async function queryNpmLatest(
  pkgName: string
): Promise<string | null> {
  try {
    const safe = encodeURIComponent(pkgName).replace(/%40/g, "@");
    const res = await fetch(`https://registry.npmjs.org/${safe}/latest`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== "string") return null;
    return data.version;
  } catch {
    return null;
  }
}

/**
 * Extract a pure semver x.y.z from a range string like `^1.2.3`, `~1.2.3`,
 * `1.2.3`, `>=1.2.3 <2`, etc. Returns null for non-semver strings such as
 * `workspace:*`, `github:foo/bar`, `file:./x`, `latest`, `*`, or `https://…`.
 */
function extractSemver(range: string): { major: number; minor: number; patch: number } | null {
  if (typeof range !== "string") return null;
  const trimmed = range.trim();
  if (!trimmed) return null;
  // Reject obvious non-registry sources.
  if (/^(workspace:|github:|git\+|git:|file:|link:|http:|https:|npm:)/i.test(trimmed)) {
    return null;
  }
  if (trimmed === "*" || /^latest$/i.test(trimmed)) return null;
  const m = trimmed.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

function cmpSemver(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number }
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Walk a manifest and produce a list of bumps. Skips packages with
 * non-semver range strings, no-op bumps, and downgrades.
 */
export async function planUpdates(
  manifest: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  },
  opts?: { fetchLatest?: (name: string) => Promise<string | null> }
): Promise<Bump[]> {
  const fetchLatest = opts?.fetchLatest ?? queryNpmLatest;
  const bumps: Bump[] = [];

  const walk = async (
    bucket: Record<string, string>,
    kind: "dep" | "dev"
  ) => {
    for (const [name, current] of Object.entries(bucket)) {
      const currentParsed = extractSemver(current);
      if (!currentParsed) continue;
      const latest = await fetchLatest(name);
      if (!latest) continue;
      const latestParsed = extractSemver(latest);
      if (!latestParsed) continue;
      // Skip no-ops and downgrades.
      if (cmpSemver(latestParsed, currentParsed) <= 0) continue;
      bumps.push({
        name,
        from: current,
        to: latest,
        kind,
        major: latestParsed.major > currentParsed.major,
      });
    }
  };

  await walk(manifest.dependencies || {}, "dep");
  await walk(manifest.devDependencies || {}, "dev");

  return bumps;
}

/**
 * Rewrite `package.json` text in-place, preserving formatting as much as
 * possible. For each bump, locates the matching `"name": "..."` line inside
 * the correct stanza (`dependencies` vs `devDependencies`) and rewrites
 * only the version string. Preserves the trailing newline.
 */
export function applyBumps(
  manifestText: string,
  bumps: Array<{ name: string; to: string; kind: "dep" | "dev" }>
): string {
  if (!manifestText) return manifestText;

  const hadTrailingNewline = manifestText.endsWith("\n");
  let text = manifestText;

  // Preserve the user's original version prefix (^ / ~ / >= / exact).
  const prefixOf = (val: string): string => {
    const m = val.match(/^\s*([\^~><=]+)/);
    return m ? m[1] : "";
  };

  const stanzaRange = (
    body: string,
    key: "dependencies" | "devDependencies"
  ): { start: number; end: number } | null => {
    // Find the "dependencies": { ... } block. Matches from the key through
    // its matching closing brace, accounting for nested braces (shouldn't
    // occur in package.json, but defensive).
    const keyRe = new RegExp(`"${key}"\\s*:\\s*\\{`);
    const keyMatch = keyRe.exec(body);
    if (!keyMatch) return null;
    const openIdx = body.indexOf("{", keyMatch.index);
    if (openIdx === -1) return null;
    let depth = 1;
    let i = openIdx + 1;
    for (; i < body.length && depth > 0; i++) {
      const ch = body[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth !== 0) return null;
    return { start: openIdx + 1, end: i - 1 }; // content between braces
  };

  for (const bump of bumps) {
    const key = bump.kind === "dep" ? "dependencies" : "devDependencies";
    const range = stanzaRange(text, key);
    if (!range) continue;
    const before = text.slice(0, range.start);
    const inside = text.slice(range.start, range.end);
    const after = text.slice(range.end);

    // Match `"<name>": "<version>"` inside the stanza. Escape special chars
    // in name (npm scopes contain `@` and `/`).
    const escapedName = bump.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lineRe = new RegExp(
      `("${escapedName}"\\s*:\\s*")([^"]+)(")`
    );
    const m = lineRe.exec(inside);
    if (!m) continue;
    const prefix = prefixOf(m[2]);
    const replacement = `${m[1]}${prefix}${bump.to}${m[3]}`;
    const newInside =
      inside.slice(0, m.index) +
      replacement +
      inside.slice(m.index + m[0].length);
    text = before + newInside + after;
  }

  if (hadTrailingNewline && !text.endsWith("\n")) text += "\n";
  if (!hadTrailingNewline && text.endsWith("\n") && !manifestText.endsWith("\n")) {
    // Shouldn't happen, but keep invariant strict.
    text = text.replace(/\n+$/, "");
  }
  return text;
}

/**
 * Format a markdown table describing the applied bumps — used as the PR body.
 */
function renderBumpTable(bumps: Bump[]): string {
  const lines: string[] = [];
  lines.push("Automated dependency update by GlueCron.");
  lines.push("");
  lines.push("| Package | From | To | Kind | Major? |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const b of bumps) {
    lines.push(
      `| \`${b.name}\` | ${b.from} | ${b.to} | ${b.kind} | ${b.major ? "yes" : "no"} |`
    );
  }
  lines.push("");
  lines.push(
    "_This PR was opened by the GlueCron AI dependency updater. Review carefully before merging — major bumps may contain breaking changes._"
  );
  return lines.join("\n");
}

/**
 * Spawn helper used for git plumbing. Returns trimmed stdout and exit code.
 * Never throws — callers check the exit code.
 */
async function spawn(
  cmd: string[],
  cwd: string,
  stdin?: string,
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin !== undefined ? "pipe" : undefined,
      env: { ...process.env, ...(env || {}) },
    });
    if (stdin !== undefined && proc.stdin) {
      (proc.stdin as WritableStreamDefaultWriter<Uint8Array> | any).write(
        new TextEncoder().encode(stdin)
      );
      (proc.stdin as any).end();
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr, exitCode };
  } catch (err: any) {
    return { stdout: "", stderr: String(err?.message || err), exitCode: -1 };
  }
}

/**
 * Write updated file content onto a new branch by building a fresh tree
 * from the current tree entries with one blob replaced, committing it, and
 * pointing the new branch ref at the new commit. Returns `{ ok: true,
 * commitSha }` or `{ ok: false, error }`.
 */
async function writeFileToBranch(
  repoDir: string,
  baseRef: string,
  newBranch: string,
  filePath: string,
  content: string,
  authorName: string,
  authorEmail: string,
  message: string
): Promise<{ ok: true; commitSha: string } | { ok: false; error: string }> {
  // 1. Hash the new blob.
  const hashed = await spawn(
    ["git", "hash-object", "-w", "--stdin"],
    repoDir,
    content
  );
  if (hashed.exitCode !== 0 || !hashed.stdout) {
    return { ok: false, error: `hash-object failed: ${hashed.stderr}` };
  }
  const blobSha = hashed.stdout;

  // 2. Read the existing tree at baseRef.
  const lsTree = await spawn(["git", "ls-tree", "-r", baseRef], repoDir);
  if (lsTree.exitCode !== 0) {
    return { ok: false, error: `ls-tree failed: ${lsTree.stderr}` };
  }
  const entries = lsTree.stdout.split("\n").filter(Boolean);
  let replaced = false;
  const rewritten = entries
    .map((line) => {
      const match = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
      if (!match) return line;
      if (match[4] === filePath) {
        replaced = true;
        return `${match[1]} blob ${blobSha}\t${match[4]}`;
      }
      return line;
    })
    .join("\n");
  const treeInput = replaced
    ? rewritten + "\n"
    : rewritten + (entries.length ? "\n" : "") + `100644 blob ${blobSha}\t${filePath}\n`;

  // 3. Build the new tree.
  const mktree = await spawn(["git", "mktree"], repoDir, treeInput);
  if (mktree.exitCode !== 0 || !mktree.stdout) {
    return { ok: false, error: `mktree failed: ${mktree.stderr}` };
  }
  const newTreeSha = mktree.stdout;

  // 4. Look up the parent commit.
  const parent = await spawn(["git", "rev-parse", baseRef], repoDir);
  if (parent.exitCode !== 0 || !parent.stdout) {
    return { ok: false, error: `rev-parse failed: ${parent.stderr}` };
  }
  const parentSha = parent.stdout;

  // 5. Create the commit.
  const commit = await spawn(
    ["git", "commit-tree", newTreeSha, "-p", parentSha, "-m", message],
    repoDir,
    undefined,
    {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: authorEmail,
    }
  );
  if (commit.exitCode !== 0 || !commit.stdout) {
    return { ok: false, error: `commit-tree failed: ${commit.stderr}` };
  }
  const commitSha = commit.stdout;

  // 6. Point the new branch at the new commit.
  const update = await spawn(
    ["git", "update-ref", `refs/heads/${newBranch}`, commitSha],
    repoDir
  );
  if (update.exitCode !== 0) {
    return { ok: false, error: `update-ref failed: ${update.stderr}` };
  }

  return { ok: true, commitSha };
}

/**
 * Main orchestrator — plan + apply + commit + PR. Never throws.
 *
 * Any failure is recorded on the run row with `status:"failed"`.
 */
export async function runDepUpdateRun(params: {
  repositoryId: string;
  owner: string;
  repo: string;
  userId: string | null;
  manifestPath?: string;
}): Promise<{ runId: string | null; status: string }> {
  const {
    repositoryId,
    owner,
    repo,
    userId,
    manifestPath = "package.json",
  } = params;

  // 1. Insert the run row in "running" state so the UI has something to show.
  let runId: string | null = null;
  try {
    const [inserted] = await db
      .insert(depUpdateRuns)
      .values({
        repositoryId,
        status: "running",
        ecosystem: "npm",
        manifestPath,
        triggeredBy: userId,
      })
      .returning();
    runId = inserted?.id ?? null;
  } catch (err) {
    // If the DB isn't reachable, we've already lost — bail with failure.
    return { runId: null, status: "failed" };
  }

  const finish = async (
    patch: Partial<typeof depUpdateRuns.$inferInsert> & { status: string }
  ) => {
    if (!runId) return;
    try {
      await db
        .update(depUpdateRuns)
        .set({ ...patch, completedAt: new Date() })
        .where(eq(depUpdateRuns.id, runId));
    } catch {
      // Swallow — we already did our best.
    }
  };

  try {
    // 2. Load the manifest from the default branch.
    const branch = (await getDefaultBranch(owner, repo)) || "main";
    const blob = await getBlob(owner, repo, branch, manifestPath);
    if (!blob || blob.isBinary) {
      await finish({
        status: "failed",
        errorMessage: `Could not read ${manifestPath} on ${branch}`,
      });
      return { runId, status: "failed" };
    }

    const manifest = parseManifest(blob.content);
    const bumps = await planUpdates(manifest);

    const attempted = JSON.stringify(bumps);

    if (bumps.length === 0) {
      await finish({
        status: "no_updates",
        attemptedBumps: attempted,
        appliedBumps: "[]",
      });
      return { runId, status: "no_updates" };
    }

    // 3. Apply the bumps to the manifest text.
    const rewritten = applyBumps(blob.content, bumps);

    // 4. Create a new branch with the rewritten manifest.
    const repoDir = getRepoPath(owner, repo);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const branchName = `gluecron/dep-update-${stamp}`;

    const authorName = "GlueCron Bot";
    const authorEmail = "bot@gluecron.com";
    const commitMessage = `chore(deps): bump ${bumps.length} package${bumps.length === 1 ? "" : "s"}`;

    const writeResult = await writeFileToBranch(
      repoDir,
      branch,
      branchName,
      manifestPath,
      rewritten,
      authorName,
      authorEmail,
      commitMessage
    );

    if (!writeResult.ok) {
      // Record the plan but note the failure — useful for the UI.
      await finish({
        status: "failed",
        attemptedBumps: attempted,
        appliedBumps: "[]",
        errorMessage: writeResult.error,
      });
      return { runId, status: "failed" };
    }

    // 5. Insert the PR row. `number` is a serial column in the schema so
    //    the DB assigns it; we just read it back from the RETURNING row.
    let prNumber: number | null = null;
    try {
      const authorId = userId ?? (await resolveBotAuthorId(owner));
      if (!authorId) throw new Error("no author");
      const prBody = renderBumpTable(bumps);
      const prTitle = `chore(deps): bump ${bumps.length} package${bumps.length === 1 ? "" : "s"}`;
      const [pr] = await db
        .insert(pullRequests)
        .values({
          repositoryId,
          authorId,
          title: prTitle,
          body: prBody,
          baseBranch: branch,
          headBranch: branchName,
          isDraft: false,
        })
        .returning();
      prNumber = pr?.number ?? null;
    } catch (err: any) {
      await finish({
        status: "failed",
        attemptedBumps: attempted,
        appliedBumps: attempted,
        branchName,
        errorMessage: `PR insert failed: ${String(err?.message || err)}`,
      });
      return { runId, status: "failed" };
    }

    await finish({
      status: "success",
      attemptedBumps: attempted,
      appliedBumps: attempted,
      branchName,
      prNumber: prNumber ?? undefined,
    });
    return { runId, status: "success" };
  } catch (err: any) {
    await finish({
      status: "failed",
      errorMessage: String(err?.message || err),
    });
    return { runId, status: "failed" };
  }
}

/**
 * Fallback author for bot-authored PRs — the repo owner. We don't have a
 * dedicated bot user row, and the `authorId` column is NOT NULL.
 */
async function resolveBotAuthorId(ownerName: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    return row?.id ?? null;
  } catch {
    return null;
  }
}

export const __internal = {
  extractSemver,
  cmpSemver,
  renderBumpTable,
  writeFileToBranch,
};
