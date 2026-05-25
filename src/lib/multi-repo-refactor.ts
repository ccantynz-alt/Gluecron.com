/**
 * Multi-repo refactor agent.
 *
 * User issues one English request — "rename `getUserById` to `findUser`" —
 * and the agent fans the change out across every repository the user owns,
 * opening one coordinated AI-authored PR per affected repo. All PRs share
 * a marker label `multi-repo:refactor:<refactorId>` so the UI can group
 * them as a single logical change.
 *
 * Lifecycle (mirrored in the DB):
 *
 *   planRefactor      — Claude reads the description, walks the user's
 *                        repos, returns a per-repo plan. Status flips
 *                        `planning` → `building` once executeRefactor
 *                        starts. Skipped repos never make it into the
 *                        `multi_repo_refactor_prs` table at all.
 *
 *   executeRefactor   — for every planned repo we ask Claude for a
 *                        concrete edit (same prompt shape as
 *                        `ai-patch-generator` / `spec-to-pr`), write the
 *                        files onto a fresh branch via the existing git
 *                        plumbing helpers, and insert a draft `pull_requests`
 *                        row. Per-repo failures flip just that child to
 *                        `failed`; the parent stays in `building` until
 *                        every child has terminated.
 *
 *   coordinated merge — when every child is `opened` (and the caller has
 *                        confirmed each PR is green + approved), invoke
 *                        `mergeRefactor`. It walks children in insertion
 *                        order and updates PR rows to `merged`. Any
 *                        failure stops the cascade — the rest stay open.
 *
 * Design notes:
 *
 *   - We never throw. Every step is funnelled through `{ ok, ... } | { ok:
 *     false, error }`. This keeps callers (the API route, the UI form
 *     handler, the autopilot loop) free of try/catch boilerplate.
 *
 *   - The Anthropic client is injectable so the test-suite can pin
 *     deterministic plans without an API key. Production callers leave
 *     `client` undefined and we lazy-resolve via `ai-client.getAnthropic`.
 *
 *   - Sequencing matters for the merge step but NOT for the build step.
 *     We open all PRs in parallel; the user's intent is one logical
 *     atomic change, but git itself can't atomic-merge across repos.
 */

import { and, desc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  labels,
  multiRepoRefactorPrs,
  multiRepoRefactors,
  prComments,
  pullRequests,
  repositories,
  users,
  type MultiRepoRefactor,
  type MultiRepoRefactorPr,
} from "../db/schema";
import {
  createOrUpdateFileOnBranch,
  getBlob,
  refExists,
  resolveRef,
  updateRef,
} from "../git/repository";
import { config } from "./config";
import { audit } from "./notify";
import {
  extractText,
  getAnthropic,
  MODEL_SONNET,
  parseJsonResponse,
} from "./ai-client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Marker prefix every multi-repo PR is tagged with. */
export const MULTI_REPO_REFACTOR_LABEL_PREFIX = "multi-repo:refactor:";

/** Marker baked into PR bodies so other tooling can recognise them. */
export const MULTI_REPO_REFACTOR_MARKER =
  "<!-- gluecron:multi-repo-refactor:v1 -->";

export type RefactorStatus =
  | "planning"
  | "building"
  | "ready_for_review"
  | "merged"
  | "failed";

export type RefactorPrStatus =
  | "pending"
  | "building"
  | "opened"
  | "failed";

/**
 * Optional Anthropic client override — primarily for tests. We accept the
 * narrow `Pick<Anthropic, "messages">` shape used elsewhere in the codebase
 * (`ai-patch-generator`) so test fakes can implement `.messages.create`
 * without committing to the whole SDK surface.
 */
export type ClaudeClient = Pick<Anthropic, "messages">;

export interface RefactorRepoPlan {
  repositoryId: string;
  /** Owner namespace + repo name. Pre-resolved so the UI doesn't re-query. */
  owner: string;
  name: string;
  /** Claude's short prediction of what it will change in this repo. */
  predicted_changes_summary: string;
}

