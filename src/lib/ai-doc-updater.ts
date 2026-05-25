/**
 * AI-tracked documentation sections — when a piece of prose in a markdown
 * file claims to describe a source file, this module keeps the two in
 * sync. The flow per push:
 *
 *   1. Scan tracked markdown files for `<!-- gluecron:doc-track src=... -->`
 *      regions (`findTrackedDocs`).
 *   2. For each region, hash the referenced source. If the hash differs
 *      from the `claimed_hash` stored in `doc_tracking`, the section is
 *      stale.
 *   3. `proposeDocUpdate` asks Claude to rewrite the prose to match the
 *      current source, then opens a PR labelled `ai:doc-update` on a
 *      fresh branch (`ai-doc-update/<basename>-<timestamp>`).
 *
 * Reuses the same git plumbing as ai-patch-generator (createOrUpdateFileOnBranch
 * + updateRef) — the patch shape Claude returns is identical, so we keep the
 * "full-file replacement" contract here too.
 *
 * SAFETY:
 *   - Caller MUST ensure ANTHROPIC_API_KEY is set OR pass a `client`.
 *     proposeDocUpdate short-circuits to `null` when neither is available
 *     so it's safe to fire from a post-receive handler.
 *   - Every step is wrapped in try/catch — neither exported function ever
 *     throws.
 *   - On hash match (no drift) we update `last_checked_at` and bail
 *     without touching git or Claude.
 *   - The `last_pr_id` column gates repeat-proposals: if a PR is already
 *     open for the same drift, we skip until it's merged or closed.
 */

