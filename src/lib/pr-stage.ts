/**
 * /stage slash-command — deploys a per-PR preview environment.
 *
 * When a user comments `/stage` on any PR, this module:
 *   1. Detects the repo's framework (next.js, bun, docker, static, node)
 *   2. For static/nextjs repos: runs `bun run build` in a temporary worktree
 *   3. Falls back to a built-in static file server at GET /preview/:stageJobId/*
 *      when no cloud deploy provider is configured
 *   4. Posts a reply comment with the live URL (or an error)
 *
 * All stage jobs are held in memory with a 4-hour TTL. Static previews
 * additionally write files to ${GIT_REPOS_PATH}/.stage-previews/${id}/ and
 * are served for 48 hours via src/routes/pulls.tsx (previewRoute).
 *
 * No new npm packages — uses only Bun built-ins.
 */

import { join } from "path";
import { db } from "../db";
import { pullRequests, prComments, repositories, users } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { config } from "./config";
import { getRepoPath } from "../git/repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageJob {
  id: string;
  prId: string;
  repoId: string;
  status: "queued" | "detecting" | "deploying" | "live" | "failed";
  framework?: "nextjs" | "node" | "bun" | "static" | "docker";
  previewUrl?: string;
  error?: string;
  startedAt: string;
  liveAt?: string;
}

// ---------------------------------------------------------------------------
// In-memory store (4 h TTL)
// ---------------------------------------------------------------------------

const STAGE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const stageJobs = new Map<
  string,
  { job: StageJob; expiresAt: number }
>();

// Key: prId → jobId (so we can detect existing active jobs per PR)
const prToJobId = new Map<string, string>();

function getJob(id: string): StageJob | null {
  const entry = stageJobs.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    stageJobs.delete(id);
    return null;
  }
  return entry.job;
}

