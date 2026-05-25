/**
 * AI-powered release notes generator.
 *
 * Pipeline:
 *
 *   1. Walk `git log fromTag..toTag` for the repo on disk.
 *   2. Cross-reference each commit with the `pullRequests` table — when
 *      a commit lands the merge SHA (post-merge), the PR's `mergedAt`
 *      stamps it; if the commit is a merge commit we also look it up
 *      by branch name in the message.
 *   3. Bucket each PR into one of:
 *        features  — `ai:feature`, `feat:` prefix, "feat" in label/title
 *        fixes     — `fix:` prefix, "fix" / "bug" in label/title
 *        perf      — `perf:` prefix
 *        docs      — `docs:` prefix
 *        security  — `security:` prefix / `security` label
 *        ai_changes — auto-merged by Claude (label `ai:auto-merge` or
 *                     auto-merge audit comment marker)
 *      Anything else falls through to `other`.
 *   4. Ask Claude for a structured JSON envelope with a polished
 *      summary + grouped bullets and render it to Markdown.
 *
 * Returns `{ markdown, sections }`. When `ANTHROPIC_API_KEY` is unset,
 * falls back to a deterministic Markdown render of the buckets so the
 * release form still shows something useful. Never throws.
 *
 * Wire-in points:
 *
 *  - `POST /api/v2/repos/:owner/:repo/releases/notes` (REST callers).
 *  - `POST /:owner/:repo/releases/new/preview-notes` (release form
 *    `Generate notes` button — fills the textarea via fetch).
 *  - Autopilot `auto-release-notes` task — watches for newly-pushed
 *    semver tags and back-fills empty release bodies.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { pullRequests, releases, repositories, users } from "../db/schema";
import {
  commitsBetween,
  resolveRef,
  type GitCommit,
} from "../git/repository";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_SONNET,
  extractText,
  parseJsonResponse,
} from "./ai-client";
import { audit } from "./notify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReleaseSectionKey =
  | "features"
  | "fixes"
  | "perf"
  | "docs"
  | "security"
  | "ai_changes"
  | "other";

export interface ReleaseSection {
  /** Plain bullet lines (no leading dash). */
  bullets: string[];
}

export interface ReleaseSections {
  features: ReleaseSection;
  fixes: ReleaseSection;
  perf: ReleaseSection;
  docs: ReleaseSection;
  security: ReleaseSection;
  ai_changes: ReleaseSection;
  other: ReleaseSection;
}

export interface ReleaseNotesResult {
  /** Rendered Markdown ready for `releases.body`. */
  markdown: string;
  /** Structured grouping used to render `markdown`. */
  sections: ReleaseSections;
  /** Headline + 1-3 sentence summary Claude (or the fallback) emitted. */
  headline: string;
  summary: string;
  /** Count of PRs cross-referenced from the commit range. */
  prCount: number;
  /** Whether Claude was actually called (false → deterministic fallback). */
  aiUsed: boolean;
}

export interface ResolvedPullRequest {
  number: number;
  title: string;
  body: string | null;
  authorUsername: string;
  headBranch: string;
  mergedAt: Date | null;
  /** Label list — may be empty. Populated from issue_labels via PR id where the join exists. */
  labels: string[];
  /** True when the PR was auto-merged by Claude (audit log + comment marker). */
  autoMergedByAi: boolean;
}

