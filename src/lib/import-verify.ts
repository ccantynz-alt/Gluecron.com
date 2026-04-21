/**
 * Post-migration smoke verifier.
 *
 * After an imported repo lands on disk + in the DB, we run a trio of cheap
 * checks to make sure the import actually produced a usable repository:
 *
 *   1. `clonable`          — required bare-repo files exist on disk
 *   2. `hasDefaultBranch`  — `git symbolic-ref HEAD` resolves to a real ref
 *   3. `commitCount`       — `git rev-list --count HEAD` returns > 0
 *
 * Every failure mode is collected into `issues` as a plain string. This
 * function never throws — callers (the /migrations UI in a parallel PR)
 * render `issues` directly.
 */
import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { repositories, users } from "../db/schema";

export interface VerifyMigrationResult {
  repoId: number;
  clonable: boolean;
  hasDefaultBranch: boolean;
  commitCount: number;
  issues: string[];
}

/**
 * Run a shell command (always as argv, never as a shell string — prevents
 * injection via owner/repo names). Returns stdout/stderr/exitCode and never
 * throws; caller decides what to do with a failed exit.
 */
async function runGit(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch (err) {
    return { stdout: "", stderr: String(err), exitCode: -1 };
  }
}

export async function verifyMigration(
  repoId: number
): Promise<VerifyMigrationResult> {
  const issues: string[] = [];
  const result: VerifyMigrationResult = {
    repoId,
    clonable: false,
    hasDefaultBranch: false,
    commitCount: 0,
    issues,
  };

  // 1. Look up the repo joined with its owner so we can resolve the
  //    on-disk path without any extra round-trips.
  let row:
    | { repoName: string; ownerName: string | null }
    | undefined;
  try {
    const rows = await db
      .select({
        repoName: repositories.name,
        ownerName: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, repoId as unknown as string))
      .limit(1);
    row = rows[0];
  } catch (err) {
    issues.push(`db lookup failed: ${String(err).slice(0, 200)}`);
    return result;
  }

  if (!row || !row.ownerName || !row.repoName) {
    issues.push("repo not found");
    return result;
  }

  const base = process.env.GIT_REPOS_PATH || "./repos";
  const path = join(base, row.ownerName, `${row.repoName}.git`);

  // 2. Clonable = the three sentinel files a bare repo always has.
  try {
    const [head, cfg, objects] = await Promise.all([
      Bun.file(join(path, "HEAD")).exists(),
      Bun.file(join(path, "config")).exists(),
      Bun.file(join(path, "objects")).exists(),
    ]);
    if (!head) issues.push("missing HEAD file");
    if (!cfg) issues.push("missing config file");
    if (!objects) issues.push("missing objects directory");
    result.clonable = head && cfg && objects;
  } catch (err) {
    issues.push(`filesystem check failed: ${String(err).slice(0, 200)}`);
  }

  // 3. Default branch = `symbolic-ref HEAD` succeeds AND points somewhere
  //    non-empty. An "unborn" ref still resolves (exit 0) but we require
  //    the commit count below to confirm the ref has history.
  {
    const { stdout, stderr, exitCode } = await runGit([
      "git",
      "-C",
      path,
      "symbolic-ref",
      "HEAD",
    ]);
    if (exitCode === 0 && stdout.trim().length > 0) {
      result.hasDefaultBranch = true;
    } else {
      const detail = (stderr || stdout).trim().slice(0, 200);
      issues.push(
        `symbolic-ref HEAD failed${detail ? `: ${detail}` : ""}`
      );
    }
  }

  // 4. Commit count — if HEAD is unborn or the objects are corrupt,
  //    `rev-list` exits non-zero and we return 0.
  {
    const { stdout, stderr, exitCode } = await runGit([
      "git",
      "-C",
      path,
      "rev-list",
      "--count",
      "HEAD",
    ]);
    if (exitCode === 0) {
      const n = parseInt(stdout.trim(), 10);
      result.commitCount = Number.isFinite(n) && n >= 0 ? n : 0;
    } else {
      const detail = (stderr || stdout).trim().slice(0, 200);
      issues.push(
        `rev-list failed${detail ? `: ${detail}` : ""}`
      );
    }
  }

  return result;
}
