/**
 * AI Copilot Workspace — issue-to-PR autonomous agent.
 *
 * Pipeline:
 *   1. Load issue context (title + body + recent comments).
 *   2. Explore the codebase — ls-tree then ask Claude which files to read.
 *   3. Generate an implementation plan (Claude call) + post as issue comment.
 *   4. Implement: create branch, apply file edits via git plumbing.
 *   5. Open a draft PR linked to the issue.
 *
 * The hot path is fully in-memory (WorkspaceJob map). A workspace_jobs table
 * is written for auditability via `src/db/schema.ts` + migration 0103.
 *
 * Never throws externally. All failures set job.status = "failed".
 */

import { join } from "path";
import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import {
  issues,
  issueComments,
  repositories,
  users,
  pullRequests,
  workspaceJobs,
} from "../db/schema";
import { getAnthropic, isAiAvailable, MODEL_SONNET, extractText, parseJsonResponse } from "./ai-client";
import { applyEditsToNewBranch, type FileEdit } from "./spec-git";
import { getBlob } from "../git/repository";
import { getBotUserIdOrFallback } from "./bot-user";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WorkspaceStatus =
  | "pending"
  | "planning"
  | "implementing"
  | "opening_pr"
  | "done"
  | "failed";

export interface WorkspaceJob {
  id: string;
  repoId: string;
  issueId: string;
  issueNumber: number;
  ownerName: string;
  repoName: string;
  status: WorkspaceStatus;
  planComment?: string;   // the plan posted as issue comment
  branchName?: string;    // e.g. "workspace/issue-42-fix-auth"
  prNumber?: number;
  errorMessage?: string;
  startedAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// In-memory job store (LRU, max 100 jobs)
// ---------------------------------------------------------------------------

const MAX_JOBS = 100;
const jobById = new Map<string, WorkspaceJob>();
// issueId → jobId for O(1) lookup by issue
const jobByIssueId = new Map<string, string>();
// repoId → jobId for "one active job per repo" guard
const activeJobByRepoId = new Map<string, string>();

function evictOldestIfNeeded(): void {
  if (jobById.size < MAX_JOBS) return;
  // Evict oldest (first inserted) entry
  const firstKey = jobById.keys().next().value;
  if (firstKey) {
    const old = jobById.get(firstKey);
    if (old) {
      jobByIssueId.delete(old.issueId);
      if (activeJobByRepoId.get(old.repoId) === firstKey) {
        activeJobByRepoId.delete(old.repoId);
      }
    }
    jobById.delete(firstKey);
  }
}

function storeJob(job: WorkspaceJob): void {
  evictOldestIfNeeded();
  jobById.set(job.id, job);
  jobByIssueId.set(job.issueId, job.id);
  if (job.status !== "done" && job.status !== "failed") {
    activeJobByRepoId.set(job.repoId, job.id);
  }
}

function updateJob(job: WorkspaceJob, patch: Partial<WorkspaceJob>): void {
  Object.assign(job, patch, { updatedAt: new Date() });
  if (job.status === "done" || job.status === "failed") {
    if (activeJobByRepoId.get(job.repoId) === job.id) {
      activeJobByRepoId.delete(job.repoId);
    }
  }
}

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------

export function getWorkspaceJob(jobId: string): WorkspaceJob | undefined {
  return jobById.get(jobId);
}

export function getWorkspaceJobForIssue(issueId: string): WorkspaceJob | undefined {
  const jobId = jobByIssueId.get(issueId);
  return jobId ? jobById.get(jobId) : undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startWorkspace(
  issueId: string,
  issueNumber: number,
  repoId: string,
  ownerName: string,
  repoName: string,
  triggeredByUserId: string
): Promise<WorkspaceJob> {
  // Guard: AI must be available
  if (!isAiAvailable()) {
    const failed: WorkspaceJob = {
      id: crypto.randomUUID(),
      repoId,
      issueId,
      issueNumber,
      ownerName,
      repoName,
      status: "failed",
      errorMessage: "ANTHROPIC_API_KEY is not configured",
      startedAt: new Date(),
      updatedAt: new Date(),
    };
    storeJob(failed);
    return failed;
  }

  // Guard: max 1 active job per repo
  const existingJobId = activeJobByRepoId.get(repoId);
  if (existingJobId) {
    const existing = jobById.get(existingJobId);
    if (existing && existing.status !== "done" && existing.status !== "failed") {
      return existing;
    }
    // Stale entry — clear it
    activeJobByRepoId.delete(repoId);
  }

  const job: WorkspaceJob = {
    id: crypto.randomUUID(),
    repoId,
    issueId,
    issueNumber,
    ownerName,
    repoName,
    status: "pending",
    startedAt: new Date(),
    updatedAt: new Date(),
  };

  storeJob(job);

  // Persist to DB for auditability (best-effort)
  try {
    await db.insert(workspaceJobs).values({
      id: job.id,
      repoId,
      issueId,
      triggeredBy: triggeredByUserId,
      status: "pending",
    });
  } catch {
    /* non-fatal — in-memory store is the source of truth */
  }

  // Fire-and-forget pipeline
  runWorkspacePipeline(job, triggeredByUserId).catch(() => {
    /* errors are captured inside the pipeline */
  });

  return job;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runWorkspacePipeline(
  job: WorkspaceJob,
  triggeredByUserId: string
): Promise<void> {
  try {
    // Step 1 — Load issue context
    const issueCtx = await loadIssueContext(job.issueId);
    if (!issueCtx) {
      throw new Error("Issue not found or DB read failed");
    }

    // Step 2 — Explore codebase
    updateJob(job, { status: "planning" });
    await persistJobStatus(job);

    const reposBase = config.gitReposPath;
    const repoDiskPath = join(reposBase, job.ownerName, `${job.repoName}.git`);

    const fileTree = await getFileTree(repoDiskPath);
    const relevantFiles = await pickRelevantFiles(issueCtx, fileTree);
    const fileContents = await readFileContents(
      job.ownerName,
      job.repoName,
      relevantFiles
    );

    // Step 3 — Generate implementation plan
    const plan = await generatePlan(issueCtx, fileContents);

    // Post plan as issue comment
    const planBody = formatPlanComment(plan);
    const botUserId = await getBotUserIdOrFallback(triggeredByUserId);
    const commentId = await postIssueComment(job.issueId, botUserId, planBody);
    updateJob(job, { planComment: commentId ?? undefined });

    // Step 4 — Implement
    updateJob(job, { status: "implementing" });
    await persistJobStatus(job);

    // Resolve default branch
    const repoRow = await db
      .select({ defaultBranch: repositories.defaultBranch })
      .from(repositories)
      .where(eq(repositories.id, job.repoId))
      .limit(1);
    const baseBranch = repoRow[0]?.defaultBranch ?? "main";

    const branchName = plan.branchName || sanitizeBranchName(
      `workspace/issue-${job.issueNumber}-${slugify(issueCtx.title)}`
    );
    updateJob(job, { branchName });

    const edits = buildEdits(plan);
    if (edits.length === 0) {
      throw new Error("AI plan produced no file changes");
    }

    const commitMsg =
      `feat: implement #${job.issueNumber} — ${plan.summary.slice(0, 60)}\n\n` +
      `Closes #${job.issueNumber}\n\n` +
      `Generated by Gluecron AI Workspace.`;

    const applied = await applyEditsToNewBranch({
      repoDiskPath,
      baseRef: baseBranch,
      edits,
      branchName,
      commitMessage: commitMsg,
      authorName: "Gluecron Workspace",
      authorEmail: "workspace@gluecron.com",
    });

    if (!applied.ok) {
      throw new Error(`git apply failed: ${applied.error}`);
    }

    // Step 5 — Open draft PR
    updateJob(job, { status: "opening_pr" });
    await persistJobStatus(job);

    const prBody =
      `Closes #${job.issueNumber}\n\n` +
      `${plan.summary}\n\n` +
      `**Files changed:**\n` +
      applied.filesChanged.map((f) => `- \`${f}\``).join("\n") +
      `\n\n<!-- gluecron:workspace:pr -->`;

    const prTitle = `feat: ${plan.summary.slice(0, 140)}`;

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: job.repoId,
        authorId: botUserId,
        title: prTitle.slice(0, 200),
        body: prBody,
        baseBranch,
        headBranch: applied.branchName,
        isDraft: true,
      })
      .returning({ number: pullRequests.number });

    if (!pr?.number) {
      throw new Error("PR insert returned no number");
    }

    updateJob(job, { status: "done", prNumber: pr.number });
    await persistJobStatus(job);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    updateJob(job, { status: "failed", errorMessage: msg });
    await persistJobStatus(job);
  }
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

interface IssueContext {
  title: string;
  body: string;
  comments: string[];
}

async function loadIssueContext(issueId: string): Promise<IssueContext | null> {
  try {
    const issueRows = await db
      .select({ title: issues.title, body: issues.body })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);

    if (!issueRows[0]) return null;
    const { title, body } = issueRows[0];

    const commentRows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(desc(issueComments.createdAt))
      .limit(5);

    return {
      title,
      body: body ?? "",
      comments: commentRows.map((r) => r.body),
    };
  } catch {
    return null;
  }
}

async function getFileTree(repoDiskPath: string): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      ["git", "ls-tree", "-r", "--name-only", "HEAD"],
      { cwd: repoDiskPath, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.slice(0, 500);
  } catch {
    return [];
  }
}

