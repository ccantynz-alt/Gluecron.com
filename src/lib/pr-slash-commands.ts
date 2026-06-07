/**
 * PR slash-commands — habit-forming productivity in the PR comment textarea.
 *
 * Users type `/rebase`, `/merge`, `/explain`, `/test`, `/lgtm`,
 * `/needs-work`, `/cc @alice @bob`, or `/help` as the first line of a PR
 * comment and the route handler in `src/routes/pulls.tsx` hands off here
 * to (a) parse it and (b) execute it. The original comment is still
 * stored unchanged so the timeline reflects what the user actually wrote;
 * the command's outcome is posted as a follow-up comment carrying a
 * `cmd:<command>` audit marker (consumed by the renderer to display a
 * polished pill, e.g. "⚡ alice ran /merge → squashed and merged").
 *
 * Boundaries (intentional):
 *   - This file does NOT talk to HTTP. The route hands it a clean
 *     `{command, args, prId, userId, repositoryId}` payload — that keeps
 *     the executor unit-testable without spinning up Hono contexts.
 *   - All git/DB primitives are imported from existing helpers
 *     (`performMerge`, `mergeWithAutoResolve`, `enqueueRun`, `audit`).
 *     No new schema, no new tables.
 *   - Anthropic + bare-repo dependencies are injectable so tests can
 *     pin behaviour without a network or filesystem worktree.
 *
 * Failure model:
 *   - `parseSlashCommand` returns `null` for anything that doesn't look
 *     like a recognised command line — including free-form text that
 *     happens to start with `/` (e.g. `/usr/local/bin/foo`). The route
 *     then stores the comment unchanged.
 *   - `executeSlashCommand` never throws. Every branch returns a
 *     human-friendly result string; transient errors (missing PR, no
 *     write access, AI unavailable) are surfaced verbatim so the
 *     follow-up comment is informative.
 */

import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  pullRequests,
  prComments,
  repositories,
  users,
  workflows,
  type PullRequest,
} from "../db/schema";
import {
  MODEL_SONNET,
  extractText,
  getAnthropic,
  isAiAvailable,
} from "./ai-client";
import { performMerge } from "./pr-merge";
import { audit } from "./notify";
import { getRepoPath } from "../git/repository";
import { resolveRepoAccess, satisfiesAccess } from "../middleware/repo-access";

/** Audit marker prefix we embed in follow-up command result comments. */
export const SLASH_CMD_MARKER_PREFIX = "<!-- cmd:";
export function slashCmdMarker(command: string): string {
  return `${SLASH_CMD_MARKER_PREFIX}${command} -->`;
}

/**
 * Recognised commands. Keep this set in sync with the cases inside
 * `executeSlashCommand` and the `/help` output below.
 */
export const SLASH_COMMANDS = [
  "rebase",
  "merge",
  "explain",
  "test",
  "lgtm",
  "needs-work",
  "cc",
  "stage",
  "help",
] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export interface ParsedSlash {
  command: SlashCommand;
  args: string[];
  /** The full raw command line (without the leading `/`). */
  raw: string;
}

/**
 * Parse the first line of a comment as a slash command.
 *
 * Returns `null` when the comment doesn't begin with `/<recognised-word>`.
 * Free-form text that happens to begin with a `/` (e.g. a Unix path) is
 * deliberately NOT matched — the recogniser is whitelist-based.
 *
 * The trailing rest of the line is split on whitespace into `args`.
 * Examples:
 *
 *   parseSlashCommand("/merge squash")        → { command: "merge", args: ["squash"] }
 *   parseSlashCommand("/cc @alice @bob")      → { command: "cc",    args: ["@alice", "@bob"] }
 *   parseSlashCommand("/help")                → { command: "help",  args: [] }
 *   parseSlashCommand("hey /merge")           → null   (must start at column 0)
 *   parseSlashCommand("/usr/local/bin/foo")   → null   (`usr` not whitelisted)
 *   parseSlashCommand("")                     → null
 */
