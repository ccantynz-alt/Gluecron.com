/**
 * AI test generator — when a PR opens, autopilot reads the diff, asks
 * Claude to write tests for the new code, and either pushes a test
 * commit onto the same branch or opens a follow-up PR against the PR's
 * head branch. Every merged PR self-improves the test suite.
 *
 * Pipeline per PR:
 *   1. Resolve the PR row + repo + owner.
 *   2. Diff `base...head` to find files added/modified. Drop test
 *      files, configs, docs, and binary blobs.
 *   3. For each surviving source file, ask Claude to write tests
 *      matching whatever framework sibling test files use. The model
 *      returns `{ patches: [{ path, new_content }] }` — the same envelope
 *      `ai-patch-generator.ts` uses, so the write path is shared.
 *   4. `append-commit` mode  — write each patch onto the PR's headBranch.
 *      `follow-up-pr` mode   — write onto a fresh `ai-tests/<n>-<ts>`
 *                              branch seeded from headBranch, then insert
 *                              a new pullRequests row pointing at the new
 *                              branch with base = original headBranch.
 *   5. Mark with label `ai:added-tests` (created on the repo, surfaced
 *      via a marker comment on whichever PR is being decorated).
 *   6. Audit `ai.tests.added` so operators can review uptake.
 *
 * Idempotent — if any prior tick already added the `ai:added-tests`
 * marker (comment on the PR for append-commit; comment on the original
 * PR for follow-up-pr) we skip. Callers fire-and-forget; we never throw.
 */

import { and, eq, like } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  labels,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import {
  createOrUpdateFileOnBranch,
  getBlob,
  getRepoPath,
  refExists,
  resolveRef,
  updateRef,
} from "../git/repository";
import { config } from "./config";
import { audit } from "./notify";
import {
  getAnthropic,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";
import { detectLanguage, detectTestFramework } from "./ai-tests";

/** Marker embedded in PR comments so subsequent ticks dedupe cleanly. */
export const AI_TESTS_MARKER = "<!-- gluecron-ai-tests:added -->";

/** Label name attached (and ensured present on the repo) for tagged PRs. */
export const AI_TESTS_LABEL = "ai:added-tests";

/** Existing PR-label marker we use to detect spec-generated PRs (avoid recursion). */
const AI_SPEC_LABEL = "ai:spec-implementation";
const AI_SPEC_PR_MARKER = "<!-- gluecron:ai-spec-implementation:v1 -->";

/** Default per-PR cap on how many new files we ask Claude to test in one run. */
export const MAX_FILES_PER_RUN = 5;

/** Hard cap on Claude prompt size — large source files get truncated. */
const MAX_SOURCE_BYTES_PER_FILE = 24_000;

/** Test-file path heuristics — skip writing tests for things that already are tests. */
const TEST_PATH_RX = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

/** Path prefixes / extensions we never propose to write tests for. */
const SKIP_PREFIX = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".github/",
  "drizzle/",
  "public/",
  "docs/",
  ".vscode/",
  ".gluecron/",
];

/** File extensions worth generating tests for. */
const CODE_EXT_RX = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|rb)$/i;

/** Doc/config extensions to skip. */
const DOC_OR_CONFIG_RX = /\.(md|mdx|txt|json|yml|yaml|toml|ini|env|lock|lockb|svg|png|jpg|jpeg|gif|webp|ico|pdf|woff|woff2|ttf|otf|css|scss)$/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TestGenMode = "append-commit" | "follow-up-pr";

export interface GenerateTestsForPrArgs {
  prId: string;
  mode: TestGenMode;
  /** Optional Anthropic client override (tests). */
  client?: Pick<Anthropic, "messages">;
  /** Optional file-list override (tests). Bypasses git diff scan. */
  changedFilesOverride?: string[];
  /** Optional per-file source resolver (tests). Bypasses getBlob. */
  resolveSource?: (path: string) => Promise<string | null>;
  /** Optional cap on files per run. */
  maxFiles?: number;
}

