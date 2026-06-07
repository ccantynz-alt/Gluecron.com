/**
 * Codebase Migration Service — AI-powered one-click language/framework translation.
 *
 * Accepts a MigrationTarget (language swap, framework swap, or custom instruction),
 * analyses the repository, generates a Claude-driven translation plan, translates
 * up to 40 files, commits everything to a new branch, and opens a pull request.
 *
 * Job lifecycle: queued → analyzing → translating → committing → opening-pr → done
 *                                                                              ↘ failed
 *
 * All jobs live in an in-memory Map, auto-purged 4 hours after completion.
 */

import { join } from "path";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { config } from "./config";
import { getAnthropic, MODEL_SONNET, extractText, parseJsonResponse } from "./ai-client";
import { db } from "../db";
import { users, repositories, pullRequests } from "../db/schema";
import { eq, and } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MigrationTarget =
  | { type: "language"; from: string; to: string }
  | { type: "framework"; from: string; to: string }
  | { type: "custom"; description: string };

export interface MigrationJob {
  id: string;
  repoId: string;
  owner: string;
  repo: string;
  userId: string;
  target: MigrationTarget;
  status:
    | "queued"
    | "analyzing"
    | "translating"
    | "committing"
    | "opening-pr"
    | "done"
    | "failed";
  progress: number; // 0-100
  currentFile?: string;
  branchName: string;
  prNumber?: number;
  error?: string;
  filesTotal: number;
  filesTranslated: number;
  startedAt: string;
  completedAt?: string;
}

interface MigrationPlan {
  filesToTranslate: Array<{ from: string; to: string; notes: string }>;
  filesToSkip: string[];
  newFiles: Array<{ path: string; content: string }>;
}

interface ResolvedRepo {
  ownerId: string;
  repoId: string;
  defaultBranch: string;
  diskPath: string;
}

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------

const migrationJobs = new Map<string, MigrationJob>();

// Sweep jobs older than 4 hours after completion.
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, job] of migrationJobs) {
    if (
      (job.status === "done" || job.status === "failed") &&
      job.completedAt &&
      new Date(job.completedAt).getTime() < cutoff
    ) {
      migrationJobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Rate limiting — 1 active migration per repo, 3 per user per day
// ---------------------------------------------------------------------------

/** jobId → repoId for active jobs */
const activeByRepo = new Map<string, string>(); // repoId → jobId

/** userId → [timestamp, ...] rolling daily window */
const dailyCounts = new Map<string, number[]>();

function recordDailyUse(userId: string): boolean {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const existing = (dailyCounts.get(userId) ?? []).filter(
    (ts) => now - ts < dayMs
  );
  if (existing.length >= 3) return false;
  existing.push(now);
  dailyCounts.set(userId, existing);
  return true;
}

export function isRepoMigrating(repoId: string): boolean {
  const jobId = activeByRepo.get(repoId);
  if (!jobId) return false;
  const job = migrationJobs.get(jobId);
  if (!job) {
    activeByRepo.delete(repoId);
    return false;
  }
  if (job.status === "done" || job.status === "failed") {
    activeByRepo.delete(repoId);
    return false;
  }
  return true;
}

export function getJob(jobId: string): MigrationJob | undefined {
  return migrationJobs.get(jobId);
}

// ---------------------------------------------------------------------------
// Git helpers (subprocess via Bun.spawn)
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  opts?: { cwd?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Gluecron Migration Bot",
      GIT_AUTHOR_EMAIL: "migration-bot@gluecron.com",
      GIT_COMMITTER_NAME: "Gluecron Migration Bot",
      GIT_COMMITTER_EMAIL: "migration-bot@gluecron.com",
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Return true if the buffer looks like a binary file (null byte in first 512 B) */
function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 512);
  return sample.includes("\0");
}

/** True if the path should always be skipped */
function shouldSkipPath(path: string): boolean {
  const lower = path.toLowerCase();
  const skip = [
    "node_modules/",
    "dist/",
    ".git/",
    ".next/",
    "build/",
    "target/",
    "__pycache__/",
    ".venv/",
    "vendor/",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "poetry.lock",
    "cargo.lock",
    "go.sum",
    "composer.lock",
    "gemfile.lock",
  ];
  return skip.some((s) => lower.includes(s));
}

// ---------------------------------------------------------------------------
// Claude helpers
// ---------------------------------------------------------------------------

function targetLabel(target: MigrationTarget): string {
  if (target.type === "language") return `${target.from} → ${target.to}`;
  if (target.type === "framework") return `${target.from} → ${target.to}`;
  return target.description;
}

async function planMigration(
  fileList: string[],
  target: MigrationTarget
): Promise<MigrationPlan | null> {
  const anthropic = getAnthropic();

  let goalDescription: string;
  if (target.type === "language") {
    goalDescription = `Convert all source code from ${target.from} to ${target.to}`;
  } else if (target.type === "framework") {
    goalDescription = `Migrate the codebase from ${target.from} framework to ${target.to} framework`;
  } else {
    goalDescription = target.description;
  }

  const fileListStr = fileList.slice(0, 500).join("\n");

  const prompt = `You are a migration expert. Given this repository's file list, create a migration plan.

Goal: ${goalDescription}

Files in repository:
${fileListStr}

Return a JSON object (no markdown, no code fences, raw JSON only) with this exact shape:
{
  "filesToTranslate": [
    { "from": "src/index.ts", "to": "src/index.py", "notes": "convert Express handlers to Flask routes" }
  ],
  "filesToSkip": ["package-lock.json", "node_modules/..."],
  "newFiles": [
    { "path": "requirements.txt", "content": "flask==3.0.0\n..." }
  ]
}

Rules:
- filesToTranslate: only source code files (no binaries, no lock files, no minified JS in dist/)
- Cap filesToTranslate at 40 entries maximum
- filesToSkip: lock files, binary assets, generated files that don't need translation
- newFiles: new config/manifest files needed for the target (e.g. requirements.txt for Python, go.mod for Go)
- Keep new file content concise and correct for the target stack
- The "to" field should use the correct extension for the target language`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractText(msg);
    const plan = parseJsonResponse<MigrationPlan>(text);
    if (!plan) return null;
    // Clamp to 40 files
    if (plan.filesToTranslate && plan.filesToTranslate.length > 40) {
      plan.filesToTranslate = plan.filesToTranslate.slice(0, 40);
    }
    return plan;
  } catch {
    return null;
  }
}

