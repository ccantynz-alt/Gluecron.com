/**
 * AI patch generator — when GateTest (or any scanner) flags a finding,
 * ask Claude to propose a concrete fix, push it as a new branch, and
 * open a follow-up PR tagged `ai:proposed-patch`.
 *
 * Pipeline per finding:
 *   1. Read the affected file at `baseSha` via `getBlob`.
 *   2. Ask Claude for `{ explanation, patches: [{ path, new_content }] }`.
 *   3. For each patch: `createOrUpdateFileOnBranch` onto a fresh branch
 *      named `ai-patch/<finding-sha>-<timestamp>`.
 *   4. Insert a `pullRequests` row pointing at the new branch.
 *   5. Tag the PR via a comment marker + create-or-fetch the
 *      `ai:proposed-patch` label row (no PR↔label table exists; the
 *      label is created on the repo for parity with issue-side use, and
 *      the tag is surfaced in the PR body — same pattern pr-triage uses
 *      for suggested labels).
 *
 * The Claude call is injectable so unit tests can pin behaviour without
 * an Anthropic key. Production callers leave `opts.client` undefined and
 * we wire up `ai-client.getAnthropic()` lazily.
 *
 * SAFETY:
 *   - Caller MUST ensure ANTHROPIC_API_KEY is set OR pass a `client`.
 *     `generatePatchForGateTestFinding` short-circuits to `null` when
 *     neither is available so it's safe to fire from a webhook handler.
 *   - Every step is wrapped in try/catch — the function never throws.
 *   - If Claude returns zero patches we do NOT open an empty PR.
 *   - Each generated PR is audited under action `ai.patch.opened` so
 *     operators can review and disable the feature if it misbehaves.
 */

