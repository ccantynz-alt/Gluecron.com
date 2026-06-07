/**
 * Spec-to-PR (experimental).
 *
 * Pipeline:
 *   1. Validate prerequisites: API key present, repo exists, user can be
 *      resolved for author metadata.
 *   2. `buildSpecContext` — read the bare repo, score paths against the spec,
 *      collect a bounded file list + top-N relevant file contents.
 *   3. `generateSpecEdits` — send that context to Claude; parse + validate the
 *      proposed edits (forbidden paths filtered defence-in-depth).
 *   4. `applyEditsToNewBranch` — write the edits to a fresh branch via git
 *      plumbing (bare repo, no working tree).
 *   5. Insert a draft `pullRequests` row pointing base→head.
 *
 * Every failure mode is funnelled through `{ok:false, error}`. We never throw
 * — the route (`src/routes/specs.tsx`) renders the error inline.
 */
import { join } from "path";
import { and, eq, like } from "drizzle-orm";
import { db } from "../db";
import {
  repositories,
  users,
  pullRequests,
  labels,
  prComments,
} from "../db/schema";
import { buildSpecContext } from "./spec-context";
import { generateSpecEdits } from "./spec-ai";
import { applyEditsToNewBranch } from "./spec-git";
import {
  getBlob,
  createOrUpdateFileOnBranch,
  getTreeRecursive,
} from "../git/repository";
import { assertAiQuota, AiQuotaExceededError } from "./billing";

export type SpecPRArgs = {
  repoId: string;
  spec: string;
  baseRef?: string;
  userId: string;
};

export type SpecPRResult =
  | {
      ok: true;
      prNumber: number;
      branchName: string;
      filesChanged: string[];
    }
  | { ok: false; error: string };

/** Derive a filesystem-safe branch suffix from the user's spec. */
function slugify(spec: string): string {
  const base = spec
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "change";
}

function randomSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 6);
}