async function translateFile(
  content: string,
  fromPath: string,
  target: MigrationTarget,
  notes: string
): Promise<string | null> {
  const anthropic = getAnthropic();

  let instruction: string;
  if (target.type === "language") {
    instruction = `Translate this ${target.from} file to ${target.to}.${notes ? ` Notes: ${notes}` : ""}`;
  } else if (target.type === "framework") {
    instruction = `Migrate this file from ${target.from} to ${target.to}.${notes ? ` Notes: ${notes}` : ""}`;
  } else {
    instruction = `Apply this transformation: ${target.description}${notes ? `. Notes: ${notes}` : ""}`;
  }

  const prompt = `${instruction}

Return ONLY the translated file content, no explanation, no code fences, no markdown. Start the output with the actual file content.

Original file (${fromPath}):
${content}`;

  try {
    const msg = await anthropic.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });
    return extractText(msg);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function resolveRepo(
  ownerName: string,
  repoName: string
): Promise<ResolvedRepo | null> {
  try {
    const [ownerRow] = await db
      .select()
      .from(users)
      .where(eq(users.username, ownerName))
      .limit(1);
    if (!ownerRow) return null;
    const [repoRow] = await db
      .select()
      .from(repositories)
      .where(
        and(
          eq(repositories.ownerId, ownerRow.id),
          eq(repositories.name, repoName)
        )
      )
      .limit(1);
    if (!repoRow) return null;
    return {
      ownerId: ownerRow.id,
      repoId: repoRow.id,
      defaultBranch: repoRow.defaultBranch || "main",
      diskPath: repoRow.diskPath,
    };
  } catch {
    return null;
  }
}

async function insertPullRequest(params: {
  repositoryId: string;
  authorId: string;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
}): Promise<number> {
  const [row] = await db
    .insert(pullRequests)
    .values({
      repositoryId: params.repositoryId,
      authorId: params.authorId,
      title: params.title,
      body: params.body,
      state: "open",
      baseBranch: params.baseBranch,
      headBranch: params.headBranch,
      isDraft: true,
    })
    .returning({ number: pullRequests.number });
  return row.number;
}

// ---------------------------------------------------------------------------
// Main migration pipeline
// ---------------------------------------------------------------------------