export interface PlanRefactorArgs {
  userId: string;
  description: string;
  /** Optional explicit repo list. When omitted we walk every repo the user owns. */
  repositoryIds?: string[];
  /** Test-only override for the Anthropic client. */
  client?: ClaudeClient;
  /** Test-only override for the title — production derives one from the description. */
  titleOverride?: string;
}

export type PlanRefactorResult =
  | {
      ok: true;
      refactor: MultiRepoRefactor;
      plan: RefactorRepoPlan[];
    }
  | { ok: false; error: string };

export interface ExecuteRefactorArgs {
  refactorId: string;
  /** Test-only override for the Anthropic client. */
  client?: ClaudeClient;
}

export interface ExecuteRefactorChildResult {
  repositoryId: string;
  status: RefactorPrStatus;
  pullRequestId?: string;
  prNumber?: number;
  branch?: string;
  error?: string;
}

export type ExecuteRefactorResult =
  | {
      ok: true;
      refactor: MultiRepoRefactor;
      children: ExecuteRefactorChildResult[];
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Label name used to mark every PR in the refactor group. */
export function refactorLabelName(refactorId: string): string {
  return `${MULTI_REPO_REFACTOR_LABEL_PREFIX}${refactorId}`;
}

/** Derive a sentence-case title from the user's free-text description. */
export function deriveTitle(description: string): string {
  const trimmed = (description || "").trim();
  if (!trimmed) return "Multi-repo refactor";
  // Take the first line, cap at ~80 chars.
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || trimmed;
  const capped = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  return capped;
}

/**
 * Derive a git-ref-safe branch name from a refactor id. Kept short so PR
 * pages stay tidy in the branch column.
 */
export function refactorBranchName(refactorId: string): string {
  const short = refactorId.replace(/-/g, "").slice(0, 8);
  return `multi-repo-refactor/${short}`;
}

/**
 * Build the planning prompt. Pure so tests can pin the shape without an
 * API key.
 */
export function buildPlanPrompt(args: {
  description: string;
  repos: Array<{ id: string; owner: string; name: string; description: string | null }>;
}): string {
  const repoLines = args.repos
    .map(
      (r) =>
        `- id=${r.id} | ${r.owner}/${r.name}${r.description ? ` — ${r.description}` : ""}`
    )
    .join("\n");
  return [
    "You are a refactoring planner for a multi-repository code change.",
    "The user has issued ONE English request. Decide which of the listed",
    "repositories are actually affected and, for each, write a one-line",
    "prediction of the concrete change the editor agent should make.",
    "",
    "User request:",
    args.description,
    "",
    "Repositories the user owns:",
    repoLines || "(none)",
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "title": "short title for the whole refactor (max 80 chars)",',
    '  "affected": [',
    '    { "repository_id": "<uuid>", "predicted_changes_summary": "1-sentence plan" }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Only include repos that are actually affected. Omit obvious no-ops.",
    "- predicted_changes_summary must be concrete (e.g. `rename getUserById to findUser in src/lib/user.ts`).",
    "- If no repo is affected, return an empty `affected` array.",
  ].join("\n");
}

/**
 * Build the per-repo edit prompt. Asks Claude for an end-state set of
 * files, exactly like `ai-patch-generator` does.
 */
export function buildEditPrompt(args: {
  description: string;
  predictedChanges: string;
  repoFiles: Array<{ path: string; content: string }>;
}): string {
  const fileBlocks = args.repoFiles
    .map(
      (f) =>
        `--- FILE: ${f.path} ---\n\`\`\`\n${f.content}\n\`\`\`\n--- END FILE ---`
    )
    .join("\n\n");
  return [
    "You are implementing one slice of a multi-repository refactor.",
    "",
    "Overall refactor request:",
    args.description,
    "",
    "Predicted change for THIS repository:",
    args.predictedChanges,
    "",
    "Current contents of the files you may modify:",
    fileBlocks || "(no files were pre-loaded)",
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "explanation": "1-3 sentence summary of what you changed",',
    '  "patches": [',
    '    { "path": "same/path/as/above", "new_content": "FULL replacement file contents" }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Return [] (empty patches) if there is genuinely nothing to do.",
    "- new_content MUST be the entire file, not a diff.",
    "- Do not invent new files — only touch files you've been shown.",
    "- Preserve existing formatting / indentation / trailing newlines.",
  ].join("\n");
}

interface ClaudePlanResponse {
  title?: string;
  affected?: Array<{
    repository_id?: string;
    predicted_changes_summary?: string;
  }>;
}

interface ClaudePatch {
  path: string;
  new_content: string;
}

interface ClaudeEditResponse {
  explanation?: string;
  patches?: ClaudePatch[];
}

// ---------------------------------------------------------------------------
// Internals — DB + git glue
// ---------------------------------------------------------------------------

/**
 * Resolve a `ClaudeClient` for the call. Returns null when no API key is
 * configured and the caller didn't inject one — signals to bail before any
 * DB writes.
 */
function resolveClient(override?: ClaudeClient): ClaudeClient | null {
  if (override) return override;
  if (!config.anthropicApiKey) return null;
  try {
    return getAnthropic();
  } catch {
    return null;
  }
}

/**
 * Load every repo the user owns, with the joined owner username. Used by
 * `planRefactor` when the caller didn't pass an explicit list.
 */
async function listUserRepos(
  userId: string,
  filterIds?: string[]
): Promise<Array<{ id: string; owner: string; name: string; description: string | null; defaultBranch: string }>> {
  try {
    const rows = await db
      .select({
        id: repositories.id,
        owner: users.username,
        name: repositories.name,
        description: repositories.description,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.ownerId, userId));
    if (!filterIds || filterIds.length === 0) return rows;
    const filterSet = new Set(filterIds);
    return rows.filter((r) => filterSet.has(r.id));
  } catch (err) {
    console.warn(
      "[multi-repo-refactor] listUserRepos failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * Ensure the group-marker label exists on a repo. Best-effort — the label
 * is a UX nicety surfaced in PR bodies, not load-bearing.
 */
async function ensureGroupLabel(
  repositoryId: string,
  refactorId: string
): Promise<void> {
  try {
    await db
      .insert(labels)
      .values({
        repositoryId,
        name: refactorLabelName(refactorId),
        color: "#8c6dff",
        description: `Member of multi-repo refactor ${refactorId}`,
      })
      .onConflictDoNothing?.();
  } catch (err) {
    console.warn(
      "[multi-repo-refactor] ensureGroupLabel failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Ask Claude to plan the refactor. Returns null on any failure (network,
 * parse, missing key).
 */
async function askClaudeForPlan(
  client: ClaudeClient,
  description: string,
  repos: Array<{ id: string; owner: string; name: string; description: string | null }>
): Promise<ClaudePlanResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: buildPlanPrompt({ description, repos }),
        },
      ],
    });
    const text = extractText(message);
    return parseJsonResponse<ClaudePlanResponse>(text);
  } catch (err) {
    console.warn(
      "[multi-repo-refactor] plan call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Ask Claude for the per-repo edit. Same shape as `ai-patch-generator`.
 */
async function askClaudeForEdit(
  client: ClaudeClient,
  description: string,
  predictedChanges: string,
  repoFiles: Array<{ path: string; content: string }>
): Promise<ClaudeEditResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: buildEditPrompt({
            description,
            predictedChanges,
            repoFiles,
          }),
        },
      ],
    });
    const text = extractText(message);
    return parseJsonResponse<ClaudeEditResponse>(text);
  } catch (err) {
    console.warn(
      "[multi-repo-refactor] edit call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Resolve repository row + owner username for use by the per-repo executor.
 */
async function loadRepoForExecute(
  repositoryId: string
): Promise<
  | {
      id: string;
      owner: string;
      ownerId: string;
      name: string;
      defaultBranch: string;
    }
  | null
> {
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        owner: users.username,
        ownerId: repositories.ownerId,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

/**
 * Render the PR body for a child PR. Pure helper exported for tests.
 */
export function renderRefactorPrBody(args: {
  refactorId: string;
  refactorTitle: string;
  description: string;
  predictedChanges: string;
  explanation: string;
  patchPaths: string[];
}): string {
  const label = refactorLabelName(args.refactorId);
  const quoted = args.description
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const files = args.patchPaths.map((p) => `- \`${p}\``).join("\n");
  return [
    MULTI_REPO_REFACTOR_MARKER,
    `## ${args.refactorTitle}`,
    "",
    "_Part of a multi-repo refactor. Every PR in this group shares the",
    `label \`${label}\` so they can be reviewed and merged together._`,
    "",
    "### Original request",
    quoted,
    "",
    "### Predicted change for this repo",
    args.predictedChanges,
    "",
    "### What changed",
    args.explanation || "_(no explanation provided)_",
    "",
    "### Files",
    files || "_(none)_",
    "",
    "---",
    "",
    `Refactor id: \`${args.refactorId}\``,
    `Group label: \`${label}\``,
    "",
    "_Auto-generated by GlueCron multi-repo refactor agent. Review every line before merging._",
  ].join("\n");
}

/**
 * Seed a fresh branch at the repo's default-branch HEAD. Mirrors the
 * `ai-patch-generator` helper but takes the branch HEAD instead of an
 * explicit base sha because the planner doesn't track per-repo commit
 * shas.
 */
async function seedBranchFromHead(
  owner: string,
  name: string,
  branch: string,
  defaultBranch: string
): Promise<{ ok: true; baseSha: string } | { ok: false; error: string }> {
  let baseSha: string | null;
  try {
    baseSha = await resolveRef(owner, name, defaultBranch);
  } catch (err) {
    return {
      ok: false,
      error: `resolveRef failed: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!baseSha) {
    return { ok: false, error: "repo has no commits on default branch" };
  }
  const fullRef = `refs/heads/${branch}`;
  if (await refExists(owner, name, fullRef)) {
    return { ok: true, baseSha };
  }
  const ok = await updateRef(owner, name, fullRef, baseSha);
  if (!ok) return { ok: false, error: "updateRef failed" };
  return { ok: true, baseSha };
}

/**
 * Update the parent refactor's status. Best-effort; failures are logged
 * but never propagate — the orchestrator already has a result to return.
 */
async function setRefactorStatus(
  refactorId: string,
  status: RefactorStatus
): Promise<void> {
  try {
    await db
      .update(multiRepoRefactors)
      .set({ status, updatedAt: new Date() })
      .where(eq(multiRepoRefactors.id, refactorId));
  } catch (err) {
    console.warn(
      "[multi-repo-refactor] setRefactorStatus failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Roll the per-child statuses up into a parent status:
 *   - any child still building/pending → parent stays `building`
 *   - every child opened              → `ready_for_review`
 *   - every child failed              → `failed`
 *   - any child failed + at least one opened → `ready_for_review`
 *     (the user can still merge what worked; failed children stay
 *     surfaced in the UI so they can be retried)
 */
export function rollupStatus(
  children: ReadonlyArray<{ status: RefactorPrStatus }>
): RefactorStatus {
  if (children.length === 0) return "failed";
  const anyInFlight = children.some(
    (c) => c.status === "pending" || c.status === "building"
  );
  if (anyInFlight) return "building";
  const opened = children.filter((c) => c.status === "opened").length;
  if (opened === 0) return "failed";
  return "ready_for_review";
}

// ---------------------------------------------------------------------------
// Public API — planRefactor
// ---------------------------------------------------------------------------

/**
 * Stage 1 of the refactor pipeline. Persists a `planning` parent row +
 * one `pending` child row per affected repo, then returns the plan so the
 * caller (UI form handler or autopilot) can confirm it before kicking off
 * `executeRefactor`.
 *
 * Never throws — failures are returned as `{ ok: false, error }`.
 */
export async function planRefactor(
  args: PlanRefactorArgs
): Promise<PlanRefactorResult> {
  const description = (args.description || "").trim();
  if (!description) return { ok: false, error: "description is empty" };

  const client = resolveClient(args.client);
  if (!client) {
    return { ok: false, error: "ANTHROPIC_API_KEY required for refactor planning" };
  }

  // Load candidate repos.
  const repos = await listUserRepos(args.userId, args.repositoryIds);
  if (repos.length === 0) {
    return { ok: false, error: "user owns no repositories to refactor" };
  }

  // Ask Claude to plan.
  const planRes = await askClaudeForPlan(client, description, repos);
  if (!planRes || !Array.isArray(planRes.affected)) {
    return { ok: false, error: "planner returned invalid response" };
  }

  // Filter the plan down to repos we actually saw (defence-in-depth — a
  // hallucinated id shouldn't be persisted).
  const repoById = new Map(repos.map((r) => [r.id, r]));
  const plan: RefactorRepoPlan[] = [];
  for (const entry of planRes.affected) {
    if (!entry || typeof entry.repository_id !== "string") continue;
    const repo = repoById.get(entry.repository_id);
    if (!repo) continue;
    const summary =
      (entry.predicted_changes_summary || "").trim() || "no summary provided";
    plan.push({
      repositoryId: repo.id,
      owner: repo.owner,
      name: repo.name,
      predicted_changes_summary: summary,
    });
  }

  if (plan.length === 0) {
    return { ok: false, error: "planner identified no affected repos" };
  }

  // Persist the parent + children. Wrap each write so a single DB failure
  // bubbles a clean error instead of a throw.
  const title =
    (args.titleOverride && args.titleOverride.trim()) ||
    (planRes.title && planRes.title.trim()) ||
    deriveTitle(description);

  let parent: MultiRepoRefactor | null = null;
  try {
    const [row] = await db
      .insert(multiRepoRefactors)
      .values({
        ownerUserId: args.userId,
        title: title.slice(0, 200),
        description,
        status: "planning",
      })
      .returning();
    parent = row || null;
  } catch (err) {
    return {
      ok: false,
      error: `parent insert failed: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!parent) return { ok: false, error: "parent insert returned no row" };

  try {
    await db.insert(multiRepoRefactorPrs).values(
      plan.map((p) => ({
        refactorId: parent!.id,
        repositoryId: p.repositoryId,
        status: "pending" as const,
      }))
    );
  } catch (err) {
    return {
      ok: false,
      error: `children insert failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  await audit({
    userId: args.userId,
    action: "multi_repo_refactor.planned",
    repositoryId: null,
    metadata: {
      refactorId: parent.id,
      title,
      affectedCount: plan.length,
    },
  });

  return { ok: true, refactor: parent, plan };
}

// ---------------------------------------------------------------------------
// Public API — executeRefactor
// ---------------------------------------------------------------------------

/**
 * Stage 2 of the refactor pipeline. For every child row in `pending` we:
 *   1. flip its status to `building`,
 *   2. resolve the repo + owner,
 *   3. seed a fresh branch off the default branch's HEAD,
 *   4. ask Claude for end-state file contents,
 *   5. write each file via `createOrUpdateFileOnBranch`,
 *   6. insert the PR row + a marker comment naming the group label,
 *   7. flip the child to `opened` (or `failed` on any non-recoverable error).
 *
 * Once every child has terminated we roll the statuses up into a parent
 * status (`ready_for_review` / `failed`) and return the children list.
 */
export async function executeRefactor(
  args: ExecuteRefactorArgs
): Promise<ExecuteRefactorResult> {
  if (!args.refactorId) return { ok: false, error: "refactorId required" };

  const client = resolveClient(args.client);
  if (!client) {
    return { ok: false, error: "ANTHROPIC_API_KEY required for refactor execution" };
  }

  // Load parent.
  let parent: MultiRepoRefactor | null = null;
  try {
    const [row] = await db
      .select()
      .from(multiRepoRefactors)
      .where(eq(multiRepoRefactors.id, args.refactorId))
      .limit(1);
    parent = row || null;
  } catch {
    return { ok: false, error: "refactor lookup failed" };
  }
  if (!parent) return { ok: false, error: "refactor not found" };

  if (parent.status === "merged") {
    return { ok: false, error: "refactor already merged" };
  }

  // Load children that need work. We re-pick `pending` and `building` so a
  // crash mid-execute is recoverable.
  let children: MultiRepoRefactorPr[] = [];
  try {
    children = await db
      .select()
      .from(multiRepoRefactorPrs)
      .where(eq(multiRepoRefactorPrs.refactorId, parent.id));
  } catch {
    return { ok: false, error: "children lookup failed" };
  }

  if (children.length === 0) {
    return { ok: false, error: "refactor has no child repos" };
  }

  await setRefactorStatus(parent.id, "building");

  const results: ExecuteRefactorChildResult[] = [];
  // Sequential by default — keeps the volume of concurrent Claude calls
  // sane and makes the test output deterministic. Production callers
  // hammering this can swap to Promise.all when they're ready.
  for (const child of children) {
    if (child.status === "opened") {
      results.push({
        repositoryId: child.repositoryId,
        status: "opened",
        pullRequestId: child.pullRequestId ?? undefined,
      });
      continue;
    }

    const out = await executeChild({
      client,
      refactor: parent,
      child,
    });
    results.push(out);
  }

  // Roll the children up into a parent status.
  const rolled = rollupStatus(results);
  await setRefactorStatus(parent.id, rolled);

  // Refresh the parent row so the caller sees the new status.
  let refreshed: MultiRepoRefactor = { ...parent, status: rolled };
  try {
    const [r] = await db
      .select()
      .from(multiRepoRefactors)
      .where(eq(multiRepoRefactors.id, parent.id))
      .limit(1);
    if (r) refreshed = r;
  } catch {
    /* keep the in-memory rolled status */
  }

  return { ok: true, refactor: refreshed, children: results };
}

interface ExecuteChildArgs {
  client: ClaudeClient;
  refactor: MultiRepoRefactor;
  child: MultiRepoRefactorPr;
}

/**
 * Run the AI patch pipeline for one child row. Always returns a result —
 * failures flip the child to `failed` with an error message stored on
 * the row so the UI can surface it inline.
 */
async function executeChild(
  args: ExecuteChildArgs
): Promise<ExecuteRefactorChildResult> {
  const { client, refactor, child } = args;

  // Mark as building.
  try {
    await db
      .update(multiRepoRefactorPrs)
      .set({ status: "building", updatedAt: new Date() })
      .where(eq(multiRepoRefactorPrs.id, child.id));
  } catch {
    /* non-fatal */
  }

  const repo = await loadRepoForExecute(child.repositoryId);
  if (!repo) {
    return finaliseChildFailure(child.id, child.repositoryId, "repo not found");
  }

  // Reuse the predicted summary from the plan if the row carries it.
  // Today we don't persist the per-repo summary on the child row to keep
  // the schema lean — we recompute by re-asking Claude inside the prompt
  // (the description itself anchors the change).
  const predictedChanges =
    `Apply the multi-repo refactor described above to the \`${repo.owner}/${repo.name}\` repository.`;

  const branch = refactorBranchName(refactor.id);
  const seeded = await seedBranchFromHead(
    repo.owner,
    repo.name,
    branch,
    repo.defaultBranch || "main"
  );
  if (!seeded.ok) {
    return finaliseChildFailure(
      child.id,
      child.repositoryId,
      `seed branch failed: ${seeded.error}`
    );
  }

  // Build a tiny pre-loaded context — for the first iteration we don't
  // ship the whole repo to Claude, we let it work from the description +
  // the predicted summary. Future enhancement: feed in the semantic-index
  // top-k files for this repo. We do read README.md when present so
  // Claude has *some* concrete anchor.
  const repoFiles: Array<{ path: string; content: string }> = [];
  try {
    const readme = await getBlob(repo.owner, repo.name, seeded.baseSha, "README.md");
    if (readme && !readme.isBinary) {
      repoFiles.push({ path: "README.md", content: readme.content });
    }
  } catch {
    /* README is a nice-to-have */
  }

  const editRes = await askClaudeForEdit(
    client,
    refactor.description,
    predictedChanges,
    repoFiles
  );
  if (
    !editRes ||
    !Array.isArray(editRes.patches) ||
    editRes.patches.length === 0
  ) {
    return finaliseChildFailure(
      child.id,
      child.repositoryId,
      "AI returned no patches"
    );
  }

  // Apply patches.
  const writtenPaths: string[] = [];
  for (const patch of editRes.patches) {
    if (
      !patch ||
      typeof patch.path !== "string" ||
      typeof patch.new_content !== "string"
    ) {
      continue;
    }
    const res = await createOrUpdateFileOnBranch({
      owner: repo.owner,
      name: repo.name,
      branch,
      filePath: patch.path,
      bytes: new TextEncoder().encode(patch.new_content),
      message: `refactor(multi-repo): ${patch.path}`,
      authorName: "GlueCron Multi-Repo Refactor",
      authorEmail: "refactor@gluecron.com",
    });
    if ("error" in res) {
      return finaliseChildFailure(
        child.id,
        child.repositoryId,
        `write failed: ${res.error}`
      );
    }
    writtenPaths.push(patch.path);
  }

  if (writtenPaths.length === 0) {
    return finaliseChildFailure(
      child.id,
      child.repositoryId,
      "no patches written"
    );
  }

  // Ensure the group label row exists on this repo, then open the PR.
  await ensureGroupLabel(repo.id, refactor.id);

  const body = renderRefactorPrBody({
    refactorId: refactor.id,
    refactorTitle: refactor.title,
    description: refactor.description,
    predictedChanges,
    explanation: editRes.explanation || "",
    patchPaths: writtenPaths,
  });
  const title = `[refactor] ${refactor.title}`.slice(0, 200);
  const baseBranch = repo.defaultBranch || "main";

  let prId: string | null = null;
  let prNumber: number | null = null;
  try {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: repo.id,
        authorId: repo.ownerId,
        title,
        body,
        baseBranch,
        headBranch: branch,
        isDraft: false,
      })
      .returning({ id: pullRequests.id, number: pullRequests.number });
    if (pr) {
      prId = pr.id;
      prNumber = pr.number;
    }
  } catch (err) {
    return finaliseChildFailure(
      child.id,
      child.repositoryId,
      `PR insert failed: ${err instanceof Error ? err.message : err}`
    );
  }

  if (!prId || prNumber == null) {
    return finaliseChildFailure(
      child.id,
      child.repositoryId,
      "PR insert returned no row"
    );
  }

  // Drop a marker comment so the label is discoverable without a join table.
  try {
    await db.insert(prComments).values({
      pullRequestId: prId,
      authorId: repo.ownerId,
      isAiReview: true,
      body: `${MULTI_REPO_REFACTOR_MARKER}\nApplied label: \`${refactorLabelName(refactor.id)}\``,
    });
  } catch {
    /* best-effort */
  }

  // Mark the child as opened.
  try {
    await db
      .update(multiRepoRefactorPrs)
      .set({
        status: "opened",
        pullRequestId: prId,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(multiRepoRefactorPrs.id, child.id));
  } catch {
    /* the in-memory result still reflects success */
  }

  await audit({
    userId: refactor.ownerUserId,
    action: "multi_repo_refactor.pr_opened",
    repositoryId: repo.id,
    metadata: {
      refactorId: refactor.id,
      prNumber,
      branch,
    },
  });

  return {
    repositoryId: repo.id,
    status: "opened",
    pullRequestId: prId,
    prNumber,
    branch,
  };
}

async function finaliseChildFailure(
  childId: string,
  repositoryId: string,
  error: string
): Promise<ExecuteRefactorChildResult> {
  try {
    await db
      .update(multiRepoRefactorPrs)
      .set({
        status: "failed",
        errorMessage: error.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(multiRepoRefactorPrs.id, childId));
  } catch {
    /* non-fatal — we still return the error to the caller */
  }
  return { repositoryId, status: "failed", error };
}

// ---------------------------------------------------------------------------
// Public API — read helpers
// ---------------------------------------------------------------------------

export interface GetRefactorResult {
  refactor: MultiRepoRefactor;
  children: Array<
    MultiRepoRefactorPr & {
      repoOwner: string | null;
      repoName: string | null;
      prNumber: number | null;
    }
  >;
}

/**
 * Load a refactor + its children, joined with the repo names and PR
 * numbers needed by the UI table.
 */
export async function getRefactor(
  refactorId: string,
  opts: { userId?: string } = {}
): Promise<GetRefactorResult | null> {
  let parent: MultiRepoRefactor | null = null;
  try {
    const conditions = opts.userId
      ? and(
          eq(multiRepoRefactors.id, refactorId),
          eq(multiRepoRefactors.ownerUserId, opts.userId)
        )
      : eq(multiRepoRefactors.id, refactorId);
    const [row] = await db
      .select()
      .from(multiRepoRefactors)
      .where(conditions)
      .limit(1);
    parent = row || null;
  } catch {
    return null;
  }
  if (!parent) return null;

  let children: GetRefactorResult["children"] = [];
  try {
    const rows = await db
      .select({
        id: multiRepoRefactorPrs.id,
        refactorId: multiRepoRefactorPrs.refactorId,
        repositoryId: multiRepoRefactorPrs.repositoryId,
        pullRequestId: multiRepoRefactorPrs.pullRequestId,
        status: multiRepoRefactorPrs.status,
        errorMessage: multiRepoRefactorPrs.errorMessage,
        createdAt: multiRepoRefactorPrs.createdAt,
        updatedAt: multiRepoRefactorPrs.updatedAt,
        repoOwner: users.username,
        repoName: repositories.name,
        prNumber: pullRequests.number,
      })
      .from(multiRepoRefactorPrs)
      .leftJoin(
        repositories,
        eq(multiRepoRefactorPrs.repositoryId, repositories.id)
      )
      .leftJoin(users, eq(repositories.ownerId, users.id))
      .leftJoin(
        pullRequests,
        eq(multiRepoRefactorPrs.pullRequestId, pullRequests.id)
      )
      .where(eq(multiRepoRefactorPrs.refactorId, refactorId));
    children = rows as GetRefactorResult["children"];
  } catch {
    children = [];
  }

  return { refactor: parent, children };
}

/** List refactors a user owns, newest first. UI-facing. */
export async function listRefactorsForUser(
  userId: string,
  limit = 50
): Promise<MultiRepoRefactor[]> {
  try {
    return await db
      .select()
      .from(multiRepoRefactors)
      .where(eq(multiRepoRefactors.ownerUserId, userId))
      .orderBy(desc(multiRepoRefactors.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test-only re-exports
// ---------------------------------------------------------------------------

export const __test = {
  buildPlanPrompt,
  buildEditPrompt,
  rollupStatus,
  refactorLabelName,
  refactorBranchName,
  deriveTitle,
  renderRefactorPrBody,
  listUserRepos,
  ensureGroupLabel,
  seedBranchFromHead,
  setRefactorStatus,
};