import { createHash } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import {
  docTracking,
  labels,
  prComments,
  pullRequests,
  repositories,
  users,
} from "../db/schema";
import {
  createOrUpdateFileOnBranch,
  getBlob,
  getDefaultBranch,
  getTreeRecursive,
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

/** Marker we embed in the auto-opened PR body for downstream tooling. */
export const AI_DOC_UPDATE_MARKER = "<!-- gluecron-ai-doc-update:proposed -->";

/** Label name we surface (and create on the repo) for these PRs. */
export const AI_DOC_UPDATE_LABEL = "ai:doc-update";

/** Opening / closing markers used to bound a tracked region in markdown. */
export const DOC_TRACK_OPEN_RE =
  /<!--\s*gluecron:doc-track\s+src=([^\s>]+?)\s*-->/g;
export const DOC_TRACK_CLOSE = "<!-- /gluecron:doc-track -->";

/** Max bytes of any single doc / source file we'll hand to Claude. */
const MAX_BYTES_FOR_CLAUDE = 64 * 1024;

/**
 * One tracked region inside a markdown file. `marker` is a stable
 * identifier we use as the unique key on `doc_tracking`; we derive it from
 * the source path so multiple regions in the same doc tracking the same
 * source don't collide (we suffix the body hash for disambiguation).
 */
export interface TrackedSection {
  marker: string;
  /** Snippet of prose currently inside the region (between the markers). */
  claim: string;
  /** Source path the region claims to describe. */
  claimedFor: string;
  /** SHA-256 of the source file's current bytes, hex. */
  currentSrcHash: string;
  /** What `doc_tracking.claimed_hash` says — null if never seen before. */
  storedClaimedHash: string | null;
  /** True when storedClaimedHash differs from currentSrcHash. */
  stale: boolean;
}

export interface TrackedDoc {
  /** Path of the markdown file inside the repo. */
  path: string;
  /** Raw contents of the markdown file we parsed. */
  raw: string;
  sections: TrackedSection[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex of a string. Used for both source-file and marker derivation. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Derive the stable marker for a region. We hash `srcPath|claim` so two
 * regions tracking the same source in the same doc can coexist as long
 * as their prose differs. Truncated for index-readability.
 */
export function deriveSectionMarker(srcPath: string, claim: string): string {
  return sha256Hex(`${srcPath}|${claim}`).slice(0, 16);
}

/**
 * Pure parser: extract every `<!-- gluecron:doc-track src=PATH -->...<!-- /gluecron:doc-track -->`
 * region from a markdown blob.
 *
 * Returns sections with `currentSrcHash`/`storedClaimedHash`/`stale` left
 * blank — the caller fills those in after consulting git + the DB.
 */
export function parseTrackedSections(
  raw: string
): Array<{ marker: string; claim: string; claimedFor: string }> {
  if (!raw || typeof raw !== "string") return [];
  const sections: Array<{
    marker: string;
    claim: string;
    claimedFor: string;
  }> = [];

  // Reset the regex's lastIndex since it's `g`-flagged and shared.
  DOC_TRACK_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOC_TRACK_OPEN_RE.exec(raw)) !== null) {
    const srcPath = m[1].trim();
    if (!srcPath) continue;
    const openEnd = m.index + m[0].length;
    const closeIdx = raw.indexOf(DOC_TRACK_CLOSE, openEnd);
    if (closeIdx === -1) continue; // unclosed region — skip
    const inner = raw.slice(openEnd, closeIdx).trim();
    if (!inner) continue;
    sections.push({
      marker: deriveSectionMarker(srcPath, inner),
      claim: inner,
      claimedFor: srcPath,
    });
    // Advance past the close marker so we don't re-match nested cases.
    DOC_TRACK_OPEN_RE.lastIndex = closeIdx + DOC_TRACK_CLOSE.length;
  }

  return sections;
}

/**
 * Resolve `{ owner, name, defaultBranch }` for a repo row. Returns null
 * if missing — caller bails gracefully.
 */
async function resolveRepoMeta(
  repositoryId: string
): Promise<{
  owner: string;
  name: string;
  ownerId: string;
  defaultBranch: string;
} | null> {
  try {
    const [row] = await db
      .select({
        ownerId: repositories.ownerId,
        ownerUsername: users.username,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
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
      defaultBranch: row.defaultBranch || "main",
    };
  } catch (err) {
    console.error(
      "[ai-doc-updater] resolveRepoMeta failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Walk the repo tree for markdown files. We cap the candidate set to
 * keep the per-push cost predictable — only files at most 3 path
 * segments deep + ending in `.md` qualify, biased toward the obvious
 * README locations.
 */
async function listMarkdownFiles(
  owner: string,
  name: string,
  ref: string
): Promise<string[]> {
  try {
    const tree = await getTreeRecursive(owner, name, ref, 50_000);
    if (!tree) return [];
    return tree.tree
      .filter(
        (e) =>
          e.type === "blob" &&
          /\.md$/i.test(e.path) &&
          e.path.split("/").length <= 3
      )
      .map((e) => e.path);
  } catch {
    return [];
  }
}

/**
 * Best-effort: ensure the `ai:doc-update` label row exists on the repo so
 * downstream tools can attach it. Mirrors ai-patch-generator.ensurePatchLabel.
 */
async function ensureDocUpdateLabel(repositoryId: string): Promise<void> {
  try {
    await db
      .insert(labels)
      .values({
        repositoryId,
        name: AI_DOC_UPDATE_LABEL,
        color: "#36c5d6",
        description:
          "Documentation update proposed automatically by GlueCron AI after source drift",
      })
      .onConflictDoNothing?.();
  } catch (err) {
    console.warn(
      "[ai-doc-updater] ensureDocUpdateLabel failed:",
      err instanceof Error ? err.message : err
    );
  }
}

// ---------------------------------------------------------------------------
// findTrackedDocs — discover + drift-detect
// ---------------------------------------------------------------------------

export interface FindTrackedDocsOptions {
  /** Override the default branch ref to scan. Useful in tests. */
  ref?: string;
}

/**
 * Walk the repository at `ref` (defaults to repo default branch), find
 * every markdown file with at least one tracked region, hash the
 * referenced source, and join against `doc_tracking` to decide whether
 * each region is stale.
 *
 * NEVER throws. Returns [] on any failure (missing repo, git error,
 * missing table, etc.).
 */
export async function findTrackedDocs(
  repositoryId: string,
  opts: FindTrackedDocsOptions = {}
): Promise<TrackedDoc[]> {
  const meta = await resolveRepoMeta(repositoryId);
  if (!meta) return [];

  let ref: string | undefined = opts.ref;
  if (!ref) {
    try {
      const resolved = await getDefaultBranch(meta.owner, meta.name);
      ref = resolved || meta.defaultBranch;
    } catch {
      ref = meta.defaultBranch;
    }
  }
  if (!ref) return [];

  const mdPaths = await listMarkdownFiles(meta.owner, meta.name, ref);
  if (!mdPaths.length) return [];

  // Pre-load every stored row for this repo so we can join in-memory.
  let storedRows: Array<{
    docPath: string;
    sectionMarker: string;
    claimedHash: string;
  }> = [];
  try {
    storedRows = await db
      .select({
        docPath: docTracking.docPath,
        sectionMarker: docTracking.sectionMarker,
        claimedHash: docTracking.claimedHash,
      })
      .from(docTracking)
      .where(eq(docTracking.repositoryId, repositoryId));
  } catch {
    storedRows = [];
  }
  const storedByKey = new Map<string, string>();
  for (const row of storedRows) {
    storedByKey.set(`${row.docPath}::${row.sectionMarker}`, row.claimedHash);
  }

  const out: TrackedDoc[] = [];

  for (const docPath of mdPaths) {
    let raw = "";
    try {
      const blob = await getBlob(meta.owner, meta.name, ref, docPath);
      if (!blob || blob.isBinary || !blob.content) continue;
      raw = blob.content;
    } catch {
      continue;
    }
    const parsed = parseTrackedSections(raw);
    if (parsed.length === 0) continue;

    const sections: TrackedSection[] = [];
    // Group source-file reads so we don't re-fetch the same blob N times.
    const srcCache = new Map<string, string | null>();
    for (const p of parsed) {
      let srcContent: string | null = srcCache.has(p.claimedFor)
        ? srcCache.get(p.claimedFor)!
        : null;
      if (!srcCache.has(p.claimedFor)) {
        try {
          const blob = await getBlob(
            meta.owner,
            meta.name,
            ref,
            p.claimedFor
          );
          srcContent = blob && !blob.isBinary ? blob.content : null;
        } catch {
          srcContent = null;
        }
        srcCache.set(p.claimedFor, srcContent);
      }
      if (srcContent == null) {
        // Source file missing — record a synthetic "no-source" hash so we
        // surface the broken pointer in the UI but don't churn PRs.
        const synthetic = "missing:" + p.claimedFor;
        const stored = storedByKey.get(`${docPath}::${p.marker}`) ?? null;
        sections.push({
          marker: p.marker,
          claim: p.claim,
          claimedFor: p.claimedFor,
          currentSrcHash: synthetic,
          storedClaimedHash: stored,
          stale: stored !== null && stored !== synthetic,
        });
        continue;
      }
      const hash = sha256Hex(srcContent);
      const stored = storedByKey.get(`${docPath}::${p.marker}`) ?? null;
      sections.push({
        marker: p.marker,
        claim: p.claim,
        claimedFor: p.claimedFor,
        currentSrcHash: hash,
        storedClaimedHash: stored,
        // If we've never seen this region before (stored == null) we treat
        // it as NOT stale and seed the row on the next push. That avoids
        // an avalanche of "drift" PRs the first time a repo opts in.
        stale: stored !== null && stored !== hash,
      });
    }

    out.push({ path: docPath, raw, sections });
  }

  return out;
}

/**
 * UPSERT every section we just observed back into `doc_tracking` so the
 * next push has an up-to-date baseline. Called after a successful
 * proposeDocUpdate so we don't propose the same drift twice. Best-effort.
 */
export async function persistObservedSections(
  repositoryId: string,
  doc: TrackedDoc
): Promise<void> {
  for (const s of doc.sections) {
    try {
      await db
        .insert(docTracking)
        .values({
          repositoryId,
          docPath: doc.path,
          sectionMarker: s.marker,
          srcPath: s.claimedFor,
          claimedHash: s.currentSrcHash,
        })
        .onConflictDoUpdate({
          target: [
            docTracking.repositoryId,
            docTracking.docPath,
            docTracking.sectionMarker,
          ],
          set: {
            claimedHash: s.currentSrcHash,
            srcPath: s.claimedFor,
            lastCheckedAt: new Date(),
          },
        });
    } catch (err) {
      console.warn(
        `[ai-doc-updater] persist failed for ${doc.path}::${s.marker}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}

// ---------------------------------------------------------------------------
// proposeDocUpdate — ask Claude to rewrite, open a PR
// ---------------------------------------------------------------------------

export interface ProposeDocUpdateOptions {
  repositoryId: string;
  /** Path of the markdown file. */
  path: string;
  /** Stale sections from `findTrackedDocs`. */
  sections: TrackedSection[];
  /**
   * Optional Anthropic client override — primarily for tests. When
   * omitted, production code lazily constructs one via `ai-client`.
   */
  client?: Pick<Anthropic, "messages">;
  /**
   * Override branch name (tests). Production code derives the name
   * from the doc basename + a timestamp.
   */
  branchOverride?: string;
}

export interface ProposeDocUpdateResult {
  branch: string;
  prNumber: number;
  updatedSections: number;
}

interface ClaudeDocPatch {
  path: string;
  new_content: string;
}

interface ClaudeDocPatchResponse {
  explanation?: string;
  patches?: ClaudeDocPatch[];
}

/**
 * Build the prompt that asks Claude to rewrite stale doc regions.
 * Exported (pure) so tests can assert against the shape.
 */
export function buildDocUpdatePrompt(args: {
  docPath: string;
  docRaw: string;
  staleSections: Array<{
    marker: string;
    claim: string;
    claimedFor: string;
    sourceContent: string;
  }>;
}): string {
  const { docPath, docRaw, staleSections } = args;
  const sectionBlobs = staleSections
    .map(
      (s, i) =>
        [
          `### Section ${i + 1} (marker=${s.marker})`,
          `Tracks: \`${s.claimedFor}\``,
          "",
          "Current prose in the doc:",
          "```markdown",
          s.claim,
          "```",
          "",
          "Current source contents:",
          "```",
          s.sourceContent.slice(0, MAX_BYTES_FOR_CLAUDE),
          "```",
        ].join("\n")
    )
    .join("\n\n---\n\n");

  return [
    "An AI-tracked documentation region in a markdown file has drifted",
    "from the source it claims to describe. Rewrite ONLY the prose inside",
    "the tracked region so it once again accurately describes the source.",
    "",
    `**Doc file:** \`${docPath}\``,
    "",
    "Full current doc (for context — do NOT rewrite anything outside the",
    "tracked region(s) and KEEP the `<!-- gluecron:doc-track src=... -->`",
    "and `<!-- /gluecron:doc-track -->` markers verbatim):",
    "```markdown",
    docRaw.slice(0, MAX_BYTES_FOR_CLAUDE),
    "```",
    "",
    "## Stale sections",
    "",
    sectionBlobs,
    "",
    "Respond ONLY with JSON of this exact shape:",
    "{",
    '  "explanation": "1-3 sentence summary of what drifted and how you updated the prose",',
    '  "patches": [',
    '    { "path": "same/doc/path", "new_content": "FULL replacement contents of the doc file" }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Return [] (empty patches) if the doc is already accurate or you cannot update it safely.",
    "- new_content MUST be the entire markdown file, not a diff.",
    "- Preserve every `<!-- gluecron:doc-track ... -->` and `<!-- /gluecron:doc-track -->` marker exactly.",
    "- Do not touch prose outside the marked regions.",
    "- Keep tone, voice, and formatting consistent with the rest of the document.",
  ].join("\n");
}

/** Branch name helper (exported for tests). */
export function docUpdateBranchName(
  docPath: string,
  override?: string
): string {
  if (override && override.trim()) return override.trim();
  const base = docPath
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "doc";
  return `ai-doc-update/${base}-${Date.now()}`;
}

/**
 * Render the PR body. Pure helper exported for tests.
 */
export function renderDocUpdatePrBody(args: {
  docPath: string;
  explanation: string;
  updatedSections: TrackedSection[];
}): string {
  const { docPath, explanation, updatedSections } = args;
  const sectionLines = updatedSections
    .map(
      (s) =>
        `- \`${s.claimedFor}\` (marker \`${s.marker}\`) — source hash drifted from \`${(s.storedClaimedHash ?? "(unseen)").slice(0, 12)}\` to \`${s.currentSrcHash.slice(0, 12)}\``
    )
    .join("\n");
  return [
    AI_DOC_UPDATE_MARKER,
    "## Documentation drift detected",
    "",
    `> Source files referenced by \`${docPath}\` have changed since the prose was last verified.`,
    "",
    "### What changed",
    explanation || "_(no explanation provided)_",
    "",
    "### Stale sections",
    sectionLines || "_(none)_",
    "",
    "---",
    "",
    `Labels: \`${AI_DOC_UPDATE_LABEL}\``,
    "",
    "_Auto-generated by GlueCron AI. Review the wording before merging — Claude may have over-edited._",
  ].join("\n");
}

async function askClaudeForDocPatch(
  client: Pick<Anthropic, "messages">,
  prompt: string
): Promise<ClaudeDocPatchResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 6144,
      messages: [{ role: "user", content: prompt }],
    });
    // Best-effort cost tracking. Mirrors ai-patch-generator.
    try {
      const { recordAiCost, extractUsage } = await import("./ai-cost-tracker");
      const usage = extractUsage(message);
      await recordAiCost({
        model: MODEL_SONNET,
        inputTokens: usage.input,
        outputTokens: usage.output,
        category: "other",
        sourceKind: "ai_doc_update",
      });
    } catch {
      /* swallow */
    }
    const text = extractText(message);
    const parsed = parseJsonResponse<ClaudeDocPatchResponse>(text);
    if (!parsed) return null;
    return parsed;
  } catch (err) {
    console.warn(
      "[ai-doc-updater] Claude call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Seed a fresh branch from the default branch HEAD. Mirrors
 * ai-patch-generator.seedBranchFromBase but here we always branch from
 * the default tip — doc fixes don't have a "base sha" of their own.
 */
async function seedBranchFromDefault(
  owner: string,
  name: string,
  branch: string,
  baseBranch: string
): Promise<string | null> {
  const fullRef = `refs/heads/${branch}`;
  if (await refExists(owner, name, fullRef)) {
    return await resolveRef(owner, name, branch);
  }
  const baseSha = await resolveRef(owner, name, baseBranch);
  if (!baseSha) return null;
  const ok = await updateRef(owner, name, fullRef, baseSha);
  return ok ? baseSha : null;
}

/**
 * Ask Claude to rewrite the stale prose and open a PR. Returns the new
 * branch + PR number, or `null` if:
 *
 *   - Anthropic isn't configured AND no `client` was injected
 *   - the repository can't be resolved
 *   - no section was actually stale
 *   - Claude returned zero patches
 *   - a PR is already open for the same (repo, doc, marker) combination
 *   - any DB / git step failed (logged + swallowed)
 *
 * NEVER throws.
 */
export async function proposeDocUpdate(
  opts: ProposeDocUpdateOptions
): Promise<ProposeDocUpdateResult | null> {
  const stale = opts.sections.filter((s) => s.stale);
  if (!stale.length) return null;

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

  const meta = await resolveRepoMeta(opts.repositoryId);
  if (!meta) return null;

  // Dedupe: skip when an open PR already exists for any of the stale
  // sections (look up by `last_pr_id`).
  try {
    const markers = stale.map((s) => s.marker);
    const rows = await db
      .select({
        sectionMarker: docTracking.sectionMarker,
        lastPrId: docTracking.lastPrId,
      })
      .from(docTracking)
      .where(
        and(
          eq(docTracking.repositoryId, opts.repositoryId),
          eq(docTracking.docPath, opts.path),
          markers.length > 0
            ? inArray(docTracking.sectionMarker, markers)
            : eq(docTracking.sectionMarker, "")
        )
      );
    const openPrIds = rows
      .map((r) => r.lastPrId)
      .filter((id): id is string => !!id);
    if (openPrIds.length > 0) {
      const stillOpen = await db
        .select({ id: pullRequests.id, state: pullRequests.state })
        .from(pullRequests)
        .where(inArray(pullRequests.id, openPrIds));
      if (stillOpen.some((p) => p.state === "open")) {
        return null;
      }
    }
  } catch {
    // dedupe failure is non-fatal — better to propose twice than zero times
  }

  await ensureDocUpdateLabel(opts.repositoryId);

  // Resolve the doc + source contents at the current default branch tip.
  const defaultBranch =
    (await getDefaultBranch(meta.owner, meta.name).catch(() => null)) ||
    meta.defaultBranch ||
    "main";

  const docBlob = await getBlob(
    meta.owner,
    meta.name,
    defaultBranch,
    opts.path
  ).catch(() => null);
  if (!docBlob || docBlob.isBinary) return null;

  const sourcesForPrompt: Array<{
    marker: string;
    claim: string;
    claimedFor: string;
    sourceContent: string;
  }> = [];
  for (const s of stale) {
    const blob = await getBlob(
      meta.owner,
      meta.name,
      defaultBranch,
      s.claimedFor
    ).catch(() => null);
    if (!blob || blob.isBinary) continue;
    sourcesForPrompt.push({
      marker: s.marker,
      claim: s.claim,
      claimedFor: s.claimedFor,
      sourceContent: blob.content,
    });
  }
  if (sourcesForPrompt.length === 0) return null;

  const prompt = buildDocUpdatePrompt({
    docPath: opts.path,
    docRaw: docBlob.content,
    staleSections: sourcesForPrompt,
  });

  const response = await askClaudeForDocPatch(client, prompt);
  if (!response || !Array.isArray(response.patches) || response.patches.length === 0) {
    return null;
  }

  // Filter patches: only allow touching the doc we asked about. Defence
  // in depth against a wandering model.
  const goodPatches = response.patches.filter(
    (p): p is ClaudeDocPatch =>
      !!p &&
      typeof p.path === "string" &&
      typeof p.new_content === "string" &&
      p.path === opts.path
  );
  if (!goodPatches.length) return null;

  const branch = docUpdateBranchName(opts.path, opts.branchOverride);
  const seeded = await seedBranchFromDefault(
    meta.owner,
    meta.name,
    branch,
    defaultBranch
  );
  if (!seeded) {
    console.warn(
      `[ai-doc-updater] could not seed branch ${branch} from ${defaultBranch} for ${meta.owner}/${meta.name}`
    );
    return null;
  }

  const writtenPaths: string[] = [];
  for (const patch of goodPatches) {
    const res = await createOrUpdateFileOnBranch({
      owner: meta.owner,
      name: meta.name,
      branch,
      filePath: patch.path,
      bytes: new TextEncoder().encode(patch.new_content),
      message: `docs(ai-doc-update): refresh tracked section(s) in ${patch.path}`,
      authorName: "GlueCron AI",
      authorEmail: "ai@gluecron.com",
    });
    if ("error" in res) {
      console.warn(
        `[ai-doc-updater] write failed (${res.error}) for ${patch.path}`
      );
      continue;
    }
    writtenPaths.push(patch.path);
  }
  if (writtenPaths.length === 0) return null;

  const body = renderDocUpdatePrBody({
    docPath: opts.path,
    explanation: response.explanation || "",
    updatedSections: stale,
  });
  const title = `[ai-doc-update] Refresh tracked section(s) in ${opts.path}`;

  let prId: string | null = null;
  let prNumber: number | null = null;
  try {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        repositoryId: opts.repositoryId,
        authorId: meta.ownerId,
        title,
        body,
        baseBranch: defaultBranch,
        headBranch: branch,
        isDraft: false,
      })
      .returning({ id: pullRequests.id, number: pullRequests.number });
    if (pr) {
      prId = pr.id;
      prNumber = pr.number;
      try {
        await db.insert(prComments).values({
          pullRequestId: pr.id,
          authorId: meta.ownerId,
          isAiReview: true,
          body: `${AI_DOC_UPDATE_MARKER}\nApplied label: \`${AI_DOC_UPDATE_LABEL}\``,
        });
      } catch (err) {
        console.warn(
          "[ai-doc-updater] failed to insert label-marker comment:",
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    console.error(
      "[ai-doc-updater] failed to insert pullRequests row:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
  if (prNumber == null || prId == null) return null;

  // Update doc_tracking rows so we don't re-propose immediately and so
  // the UI can deep-link to the open PR.
  for (const s of stale) {
    try {
      await db
        .insert(docTracking)
        .values({
          repositoryId: opts.repositoryId,
          docPath: opts.path,
          sectionMarker: s.marker,
          srcPath: s.claimedFor,
          claimedHash: s.currentSrcHash,
          lastPrId: prId,
        })
        .onConflictDoUpdate({
          target: [
            docTracking.repositoryId,
            docTracking.docPath,
            docTracking.sectionMarker,
          ],
          set: {
            srcPath: s.claimedFor,
            claimedHash: s.currentSrcHash,
            lastCheckedAt: new Date(),
            lastPrId: prId,
          },
        });
    } catch (err) {
      console.warn(
        `[ai-doc-updater] doc_tracking upsert failed for ${opts.path}::${s.marker}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  await audit({
    userId: null,
    action: "ai.doc_update.opened",
    repositoryId: opts.repositoryId,
    metadata: {
      branch,
      prNumber,
      docPath: opts.path,
      sectionCount: stale.length,
    },
  });

  return { branch, prNumber, updatedSections: writtenPaths.length };
}

/**
 * Convenience driver used by the post-receive hook. Walks every tracked
 * doc and proposes one PR per stale doc. Never throws.
 */
export async function runDocDriftCheckForRepo(
  repositoryId: string
): Promise<{ docs: number; proposed: number }> {
  const docs = await findTrackedDocs(repositoryId);
  let proposed = 0;
  for (const d of docs) {
    const hasStale = d.sections.some((s) => s.stale);
    if (!hasStale) {
      // First-time observation: just seed the claimed_hash rows so the
      // next push has a baseline to compare against.
      await persistObservedSections(repositoryId, d);
      continue;
    }
    const out = await proposeDocUpdate({
      repositoryId,
      path: d.path,
      sections: d.sections,
    }).catch(() => null);
    if (out) proposed += 1;
  }
  return { docs: docs.length, proposed };
}

/**
 * Test-only re-exports of internal helpers.
 */
export const __test = {
  resolveRepoMeta,
  listMarkdownFiles,
  ensureDocUpdateLabel,
  askClaudeForDocPatch,
  seedBranchFromDefault,
};