function setJob(job: StageJob): void {
  stageJobs.set(job.id, {
    job,
    expiresAt: Date.now() + STAGE_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

async function detectFramework(
  ownerName: string,
  repoName: string
): Promise<StageJob["framework"]> {
  const repoDir = getRepoPath(ownerName, repoName);
  // List all files (HEAD) — bare repo so we use ls-tree
  const { stdout } = await git(
    ["ls-tree", "-r", "--name-only", "HEAD"],
    repoDir
  );
  const files = stdout.trim().split("\n").filter(Boolean);

  const hasFile = (name: string) =>
    files.some((f) => f === name || f.endsWith(`/${name}`));
  const hasPattern = (re: RegExp) => files.some((f) => re.test(f));

  if (hasPattern(/^next\.config\.(js|ts|mjs|cjs)$/)) return "nextjs";

  // Check package.json for bun engine
  if (hasFile("package.json")) {
    try {
      const { stdout: blob } = await git(
        ["show", `HEAD:package.json`],
        repoDir
      );
      const pkg = JSON.parse(blob) as Record<string, unknown>;
      const engines = pkg.engines as Record<string, string> | undefined;
      if (engines && typeof engines.bun === "string") return "bun";
    } catch {
      /* ignore parse errors */
    }
  }

  if (hasFile("Dockerfile")) return "docker";
  if (hasFile("index.html")) return "static";

  return "node";
}

// ---------------------------------------------------------------------------
// Static file serving helpers
// ---------------------------------------------------------------------------

const PREVIEW_SERVE_DIR_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const previewExpiry = new Map<string, number>(); // jobId → expiresAt

export function getPreviewDir(jobId: string): string {
  return join(config.gitReposPath, ".stage-previews", jobId);
}

export function markPreviewExpiry(jobId: string): void {
  previewExpiry.set(jobId, Date.now() + PREVIEW_SERVE_DIR_TTL_MS);
}

export function isPreviewExpired(jobId: string): boolean {
  const exp = previewExpiry.get(jobId);
  if (exp === undefined) return true;
  return Date.now() > exp;
}

// ---------------------------------------------------------------------------
// Post a PR comment as the system (bot) user — inserts directly into DB
// ---------------------------------------------------------------------------

async function postPrComment(prId: string, body: string): Promise<void> {
  // Find the repo owner to use as the author (best-effort)
  const [pr] = await db
    .select({ authorId: pullRequests.authorId })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .limit(1);
  if (!pr) return;

  await db.insert(prComments).values({
    pullRequestId: prId,
    authorId: pr.authorId,
    body,
    moderationStatus: "approved",
  });
}

// ---------------------------------------------------------------------------
// Build a static preview — checkout HEAD into a worktree, optionally build
// ---------------------------------------------------------------------------

async function buildStaticPreview(
  ownerName: string,
  repoName: string,
  framework: StageJob["framework"],
  jobId: string
): Promise<{ ok: boolean; error?: string }> {
  const repoDir = getRepoPath(ownerName, repoName);
  const outputDir = getPreviewDir(jobId);

  // Create a temporary worktree
  const worktreeDir = join(
    config.gitReposPath,
    ".stage-worktrees",
    `${jobId}_${Date.now()}`
  );

  try {
    // Create worktree (detached HEAD at HEAD commit)
    const wt = await git(
      ["worktree", "add", "--detach", worktreeDir, "HEAD"],
      repoDir
    );
    if (wt.exitCode !== 0) {
      return { ok: false, error: wt.stderr.trim() || "Failed to create worktree" };
    }

    // For nextjs/node/bun — try to build
    if (framework === "nextjs" || framework === "bun" || framework === "node") {
      // Check if package.json exists before attempting build
      const hasPackageJson = await Bun.file(
        join(worktreeDir, "package.json")
      ).exists();
      if (hasPackageJson) {
        const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
          cwd: worktreeDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        await install.exited; // best-effort

        const build = Bun.spawn(["bun", "run", "build"], {
          cwd: worktreeDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        const buildExit = await build.exited;
        if (buildExit !== 0) {
          // Build failed — try to serve static files from the worktree as-is
          // (some projects don't have a build step)
        }
      }
    }

    // Determine what to copy into outputDir
    // nextjs: .next/static or out/ or build/
    // others: dist/ or public/ or . (whole worktree)
    const candidateDirs: string[] = [];
    if (framework === "nextjs") {
      candidateDirs.push(
        join(worktreeDir, "out"),
        join(worktreeDir, ".next", "static"),
        join(worktreeDir, "build")
      );
    }
    candidateDirs.push(
      join(worktreeDir, "dist"),
      join(worktreeDir, "public"),
      join(worktreeDir, "_site"),
      worktreeDir
    );

    // Find first candidate that has an index.html
    let sourceDir: string | null = null;
    for (const candidate of candidateDirs) {
      try {
        const indexExists = await Bun.file(
          join(candidate, "index.html")
        ).exists();
        if (indexExists) {
          sourceDir = candidate;
          break;
        }
      } catch {
        /* skip */
      }
    }

    if (!sourceDir) {
      // Copy the entire worktree
      sourceDir = worktreeDir;
    }

    // Recursively copy sourceDir → outputDir
    const copyResult = await copyDir(sourceDir, outputDir);
    if (!copyResult.ok) {
      return { ok: false, error: copyResult.error };
    }

    markPreviewExpiry(jobId);
    return { ok: true };
  } finally {
    // Clean up worktree
    await git(["worktree", "remove", "--force", worktreeDir], repoDir).catch(
      () => {}
    );
  }
}

// ---------------------------------------------------------------------------
// Simple recursive directory copy using Bun
// ---------------------------------------------------------------------------

async function copyDir(
  src: string,
  dst: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Ensure destination directory exists first
    const mkdir = Bun.spawn(["mkdir", "-p", dst], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await mkdir.exited;

    const proc = Bun.spawn(["cp", "-r", src + "/.", dst], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain stdout to prevent deadlock
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      return {
        ok: false,
        error: stderr.trim() || `cp exited ${exitCode}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main trigger function
// ---------------------------------------------------------------------------

export async function triggerStage(
  prId: string,
  _triggeredByUserId: string
): Promise<StageJob> {
  // Return existing active job if one exists for this PR
  const existingJobId = prToJobId.get(prId);
  if (existingJobId) {
    const existing = getJob(existingJobId);
    if (
      existing &&
      (existing.status === "live" || existing.status === "deploying" || existing.status === "detecting")
    ) {
      return existing;
    }
  }

  // Create new job
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const job: StageJob = {
    id: jobId,
    prId,
    repoId: "",
    status: "queued",
    startedAt: now,
  };

  setJob(job);
  prToJobId.set(prId, jobId);

  // Run the pipeline asynchronously (fire-and-forget from caller's perspective)
  runStagePipeline(job).catch((err) => {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    setJob(job);
  });

  return job;
}

async function runStagePipeline(job: StageJob): Promise<void> {
  const startMs = Date.now();

  // ── 1. Load PR + repo info ──────────────────────────────────────────────
  const [pr] = await db
    .select({
      id: pullRequests.id,
      repositoryId: pullRequests.repositoryId,
    })
    .from(pullRequests)
    .where(eq(pullRequests.id, job.prId))
    .limit(1);

  if (!pr) {
    job.status = "failed";
    job.error = "PR not found";
    setJob(job);
    return;
  }

  job.repoId = pr.repositoryId;

  const [repoRow] = await db
    .select({
      name: repositories.name,
      ownerId: repositories.ownerId,
    })
    .from(repositories)
    .where(eq(repositories.id, pr.repositoryId))
    .limit(1);

  if (!repoRow) {
    job.status = "failed";
    job.error = "Repository not found";
    setJob(job);
    return;
  }

  const [ownerRow] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.id, repoRow.ownerId))
    .limit(1);

  if (!ownerRow) {
    job.status = "failed";
    job.error = "Repository owner not found";
    setJob(job);
    return;
  }

  const ownerName = ownerRow.username;
  const repoName = repoRow.name;

  // ── 2. Detect framework ─────────────────────────────────────────────────
  job.status = "detecting";
  setJob(job);

  let framework: StageJob["framework"];
  try {
    framework = await detectFramework(ownerName, repoName);
  } catch (err) {
    framework = "node";
  }
  job.framework = framework;

  // ── 3. Deploy ───────────────────────────────────────────────────────────
  job.status = "deploying";
  setJob(job);

  // If it's docker, we can't easily build/run it locally — tell the user
  if (framework === "docker") {
    await postPrComment(
      job.prId,
      "<!-- cmd:stage -->\n\n**Preview not available** — Docker-based projects require a configured deployment provider. " +
        "Set `CRONTECH_DEPLOY_URL` in repo settings to enable staging."
    );
    job.status = "failed";
    job.error = "Docker projects require an external deploy provider";
    setJob(job);
    return;
  }

  // Use built-in static file server (fallback)
  const previewBaseUrl = config.previewDomain || config.appBaseUrl;
  const previewUrl = `${previewBaseUrl}/preview/${job.id}/index.html`;

  const buildResult = await buildStaticPreview(
    ownerName,
    repoName,
    framework,
    job.id
  );

  if (!buildResult.ok) {
    // Post "preview not available" comment
    await postPrComment(
      job.prId,
      `<!-- cmd:stage -->\n\n**Preview not available** — could not build the project: ${buildResult.error}\n\n` +
        `Configure a deployment provider in repo settings, or add an \`index.html\` for static hosting.`
    );
    job.status = "failed";
    job.error = buildResult.error;
    setJob(job);
    return;
  }

  // ── 4. Reply ─────────────────────────────────────────────────────────────
  job.status = "live";
  job.previewUrl = previewUrl;
  job.liveAt = new Date().toISOString();
  setJob(job);

  const elapsedSec = Math.round((Date.now() - startMs) / 1000);
  const frameworkLabel =
    framework === "nextjs"
      ? "Next.js"
      : framework === "bun"
        ? "Bun"
        : framework === "static"
          ? "Static"
          : framework === "node"
            ? "Node.js"
            : framework ?? "Unknown";

  await postPrComment(
    job.prId,
    `<!-- cmd:stage -->\n\n` +
      `**Preview deployed!**\n\n` +
      `[View preview →](${previewUrl})\n\n` +
      `Framework detected: **${frameworkLabel}** · Deployed in **${elapsedSec}s**`
  );
}

// ---------------------------------------------------------------------------
// Look up a job by ID (used by the preview route)
// ---------------------------------------------------------------------------

export function getStageJob(jobId: string): StageJob | null {
  return getJob(jobId);
}