export function parseSlashCommand(comment: string): ParsedSlash | null {
  if (!comment) return null;
  // Only consider the first non-blank line. The body may carry context
  // below the command (e.g. `/needs-work\nplease tighten the loop`).
  const firstLine = comment.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("/")) return null;
  // Strip the leading slash and split on whitespace.
  const rest = firstLine.slice(1);
  // Reject leading whitespace ("/ merge" is not a command).
  if (!rest || /^\s/.test(rest)) return null;
  const tokens = rest.split(/\s+/);
  const head = tokens.shift() ?? "";
  // Normalise: lower-case + strip any trailing punctuation a user might
  // type by reflex ("/help.").
  const normalised = head.toLowerCase().replace(/[.,!?]+$/, "");
  if (!(SLASH_COMMANDS as readonly string[]).includes(normalised)) return null;
  return {
    command: normalised as SlashCommand,
    args: tokens,
    raw: rest,
  };
}

// ---------------------------------------------------------------------------
// Executor surface
// ---------------------------------------------------------------------------

export interface ExecuteSlashArgs {
  command: SlashCommand;
  args: string[];
  prId: string;
  userId: string;
  repositoryId: string;
  /**
   * Test-only injection points. Production callers leave these blank and
   * the helpers below fall back to the real Anthropic client + git
   * subprocess.
   */
  deps?: ExecuteSlashDeps;
}

export interface ExecuteSlashDeps {
  /** Override the Anthropic client used by `/explain`. */
  anthropic?: Pick<Anthropic, "messages">;
  /** Override the git subprocess runner used by `/rebase`. */
  git?: (
    args: string[],
    opts: { cwd: string }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Override the merge executor used by `/merge`. */
  merge?: typeof performMerge;
  /**
   * Override the access resolver. Real production uses the middleware's
   * `resolveRepoAccess`, which talks to the DB. Tests can pin a level.
   */
  resolveAccess?: (args: {
    repoId: string;
    userId: string;
    isPublic: boolean;
  }) => Promise<"none" | "read" | "write" | "admin" | "owner">;
}

export interface SlashResult {
  /** Markdown body to post as the follow-up comment. */
  body: string;
  /** Whether the action actually fired (false = "I tried, but…"). */
  ok: boolean;
  /** Convenience: the audit marker the renderer will look for. */
  marker: string;
}

/**
 * Execute a parsed slash command. Always resolves; never throws.
 *
 * Production callers should:
 *   1. Insert the user's original comment unchanged.
 *   2. Call this function.
 *   3. Insert a second comment with `body = result.body` so the timeline
 *      shows both the user input and the bot's response.
 */
export async function executeSlashCommand(
  args: ExecuteSlashArgs
): Promise<SlashResult> {
  const marker = slashCmdMarker(args.command);
  try {
    switch (args.command) {
      case "help":
        return { ok: true, marker, body: renderHelp(marker) };
      case "lgtm":
        return { ...(await runLgtm(args)), marker };
      case "needs-work":
        return { ...(await runNeedsWork(args)), marker };
      case "cc":
        return { ...(await runCc(args)), marker };
      case "explain":
        return { ...(await runExplain(args)), marker };
      case "merge":
        return { ...(await runMerge(args)), marker };
      case "rebase":
        return { ...(await runRebase(args)), marker };
      case "test":
        return { ...(await runTest(args)), marker };
      case "stage":
        return { ...(await runStage(args)), marker };
      default:
        return {
          ok: false,
          marker,
          body: `${marker}\n\nUnrecognised slash command: \`/${args.command}\`. Type \`/help\` for the list.`,
        };
    }
  } catch (err) {
    return {
      ok: false,
      marker,
      body: `${marker}\n\nSlash-command \`/${args.command}\` failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ---------------------------------------------------------------------------
// Individual command implementations
// ---------------------------------------------------------------------------

function renderHelp(marker: string): string {
  const lines = [
    marker,
    "",
    "**PR slash commands**",
    "",
    "Type any of these as the first line of a PR comment:",
    "",
    "- `/rebase` — rebase the PR's head onto its base and force-push",
    "- `/merge [squash|rebase|merge]` — merge the PR using the requested strategy",
    "- `/explain` — Claude posts a high-level explanation of this PR",
    "- `/test` — kick the repo's CI test workflow",
    "- `/lgtm` — approve the PR (adds an approval comment)",
    "- `/needs-work` — request changes",
    "- `/cc @user1 @user2` — request reviewers",
    "- `/stage` — deploy a preview environment and reply with the live URL",
    "- `/help` — show this list",
  ];
  return lines.join("\n");
}

async function runLgtm(args: ExecuteSlashArgs): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("lgtm");
  const username = await usernameFor(args.userId);
  const body = `${marker}\n\n**Approved** — ${username ? `@${username}` : "a reviewer"} signed off via \`/lgtm\`.`;
  await audit({
    userId: args.userId,
    repositoryId: args.repositoryId,
    action: "pr.slash.lgtm",
    targetType: "pr",
    targetId: args.prId,
  });
  return { ok: true, body };
}

async function runNeedsWork(
  args: ExecuteSlashArgs
): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("needs-work");
  const username = await usernameFor(args.userId);
  const reason = args.args.join(" ").trim();
  const body = [
    marker,
    "",
    `**Changes requested** — ${username ? `@${username}` : "a reviewer"} flagged this PR via \`/needs-work\`.`,
    reason ? `\n> ${reason}` : "",
  ]
    .join("\n")
    .trim();
  await audit({
    userId: args.userId,
    repositoryId: args.repositoryId,
    action: "pr.slash.needs_work",
    targetType: "pr",
    targetId: args.prId,
    metadata: reason ? { reason } : undefined,
  });
  return { ok: true, body };
}

async function runCc(args: ExecuteSlashArgs): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("cc");
  // Normalise tokens: accept "@user", "user," or bare "user".
  const candidates = args.args
    .map((t) => t.replace(/^@+/, "").replace(/[,;]+$/, "").trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    return {
      ok: false,
      body: `${marker}\n\n\`/cc\` requires one or more @usernames. Example: \`/cc @alice @bob\`.`,
    };
  }
  // Resolve which of the requested usernames actually exist. Unknown
  // names are still listed so the requester knows what was skipped.
  const found = await usernamesExist(candidates);
  const known = candidates.filter((u) => found.has(u.toLowerCase()));
  const unknown = candidates.filter((u) => !found.has(u.toLowerCase()));
  await audit({
    userId: args.userId,
    repositoryId: args.repositoryId,
    action: "pr.slash.cc",
    targetType: "pr",
    targetId: args.prId,
    metadata: { requested: candidates, known, unknown },
  });
  const lines = [marker, ""];
  if (known.length > 0) {
    lines.push(
      `**Reviewers requested:** ${known.map((u) => `@${u}`).join(", ")}`
    );
  }
  if (unknown.length > 0) {
    lines.push(
      `_Skipped (no such user):_ ${unknown.map((u) => `\`${u}\``).join(", ")}`
    );
  }
  return { ok: known.length > 0, body: lines.join("\n") };
}

async function runExplain(
  args: ExecuteSlashArgs
): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("explain");
  const pr = await loadPr(args.prId);
  if (!pr) {
    return { ok: false, body: `${marker}\n\nCould not load PR #${args.prId}.` };
  }
  const repoInfo = await loadRepoOwner(pr.repositoryId);
  if (!repoInfo) {
    return { ok: false, body: `${marker}\n\nCould not resolve repository.` };
  }

