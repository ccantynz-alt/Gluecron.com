/**
 * PR preview builder (migration 0077).
 *
 * When a PR is opened or updated and the repo has `preview_build_command`
 * configured, this module:
 *   1. Clones the PR's head branch into /tmp/previews/<prId>-<shortSha>
 *   2. Runs the configured build command with a 2-minute timeout
 *   3. Captures stdout + stderr as the build log
 *   4. On success: marks the pr_previews row as 'ready' and posts a PR comment
 *   5. On failure: marks it 'failed' and stores the log
 *
 * Feature flag: preview builds only run when PREVIEW_DOMAIN env var is set
 * AND the repo has preview_build_command configured.
 *
 * Philosophy: never throw — every DB + subprocess call is wrapped in
 * try/catch so a failure cannot disrupt the PR creation path. Callers use
 * `buildPreview(...).catch(() => {})` fire-and-forget style.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  pullRequests,
  prPreviews,
  prComments,
  users,
} from "../db/schema";
import { config } from "./config";

const PREVIEW_BUILD_DIR = process.env.PREVIEW_BUILD_DIR || "/tmp/previews";
const BUILD_TIMEOUT_MS = 2 * 60 * 1_000; // 2 minutes

// ─── helpers ────────────────────────────────────────────────────────────────

/** Slugify a string for use in a URL path segment. */
function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Compute the public URL for a built preview. */
export function previewBuilderUrl(
  ownerName: string,
  repoName: string,
  branchName: string
): string {
  const domain = config.previewDomain || config.appBaseUrl;
  return `${domain}/previews/${ownerName}/${repoName}/${slug(branchName)}/`;
}

/** The on-disk directory where built output lives. */
export function previewBuildPath(
  prId: string,
  headSha: string,
  outputDir: string
): string {
  const shortSha = headSha.slice(0, 8);
  return `${PREVIEW_BUILD_DIR}/${slug(prId)}-${shortSha}/${outputDir}`;
}

// ─── core builder ───────────────────────────────────────────────────────────

/**
 * Build a preview for the given PR. Fire-and-forget by callers:
 *   `buildPreview(prId, repoId, headSha).catch(() => {})`
 */