import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  labels,
  pullRequests,
  prComments,
  repositories,
  users,
} from "../db/schema";
import {
  createOrUpdateFileOnBranch,
  getBlob,
  refExists,
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

/**
 * Marker we embed in the auto-opened PR body. Mirrors the convention
 * used by `ai-review.ts` (`AI_REVIEW_MARKER`) so other tooling can
 * detect AI-authored patch PRs without a schema change.
 */
export const AI_PATCH_MARKER = "<!-- gluecron-ai-patch:proposed -->";

/** Label name we surface (and create on the repo) for these PRs. */
export const AI_PATCH_LABEL = "ai:proposed-patch";

/**
 * Severity ladder used by the gate.ts integration to decide whether a
 * finding is worth opening a patch PR for. Exported so callers can use
 * the same constants when filtering their own finding sets.
 */
export const PATCH_SEVERITY_THRESHOLD = ["medium", "high", "critical"] as const;
export type PatchSeverity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

export function severityAtOrAboveMedium(s: string | undefined | null): boolean {
  if (!s) return false;
  return (PATCH_SEVERITY_THRESHOLD as readonly string[]).includes(
    String(s).toLowerCase()
  );
}

/**
 * Shape we accept from a GateTest result. Kept intentionally loose so
 * we can plug in scanner outputs that vary in field names (some send
 * `file`, others `path`; some `description`, others `message`).
 */
export interface GateTestFinding {
  /** Stable id from the scanner if it has one; otherwise we derive one. */
  id?: string;
  ruleId?: string;
  /** File path inside the repo. Required — we can't fix what we can't find. */
  path?: string;
  file?: string;
  /** Line number (1-based) when known. */
  line?: number;
  severity?: PatchSeverity | string;
  /** Short human-readable label, e.g. "Hardcoded credential". */
  title?: string;
  /** Long description / remediation hint. */
  description?: string;
  message?: string;
}

export interface GeneratePatchOptions {
  repositoryId: string;
  /** Commit sha the findings were reported against. Used as the base. */
  baseSha: string;
  findings: GateTestFinding[];
  /**
   * Optional Anthropic client override — primarily for tests. When
   * omitted, production code lazily constructs one via `ai-client`.
   */
  client?: Pick<Anthropic, "messages">;
  /**
   * Optional URL/identifier of the original GateTest report so it can
   * be cited in the PR body. Free-form text.
   */
  reportUrl?: string | null;
  /**
   * Override branch name (tests). Production code derives the name
   * from the finding id + a timestamp.
   */
  branchOverride?: string;
}

export interface GeneratePatchResult {
  branch: string;
  prNumber: number;
}

interface ClaudePatch {
  path: string;
  new_content: string;
}

interface ClaudePatchResponse {
  explanation?: string;
  patches?: ClaudePatch[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findingPath(f: GateTestFinding): string | null {
  const p = f.path || f.file || "";
  return p.trim() ? p.trim() : null;
}

function findingDescription(f: GateTestFinding): string {
  return (
    f.description ||
    f.message ||
    f.title ||
    f.ruleId ||
    "(no description provided)"
  );
}

/**
 * Derive a stable short identifier for a finding. If the scanner sent
 * its own `id` we use that; otherwise SHA-1 of the salient fields,
 * truncated for branch-name safety.
 */
export function findingShortId(f: GateTestFinding): string {
  if (f.id && /^[A-Za-z0-9._-]+$/.test(f.id)) return f.id.slice(0, 24);
  const seed = [
    f.ruleId || "",
    findingPath(f) || "",
    String(f.line ?? ""),
    f.title || "",
    findingDescription(f),
  ].join("|");
  return createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

/**
 * Resolve `{ owner, name }` for a repository row. Returns null if the
 * repo (or its owner) has been deleted between gate run and patch
 * generation — caller bails gracefully.
 */
async function resolveOwnerName(
  repositoryId: string
): Promise<{ owner: string; name: string; ownerId: string } | null> {
  try {
    const [row] = await db
      .select({
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
        name: repositories.name,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!row) return null;
    return {
      owner: row.ownerUsername,
      name: row.name,
      ownerId: row.ownerId,
    };
  } catch (err) {
    console.error(
      "[ai-patch] resolveOwnerName failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Ensure the `ai:proposed-patch` label row exists on the repo so
 * downstream tools can attach it. Best-effort — failures are logged but
 * don't block PR creation.
 */
async function ensurePatchLabel(repositoryId: string): Promise<void> {
  try {
    await db
      .insert(labels)
      .values({
        repositoryId,
        name: AI_PATCH_LABEL,
        color: "#bc8cff",
        description:
          "Patch proposed automatically by GlueCron AI from a GateTest finding",
      })
      .onConflictDoNothing?.();
  } catch (err) {
    // Was a silent .catch(() => {}) — log so DB schema drift surfaces.
    console.warn(
      "[ai-patch] ensurePatchLabel failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Build the prompt that asks Claude to propose a single-file fix.
 * Kept in a pure function so the shape can be unit-tested.
 */
export function buildPatchPrompt(
  finding: GateTestFinding,
  filePath: string,
  fileContent: string
): string {
  const desc = findingDescription(finding);
  const line = finding.line ? ` (line ${finding.line})` : "";
  return [
    "A security/quality scanner has flagged a finding in this file.",
    "Propose a minimal, targeted fix.",
    "",
    `**File:** \`${filePath}\`${line}`,
    `**Severity:** ${finding.severity || "unspecified"}`,
    `**Rule:** ${finding.ruleId || finding.title || "(unnamed)"}`,
    `**Description:** ${desc}`,
    "",
    "Current file contents:",
    "```",
    fileContent,
    "```",
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "explanation": "1-3 sentence summary of what was wrong and what you changed",',
    '  "patches": [',
    '    { "path": "same/path/as/above", "new_content": "FULL replacement file contents" }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Return [] (empty patches) if the finding is a false positive or you cannot fix it safely.",
    "- new_content MUST be the entire file, not a diff.",
    "- Do not invent new files — only touch files you've been shown.",
    "- Preserve existing formatting / indentation / trailing newlines.",
  ].join("\n");
}

/**
 * Ask Claude for a patch. Returns parsed `{ explanation, patches }` or
 * null on any failure (network, parse, missing key).
 */
async function askClaudeForPatch(
  client: Pick<Anthropic, "messages">,
  finding: GateTestFinding,
  filePath: string,
  fileContent: string
): Promise<ClaudePatchResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 4096,
      messages: [
        { role: "user", content: buildPatchPrompt(finding, filePath, fileContent) },
      ],
    });
    const text = extractText(message);
    const parsed = parseJsonResponse<ClaudePatchResponse>(text);
    if (!parsed) return null;
    return parsed;
  } catch (err) {
    console.warn(
      "[ai-patch] Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Build a branch name that is safe for git ref rules and won't collide
 * on rapid back-to-back runs. Caller can supply `branchOverride` for
 * deterministic test output.
 */
export function patchBranchName(
  finding: GateTestFinding,
  override?: string
): string {
  if (override && override.trim()) return override.trim();
  const id = findingShortId(finding);
  const ts = Date.now();
  return `ai-patch/${id}-${ts}`;
}

/**
 * Choose the parent ref a brand-new branch should point at. We prefer
 * `baseSha` (the commit the finding was reported against) so the PR
 * diff is exactly the AI's change, but fall back to the repo default
 * branch ref if for some reason that sha is unreachable.
 */
async function seedBranchFromBase(
  owner: string,
  name: string,
  branch: string,
  baseSha: string
): Promise<boolean> {
  const fullRef = `refs/heads/${branch}`;
  if (await refExists(owner, name, fullRef)) return true;
  return updateRef(owner, name, fullRef, baseSha);
}

/**
 * Render the PR body. Pure helper exported for tests.
 */
export function renderPatchPrBody(args: {
  finding: GateTestFinding;
  filePath: string;
  explanation: string;
  reportUrl?: string | null;
  patchPaths: string[];
}): string {
  const { finding, filePath, explanation, reportUrl, patchPaths } = args;
  const desc = findingDescription(finding);
  const line = finding.line ? `:${finding.line}` : "";
  const files = patchPaths.map((p) => `- \`${p}\``).join("\n");
  const citation = reportUrl
    ? `Original GateTest report: ${reportUrl}`
    : "Original GateTest report: (not provided)";
  return [
    AI_PATCH_MARKER,
    "## Proposed fix",
    "",
    `> **GateTest finding:** ${finding.title || finding.ruleId || "(unnamed)"} — \`${filePath}${line}\``,
    `> ${desc}`,
    "",
    "### What changed",
    explanation || "_(no explanation provided)_",
    "",
    "### Files",
    files || "_(none)_",
    "",
    "---",
    "",
    citation,
    "",
    `Labels: \`${AI_PATCH_LABEL}\``,
    "",
    "_Auto-generated by GlueCron AI. Review before merging — the fix may need refinement._",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a patch PR for the first actionable GateTest finding in
 * `opts.findings`. Returns the new branch + PR number, or `null` if:
 *
 *   - Anthropic isn't configured AND no `client` was injected
 *   - the repository can't be resolved
 *   - no finding had a fixable file
 *   - Claude returned zero patches for every finding it was asked about
 *   - any DB / git step failed (logged + swallowed)
 *
 * Currently opens **one** PR covering the first finding that produced a
 * non-empty patch set. Multi-finding batching is a future enhancement
 * — keeping the surface narrow makes the trust story simpler.
 */
export async function generatePatchForGateTestFinding(
  opts: GeneratePatchOptions
): Promise<GeneratePatchResult | null> {
  if (!opts.findings?.length) return null;

  // Resolve client lazily so tests can inject without an API key.
  let client: Pick<Anthropic, "messages">;
  if (opts.client) {
    client = opts.client;
  } else {
    if (!config.anthropicApiKey) return null;
    try {
      client = getAnthropic();
    } catch {
      return null;
    }
  }

  const repo = await resolveOwnerName(opts.repositoryId);
  if (!repo) return null;

  await ensurePatchLabel(opts.repositoryId);

  // Try each finding in order; stop at the first one that produces a
  // viable patch set. This keeps the volume of AI-opened PRs sane —
  // one finding per gate run.
  for (const finding of opts.findings) {
    const filePath = findingPath(finding);
    if (!filePath) continue;

    let blob;
    try {
      blob = await getBlob(repo.owner, repo.name, opts.baseSha, filePath);
    } catch (err) {
      console.warn(
        `[ai-patch] getBlob failed for ${filePath} at ${opts.baseSha}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }
    if (!blob || blob.isBinary) continue;

    const claudeRes = await askClaudeForPatch(
      client,
      finding,
      filePath,
      blob.content
    );
    if (!claudeRes || !Array.isArray(claudeRes.patches) || claudeRes.patches.length === 0) {
      continue;
    }

    const branch = patchBranchName(finding, opts.branchOverride);
    const seeded = await seedBranchFromBase(
      repo.owner,
      repo.name,
      branch,
      opts.baseSha
    );
    if (!seeded) {
      console.warn(
        `[ai-patch] could not seed branch ${branch} from ${opts.baseSha} for ${repo.owner}/${repo.name}`
      );
      continue;
    }

    const writtenPaths: string[] = [];
    let writeError: string | null = null;
    for (const patch of claudeRes.patches) {
      if (!patch || typeof patch.path !== "string" || typeof patch.new_content !== "string") {
        continue;
      }
      const res = await createOrUpdateFileOnBranch({
        owner: repo.owner,
        name: repo.name,
        branch,
        filePath: patch.path,
        bytes: new TextEncoder().encode(patch.new_content),
        message: `fix(ai-patch): address GateTest finding in ${patch.path}`,
        authorName: "GlueCron AI",
        authorEmail: "ai@gluecron.com",
      });
      if ("error" in res) {
        writeError = res.error;
        break;
      }
      writtenPaths.push(patch.path);
    }

    if (writeError || writtenPaths.length === 0) {
      console.warn(
        `[ai-patch] write failed (${writeError ?? "no patches written"}) on ${repo.owner}/${repo.name}@${branch}`
      );
      continue;
    }

    // Look up the repo's default branch to use as PR base.
    let baseBranch = "main";
    try {
      const [r] = await db
        .select({ defaultBranch: repositories.defaultBranch })
        .from(repositories)
        .where(eq(repositories.id, opts.repositoryId))
        .limit(1);
      if (r?.defaultBranch) baseBranch = r.defaultBranch;
    } catch {
      // keep "main" default
    }

    const body = renderPatchPrBody({
      finding,
      filePath,
      explanation: claudeRes.explanation || "",
      reportUrl: opts.reportUrl,
      patchPaths: writtenPaths,
    });
    const title = `[ai-patch] ${finding.title || finding.ruleId || "GateTest fix"} in ${filePath}`;

    let prNumber: number | null = null;
    try {
      const [pr] = await db
        .insert(pullRequests)
        .values({
          repositoryId: opts.repositoryId,
          authorId: repo.ownerId, // AI commits attributed to repo owner
          title,
          body,
          baseBranch,
          headBranch: branch,
          isDraft: false,
        })
        .returning({ number: pullRequests.number, id: pullRequests.id });
      if (pr) {
        prNumber = pr.number;
        // Drop a marker comment so other tooling (and humans skimming
        // the conversation tab) can spot the label without a join table.
        try {
          await db.insert(prComments).values({
            pullRequestId: pr.id,
            authorId: repo.ownerId,
            isAiReview: true,
            body: `${AI_PATCH_MARKER}\nApplied label: \`${AI_PATCH_LABEL}\``,
          });
        } catch (err) {
          console.warn(
            "[ai-patch] failed to insert label-marker comment:",
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      console.error(
        "[ai-patch] failed to insert pullRequests row:",
        err instanceof Error ? err.message : err
      );
      continue;
    }

    if (prNumber == null) continue;

    await audit({
      userId: null,
      action: "ai.patch.opened",
      repositoryId: opts.repositoryId,
      metadata: {
        branch,
        prNumber,
        filePath,
        baseSha: opts.baseSha,
        findingId: findingShortId(finding),
        severity: finding.severity || "unspecified",
      },
    });

    return { branch, prNumber };
  }

  return null;
}

/**
 * Test-only re-exports of internal helpers so the test suite can pin
 * pure invariants without reaching through `__internal` proxies.
 */
export const __test = {
  findingPath,
  findingDescription,
  resolveOwnerName,
  askClaudeForPatch,
  seedBranchFromBase,
};