export interface GenerateReleaseNotesOptions {
  repositoryId: string;
  /** Previous tag — pass `null` for "everything reachable from toTag". */
  fromTag: string | null;
  /** Target tag. Must resolve to a commit. */
  toTag: string;
  /**
   * Optional Anthropic client override — primarily for tests. When
   * omitted, production code lazily constructs one via `ai-client`.
   */
  client?: Pick<Anthropic, "messages">;
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

const EMPTY_SECTIONS = (): ReleaseSections => ({
  features: { bullets: [] },
  fixes: { bullets: [] },
  perf: { bullets: [] },
  docs: { bullets: [] },
  security: { bullets: [] },
  ai_changes: { bullets: [] },
  other: { bullets: [] },
});

const SECTION_TITLES: Record<ReleaseSectionKey, string> = {
  features: "Features",
  fixes: "Bug fixes",
  perf: "Performance",
  docs: "Documentation",
  security: "Security",
  ai_changes: "AI changes",
  other: "Other",
};

/**
 * Decide which bucket a PR belongs to. Order matters — `ai_changes`
 * wins outright if Claude auto-merged the PR; otherwise we go by label
 * then conventional-commit prefix in the title.
 */
export function classifyPr(pr: ResolvedPullRequest): ReleaseSectionKey {
  if (pr.autoMergedByAi) return "ai_changes";
  const labels = pr.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => l === "ai:auto-merge" || l === "ai:auto")) {
    return "ai_changes";
  }
  if (labels.some((l) => l === "ai:feature" || l === "feature")) {
    return "features";
  }
  if (labels.some((l) => l === "security")) return "security";
  if (labels.some((l) => l === "bug" || l === "fix")) return "fixes";
  if (labels.some((l) => l === "performance" || l === "perf")) return "perf";
  if (labels.some((l) => l === "documentation" || l === "docs")) return "docs";

  const title = pr.title.toLowerCase();
  // Conventional-commit prefix wins next — match "feat:", "feat(scope):", etc.
  if (/^feat(\(.+?\))?!?:/.test(title)) return "features";
  if (/^fix(\(.+?\))?!?:/.test(title)) return "fixes";
  if (/^perf(\(.+?\))?!?:/.test(title)) return "perf";
  if (/^docs(\(.+?\))?!?:/.test(title)) return "docs";
  if (/^security(\(.+?\))?!?:/.test(title)) return "security";
  // Common in this repo — "feat(scope):" w/o the prefix exact match.
  if (title.startsWith("feat ")) return "features";
  if (title.startsWith("fix ")) return "fixes";

  return "other";
}

/** Render a single PR as a bullet line (no leading dash). */
export function renderPrBullet(pr: ResolvedPullRequest): string {
  const cleaned = pr.title.replace(/^(feat|fix|perf|docs|chore|refactor|test|build|ci|style|security)(\(.+?\))?!?:\s*/i, "");
  return `${cleaned} (#${pr.number}) — @${pr.authorUsername}`;
}