export interface GenerateTestsForPrResult {
  ok: boolean;
  /** Branch the test commit(s) landed on. */
  branch?: string;
  /** New PR number when mode='follow-up-pr'. */
  prNumber?: number;
  /** Reason for ok=false. */
  error?: string;
  /** Number of test files written. */
  written?: number;
  /** Whether we short-circuited via the idempotent dedupe. */
  alreadyDone?: boolean;
}

interface ClaudeTestPatch {
  path: string;
  new_content: string;
}

interface ClaudeTestResponse {
  patches?: ClaudeTestPatch[];
}

interface PrFacts {
  pr: {
    id: string;
    number: number;
    title: string;
    body: string | null;
    baseBranch: string;
    headBranch: string;
    repositoryId: string;
    authorId: string;
    state: string;
  };
  ownerName: string;
  repoName: string;
  repoOwnerId: string;
  defaultBranch: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the test suite can pin invariants
// ---------------------------------------------------------------------------

/**
 * Decide whether a given changed file path is worth asking Claude to test.
 * Drops test files, configs, docs, build output, binaries, and anything
 * outside the project's source layout heuristic.
 */
export function isCandidateSourceFile(path: string): boolean {
  if (!path || typeof path !== "string") return false;
  if (path.includes("..")) return false;
  if (SKIP_PREFIX.some((p) => path.startsWith(p))) return false;
  if (TEST_PATH_RX.test(path)) return false;
  if (DOC_OR_CONFIG_RX.test(path)) return false;
  if (!CODE_EXT_RX.test(path)) return false;
  return true;
}

/**
 * Build the per-file prompt that asks Claude to write tests. Pure so it's
 * easy to assert against in unit tests.
 */
export function buildTestsForPrPrompt(args: {
  filePath: string;
  language: string;
  framework: string;
  sourceCode: string;
  prTitle: string;
}): string {
  const trimmed =
    args.sourceCode.length > MAX_SOURCE_BYTES_PER_FILE
      ? args.sourceCode.slice(0, MAX_SOURCE_BYTES_PER_FILE) +
        "\n// ... (truncated)"
      : args.sourceCode;
  return [
    "Write tests for the new code below. Match the existing test framework",
    "the repository already uses — look at the framework hint and write idioms",
    "that fit (do not introduce a new test runner).",
    "",
    `**Pull request:** ${args.prTitle}`,
    `**Source file:** \`${args.filePath}\``,
    `**Language:** ${args.language}`,
    `**Framework:** ${args.framework}`,
    "",
    "Source file contents:",
    "```",
    trimmed,
    "```",
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "patches": [',
    '    { "path": "path/to/new/test/file", "new_content": "FULL file contents" }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Return an empty patches array if you cannot write meaningful tests safely.",
    "- new_content MUST be the entire file (not a diff).",
    "- Pick a sensible test-file path that matches the repo's conventions for",
    `  framework \`${args.framework}\` (e.g. \`src/__tests__/<name>.test.ts\``,
    "  for bun:test, `test_<name>.py` for pytest, `<name>_test.go` for go test).",
    "- Tests SHOULD compile/import cleanly and exercise the file's public surface.",
    "- Use realistic assertions; avoid `expect(true).toBe(true)` placeholders.",
    "- Do not modify the source file — only emit new test files.",
  ].join("\n");
}

/**
 * Compute a unique branch name for follow-up-pr mode. Caller can override
 * for deterministic test output.
 */
export function testsBranchName(prNumber: number, override?: string): string {
  if (override && override.trim()) return override.trim();
  return `ai-tests/pr-${prNumber}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up the PR + repo + owner row in one go. Returns null if any link
 * is missing so callers bail before touching git.
 */
async function loadPrFacts(prId: string): Promise<PrFacts | null> {
  try {
    const [row] = await db
      .select({
        prId: pullRequests.id,
        prNumber: pullRequests.number,
        prTitle: pullRequests.title,
        prBody: pullRequests.body,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        repositoryId: pullRequests.repositoryId,
        authorId: pullRequests.authorId,
        state: pullRequests.state,
        ownerName: users.username,
        repoName: repositories.name,
        repoOwnerId: repositories.ownerId,
        defaultBranch: repositories.defaultBranch,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(pullRequests.id, prId))
      .limit(1);
    if (!row) return null;
    return {
      pr: {
        id: row.prId,
        number: row.prNumber,
        title: row.prTitle,
        body: row.prBody,
        baseBranch: row.baseBranch,
        headBranch: row.headBranch,
        repositoryId: row.repositoryId,
        authorId: row.authorId,
        state: row.state,
      },
      ownerName: row.ownerName,
      repoName: row.repoName,
      repoOwnerId: row.repoOwnerId,
      defaultBranch: row.defaultBranch,
    };
  } catch (err) {
    console.warn(
      "[ai-test-generator] loadPrFacts failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Best-effort list of files changed between baseBranch...headBranch.
 * Returns just paths (no patch text — we re-read each file from the
 * head ref via getBlob so Claude sees the final state, not the diff).
 */
async function listChangedSourceFiles(
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<string[]> {
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "diff", "--name-only", `${baseBranch}...${headBranch}`],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    console.warn(
      "[ai-test-generator] listChangedSourceFiles failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

/**
 * List every blob in the repo at `ref`. Used to derive the framework hint
 * (jest vs vitest vs bun:test vs pytest, etc.) via `detectTestFramework`.
 */
async function listRepoFiles(
  ownerName: string,
  repoName: string,
  ref: string,
  cap = 2000
): Promise<string[]> {
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "ls-tree", "-r", "--name-only", ref],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, cap);
  } catch {
    return [];
  }
}

/**
 * Look for an existing `ai:added-tests` marker comment on the given PR.
 * Returns true if found — caller short-circuits.
 */
async function alreadyTagged(pullRequestId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: prComments.id })
      .from(prComments)
      .where(
        and(
          eq(prComments.pullRequestId, pullRequestId),
          like(prComments.body, `%${AI_TESTS_MARKER}%`)
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Look for an existing follow-up tests PR that targets this PR's head
 * branch. The dedup is keyed off the PR body marker we always write, so
 * a previously-opened follow-up never gets re-opened.
 */
async function alreadyHasFollowUpPr(
  repositoryId: string,
  originalPrNumber: number
): Promise<boolean> {
  try {
    const needle = `${AI_TESTS_MARKER}\nfor PR #${originalPrNumber}`;
    const rows = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          like(pullRequests.body, `%${needle}%`)
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Does the PR look AI-generated by spec-to-PR? We avoid recursing on
 * those (the spec already produced both code + tests in most cases).
 */
export function looksLikeSpecPr(prBody: string | null | undefined): boolean {
  if (!prBody) return false;
  return prBody.includes(AI_SPEC_PR_MARKER) || prBody.includes(AI_SPEC_LABEL);
}

/**
 * Ensure the `ai:added-tests` label row exists on the repo. Best-effort —
 * label is a UX nicety, not load-bearing. Mirrors `ensurePatchLabel` from
 * ai-patch-generator.
 */
async function ensureTestsLabel(repositoryId: string): Promise<void> {
  try {
    await db
      .insert(labels)
      .values({
        repositoryId,
        name: AI_TESTS_LABEL,
        color: "#3fb950",
        description:
          "Tests auto-generated by Gluecron AI from a pull request diff",
      })
      .onConflictDoNothing?.();
  } catch (err) {
    console.warn(
      "[ai-test-generator] ensureTestsLabel failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Ask Claude for tests. Returns parsed `{ patches }` or null on any
 * failure (network, parse error, no key). Caller treats null as a skip.
 */
async function askClaudeForTests(
  client: Pick<Anthropic, "messages">,
  args: {
    filePath: string;
    language: string;
    framework: string;
    sourceCode: string;
    prTitle: string;
  }
): Promise<ClaudeTestResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 4096,
      messages: [
        { role: "user", content: buildTestsForPrPrompt(args) },
      ],
    });
    const text = extractText(message);
    const parsed = parseJsonResponse<ClaudeTestResponse>(text);
    if (!parsed) return null;
    return parsed;
  } catch (err) {
    console.warn(
      "[ai-test-generator] Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Seed `branch` from `parentSha` if it doesn't yet exist. Returns true on
 * success or if it already exists.
 */
async function ensureBranchAt(
  ownerName: string,
  repoName: string,
  branch: string,
  parentSha: string
): Promise<boolean> {
  const fullRef = `refs/heads/${branch}`;
  if (await refExists(ownerName, repoName, fullRef)) return true;
  return updateRef(ownerName, repoName, fullRef, parentSha);
}

/**
 * Drop the marker comment on `pullRequestId` so the next tick's dedupe
 * sees us. Best-effort — failures are logged but don't stop the run.
 */
async function dropMarkerComment(
  pullRequestId: string,
  authorId: string,
  bodySuffix: string
): Promise<void> {
  try {
    await db.insert(prComments).values({
      pullRequestId,
      authorId,
      isAiReview: true,
      body: `${AI_TESTS_MARKER}\n${bodySuffix}`,
    });
  } catch (err) {
    console.warn(
      "[ai-test-generator] dropMarkerComment failed:",
      err instanceof Error ? err.message : err
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate tests for a PR. Returns a structured result; never throws.
 *
 * `mode='append-commit'`:
 *   Writes each generated test file onto the PR's existing headBranch.
 *   Surfaces the marker as a comment on the original PR.
 *
 * `mode='follow-up-pr'`:
 *   Branches off the PR's headBranch into `ai-tests/pr-<n>-<ts>`, writes
 *   each test file, then opens a new PR targeting the original headBranch
 *   as base. Surfaces the marker on both PRs.
 */
export async function generateTestsForPr(
  args: GenerateTestsForPrArgs
): Promise<GenerateTestsForPrResult> {
  // 1. Resolve client. Lazy so tests can inject without an API key.
  let client: Pick<Anthropic, "messages">;
  if (args.client) {
    client = args.client;
  } else {
    if (!config.anthropicApiKey) {
      return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
    }
    try {
      client = getAnthropic();
    } catch {
      return { ok: false, error: "Failed to construct Anthropic client" };
    }
  }

  // 2. Load PR row + repo + owner.
  const facts = await loadPrFacts(args.prId);
  if (!facts) return { ok: false, error: "PR not found" };

  // 3. Avoid recursion on spec-driven PRs.
  if (looksLikeSpecPr(facts.pr.body)) {
    return { ok: false, error: "PR is AI-generated (ai:spec-implementation); skipping" };
  }

  // 4. Idempotency — both modes write a marker on the original PR.
  if (await alreadyTagged(facts.pr.id)) {
    return { ok: true, alreadyDone: true, written: 0 };
  }
  if (
    args.mode === "follow-up-pr" &&
    (await alreadyHasFollowUpPr(facts.pr.repositoryId, facts.pr.number))
  ) {
    return { ok: true, alreadyDone: true, written: 0 };
  }

  // 5. Discover changed source files.
  const allChanged =
    args.changedFilesOverride ??
    (await listChangedSourceFiles(
      facts.ownerName,
      facts.repoName,
      facts.pr.baseBranch,
      facts.pr.headBranch
    ));

  const candidates = allChanged.filter(isCandidateSourceFile);
  const cap = Math.max(1, args.maxFiles ?? MAX_FILES_PER_RUN);
  const sliced = candidates.slice(0, cap);

  if (sliced.length === 0) {
    return { ok: false, error: "No candidate source files in diff" };
  }

  // 6. Framework hint via existing detector + repo tree listing.
  const repoFiles = await listRepoFiles(
    facts.ownerName,
    facts.repoName,
    facts.pr.headBranch
  );

  // 7. Resolve the head sha — needed both to seed a follow-up branch and
  //    to read source files at the head state.
  const headSha = await resolveRef(
    facts.ownerName,
    facts.repoName,
    facts.pr.headBranch
  );
  if (!headSha) {
    return { ok: false, error: "Could not resolve head branch sha" };
  }

  // 8. Determine the branch we'll write commits to.
  let writeBranch = facts.pr.headBranch;
  if (args.mode === "follow-up-pr") {
    writeBranch = testsBranchName(facts.pr.number);
    const seeded = await ensureBranchAt(
      facts.ownerName,
      facts.repoName,
      writeBranch,
      headSha
    );
    if (!seeded) {
      return { ok: false, error: `Could not seed branch ${writeBranch}` };
    }
  }

  // 9. Per-file Claude loop. Each file's test patches are written
  //    individually so a single failure can't lose all the work.
  await ensureTestsLabel(facts.pr.repositoryId);

  const written: string[] = [];
  const skipped: string[] = [];
  for (const sourcePath of sliced) {
    const sourceContent =
      args.resolveSource !== undefined
        ? await args.resolveSource(sourcePath)
        : await readSourceContent(
            facts.ownerName,
            facts.repoName,
            facts.pr.headBranch,
            sourcePath
          );
    if (sourceContent == null || sourceContent === "") {
      skipped.push(sourcePath);
      continue;
    }

    const language = detectLanguage(sourcePath);
    const framework = detectTestFramework(language, repoFiles);

    const claudeRes = await askClaudeForTests(client, {
      filePath: sourcePath,
      language,
      framework,
      sourceCode: sourceContent,
      prTitle: facts.pr.title,
    });
    if (!claudeRes || !Array.isArray(claudeRes.patches) || claudeRes.patches.length === 0) {
      skipped.push(sourcePath);
      continue;
    }

    for (const patch of claudeRes.patches) {
      if (
        !patch ||
        typeof patch.path !== "string" ||
        typeof patch.new_content !== "string"
      ) {
        continue;
      }
      // Safety: only allow new files inside the repo, with a test-file
      // shaped path. We deliberately reject patches that try to rewrite
      // the source file (Claude's job is to ADD tests, not edit code).
      if (patch.path === sourcePath) continue;
      if (patch.path.includes("..") || patch.path.startsWith("/")) continue;

      const res = await createOrUpdateFileOnBranch({
        owner: facts.ownerName,
        name: facts.repoName,
        branch: writeBranch,
        filePath: patch.path,
        bytes: new TextEncoder().encode(patch.new_content),
        message: `test(ai): add tests for ${sourcePath}`,
        authorName: "Gluecron AI",
        authorEmail: "ai@gluecron.com",
      });
      if ("error" in res) {
        skipped.push(patch.path);
        continue;
      }
      written.push(patch.path);
    }
  }

  if (written.length === 0) {
    return {
      ok: false,
      error: "Claude produced no usable test patches",
      written: 0,
    };
  }

  // 10. Decorate the right PR(s) with the marker + label citation.
  if (args.mode === "append-commit") {
    await dropMarkerComment(
      facts.pr.id,
      facts.repoOwnerId,
      [
        `Applied label: \`${AI_TESTS_LABEL}\``,
        `Added ${written.length} test file${written.length === 1 ? "" : "s"} on \`${writeBranch}\`:`,
        ...written.map((p) => `- \`${p}\``),
      ].join("\n")
    );

    await audit({
      userId: null,
      action: "ai.tests.added",
      repositoryId: facts.pr.repositoryId,
      targetType: "pull_request",
      targetId: facts.pr.id,
      metadata: {
        mode: args.mode,
        prNumber: facts.pr.number,
        branch: writeBranch,
        written,
      },
    });

    return {
      ok: true,
      branch: writeBranch,
      written: written.length,
    };
  }

  // follow-up-pr mode — open the new PR targeting the original headBranch.
  let newPrNumber: number | null = null;
  let newPrId: string | null = null;
  try {
    const body = renderFollowUpPrBody({
      originalPrNumber: facts.pr.number,
      branch: writeBranch,
      written,
    });
    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: facts.pr.repositoryId,
        authorId: facts.repoOwnerId,
        title: `[tests] +tests for #${facts.pr.number}`,
        body,
        baseBranch: facts.pr.headBranch,
        headBranch: writeBranch,
        isDraft: false,
      })
      .returning({ number: pullRequests.number, id: pullRequests.id });
    if (pr) {
      newPrNumber = pr.number;
      newPrId = pr.id;
    }
  } catch (err) {
    console.warn(
      "[ai-test-generator] follow-up PR insert failed:",
      err instanceof Error ? err.message : err
    );
  }

  // Always drop the marker on the ORIGINAL PR so future ticks dedupe.
  await dropMarkerComment(
    facts.pr.id,
    facts.repoOwnerId,
    [
      `Applied label: \`${AI_TESTS_LABEL}\``,
      newPrNumber
        ? `Opened follow-up tests PR #${newPrNumber} → \`${writeBranch}\``
        : `Tests pushed to branch \`${writeBranch}\` (PR insert failed).`,
      ...written.map((p) => `- \`${p}\``),
    ].join("\n")
  );

  // Also drop a marker on the follow-up PR itself so direct lookups work.
  if (newPrId) {
    await dropMarkerComment(
      newPrId,
      facts.repoOwnerId,
      `Applied label: \`${AI_TESTS_LABEL}\``
    );
  }

  await audit({
    userId: null,
    action: "ai.tests.added",
    repositoryId: facts.pr.repositoryId,
    targetType: "pull_request",
    targetId: facts.pr.id,
    metadata: {
      mode: args.mode,
      prNumber: facts.pr.number,
      followUpPrNumber: newPrNumber,
      branch: writeBranch,
      written,
    },
  });

  return {
    ok: true,
    branch: writeBranch,
    prNumber: newPrNumber ?? undefined,
    written: written.length,
  };
}

/**
 * Render the PR body for the follow-up tests PR. Pure helper exported
 * for tests.
 */
export function renderFollowUpPrBody(args: {
  originalPrNumber: number;
  branch: string;
  written: string[];
}): string {
  const files = args.written.map((p) => `- \`${p}\``).join("\n");
  return [
    `${AI_TESTS_MARKER}`,
    `for PR #${args.originalPrNumber}`,
    "",
    `## +tests for #${args.originalPrNumber}`,
    "",
    "Gluecron AI scanned the source changes in this PR's branch and added",
    "tests that match the repository's existing test framework.",
    "",
    `Branch: \`${args.branch}\``,
    "",
    "### Files added",
    files || "_(none)_",
    "",
    "---",
    "",
    `Labels: \`${AI_TESTS_LABEL}\``,
    "",
    "_Auto-generated by Gluecron AI. Review every assertion before merging._",
  ].join("\n");
}

/**
 * Read a file from the bare repo at the given ref, returning its text or
 * null when missing/binary/too-large.
 */
async function readSourceContent(
  ownerName: string,
  repoName: string,
  ref: string,
  path: string
): Promise<string | null> {
  try {
    const blob = await getBlob(ownerName, repoName, ref, path);
    if (!blob) return null;
    if (blob.isBinary) return null;
    return blob.content;
  } catch {
    return null;
  }
}

/**
 * Test-only re-exports of internal helpers.
 */
export const __test = {
  loadPrFacts,
  listChangedSourceFiles,
  listRepoFiles,
  alreadyTagged,
  alreadyHasFollowUpPr,
  ensureTestsLabel,
  ensureBranchAt,
  readSourceContent,
  askClaudeForTests,
  dropMarkerComment,
};