export async function createSpecPR(args: SpecPRArgs): Promise<SpecPRResult> {
  // 1. API key gate. Without it the AI step would fail anyway — bail before
  //    any DB or disk work.
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY required for spec-to-PR" };
  }

  // 1b. AI quota hard gate. Returns a user-visible error when the budget is
  //     exhausted so the UI can surface an upgrade prompt.
  try {
    await assertAiQuota(args.userId);
  } catch (err) {
    if (err instanceof AiQuotaExceededError) {
      return {
        ok: false,
        error:
          "Monthly AI token budget reached. Upgrade at /settings/billing to continue using spec-to-PR.",
      };
    }
    // Unexpected billing error — fail open so a DB glitch doesn't block users.
    console.warn("[spec-to-pr] assertAiQuota failed unexpectedly:", err);
  }

  const spec = typeof args.spec === "string" ? args.spec.trim() : "";
  if (!spec) return { ok: false, error: "spec is empty" };

  // 2. Resolve repo + owner so we can build the on-disk path.
  let repoRow: {
    id: string;
    name: string;
    defaultBranch: string | null;
    ownerName: string | null;
  } | undefined;
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerName: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, args.repoId))
      .limit(1);
    repoRow = rows[0];
  } catch {
    return { ok: false, error: "db lookup failed" };
  }
  if (!repoRow || !repoRow.ownerName) {
    return { ok: false, error: "repo not found" };
  }

  // 3. Resolve the author — needed for the commit-tree call and the PR row.
  let authorRow: { username: string; email: string | null } | undefined;
  try {
    const rows = await db
      .select({ username: users.username, email: users.email })
      .from(users)
      .where(eq(users.id, args.userId))
      .limit(1);
    authorRow = rows[0];
  } catch {
    return { ok: false, error: "db lookup failed" };
  }
  if (!authorRow) return { ok: false, error: "author not found" };

  const base = process.env.GIT_REPOS_PATH || "./repos";
  const repoDiskPath = join(base, repoRow.ownerName, `${repoRow.name}.git`);
  const defaultBranch = repoRow.defaultBranch || "main";
  const baseRef = (args.baseRef && args.baseRef.trim()) || defaultBranch;

  // 4. Build context.
  const ctx = await buildSpecContext({
    repoDiskPath,
    spec,
    defaultBranch: baseRef,
  });
  if (!ctx.ok) {
    return { ok: false, error: `context build failed: ${ctx.error}` };
  }

  // 5. Ask Claude for edits.
  const ai = await generateSpecEdits({
    spec,
    fileList: ctx.context.fileList,
    relevantFiles: ctx.context.relevantFiles,
    defaultBranch: ctx.context.defaultBranch,
  });
  if (!ai.ok) return { ok: false, error: `AI failed: ${ai.error}` };
  if (ai.edits.length === 0) {
    return { ok: false, error: "AI proposed no changes" };
  }

  // 6. Apply edits to a fresh branch via git plumbing.
  const branchName = `spec/${slugify(spec)}-${randomSuffix()}`;
  const commitSubject = ai.summary || `spec: ${spec.slice(0, 60)}`;
  const commitBody = `Generated by spec-to-PR.\n\nSpec:\n${spec}`;
  const commitMessage = `${commitSubject}\n\n${commitBody}`;

  const authorEmail =
    authorRow.email || `${authorRow.username}@users.noreply.gluecron`;
  const applied = await applyEditsToNewBranch({
    repoDiskPath,
    baseRef,
    edits: ai.edits,
    branchName,
    commitMessage,
    authorName: authorRow.username,
    authorEmail,
  });
  if (!applied.ok) return { ok: false, error: `git apply failed: ${applied.error}` };

  // 7. Insert the draft PR row.
  try {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: repoRow.id,
        authorId: args.userId,
        title: commitSubject.slice(0, 200),
        body: `${commitBody}\n\nFiles changed:\n${applied.filesChanged
          .map((p) => `- ${p}`)
          .join("\n")}`,
        baseBranch: baseRef,
        headBranch: applied.branchName,
        isDraft: true,
      })
      .returning();
    const number = pr?.number;
    if (typeof number !== "number") {
      return { ok: false, error: "PR insert returned no number" };
    }
    return {
      ok: true,
      prNumber: number,
      branchName: applied.branchName,
      filesChanged: applied.filesChanged,
    };
  } catch (err) {
    return {
      ok: false,
      error: `PR insert failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// runSpecToPr — autopilot-driven spec-file flow.
//
// Reads a spec file living at `.gluecron/specs/<name>.md` inside the repo,
// parses its YAML-style front-matter, and (when `status: ready`) generates a
// PR off the same context/AI/git pipeline as `createSpecPR`. After the PR is
// opened the spec file is rewritten with `status: building`. After successful
// completion the file is rewritten to `status: shipped` (with the new PR
// number recorded). Failures rewrite to `status: failed` with the error.
//
// Distinct from `createSpecPR` in two ways:
//   1. Spec text lives in the repo, not a route body — supplied via `specPath`.
//   2. PRs are tagged with the `ai:spec-implementation` label (created on
//      demand on the repo for parity with the existing `ai:proposed-patch`
//      label flow in `ai-patch-generator.ts`).
// ---------------------------------------------------------------------------

/** Label name surfaced (and ensured present) for spec-driven PRs. */
export const AI_SPEC_LABEL = "ai:spec-implementation";

/** Marker baked into the PR body so the autopilot loop can detect "already implemented". */
export const AI_SPEC_PR_MARKER = "<!-- gluecron:ai-spec-implementation:v1 -->";

export type SpecStatus = "draft" | "ready" | "building" | "shipped" | "failed";

export interface ParsedSpec {
  frontMatter: Record<string, string>;
  body: string;
  raw: string;
  /** True when the document opened with a `---` fence. */
  hasFrontMatter: boolean;
}

export interface RunSpecToPrArgs {
  repositoryId: string;
  /** Path to the spec markdown inside the repo, e.g. `.gluecron/specs/foo.md`. */
  specPath: string;
  /** Optional base sha override. Falls back to repo default branch HEAD. */
  baseSha?: string;
}

export type RunSpecToPrResult =
  | { ok: true; branch: string; prNumber: number; status: SpecStatus }
  | { ok: false; error: string; status?: SpecStatus };

/**
 * Parse YAML-style front-matter. Intentionally tiny — just `key: value` pairs.
 * Anything we can't parse is treated as an absent front-matter block.
 */
export function parseFrontMatter(raw: string): ParsedSpec {
  if (typeof raw !== "string" || !raw) {
    return { frontMatter: {}, body: "", raw: raw || "", hasFrontMatter: false };
  }
  const fenced = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fenced) {
    return { frontMatter: {}, body: raw, raw, hasFrontMatter: false };
  }
  const block = fenced[1];
  const body = fenced[2] || "";
  const fm: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip matched quotes around the value.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  return { frontMatter: fm, body, raw, hasFrontMatter: true };
}

/**
 * Serialise the spec back to a markdown document with the supplied
 * front-matter map. Keys are emitted in the order returned by `Object.keys`
 * which preserves insertion order in JS.
 */
export function serialiseSpec(
  frontMatter: Record<string, string>,
  body: string
): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(frontMatter)) {
    const val = String(v ?? "");
    // Quote values that contain `:` or leading/trailing whitespace so the
    // round-trip stays parseable.
    const needsQuote = /[:#]/.test(val) || /^\s|\s$/.test(val);
    lines.push(`${k}: ${needsQuote ? JSON.stringify(val) : val}`);
  }
  lines.push("---");
  // Always end the front-matter with a single newline before the body, and
  // preserve the body verbatim (callers pass body that already starts with
  // a newline or content).
  const trimmedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `${lines.join("\n")}\n${trimmedBody}`;
}

/**
 * Read a spec file from the repo via git plumbing. Returns null when the
 * file is missing or binary. Failures are funnelled into `ok:false`.
 */
async function readSpecFile(
  ownerName: string,
  repoName: string,
  ref: string,
  specPath: string
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  try {
    const blob = await getBlob(ownerName, repoName, ref, specPath);
    if (!blob) return { ok: false, error: "spec file not found" };
    if (blob.isBinary) return { ok: false, error: "spec file is binary" };
    return { ok: true, content: blob.content };
  } catch (err) {
    return {
      ok: false,
      error: `getBlob failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Rewrite the spec file on the repo's default branch with an updated
 * front-matter status. Best-effort — failures are logged but do not block
 * the PR from being opened.
 */
async function updateSpecStatus(args: {
  ownerName: string;
  repoName: string;
  branch: string;
  specPath: string;
  current: ParsedSpec;
  status: SpecStatus;
  extra?: Record<string, string>;
  authorName: string;
  authorEmail: string;
}): Promise<{ ok: true; commitSha: string } | { ok: false; error: string }> {
  const fm: Record<string, string> = { ...args.current.frontMatter };
  fm.status = args.status;
  if (args.extra) {
    for (const [k, v] of Object.entries(args.extra)) fm[k] = v;
  }
  const newRaw = args.current.hasFrontMatter
    ? serialiseSpec(fm, args.current.body)
    : serialiseSpec(fm, args.current.raw);

  const res = await createOrUpdateFileOnBranch({
    owner: args.ownerName,
    name: args.repoName,
    branch: args.branch,
    filePath: args.specPath,
    bytes: new TextEncoder().encode(newRaw),
    message: `chore(spec): mark ${args.specPath} as ${args.status}`,
    authorName: args.authorName,
    authorEmail: args.authorEmail,
  });
  if ("error" in res) return { ok: false, error: res.error };
  return { ok: true, commitSha: res.commitSha };
}

/**
 * Ensure the `ai:spec-implementation` label row exists on the repo.
 * Best-effort — failures are swallowed.
 */
async function ensureSpecLabel(repositoryId: string): Promise<void> {
  try {
    await db
      .insert(labels)
      .values({
        repositoryId,
        name: AI_SPEC_LABEL,
        color: "#36c5d6",
        description:
          "PR auto-opened by spec-to-PR autopilot from a .gluecron/specs/*.md file",
      })
      .onConflictDoNothing?.();
  } catch {
    /* ignore — label is a UX nicety, not load-bearing */
  }
}

/**
 * Derive a slug from the spec path's basename. `.gluecron/specs/foo-bar.md`
 * → `foo-bar`.
 */
export function specBasename(specPath: string): string {
  const last = specPath.split("/").pop() || specPath;
  const noExt = last.replace(/\.md$/i, "");
  return noExt.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "spec";
}

/**
 * Driver entry point used by both the autopilot loop and direct callers.
 * Returns the new branch/PR on success, or a structured error on failure.
 * Never throws.
 */
export async function runSpecToPr(
  args: RunSpecToPrArgs
): Promise<RunSpecToPrResult> {
  // 1. Hard gates. We short-circuit fast when the platform is configured
  //    to skip AI work, so callers (autopilot) don't fan out unnecessary
  //    DB / git reads.
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return { ok: false, error: "AUTOPILOT_DISABLED" };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY required for spec-to-PR" };
  }
  if (!args.specPath || !args.specPath.endsWith(".md")) {
    return { ok: false, error: "specPath must be a .md file" };
  }
  if (
    args.specPath.includes("..") ||
    args.specPath.startsWith("/") ||
    !args.specPath.startsWith(".gluecron/specs/")
  ) {
    return {
      ok: false,
      error: "specPath must live under .gluecron/specs/",
    };
  }

  // 2. Resolve repo + owner.
  let repoRow:
    | {
        id: string;
        name: string;
        defaultBranch: string;
        ownerId: string;
        ownerName: string | null;
      }
    | undefined;
  try {
    const rows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerId: repositories.ownerId,
        ownerName: users.username,
      })
      .from(repositories)
      .leftJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.id, args.repositoryId))
      .limit(1);
    repoRow = rows[0];
  } catch {
    return { ok: false, error: "db lookup failed" };
  }
  if (!repoRow || !repoRow.ownerName) {
    return { ok: false, error: "repo not found" };
  }

  // 2b. AI quota hard gate — check against the repo owner's budget.
  //     runSpecToPr is called from the autopilot so we skip silently (return
  //     ok:false) rather than throwing; the autopilot loop logs the error.
  try {
    await assertAiQuota(repoRow.ownerId);
  } catch (err) {
    if (err instanceof AiQuotaExceededError) {
      return {
        ok: false,
        error:
          "Monthly AI token budget reached. Upgrade at /settings/billing to continue using spec-to-PR.",
      };
    }
    console.warn("[spec-to-pr] assertAiQuota failed unexpectedly:", err);
  }

  const ownerName = repoRow.ownerName;
  const repoName = repoRow.name;
  const defaultBranch = repoRow.defaultBranch || "main";
  const baseRef = args.baseSha && args.baseSha.trim() ? args.baseSha : defaultBranch;

  // 3. Read the spec file at the base ref.
  const specRead = await readSpecFile(ownerName, repoName, baseRef, args.specPath);
  if (!specRead.ok) return { ok: false, error: specRead.error };
  const parsed = parseFrontMatter(specRead.content);

  const status = (parsed.frontMatter.status || "draft").toLowerCase() as SpecStatus;
  if (status !== "ready") {
    return {
      ok: false,
      error: `spec status is ${status}, not ready`,
      status,
    };
  }

  const title =
    (parsed.frontMatter.title && parsed.frontMatter.title.trim()) ||
    specBasename(args.specPath);
  const specBody = parsed.body.trim() || parsed.raw.trim();
  if (!specBody) return { ok: false, error: "spec body is empty" };

  // 4. Idempotency: skip if a PR already exists referencing this spec path.
  try {
    const existing = await db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repoRow.id),
          like(pullRequests.body, `%${args.specPath}%`)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      return {
        ok: false,
        error: `PR already exists for this spec (#${existing[0].number})`,
        status: "building",
      };
    }
  } catch {
    // Non-fatal — if the dedup query failed, fall through.
  }

  // 5. Build context + ask Claude for edits. Reuse the existing helpers so
  //    we don't fork the prompt surface.
  const base = process.env.GIT_REPOS_PATH || "./repos";
  const repoDiskPath = join(base, ownerName, `${repoName}.git`);

  const ctx = await buildSpecContext({
    repoDiskPath,
    spec: specBody,
    defaultBranch: baseRef,
  });
  if (!ctx.ok) {
    return { ok: false, error: `context build failed: ${ctx.error}` };
  }

  // Augment the context's file list with a recursive listing so Claude
  // sees the whole tree (capped). This makes spec-driven runs more
  // robust against monorepo layouts than the default 500-line list.
  try {
    const recursive = await getTreeRecursive(ownerName, repoName, baseRef, 1500);
    if (recursive && recursive.tree.length > 0) {
      const blobPaths = recursive.tree
        .filter((e) => e.type === "blob")
        .map((e) => e.path);
      // Replace the file list with the recursive view, but keep it bounded.
      ctx.context.fileList = blobPaths.slice(0, 500);
    }
  } catch {
    /* keep the original list — recursive scan is a nice-to-have */
  }

  const ai = await generateSpecEdits({
    spec: specBody,
    fileList: ctx.context.fileList,
    relevantFiles: ctx.context.relevantFiles,
    defaultBranch: ctx.context.defaultBranch,
  });
  if (!ai.ok) return { ok: false, error: `AI failed: ${ai.error}` };
  if (ai.edits.length === 0) {
    return { ok: false, error: "AI proposed no changes" };
  }

  // 6. Apply edits to a new branch.
  const branchName = `ai-spec/${specBasename(args.specPath)}-${Date.now()}`;
  const authorName = "Gluecron Autopilot";
  const authorEmail = "autopilot@gluecron.com";
  const commitSubject = ai.summary || `spec: ${title}`.slice(0, 80);
  const commitBody = `Generated by spec-to-PR autopilot.\n\nSpec: ${args.specPath}\n\n${specBody}`;
  const commitMessage = `${commitSubject}\n\n${commitBody}`;

  const applied = await applyEditsToNewBranch({
    repoDiskPath,
    baseRef,
    edits: ai.edits,
    branchName,
    commitMessage,
    authorName,
    authorEmail,
  });
  if (!applied.ok) {
    return { ok: false, error: `git apply failed: ${applied.error}` };
  }

  // 7. Ensure the spec-implementation label exists on the repo.
  await ensureSpecLabel(repoRow.id);

  // 8. Insert the PR row.
  let prNumber: number | null = null;
  let prId: string | null = null;
  try {
    const quotedSpec = specBody
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const filesList = applied.filesChanged.map((p) => `- \`${p}\``).join("\n");
    const body = [
      AI_SPEC_PR_MARKER,
      `## Spec-to-PR — \`${args.specPath}\``,
      "",
      "### Spec",
      quotedSpec,
      "",
      "### Summary of changes",
      ai.summary || "_(no summary provided)_",
      "",
      "### Files changed",
      filesList || "_(none)_",
      "",
      "---",
      "",
      `Spec path: \`${args.specPath}\``,
      `Label: \`${AI_SPEC_LABEL}\``,
      "",
      "_Auto-generated by Gluecron spec-to-PR autopilot. Review every line before merging._",
    ].join("\n");

    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: repoRow.id,
        authorId: repoRow.ownerId,
        title: `[spec] ${title}`.slice(0, 200),
        body,
        baseBranch: defaultBranch,
        headBranch: applied.branchName,
        isDraft: true,
      })
      .returning({ number: pullRequests.number, id: pullRequests.id });
    if (pr) {
      prNumber = pr.number;
      prId = pr.id;
    }
  } catch (err) {
    return {
      ok: false,
      error: `PR insert failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (prNumber == null || prId == null) {
    return { ok: false, error: "PR insert returned no row" };
  }

  // 9. Drop a marker comment surfacing the label (mirrors ai-patch-generator).
  try {
    await db.insert(prComments).values({
      pullRequestId: prId,
      authorId: repoRow.ownerId,
      isAiReview: true,
      body: `${AI_SPEC_PR_MARKER}\nApplied label: \`${AI_SPEC_LABEL}\``,
    });
  } catch {
    /* best-effort */
  }

  // 10. Rewrite the spec file to `status: building` so the autopilot loop
  //     doesn't re-pick it on the next tick. Best-effort.
  try {
    await updateSpecStatus({
      ownerName,
      repoName,
      branch: defaultBranch,
      specPath: args.specPath,
      current: parsed,
      status: "building",
      extra: { pr: String(prNumber) },
      authorName,
      authorEmail,
    });
  } catch {
    /* status update is non-fatal */
  }

  return {
    ok: true,
    branch: applied.branchName,
    prNumber,
    status: "building",
  };
}

/**
 * Mark a spec file as `shipped` once its PR is merged. Called from the PR
 * merge webhook / merge handler in a follow-up wiring (kept here so the
 * autopilot loop and the merge path use the same writer).
 */
export async function markSpecShipped(args: {
  ownerName: string;
  repoName: string;
  defaultBranch: string;
  specPath: string;
  prNumber: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const read = await readSpecFile(
    args.ownerName,
    args.repoName,
    args.defaultBranch,
    args.specPath
  );
  if (!read.ok) return { ok: false, error: read.error };
  const parsed = parseFrontMatter(read.content);
  const res = await updateSpecStatus({
    ownerName: args.ownerName,
    repoName: args.repoName,
    branch: args.defaultBranch,
    specPath: args.specPath,
    current: parsed,
    status: "shipped",
    extra: { pr: String(args.prNumber) },
    authorName: "Gluecron Autopilot",
    authorEmail: "autopilot@gluecron.com",
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}

/** Test-only exports of internal helpers. */
export const __specTest = {
  parseFrontMatter,
  serialiseSpec,
  specBasename,
  readSpecFile,
  updateSpecStatus,
  ensureSpecLabel,
};
