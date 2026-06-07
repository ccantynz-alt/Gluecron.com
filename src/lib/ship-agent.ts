/**
 * Ship Agent — autonomous AI feature implementation pipeline.
 *
 * Given a GitHub issue, the agent:
 *   1. Plans the implementation by reading the file tree and key files.
 *   2. Reads all files the plan references.
 *   3. Creates a branch and rewrites each file via Claude.
 *   4. Commits the changes.
 *   5. Opens a PR and posts a comment on the original issue.
 *
 * Jobs run fire-and-forget (async, no await at call-site).
 * Progress is stored in-memory in `shipJobs` and polled by the UI.
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { writeFile, mkdir } from "fs/promises";
import { config } from "./config";
import { getAnthropic, extractText, parseJsonResponse, MODEL_SONNET } from "./ai-client";
import { getRepoPath, getDefaultBranch, resolveRef } from "../git/repository";
import { db } from "../db";
import { pullRequests, issues, issueComments, users } from "../db/schema";
import { and, eq, desc } from "drizzle-orm";

// ─── Types ─────────────────────────────────────────────────────────────────

export type ShipStatus =
  | "planning"
  | "reading"
  | "coding"
  | "committing"
  | "opening-pr"
  | "done"
  | "failed";

export interface ShipJob {
  id: string;
  issueId: string;
  repoId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  requestedByUserId: string;
  status: ShipStatus;
  plan?: string;
  branchName?: string;
  prNumber?: number;
  prUrl?: string;
  log: string[];
  error?: string;
  createdAt: Date;
  completedAt?: Date;
}

interface PlanResponse {
  plan: string;
  files_to_modify: Array<{ path: string; change_description: string }>;
  new_files: Array<{ path: string; purpose: string }>;
  branch_name: string;
}

// ─── In-memory store ────────────────────────────────────────────────────────

export const shipJobs = new Map<string, ShipJob>();

// ─── Rate-limiting state ────────────────────────────────────────────────────

// Track jobs started per user per day (UTC).
const userDayJobCount = new Map<string, { date: string; count: number }>();
// Track active jobs per repo.
const repoActiveJobs = new Map<string, string>(); // repoId -> jobId

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkRateLimits(userId: string, repoId: string): string | null {
  const today = todayUtc();
  const userKey = `${userId}:${today}`;
  const entry = userDayJobCount.get(userId);
  if (entry && entry.date === today && entry.count >= 3) {
    return "Rate limit: max 3 ship jobs per user per day.";
  }
  const activeJobId = repoActiveJobs.get(repoId);
  if (activeJobId && shipJobs.get(activeJobId)?.status !== "done" && shipJobs.get(activeJobId)?.status !== "failed") {
    return "Rate limit: only 1 concurrent ship job per repo.";
  }
  return null;
}

function incrementUserCount(userId: string) {
  const today = todayUtc();
  const entry = userDayJobCount.get(userId);
  if (!entry || entry.date !== today) {
    userDayJobCount.set(userId, { date: today, count: 1 });
  } else {
    entry.count++;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function addLog(job: ShipJob, msg: string) {
  job.log.push(`[${new Date().toISOString()}] ${msg}`);
}

async function execGit(
  args: string[],
  cwd: string,
  env?: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, ...env },
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

/**
 * Get a flat list of all files (blob paths) in the repo, up to maxCount.
 */
async function listAllFiles(
  repoPath: string,
  ref: string,
  maxCount = 200
): Promise<string[]> {
  const { stdout, exitCode } = await execGit(
    ["git", "ls-tree", "-r", "--name-only", ref],
    repoPath
  );
  if (exitCode !== 0) return [];
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, maxCount);
}

/**
 * Read a file's content from the bare git repo.
 */
async function readFileFromRepo(repoPath: string, ref: string, filePath: string): Promise<string> {
  const { stdout, exitCode } = await execGit(
    ["git", "show", `${ref}:${filePath}`],
    repoPath
  );
  if (exitCode !== 0) return "";
  return stdout;
}

/**
 * Get a bot user for authoring the PR.
 * Falls back to the requesting user if no bot user exists.
 */
async function getBotUserId(fallbackUserId: string): Promise<string> {
  try {
    const [bot] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, "gluecron-bot"))
      .limit(1);
    if (bot) return bot.id;
  } catch {
    // fall through
  }
  return fallbackUserId;
}