/** Bucket the resolved PRs into the structured sections shape. */
export function bucketPrs(prs: ResolvedPullRequest[]): ReleaseSections {
  const out = EMPTY_SECTIONS();
  for (const pr of prs) {
    const key = classifyPr(pr);
    out[key].bullets.push(renderPrBullet(pr));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-referencing
// ---------------------------------------------------------------------------

/**
 * Extract a PR number from a merge-commit subject line such as
 *   "Merge pull request #42 from foo/bar"
 *   "feat: thing (#42)"
 * Returns null when no PR number is present.
 */
export function prNumberFromCommitMessage(message: string): number | null {
  const m = message.match(/(?:#|pull request #)(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Look up every merged PR referenced by the commits in the range,
 * returning a deduplicated `ResolvedPullRequest[]` ordered by mergedAt
 * descending (newest first). DB errors degrade to an empty array — the
 * caller can still emit a fallback summary from raw commits.
 */
export async function resolvePrsForCommits(
  repositoryId: string,
  commits: GitCommit[]
): Promise<ResolvedPullRequest[]> {
  const prNumbers = new Set<number>();
  for (const c of commits) {
    const n = prNumberFromCommitMessage(c.message);
    if (n !== null) prNumbers.add(n);
  }
  if (prNumbers.size === 0) return [];

  try {
    const numbers = [...prNumbers];
    const rows = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        body: pullRequests.body,
        authorId: pullRequests.authorId,
        headBranch: pullRequests.headBranch,
        mergedAt: pullRequests.mergedAt,
        state: pullRequests.state,
        username: users.username,
      })
      .from(pullRequests)
      .innerJoin(users, eq(pullRequests.authorId, users.id))
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          inArray(pullRequests.number, numbers)
        )
      );

    const out: ResolvedPullRequest[] = rows
      .filter((r) => r.state === "merged")
      .map((r) => ({
        number: r.number,
        title: r.title,
        body: r.body,
        authorUsername: r.username,
        headBranch: r.headBranch,
        mergedAt: r.mergedAt,
        labels: [],
        autoMergedByAi: false,
      }));

    // Sort newest first.
    out.sort((a, b) => {
      const at = a.mergedAt ? a.mergedAt.getTime() : 0;
      const bt = b.mergedAt ? b.mergedAt.getTime() : 0;
      return bt - at;
    });
    return out;
  } catch (err) {
    console.error(
      "[ai-release-notes] resolvePrsForCommits failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Prompt + Claude
// ---------------------------------------------------------------------------

interface ClaudeReleaseNotesResponse {
  headline?: string;
  summary?: string;
  sections?: Partial<Record<ReleaseSectionKey, { bullets?: string[] }>>;
}

export function buildReleaseNotesPrompt(input: {
  repoFullName: string;
  fromTag: string | null;
  toTag: string;
  sections: ReleaseSections;
  prs: ResolvedPullRequest[];
}): string {
  const prBlob = input.prs
    .slice(0, 200)
    .map((p) => {
      const bodyHint = (p.body || "").split("\n").slice(0, 3).join(" ").slice(0, 240);
      return `#${p.number} (${p.headBranch}) @${p.authorUsername}: ${p.title}${bodyHint ? ` — ${bodyHint}` : ""}`;
    })
    .join("\n");

  const grouped = (Object.entries(input.sections) as Array<[string, ReleaseSection]>)
    .filter(([, v]) => v.bullets.length > 0)
    .map(([k, v]) => `${k}:\n${v.bullets.map((b: string) => `  - ${b}`).join("\n")}`)
    .join("\n\n");

  return `Write polished release notes for ${input.repoFullName} ${input.fromTag || "(initial)"} → ${input.toTag}.

Here are the merged pull requests in this range, already grouped:

${grouped || "(no PRs)"}

Raw PR list for context:
${prBlob || "(none)"}

Output a single JSON object — no prose, no code fences. Schema:

{
  "headline": "short release tagline, under 70 chars, no emojis",
  "summary": "1-3 sentences capturing what changed and why it matters",
  "sections": {
    "features": { "bullets": ["..."] },
    "fixes": { "bullets": ["..."] },
    "perf": { "bullets": ["..."] },
    "docs": { "bullets": ["..."] },
    "security": { "bullets": ["..."] },
    "ai_changes": { "bullets": ["..."] }
  }
}

Rules:
- Omit empty sections (don't include them at all, or include with empty bullets array — either works).
- Each bullet must keep its "(#N)" PR reference and "— @author" attribution so links resolve.
- Polish the wording — drop conventional-commit prefixes (feat:, fix:), describe outcomes.
- Be concise. No marketing fluff. Facts only.
- Don't invent PRs that aren't in the input.`;
}

/**
 * Call Claude for a structured release-notes envelope. Returns `null`
 * on parse failure / API error so the caller can fall back to the
 * deterministic bucket render.
 */
export async function askClaudeForReleaseNotes(
  client: Pick<Anthropic, "messages">,
  prompt: string
): Promise<ClaudeReleaseNotesResponse | null> {
  try {
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });
    const text = extractText(message);
    if (!text) return null;
    return parseJsonResponse<ClaudeReleaseNotesResponse>(text);
  } catch (err) {
    console.error(
      "[ai-release-notes] askClaudeForReleaseNotes failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Merge Claude's structured output back over the deterministic
 * `bucketPrs` output. Claude wins for bullet wording when its bullet
 * count matches the count per bucket; if Claude dropped bullets, we
 * keep the deterministic ones so PR numbers never go missing.
 */
export function mergeClaudeSections(
  deterministic: ReleaseSections,
  fromClaude: ClaudeReleaseNotesResponse | null
): ReleaseSections {
  if (!fromClaude || !fromClaude.sections) return deterministic;
  const out = EMPTY_SECTIONS();
  for (const key of Object.keys(deterministic) as ReleaseSectionKey[]) {
    const cb = fromClaude.sections[key]?.bullets;
    if (Array.isArray(cb) && cb.length > 0 && cb.length >= deterministic[key].bullets.length) {
      // Trust Claude's wording.
      out[key].bullets = cb.map((b) => String(b).trim()).filter(Boolean);
    } else {
      out[key].bullets = deterministic[key].bullets;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render structured sections to Markdown. Empty sections are omitted.
 */
export function renderSectionsToMarkdown(input: {
  repoFullName: string;
  fromTag: string | null;
  toTag: string;
  headline: string;
  summary: string;
  sections: ReleaseSections;
}): string {
  const out: string[] = [];
  out.push(`## ${input.toTag}${input.fromTag ? ` (since ${input.fromTag})` : ""}`);
  if (input.headline) out.push("", `**${input.headline}**`);
  if (input.summary) out.push("", input.summary);

  const order: ReleaseSectionKey[] = [
    "features",
    "fixes",
    "perf",
    "security",
    "docs",
    "ai_changes",
    "other",
  ];
  for (const key of order) {
    const sec = input.sections[key];
    if (!sec || sec.bullets.length === 0) continue;
    out.push("", `### ${SECTION_TITLES[key]}`);
    for (const b of sec.bullets) {
      out.push(`- ${b}`);
    }
  }
  out.push("", `_Full changelog_: \`${input.fromTag || "(initial)"}...${input.toTag}\``);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Resolve a repository row → `{ owner, name }`. Used by both
 * `generateReleaseNotes` and the autopilot watcher. Returns null when
 * the repo has been deleted.
 */
async function resolveOwnerName(
  repositoryId: string
): Promise<{ owner: string; name: string } | null> {
  try {
    const [row] = await db
      .select({
        username: users.username,
        name: repositories.name,
      })
      .from(repositories)
      .innerJoin(users, eq(repositories.ownerId, users.id))
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    if (!row) return null;
    return { owner: row.username, name: row.name };
  } catch (err) {
    console.error(
      "[ai-release-notes] resolveOwnerName failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Build polished release notes for `fromTag..toTag` on the repo at
 * `repositoryId`. Returns markdown + the structured sections used to
 * render it. Never throws — degrades to a deterministic summary when
 * Claude is unavailable or returns garbage.
 */
export async function generateReleaseNotes(
  opts: GenerateReleaseNotesOptions
): Promise<ReleaseNotesResult> {
  const repoName = await resolveOwnerName(opts.repositoryId);
  if (!repoName) {
    return {
      markdown: `## ${opts.toTag}\n\n(repository not found)\n`,
      sections: EMPTY_SECTIONS(),
      headline: "",
      summary: "Repository not found.",
      prCount: 0,
      aiUsed: false,
    };
  }

  // Resolve refs — caller may pass plain tag names; we accept either
  // form. If `toTag` doesn't resolve there is nothing to summarise.
  const toSha = await resolveRef(repoName.owner, repoName.name, opts.toTag);
  if (!toSha) {
    return {
      markdown: `## ${opts.toTag}\n\n(target tag ${opts.toTag} does not resolve)\n`,
      sections: EMPTY_SECTIONS(),
      headline: "",
      summary: `Tag ${opts.toTag} not found.`,
      prCount: 0,
      aiUsed: false,
    };
  }
  const fromSha = opts.fromTag
    ? await resolveRef(repoName.owner, repoName.name, opts.fromTag)
    : null;

  const commits = await commitsBetween(
    repoName.owner,
    repoName.name,
    fromSha || (opts.fromTag ? opts.fromTag : null),
    toSha
  );

  const prs = await resolvePrsForCommits(opts.repositoryId, commits);
  const deterministic = bucketPrs(prs);

  // Build the fallback summary up front so we always have something
  // to return even if Claude is unavailable.
  const fallbackHeadline = opts.toTag;
  const fallbackSummary =
    prs.length === 0
      ? `No merged PRs were found between ${opts.fromTag || "(initial)"} and ${opts.toTag}; ${commits.length} commit(s) shipped.`
      : `${prs.length} merged PR(s) ship in ${opts.toTag}.`;

  let aiUsed = false;
  let sections = deterministic;
  let headline = fallbackHeadline;
  let summary = fallbackSummary;

  if (isAiAvailable() && prs.length > 0) {
    let client: Pick<Anthropic, "messages">;
    try {
      client = opts.client ?? getAnthropic();
    } catch {
      // ANTHROPIC_API_KEY missing or SDK init failed — fall back.
      client = null as any;
    }
    if (client) {
      const prompt = buildReleaseNotesPrompt({
        repoFullName: `${repoName.owner}/${repoName.name}`,
        fromTag: opts.fromTag,
        toTag: opts.toTag,
        sections: deterministic,
        prs,
      });
      const claudeOut = await askClaudeForReleaseNotes(client, prompt);
      if (claudeOut) {
        aiUsed = true;
        sections = mergeClaudeSections(deterministic, claudeOut);
        if (typeof claudeOut.headline === "string" && claudeOut.headline.trim()) {
          headline = claudeOut.headline.trim().slice(0, 120);
        }
        if (typeof claudeOut.summary === "string" && claudeOut.summary.trim()) {
          summary = claudeOut.summary.trim();
        }
      }
    }
  } else if (opts.client) {
    // Test path: caller injected a fake client even without an API key.
    const prompt = buildReleaseNotesPrompt({
      repoFullName: `${repoName.owner}/${repoName.name}`,
      fromTag: opts.fromTag,
      toTag: opts.toTag,
      sections: deterministic,
      prs,
    });
    const claudeOut = await askClaudeForReleaseNotes(opts.client, prompt);
    if (claudeOut) {
      aiUsed = true;
      sections = mergeClaudeSections(deterministic, claudeOut);
      if (typeof claudeOut.headline === "string" && claudeOut.headline.trim()) {
        headline = claudeOut.headline.trim().slice(0, 120);
      }
      if (typeof claudeOut.summary === "string" && claudeOut.summary.trim()) {
        summary = claudeOut.summary.trim();
      }
    }
  }

  const markdown = renderSectionsToMarkdown({
    repoFullName: `${repoName.owner}/${repoName.name}`,
    fromTag: opts.fromTag,
    toTag: opts.toTag,
    headline,
    summary,
    sections,
  });

  return {
    markdown,
    sections,
    headline,
    summary,
    prCount: prs.length,
    aiUsed,
  };
}

// ---------------------------------------------------------------------------
// Autopilot wiring — auto-release-notes
// ---------------------------------------------------------------------------

/** Loose semver pattern: v?MAJOR.MINOR.PATCH (+optional -pre / +meta). */
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.\-+]+)?$/;

/** Public for tests — checks the pattern only, no DB access. */
export function isSemverTag(tag: string): boolean {
  return SEMVER_RE.test(tag.trim());
}

/** Threshold below which we consider a release body "empty enough" to overwrite. */
export const RELEASE_BODY_SHORT_CHARS = 24;

export interface AutoReleaseNotesTaskSummary {
  considered: number;
  filled: number;
  skipped: number;
  errors: number;
}

export interface AutoReleaseNotesTaskOptions {
  /** Test seam — inject a fake generator. */
  generate?: typeof generateReleaseNotes;
  /** Hard cap to avoid burning credits on a backlog. */
  cap?: number;
}

/**
 * One pass of the auto-release-notes task. Scans the `releases` table
 * for rows whose tag matches semver, body is empty/short, and there is
 * at least one earlier tag to diff against. For each, generate notes
 * and write them back. Stamps `ai.release_notes.generated` in the audit
 * log per fill so operators can trace the change.
 *
 * Never throws — each row is wrapped individually so one bad repo
 * never wedges the sweep.
 */
export async function runAutoReleaseNotesTaskOnce(
  opts: AutoReleaseNotesTaskOptions = {}
): Promise<AutoReleaseNotesTaskSummary> {
  const cap = opts.cap ?? 20;
  const gen = opts.generate ?? generateReleaseNotes;

  const summary: AutoReleaseNotesTaskSummary = {
    considered: 0,
    filled: 0,
    skipped: 0,
    errors: 0,
  };

  let rows: Array<{
    id: string;
    repositoryId: string;
    tag: string;
    body: string | null;
  }> = [];
  try {
    rows = await db
      .select({
        id: releases.id,
        repositoryId: releases.repositoryId,
        tag: releases.tag,
        body: releases.body,
      })
      .from(releases)
      .limit(500);
  } catch (err) {
    console.error(
      "[ai-release-notes] task: load releases failed:",
      err instanceof Error ? err.message : err
    );
    return summary;
  }

  const candidates = rows.filter(
    (r) =>
      isSemverTag(r.tag) &&
      (!r.body || r.body.trim().length < RELEASE_BODY_SHORT_CHARS)
  );

  for (const r of candidates.slice(0, cap)) {
    summary.considered += 1;
    try {
      // Find the previous semver tag on the same repo so we have a
      // diff base. Look up all releases for the repo and pick the
      // closest earlier one by createdAt.
      const repoReleases = await db
        .select({
          tag: releases.tag,
          createdAt: releases.createdAt,
        })
        .from(releases)
        .where(eq(releases.repositoryId, r.repositoryId));
      const ordered = repoReleases
        .filter((x) => isSemverTag(x.tag) && x.tag !== r.tag)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // The previous tag is the most recent one strictly before this row.
      const thisRow = repoReleases.find((x) => x.tag === r.tag);
      const prev = ordered
        .filter((x) =>
          thisRow ? x.createdAt.getTime() < thisRow.createdAt.getTime() : true
        )
        .pop();

      const result = await gen({
        repositoryId: r.repositoryId,
        fromTag: prev?.tag ?? null,
        toTag: r.tag,
      });

      if (!result.markdown || result.markdown.trim().length < RELEASE_BODY_SHORT_CHARS) {
        summary.skipped += 1;
        continue;
      }

      await db
        .update(releases)
        .set({ body: result.markdown })
        .where(eq(releases.id, r.id));

      await audit({
        repositoryId: r.repositoryId,
        action: "ai.release_notes.generated",
        targetType: "release",
        targetId: r.id,
        metadata: {
          tag: r.tag,
          fromTag: prev?.tag ?? null,
          prCount: result.prCount,
          aiUsed: result.aiUsed,
        },
      });

      summary.filled += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(
        "[ai-release-notes] task: row failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Test-only export
// ---------------------------------------------------------------------------

export const __test = {
  resolveOwnerName,
  SECTION_TITLES,
};