async function pickRelevantFiles(
  ctx: IssueContext,
  fileTree: string[]
): Promise<string[]> {
  if (fileTree.length === 0) return [];

  const prompt =
    `Given this issue:\n${ctx.title}\n${ctx.body}\n\n` +
    `And this file tree:\n${fileTree.join("\n")}\n\n` +
    `List the 20 most relevant file paths to read in order to implement the issue. ` +
    `Return JSON: {"files": string[]}`;

  try {
    const client = getAnthropic();
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 512,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractText(msg);
    const parsed = parseJsonResponse<{ files: string[] }>(text);
    if (parsed && Array.isArray(parsed.files)) {
      return parsed.files.slice(0, 20).filter((f: string) => typeof f === "string");
    }
  } catch {
    /* fall through — return empty */
  }
  // Fallback: first 10 files
  return fileTree.slice(0, 10);
}

const MAX_FILE_BYTES = 8 * 1024;       // 8 KB per file
const MAX_TOTAL_BYTES = 80 * 1024;     // 80 KB total

async function readFileContents(
  ownerName: string,
  repoName: string,
  filePaths: string[]
): Promise<Array<{ path: string; content: string }>> {
  const results: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;

  for (const filePath of filePaths) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    try {
      const blob = await getBlob(ownerName, repoName, "HEAD", filePath);
      if (!blob || blob.isBinary) continue;
      const content = blob.content.slice(0, MAX_FILE_BYTES);
      totalBytes += content.length;
      results.push({ path: filePath, content });
    } catch {
      /* skip unreadable files */
    }
  }

  return results;
}