export async function buildPreview(
  prId: string,
  repoId: string,
  headSha: string
): Promise<void> {
  // Feature flag: only run when PREVIEW_DOMAIN is set
  if (!config.previewDomain) return;

  // ── look up the repo for build config ──
  let repo: {
    id: string;
    name: string;
    ownerId: string;
    previewBuildCommand: string | null;
    previewOutputDir: string | null;
    diskPath: string;
  } | null = null;

  let ownerUsername = "";

  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        previewBuildCommand: repositories.previewBuildCommand,
        previewOutputDir: repositories.previewOutputDir,
        diskPath: repositories.diskPath,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);
    if (!row) return;
    repo = row;

    // Resolve owner username for URL construction
    const [ownerRow] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, repo.ownerId))
      .limit(1);
    ownerUsername = ownerRow?.username ?? "";
  } catch (err) {
    console.warn("[preview-builder] repo lookup failed:", err instanceof Error ? err.message : err);
    return;
  }

  // Opt-in gate: skip if no build command configured
  if (!repo.previewBuildCommand) return;

  // ── look up the PR for branch name ──
  let pr: { id: string; headBranch: string; number: number } | null = null;
  try {
    const [row] = await db
      .select({ id: pullRequests.id, headBranch: pullRequests.headBranch, number: pullRequests.number })
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .limit(1);
    if (!row) return;
    pr = row;
  } catch (err) {
    console.warn("[preview-builder] pr lookup failed:", err instanceof Error ? err.message : err);
    return;
  }

  const buildCommand = repo.previewBuildCommand;
  const outputDir = repo.previewOutputDir || "dist";
  const shortSha = headSha.slice(0, 8);
  const previewUrl = previewBuilderUrl(ownerUsername, repo.name, pr.headBranch);
  const buildDir = `${PREVIEW_BUILD_DIR}/${slug(prId)}-${shortSha}`;

  // ── upsert preview row to 'building' ──
  let previewRowId: number | null = null;
  try {
    const [row] = await db
      .insert(prPreviews)
      .values({
        repoId,
        prId,
        branchName: pr.headBranch,
        headSha,
        status: "building",
        previewUrl,
        buildCommand,
        outputDir,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: prPreviews.id });
    // If there's already a row (same prId+headSha isn't unique, but let's handle it)
    if (row) {
      previewRowId = row.id;
    } else {
      // Find existing
      const [existing] = await db
        .select({ id: prPreviews.id })
        .from(prPreviews)
        .where(and(eq(prPreviews.prId, prId), eq(prPreviews.headSha, headSha)))
        .limit(1);
      previewRowId = existing?.id ?? null;
    }
  } catch (err) {
    console.warn("[preview-builder] insert failed:", err instanceof Error ? err.message : err);
    return;
  }

  // ── clone + build ──
  const buildStart = Date.now();
  let buildLog = "";
  let buildOk = false;

  try {
    // Step 1: clone the bare repo and checkout the head branch
    const cloneProc = Bun.spawn(
      ["git", "clone", "--branch", pr.headBranch, "--depth", "1", repo.diskPath, buildDir],
      { stderr: "pipe", stdout: "pipe" }
    );

    const cloneStdout = await new Response(cloneProc.stdout).text();
    const cloneStderr = await new Response(cloneProc.stderr).text();
    await cloneProc.exited;

    buildLog += `=== clone ===\n${cloneStdout}${cloneStderr}\n`;

    if (cloneProc.exitCode !== 0) {
      throw new Error(`git clone failed (exit ${cloneProc.exitCode}): ${cloneStderr.slice(0, 500)}`);
    }

    // Step 2: run the build command with timeout
    const buildProc = Bun.spawn(
      ["sh", "-c", buildCommand],
      {
        cwd: buildDir,
        stderr: "pipe",
        stdout: "pipe",
        env: { ...process.env, CI: "1" },
      }
    );

    // Apply 2-minute timeout
    const timeoutHandle = setTimeout(() => {
      try { buildProc.kill(); } catch {}
    }, BUILD_TIMEOUT_MS);

    const buildStdout = await new Response(buildProc.stdout).text();
    const buildStderr = await new Response(buildProc.stderr).text();
    await buildProc.exited;
    clearTimeout(timeoutHandle);

    buildLog += `\n=== build: ${buildCommand} ===\n${buildStdout}${buildStderr}\n`;

    if (buildProc.exitCode !== 0) {
      throw new Error(`build command failed (exit ${buildProc.exitCode})`);
    }

    buildOk = true;
  } catch (err) {
    buildLog += `\n=== error ===\n${err instanceof Error ? err.message : String(err)}\n`;
  }

  const durationMs = Date.now() - buildStart;

  // ── update preview row ──
  try {
    if (previewRowId !== null) {
      await db
        .update(prPreviews)
        .set({
          status: buildOk ? "ready" : "failed",
          buildLog: buildLog.slice(0, 50_000),
          previewUrl: buildOk ? previewUrl : null,
          buildDurationMs: durationMs,
          updatedAt: new Date(),
        })
        .where(eq(prPreviews.id, previewRowId));
    }
  } catch (err) {
    console.warn("[preview-builder] update failed:", err instanceof Error ? err.message : err);
  }

  // ── post a PR comment with the result ──
  try {
    // Use the system bot user (first admin user, or fall back to the PR author)
    const [authorRow] = await db
      .select({ authorId: pullRequests.authorId })
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .limit(1);

    if (authorRow) {
      const buildTimeS = Math.round(durationMs / 1000);
      const body = buildOk
        ? `🚀 **Preview deployed**\nURL: ${previewUrl}\nBuilt from: \`${shortSha}\`\nBuild time: ${buildTimeS}s`
        : `❌ **Preview build failed**\nCommit: \`${shortSha}\`\nBuild time: ${buildTimeS}s\n\nSee build log in the [Previews tab](/${ownerUsername}/${repo.name}/previews).`;

      await db.insert(prComments).values({
        pullRequestId: prId,
        authorId: authorRow.authorId,
        body,
        isAiReview: false,
        moderationStatus: "approved",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  } catch (err) {
    console.warn("[preview-builder] comment failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Look up the most recent pr_previews row for a given PR.
 * Returns null if none exists or the table doesn't exist yet.
 */
export async function getPreviewForPr(prId: string): Promise<{
  id: number;
  status: string;
  previewUrl: string | null;
  headSha: string;
  buildDurationMs: number | null;
} | null> {
  if (!prId) return null;
  try {
    const [row] = await db
      .select({
        id: prPreviews.id,
        status: prPreviews.status,
        previewUrl: prPreviews.previewUrl,
        headSha: prPreviews.headSha,
        buildDurationMs: prPreviews.buildDurationMs,
      })
      .from(prPreviews)
      .where(eq(prPreviews.prId, prId))
      .orderBy(prPreviews.id)
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}