/**
 * Post a comment on the issue from the requesting user.
 */
async function postIssueComment(
  issueId: string,
  authorId: string,
  body: string
): Promise<void> {
  try {
    await db.insert(issueComments).values({
      issueId,
      authorId,
      body,
      moderationStatus: "approved",
    });
  } catch (err) {
    console.warn("[ship-agent] failed to post issue comment:", err);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function startShipJob(params: {
  issueId: string;
  repoId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  requestedByUserId: string;
}): Promise<string> {
  const rateLimitErr = checkRateLimits(params.requestedByUserId, params.repoId);
  if (rateLimitErr) throw new Error(rateLimitErr);

  const jobId = randomUUID();
  const job: ShipJob = {
    id: jobId,
    ...params,
    status: "planning",
    log: [],
    createdAt: new Date(),
  };

  shipJobs.set(jobId, job);
  incrementUserCount(params.requestedByUserId);
  repoActiveJobs.set(params.repoId, jobId);

  // Fire-and-forget
  runShipJob(job).catch((err) => {
    console.error("[ship-agent] unhandled error in runShipJob:", err);
  });

  return jobId;
}

export function getShipJob(jobId: string): ShipJob | undefined {
  return shipJobs.get(jobId);
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

async function runShipJob(job: ShipJob): Promise<void> {
  try {
    await phasePlan(job);
    await phaseRead(job);
    await phaseCode(job);
    await phaseCommit(job);
    await phaseOpenPr(job);
    job.status = "done";
    job.completedAt = new Date();
    addLog(job, "Ship agent completed successfully.");
    await postIssueComment(
      job.issueId,
      job.requestedByUserId,
      `Ship Agent completed! Changes are ready for review in PR #${job.prNumber}. If the GateTest passes, this is ready to merge.`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.status = "failed";
    job.error = msg;
    job.completedAt = new Date();
    addLog(job, `FAILED: ${msg}`);
    await postIssueComment(
      job.issueId,
      job.requestedByUserId,
      `Ship Agent failed during the **${job.status}** phase.\n\nError: \`${msg}\`\n\nPlease review the issue and try again or implement manually.`
    ).catch(() => {});
  }
}

// ─── Phase 1: Planning ───────────────────────────────────────────────────────

async function phasePlan(job: ShipJob): Promise<void> {
  job.status = "planning";
  addLog(job, "Starting planning phase...");

  const repoDiskPath = getRepoPath(job.owner, job.repo);
  const defaultBranch = (await getDefaultBranch(job.owner, job.repo)) ?? "main";
  const ref = await resolveRef(job.owner, job.repo, defaultBranch);
  if (!ref) throw new Error(`Cannot resolve ref for branch '${defaultBranch}'. Does the repo have commits?`);

  // File tree (up to 200 files)
  const allFiles = await listAllFiles(repoDiskPath, ref, 200);
  const treeStr = allFiles.join("\n");
  addLog(job, `Read file tree: ${allFiles.length} files.`);

  // Read a few key files for context
  const keyFiles = ["README.md", "package.json", "bun.lockb", "src/app.tsx", "CLAUDE.md"];
  const keyFileContents: string[] = [];
  for (const f of keyFiles) {
    if (allFiles.includes(f)) {
      const content = await readFileFromRepo(repoDiskPath, ref, f);
      if (content && !content.includes("\0")) {
        keyFileContents.push(`--- ${f} ---\n${content.slice(0, 2000)}`);
      }
    }
  }

  const client = getAnthropic();

  const userPrompt = `Issue: ${job.issueTitle}\n\n${job.issueBody}\n\nFile tree:\n${treeStr}\n\nKey files:\n${keyFileContents.join("\n\n").slice(0, 6000)}\n\nReturn JSON with this exact shape:\n{"plan": "string describing what will be done", "files_to_modify": [{"path": "src/...", "change_description": "..."}], "new_files": [{"path": "src/...", "purpose": "..."}], "branch_name": "feat/short-slug"}`;

  let planRaw: PlanResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 4000,
      system:
        "You are an expert developer. Given a GitHub issue and codebase, create a precise implementation plan. Return ONLY valid JSON, no explanations.",
      messages: [{ role: "user", content: attempt === 0 ? userPrompt : `Return ONLY valid JSON, no explanation:\n${userPrompt}` }],
    });
    const text = extractText(msg);
    planRaw = parseJsonResponse<PlanResponse>(text);
    if (planRaw) break;
  }

  if (!planRaw) {
    throw new Error("AI returned invalid JSON for the implementation plan. Aborting.");
  }

  job.plan = planRaw.plan;
  job.branchName = sanitizeBranchName(planRaw.branch_name || `ship-agent/issue-${job.issueNumber}`);
  // Store the plan details for later phases
  (job as any)._planDetails = planRaw;
  (job as any)._defaultBranch = defaultBranch;
  (job as any)._ref = ref;

  addLog(job, `Plan: ${job.plan}`);
  addLog(job, `Branch: ${job.branchName}`);
  addLog(
    job,
    `Files to modify: ${planRaw.files_to_modify.length}, new files: ${planRaw.new_files.length}`
  );
}

// ─── Phase 2: Reading ────────────────────────────────────────────────────────

async function phaseRead(job: ShipJob): Promise<void> {
  job.status = "reading";
  addLog(job, "Reading relevant files...");

  const plan: PlanResponse = (job as any)._planDetails;
  const ref: string = (job as any)._ref;
  const repoDiskPath = getRepoPath(job.owner, job.repo);

  const fileContents = new Map<string, string>();

  for (const fm of plan.files_to_modify) {
    const content = await readFileFromRepo(repoDiskPath, ref, fm.path);
    fileContents.set(fm.path, content);
  }

  (job as any)._fileContents = fileContents;

  addLog(job, `Read ${fileContents.size} files.`);
}

// ─── Phase 3: Coding ─────────────────────────────────────────────────────────

async function phaseCode(job: ShipJob): Promise<void> {
  job.status = "coding";
  addLog(job, "Creating branch and writing code...");

  const plan: PlanResponse = (job as any)._planDetails;
  const defaultBranch: string = (job as any)._defaultBranch;
  const fileContents: Map<string, string> = (job as any)._fileContents;
  const repoDiskPath = getRepoPath(job.owner, job.repo);

  // We work in a temporary clone of the bare repo so we can read/write files
  // without polluting the bare repo. Use a worktree instead.
  const worktreeBase = join(config.gitReposPath, ".ship-agent-worktrees");
  const worktreePath = join(worktreeBase, job.id);

  await mkdir(worktreeBase, { recursive: true });

  // Create a worktree at the default branch
  const addResult = await execGit(
    ["git", "worktree", "add", "--no-checkout", worktreePath, defaultBranch],
    repoDiskPath
  );
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${addResult.stderr}`);
  }

  // Configure identity for commits inside worktree
  await execGit(["git", "config", "user.email", "ship-agent@gluecron.com"], worktreePath);
  await execGit(["git", "config", "user.name", "Gluecron Ship Agent"], worktreePath);

  // Checkout the default branch
  await execGit(["git", "checkout", defaultBranch], worktreePath);

  // Create the feature branch
  const branchResult = await execGit(
    ["git", "checkout", "-b", job.branchName!],
    worktreePath
  );
  if (branchResult.exitCode !== 0) {
    throw new Error(`Failed to create branch '${job.branchName}': ${branchResult.stderr}`);
  }
  addLog(job, `Created branch: ${job.branchName}`);

  const client = getAnthropic();

  // Modify existing files
  for (const fm of plan.files_to_modify) {
    const currentContent = fileContents.get(fm.path) ?? "";

    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8000,
      system:
        "You are implementing a feature. Return the COMPLETE updated file content. No explanations, no markdown code blocks — just the raw file content.",
      messages: [
        {
          role: "user",
          content: `File: ${fm.path}\nCurrent content:\n${currentContent}\n\nChange needed: ${fm.change_description}\nFull issue context: ${job.issueTitle}\n${job.issueBody}\nImplementation plan: ${job.plan}`,
        },
      ],
    });

    let newContent = extractText(msg);
    // Strip potential markdown code fences if Claude added them
    newContent = stripCodeFences(newContent);

    const targetPath = join(worktreePath, fm.path);
    await mkdir(join(targetPath, ".."), { recursive: true }).catch(() => {});
    await writeFile(targetPath, newContent, "utf8");
    await execGit(["git", "add", fm.path], worktreePath);
    addLog(job, `Modified: ${fm.path}`);
  }

  // Create new files
  for (const nf of plan.new_files) {
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8000,
      system:
        "You are implementing a feature. Return the COMPLETE file content for the new file. No explanations, no markdown code blocks — just the raw file content.",
      messages: [
        {
          role: "user",
          content: `New file: ${nf.path}\nPurpose: ${nf.purpose}\nFull issue context: ${job.issueTitle}\n${job.issueBody}\nImplementation plan: ${job.plan}`,
        },
      ],
    });

    let newContent = extractText(msg);
    newContent = stripCodeFences(newContent);

    const targetPath = join(worktreePath, nf.path);
    await mkdir(join(targetPath, ".."), { recursive: true }).catch(() => {});
    await writeFile(targetPath, newContent, "utf8");
    await execGit(["git", "add", nf.path], worktreePath);
    addLog(job, `Created: ${nf.path}`);
  }

  (job as any)._worktreePath = worktreePath;
}

// ─── Phase 4: Committing ─────────────────────────────────────────────────────

async function phaseCommit(job: ShipJob): Promise<void> {
  job.status = "committing";
  addLog(job, "Committing changes...");

  const worktreePath: string = (job as any)._worktreePath;
  const repoDiskPath = getRepoPath(job.owner, job.repo);

  const commitMsg = `feat: ${job.issueTitle}\n\nCloses #${job.issueNumber}\n\nAI-implemented via Gluecron Ship Agent`;

  const commitResult = await execGit(
    ["git", "commit", "-m", commitMsg],
    worktreePath
  );
  if (commitResult.exitCode !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr}`);
  }
  addLog(job, "Committed changes.");

  // Push the branch to origin (the bare repo itself)
  const pushResult = await execGit(
    ["git", "push", repoDiskPath, job.branchName!],
    worktreePath
  );
  if (pushResult.exitCode !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr}`);
  }
  addLog(job, `Pushed branch '${job.branchName}' to origin.`);

  // Clean up worktree
  await execGit(
    ["git", "worktree", "remove", "--force", worktreePath],
    repoDiskPath
  ).catch(() => {});
}