interface FilePlan {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
  patch: string;
}

interface WorkspacePlan {
  summary: string;
  files: FilePlan[];
  branchName: string;
}

async function generatePlan(
  ctx: IssueContext,
  fileContents: Array<{ path: string; content: string }>
): Promise<WorkspacePlan> {
  const fileSection = fileContents
    .map((f) => `=== ${f.path} ===\n${f.content}`)
    .join("\n\n");

  const commentSection = ctx.comments.length > 0
    ? `\n\nComments:\n${ctx.comments.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}`
    : "";

  const userPrompt =
    `Issue: ${ctx.title}\n${ctx.body}${commentSection}\n\n` +
    `Relevant code:\n${fileSection}\n\n` +
    `Return JSON:\n` +
    `{\n` +
    `  "summary": string,\n` +
    `  "files": Array<{\n` +
    `    "path": string,\n` +
    `    "action": "create" | "modify" | "delete",\n` +
    `    "description": string,\n` +
    `    "patch": string\n` +
    `  }>,\n` +
    `  "branchName": string\n` +
    `}`;

  const systemPrompt =
    "You are an expert software engineer. Generate a detailed implementation plan for the given issue. " +
    "For each file, provide the full new content (not a diff) in the 'patch' field. " +
    "Branch name should follow the pattern: workspace/issue-<number>-<short-slug>. " +
    "Return only valid JSON — no prose, no markdown fences.";

  const client = getAnthropic();
  const msg = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: 4096,
    temperature: 0.2,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = extractText(msg);
  const parsed = parseJsonResponse<WorkspacePlan>(text);

  if (!parsed || typeof parsed.summary !== "string") {
    throw new Error("AI returned invalid plan JSON");
  }

  return {
    summary: parsed.summary || "AI-generated implementation",
    files: Array.isArray(parsed.files) ? parsed.files : [],
    branchName: typeof parsed.branchName === "string" && parsed.branchName
      ? sanitizeBranchName(parsed.branchName)
      : "",
  };
}

function buildEdits(plan: WorkspacePlan): FileEdit[] {
  const edits: FileEdit[] = [];
  for (const f of plan.files) {
    if (!f.path || typeof f.path !== "string") continue;
    // Reject traversal attempts
    if (f.path.startsWith("/") || f.path.includes("..")) continue;

    if (f.action === "delete") {
      edits.push({ action: "delete", path: f.path });
    } else {
      // create or modify — we always write the full content
      const content = typeof f.patch === "string" ? f.patch : "";
      edits.push({ action: f.action === "create" ? "create" : "edit", path: f.path, content });
    }
  }
  return edits;
}

function formatPlanComment(plan: WorkspacePlan): string {
  const fileLines = plan.files
    .map((f) => `- **${f.action}** \`${f.path}\` — ${f.description}`)
    .join("\n");

  return (
    `<!-- gluecron:workspace:plan -->\n` +
    `## AI Workspace Plan\n\n` +
    `${plan.summary}\n\n` +
    `**Files to change:**\n` +
    (fileLines || "_No files identified_") +
    `\n\n` +
    `_Implementing now... a draft PR will be opened when complete._`
  );
}

async function postIssueComment(
  issueId: string,
  authorId: string,
  body: string
): Promise<string | null> {
  try {
    const [row] = await db
      .insert(issueComments)
      .values({ issueId, authorId, body })
      .returning({ id: issueComments.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function persistJobStatus(job: WorkspaceJob): Promise<void> {
  try {
    await db
      .update(workspaceJobs)
      .set({
        status: job.status,
        planComment: job.planComment ?? null,
        branchName: job.branchName ?? null,
        prNumber: job.prNumber ?? null,
        errorMessage: job.errorMessage ?? null,
        updatedAt: job.updatedAt,
      })
      .where(eq(workspaceJobs.id, job.id));
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "change";
}

function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9/_-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}