  if (!args.deps?.anthropic && !isAiAvailable()) {
    return {
      ok: false,
      body: `${marker}\n\nAI is not configured (\`ANTHROPIC_API_KEY\` unset) — \`/explain\` is unavailable.`,
    };
  }

  const diff = await diffBetweenBranches(
    repoInfo.ownerName,
    repoInfo.repoName,
    pr.baseBranch,
    pr.headBranch,
    args.deps?.git
  );
  // Hard cap to keep prompt sizes sane.
  const diffSnippet = diff.slice(0, 60_000);
  const explanation = await callExplainClaude({
    title: pr.title,
    body: pr.body || "",
    diff: diffSnippet,
    client: args.deps?.anthropic,
  });

  await audit({
    userId: args.userId,
    repositoryId: args.repositoryId,
    action: "pr.slash.explain",
    targetType: "pr",
    targetId: args.prId,
  });

  return {
    ok: true,
    body: `${marker}\n\n**PR explanation** (via \`/explain\`)\n\n${explanation}`,
  };
}

async function runMerge(args: ExecuteSlashArgs): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("merge");
  const strategy = parseMergeStrategy(args.args[0]);

  const pr = await loadPr(args.prId);
  if (!pr) {
    return { ok: false, body: `${marker}\n\nCould not load PR.` };
  }
  const repoInfo = await loadRepoOwner(pr.repositoryId);
  if (!repoInfo) {
    return { ok: false, body: `${marker}\n\nCould not resolve repository.` };
  }

  // Access check — base-branch write access is required.
  const access = await (args.deps?.resolveAccess ?? resolveRepoAccess)({
    repoId: pr.repositoryId,
    userId: args.userId,
    isPublic: repoInfo.isPublic,
  });
  if (!satisfiesAccess(access, "write")) {
    return {
      ok: false,
      body: `${marker}\n\n\`/merge\` denied — write access to \`${repoInfo.ownerName}/${repoInfo.repoName}\` is required (you have \`${access}\`).`,
    };
  }

  const merge = args.deps?.merge ?? performMerge;
  const result = await merge({
    pr: {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      repositoryId: pr.repositoryId,
      authorId: pr.authorId,
      state: pr.state,
      isDraft: pr.isDraft,
    },
    ownerName: repoInfo.ownerName,
    repoName: repoInfo.repoName,
    actorUserId: args.userId,
  });

  await audit({
    userId: args.userId,
    repositoryId: args.repositoryId,
    action: "pr.slash.merge",
    targetType: "pr",
    targetId: args.prId,
    metadata: {
      strategy,
      ok: result.ok,
      error: result.error,
      closed: result.closedIssueNumbers,
    },
  });

  if (!result.ok) {
    return {
      ok: false,
      body: `${marker}\n\n\`/merge\` failed: ${result.error}`,
    };
  }
  const closed =
    result.closedIssueNumbers.length > 0
      ? ` Closed issues: ${result.closedIssueNumbers.map((n) => `#${n}`).join(", ")}.`
      : "";
  return {
    ok: true,
    body: `${marker}\n\n**Merged** — \`${pr.headBranch}\` → \`${pr.baseBranch}\` via \`/merge ${strategy}\`.${closed}`,
  };
}