async function runMigration(job: MigrationJob): Promise<void> {
  const worktreeBase = join(config.gitReposPath, ".migration-worktrees");
  const worktreePath = join(worktreeBase, job.id);

  try {
    // ── 1. Resolve the repo ──────────────────────────────────────────────────
    job.status = "analyzing";
    job.progress = 5;

    const resolved = await resolveRepo(job.owner, job.repo);
    if (!resolved) throw new Error("Repository not found");

    const bareRepoPath = resolved.diskPath;

    // ── 2. Get file list ─────────────────────────────────────────────────────
    const lsResult = await git(["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: bareRepoPath,
    });
    if (lsResult.exitCode !== 0) {
      // Empty repo
      throw new Error("Repository has no commits yet — nothing to migrate");
    }

    const allFiles = lsResult.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => !shouldSkipPath(f));

    if (allFiles.length === 0) {
      throw new Error("No translatable files found in the repository");
    }

    job.progress = 10;

    // ── 3. Plan the migration ────────────────────────────────────────────────
    const plan = await planMigration(allFiles, job.target);
    if (!plan) throw new Error("Failed to generate migration plan from Claude");

    job.filesTotal = plan.filesToTranslate.length + plan.newFiles.length;
    job.progress = 20;

    // ── 4. Create worktree ──────────────────────────────────────────────────
    await mkdir(worktreeBase, { recursive: true });

    // git worktree add creates a linked working tree from the bare repo
    const wtResult = await git(
      ["worktree", "add", "--no-checkout", worktreePath, "HEAD"],
      { cwd: bareRepoPath }
    );
    if (wtResult.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${wtResult.stderr}`);
    }

    // Checkout the default branch content into the worktree
    const checkoutResult = await git(["checkout", "-f", "HEAD", "--", "."], {
      cwd: worktreePath,
    });
    // Silently continue even if partial checkout — some files may not exist

    // Create and switch to the migration branch
    const branchResult = await git(
      ["checkout", "-b", job.branchName],
      { cwd: worktreePath }
    );
    if (branchResult.exitCode !== 0) {
      throw new Error(`Failed to create branch: ${branchResult.stderr}`);
    }

    // ── 5. Translate files ───────────────────────────────────────────────────
    job.status = "translating";
    job.progress = 25;

    const progressPerFile = plan.filesToTranslate.length > 0
      ? 50 / plan.filesToTranslate.length
      : 50;

    for (let i = 0; i < plan.filesToTranslate.length; i++) {
      const entry = plan.filesToTranslate[i];
      job.currentFile = entry.from;
      job.filesTranslated = i;

      // Read original file content
      let originalContent: string;
      try {
        const showResult = await git(
          ["show", `HEAD:${entry.from}`],
          { cwd: bareRepoPath }
        );
        if (showResult.exitCode !== 0) {
          // File doesn't exist or can't be read — skip
          job.progress = Math.round(25 + (i + 1) * progressPerFile);
          continue;
        }
        originalContent = showResult.stdout;
      } catch {
        job.progress = Math.round(25 + (i + 1) * progressPerFile);
        continue;
      }

      // Skip binary files
      if (isBinaryContent(originalContent)) {
        job.progress = Math.round(25 + (i + 1) * progressPerFile);
        continue;
      }

      // Skip very large files (50KB)
      if (originalContent.length > 50 * 1024) {
        job.progress = Math.round(25 + (i + 1) * progressPerFile);
        continue;
      }

      // Translate via Claude
      const translated = await translateFile(
        originalContent,
        entry.from,
        job.target,
        entry.notes || ""
      );
      if (!translated) {
        // Translation failed for this file — skip gracefully
        job.progress = Math.round(25 + (i + 1) * progressPerFile);
        continue;
      }

      // Write translated file to the destination path
      const destPath = join(worktreePath, entry.to);
      const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
      if (destDir && destDir !== worktreePath) {
        await mkdir(destDir, { recursive: true });
      }
      await writeFile(destPath, translated, "utf-8");

      // If the source and destination paths differ, remove the old file
      if (entry.from !== entry.to) {
        const srcPath = join(worktreePath, entry.from);
        if (existsSync(srcPath)) {
          try {
            await rm(srcPath);
          } catch {
            // Non-fatal
          }
        }
      }

      job.filesTranslated = i + 1;
      job.progress = Math.round(25 + (i + 1) * progressPerFile);
    }

    // Write new files (package.json, requirements.txt, etc.)
    for (const newFile of plan.newFiles) {
      const destPath = join(worktreePath, newFile.path);
      const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
      if (destDir && destDir !== worktreePath) {
        await mkdir(destDir, { recursive: true });
      }
      await writeFile(destPath, newFile.content, "utf-8");
      job.filesTranslated = Math.min(
        job.filesTranslated + 1,
        job.filesTotal
      );
    }

    job.currentFile = undefined;
    job.progress = 75;

    // ── 6. Commit ────────────────────────────────────────────────────────────
    job.status = "committing";

    const label = targetLabel(job.target);
    const addResult = await git(["add", "-A"], { cwd: worktreePath });
    if (addResult.exitCode !== 0) {
      throw new Error(`git add failed: ${addResult.stderr}`);
    }

    // Check if there's anything to commit
    const statusResult = await git(
      ["status", "--porcelain"],
      { cwd: worktreePath }
    );
    if (!statusResult.stdout.trim()) {
      throw new Error("No changes were produced by the migration — all files may have been skipped");
    }

    const commitMsg = `migrate: AI translation — ${label}\n\nAutomatically generated by Gluecron AI Codebase Migrator.\nFiles translated: ${job.filesTranslated}/${job.filesTotal}`;
    const commitResult = await git(
      ["commit", "-m", commitMsg],
      { cwd: worktreePath }
    );
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit failed: ${commitResult.stderr}`);
    }

    job.progress = 85;

    // ── 7. Push ──────────────────────────────────────────────────────────────
    // Push the new branch from the worktree into the bare repo
    const pushResult = await git(
      ["push", bareRepoPath, `HEAD:refs/heads/${job.branchName}`],
      { cwd: worktreePath }
    );
    if (pushResult.exitCode !== 0) {
      throw new Error(`git push failed: ${pushResult.stderr}`);
    }

    job.progress = 92;

    // ── 8. Open PR ───────────────────────────────────────────────────────────
    job.status = "opening-pr";

    const prBody = [
      `## AI Codebase Migration — ${label}`,
      "",
      "This pull request was **automatically generated** by the Gluecron AI Codebase Migrator.",
      "",
      `**Migration type:** ${job.target.type}`,
      `**Target:** ${label}`,
      `**Files translated:** ${job.filesTranslated}`,
      `**Total files processed:** ${job.filesTotal}`,
      "",
      "> **Review carefully before merging.** AI translation is thorough but not perfect.",
      "> Test the migrated code in a staging environment before landing to main.",
    ].join("\n");

    const prTitle = `migrate: AI codebase migration — ${label}`;

    const prNumber = await insertPullRequest({
      repositoryId: resolved.repoId,
      authorId: job.userId,
      title: prTitle,
      body: prBody,
      baseBranch: resolved.defaultBranch,
      headBranch: job.branchName,
    });

    job.prNumber = prNumber;
    job.progress = 100;
    job.status = "done";
    job.completedAt = new Date().toISOString();
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : "Unknown error";
    job.completedAt = new Date().toISOString();
  } finally {
    // Clean up the worktree regardless of success or failure
    try {
      if (existsSync(worktreePath)) {
        // Prune the worktree registration from the bare repo
        const resolved2 = await resolveRepo(job.owner, job.repo);
        if (resolved2) {
          await git(["worktree", "prune"], { cwd: resolved2.diskPath });
        }
        await rm(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
    // Release the repo lock
    activeByRepo.delete(job.repoId);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartMigrationParams {
  owner: string;
  repo: string;
  repoId: string;
  userId: string;
  target: MigrationTarget;
}

export async function startMigration(
  params: StartMigrationParams
): Promise<{ ok: true; job: MigrationJob } | { ok: false; error: string }> {
  // Rate limit: 1 active migration per repo
  if (isRepoMigrating(params.repoId)) {
    return {
      ok: false,
      error: "A migration is already in progress for this repository. Wait for it to finish.",
    };
  }

  // Rate limit: 3 per user per day
  if (!recordDailyUse(params.userId)) {
    return {
      ok: false,
      error: "You have reached the daily limit of 3 migrations. Try again tomorrow.",
    };
  }

  const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const timestamp = Math.floor(Date.now() / 1000);
  let branchSuffix: string;
  if (params.target.type === "language") {
    branchSuffix = `${params.target.from.toLowerCase()}-to-${params.target.to.toLowerCase()}`;
  } else if (params.target.type === "framework") {
    branchSuffix = `${params.target.from.toLowerCase()}-to-${params.target.to.toLowerCase()}`;
  } else {
    branchSuffix = "custom";
  }
  // Sanitize branch name
  branchSuffix = branchSuffix.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40);
  const branchName = `migrate/${branchSuffix}-${timestamp}`;

  const job: MigrationJob = {
    id: jobId,
    repoId: params.repoId,
    owner: params.owner,
    repo: params.repo,
    userId: params.userId,
    target: params.target,
    status: "queued",
    progress: 0,
    branchName,
    filesTotal: 0,
    filesTranslated: 0,
    startedAt: new Date().toISOString(),
  };

  migrationJobs.set(jobId, job);
  activeByRepo.set(params.repoId, jobId);

  // Fire and forget
  void runMigration(job);

  return { ok: true, job };
}