// ─── Phase 5: Opening PR ─────────────────────────────────────────────────────

async function phaseOpenPr(job: ShipJob): Promise<void> {
  job.status = "opening-pr";
  addLog(job, "Opening pull request...");

  const plan: PlanResponse = (job as any)._planDetails;
  const defaultBranch: string = (job as any)._defaultBranch;
  const authorId = await getBotUserId(job.requestedByUserId);

  const fileList = [
    ...plan.files_to_modify.map((f) => `- Modified: \`${f.path}\``),
    ...plan.new_files.map((f) => `- Created: \`${f.path}\``),
  ].join("\n");

  const prBody = `Closes #${job.issueNumber}\n\n## What was done\n\n${job.plan}\n\n## Changes\n\n${fileList}\n\n*AI-implemented via Gluecron Ship Agent*`;

  const [pr] = await db
    .insert(pullRequests)
    .values({
      repositoryId: job.repoId,
      authorId,
      title: `feat: ${job.issueTitle}`,
      body: prBody,
      baseBranch: defaultBranch,
      headBranch: job.branchName!,
      state: "open",
    })
    .returning();

  job.prNumber = pr.number;
  job.prUrl = `/${job.owner}/${job.repo}/pulls/${pr.number}`;

  addLog(job, `PR #${pr.number} opened.`);

  // Post comment on the issue linking to the PR
  await postIssueComment(
    job.issueId,
    job.requestedByUserId,
    `**Ship Agent started work!** PR opened: #${pr.number} — [View PR](/${job.owner}/${job.repo}/pulls/${pr.number})`
  );
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._\-/]/g, "-")
    .replace(/^[-./]+|[-./]+$/g, "")
    .replace(/\/+/g, "/")
    .slice(0, 80) || `ship-agent/issue`;
}

function stripCodeFences(text: string): string {
  // Remove ```lang ... ``` wrapper if present
  const match = text.match(/^```(?:\w+)?\n([\s\S]*)\n```$/);
  if (match) return match[1];
  // Also handle without trailing newline
  const match2 = text.match(/^```(?:\w+)?\n([\s\S]*)```$/);
  if (match2) return match2[1];
  return text;
}