async function runRebase(args: ExecuteSlashArgs): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("rebase");
  const pr = await loadPr(args.prId);
  if (!pr) {
    return { ok: false, body: `${marker}\n\nCould not load PR.` };
  }
  if (pr.state !== "open") {
    return {
      ok: false,
      body: `${marker}\n\n\`/rebase\` only works on open PRs (state=${pr.state}).`,
    };
  }
  const repoInfo = await loadRepoOwner(pr.repositoryId);
  if (!repoInfo) {
    return { ok: false, body: `${marker}\n\nCould not resolve repository.` };
  }

  const access = await (args.deps?.resolveAccess ?? resolveRepoAccess)({
    repoId: pr.repositoryId,
    userId: args.userId,
    isPublic: repoInfo.isPublic,
  });
  if (!satisfiesAccess(access, "write")) {
    return {
      ok: false,
      body: `${marker}\n\n\`/rebase\` denied — write access required (you have \`${access}\`).`,
    };
  }

  const cwd = getRepoPath(repoInfo.ownerName, repoInfo.repoName);
  const git = args.deps?.git ?? defaultGit;

  // Use a fresh worktree so we don't disturb the bare-repo state.
  const worktree = `${cwd}/_rebase_worktree_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  try {
    const add = await git(["worktree", "add", "-f", worktree, pr.headBranch], {
      cwd,
    });
    if (add.exitCode !== 0) {
      return {
        ok: false,
        body: `${marker}\n\n\`/rebase\` could not create worktree: ${add.stderr.trim() || `exit ${add.exitCode}`}`,
      };
    }
    const rebase = await git(["rebase", pr.baseBranch], { cwd: worktree });
    if (rebase.exitCode !== 0) {
      await git(["rebase", "--abort"], { cwd: worktree }).catch(() => {});
      return {
        ok: false,
        body: `${marker}\n\n\`/rebase\` hit conflicts and was aborted: ${rebase.stderr.trim() || rebase.stdout.trim() || `exit ${rebase.exitCode}`}`,
      };
    }
    const head = await git(["rev-parse", "HEAD"], { cwd: worktree });
    if (head.exitCode !== 0) {
      return {
        ok: false,
        body: `${marker}\n\n\`/rebase\` could not read new head SHA.`,
      };
    }
    const newSha = head.stdout.trim();
    // Force-update the head ref in the bare repo (the "force push").
    const update = await git(
      ["update-ref", `refs/heads/${pr.headBranch}`, newSha],
      { cwd }
    );
    if (update.exitCode !== 0) {
      return {
        ok: false,
        body: `${marker}\n\n\`/rebase\` could not update head ref: ${update.stderr.trim() || `exit ${update.exitCode}`}`,
      };
    }
    await audit({
      userId: args.userId,
      repositoryId: args.repositoryId,
      action: "pr.slash.rebase",
      targetType: "pr",
      targetId: args.prId,
      metadata: { newSha, base: pr.baseBranch, head: pr.headBranch },
    });
    return {
      ok: true,
      body: `${marker}\n\n**Rebased** \`${pr.headBranch}\` onto \`${pr.baseBranch}\` and force-pushed → \`${newSha.slice(0, 7)}\`.`,
    };
  } finally {
    await git(["worktree", "remove", "--force", worktree], { cwd }).catch(
      () => {}
    );
  }
}

async function runTest(args: ExecuteSlashArgs): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("test");
  const pr = await loadPr(args.prId);
  if (!pr) {
    return { ok: false, body: `${marker}\n\nCould not load PR.` };
  }
  // Find the repo's test workflow. We accept either `.gluecron/workflows/test.yml`
  // or `.gluecron/workflows/ci.yml` (matching the spec). Repo owners can
  // alias their workflow by naming the file accordingly.
  const wf = await findTestWorkflow(pr.repositoryId);
  if (!wf) {
    return {
      ok: false,
      body: `${marker}\n\n\`/test\` could not find a test workflow — add \`.gluecron/workflows/test.yml\` or \`ci.yml\` to enable.`,
    };
  }
  // Lazy import so this module stays cheap to load. The runner manages
  // its own DB writes; we just enqueue.
  let runId = "";
  try {
    const { enqueueRun } = await import("./workflow-runner");
    runId = await enqueueRun({
      workflowId: wf.id,
      repositoryId: pr.repositoryId,
      event: "workflow_dispatch",
      ref: `refs/heads/${pr.headBranch}`,
      triggeredBy: args.userId,
    });
  } catch (err) {
    return {
      ok: false,
      body: `${marker}\n\n\`/test\` could not enqueue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  await audit({
    userId: args.userId,
    repositoryId: args.repositoryId,
    action: "pr.slash.test",
    targetType: "pr",
    targetId: args.prId,
    metadata: { workflowId: wf.id, runId },
  });
  return {
    ok: !!runId,
    body: `${marker}\n\n**Tests dispatched** — workflow \`${wf.name}\` queued${runId ? ` (run id \`${runId.slice(0, 8)}\`).` : "."}`,
  };
}

async function runStage(
  args: ExecuteSlashArgs
): Promise<Omit<SlashResult, "marker">> {
  const marker = slashCmdMarker("stage");
  try {
    // Lazy import to avoid circular dependency at module load time
    const { triggerStage } = await import("./pr-stage");
    // Fire-and-forget — the stage pipeline posts its own reply comment
    // with the preview URL once live. We immediately return a "queued"
    // acknowledgement so the user knows the command was accepted.
    triggerStage(args.prId, args.userId).catch(() => {});
    return {
      ok: true,
      body: `${marker}\n\n**Preview queued** — detecting framework and deploying. A follow-up comment will appear with the live URL in a few seconds.`,
    };
  } catch (err) {
    return {
      ok: false,
      body: `${marker}\n\n\`/stage\` failed to queue: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseMergeStrategy(raw: string | undefined): "squash" | "rebase" | "merge" {
  const candidate = (raw || "").toLowerCase().trim();
  if (candidate === "squash" || candidate === "rebase" || candidate === "merge") {
    return candidate;
  }
  // Default — match the existing UI button which performs a clean merge.
  return "merge";
}

async function loadPr(prId: string): Promise<PullRequest | null> {
  try {
    const [pr] = await db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.id, prId))
      .limit(1);
    return pr ?? null;
  } catch {
    return null;
  }
}

async function loadRepoOwner(
  repositoryId: string
): Promise<{ ownerName: string; repoName: string; isPublic: boolean } | null> {
  try {
    const [row] = await db
      .select({
        repoName: repositories.name,
        isPrivate: repositories.isPrivate,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!row) return null;
    return {
      ownerName: row.ownerName,
      repoName: row.repoName,
      isPublic: !row.isPrivate,
    };
  } catch {
    return null;
  }
}

async function usernameFor(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.username ?? null;
  } catch {
    return null;
  }
}

async function usernamesExist(candidates: string[]): Promise<Set<string>> {
  const lowered = new Set<string>();
  if (candidates.length === 0) return lowered;
  try {
    const rows = await db
      .select({ username: users.username })
      .from(users);
    const known = new Set(rows.map((r) => r.username.toLowerCase()));
    for (const c of candidates) {
      if (known.has(c.toLowerCase())) lowered.add(c.toLowerCase());
    }
  } catch {
    /* swallow — empty set means we report all as unknown */
  }
  return lowered;
}

async function findTestWorkflow(
  repositoryId: string
): Promise<{ id: string; name: string; path: string } | null> {
  try {
    const rows = await db
      .select({ id: workflows.id, name: workflows.name, path: workflows.path })
      .from(workflows)
      .where(eq(workflows.repositoryId, repositoryId));
    // Prefer test.yml > test.yaml > ci.yml > ci.yaml. Repo path is
    // `.gluecron/workflows/<file>`.
    const order = ["test.yml", "test.yaml", "ci.yml", "ci.yaml"];
    for (const file of order) {
      const hit = rows.find((r) => r.path.endsWith(`/${file}`) || r.path === file);
      if (hit) return hit;
    }
    return null;
  } catch {
    return null;
  }
}

async function defaultGit(
  cmd: string[],
  opts: { cwd: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...cmd], {
    cwd: opts.cwd,
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

async function diffBetweenBranches(
  owner: string,
  repo: string,
  baseBranch: string,
  headBranch: string,
  gitOverride?: ExecuteSlashDeps["git"]
): Promise<string> {
  const cwd = getRepoPath(owner, repo);
  const git = gitOverride ?? defaultGit;
  try {
    const r = await git(["diff", `${baseBranch}...${headBranch}`, "--"], { cwd });
    return r.stdout;
  } catch {
    return "";
  }
}

interface ExplainClaudeArgs {
  title: string;
  body: string;
  diff: string;
  client?: Pick<Anthropic, "messages">;
}

async function callExplainClaude(args: ExplainClaudeArgs): Promise<string> {
  const client = args.client ?? getAnthropic();
  const prompt = `You are explaining a pull request to a reviewer doing a cold read.

Write a concise Markdown explanation (under ~250 words) covering:

1. **What this PR changes** — one or two sentences.
2. **Why** — inferred from the title/body.
3. **Risk areas** — the most important spots a reviewer should focus on.

Do not include a top-level H1. Use short paragraphs and bullet points. Stay factual; if the diff is empty say so.

PR title: ${args.title}

PR body:
${args.body || "(empty)"}

Diff (truncated):
\`\`\`diff
${args.diff || "(empty)"}
\`\`\`
`;
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractText(message as Anthropic.Messages.Message).trim();
    return text || "_Claude returned no explanation._";
  } catch (err) {
    return `_Claude call failed: ${err instanceof Error ? err.message : String(err)}._`;
  }
}

/**
 * Look at a stored comment body and, if it carries our slash-command
 * marker, return the bare command name. Used by the renderer to swap
 * the comment for a pill. Falls back to `null` for normal comments.
 */
export function detectSlashCmdComment(body: string): SlashCommand | null {
  if (!body) return null;
  const match = body.match(/^<!--\s*cmd:([a-z-]+)\s*-->/i);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  if (!(SLASH_COMMANDS as readonly string[]).includes(cmd)) return null;
  return cmd as SlashCommand;
}

/**
 * Strip the marker line from a stored slash-command comment so the
 * renderer can show just the human-friendly body inside the pill.
 */
export function stripSlashCmdMarker(body: string): string {
  return (body || "").replace(/^<!--\s*cmd:[a-z-]+\s*-->\s*/i, "").trimStart();
}

/** Test-only handles. */
export const __test = {
  callExplainClaude,
  parseMergeStrategy,
  findTestWorkflow,
};
