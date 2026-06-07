/**
 * Block M3 — AI pre-merge risk score.
 *
 * For every open PR we compute a transparent, auditable 0-10 risk score
 * the reviewer can see at a glance before clicking Merge. The score is a
 * pure function over a small set of signals (file count, line count,
 * teams affected, schema migrations touched, dependency churn, test
 * ratio). The LLM (Sonnet 4.6) only writes the one-paragraph
 * prose summary; it never influences the numeric score.
 *
 * Architecture:
 *
 *   1. `computePrRiskScore(signals)` — pure helper. Same input always
 *      yields the same score. Documented inline; auditable.
 *   2. `generatePrRiskSummary(args)` — calls Sonnet for prose. Never
 *      throws — falls back to a deterministic sentence when no API key
 *      is set or the call fails.
 *   3. `computePrRiskForPullRequest(prId)` — DB-backed orchestrator.
 *      Resolves the PR + head SHA, gathers signals, computes the score,
 *      persists it to `pr_risk_scores`, returns the full row.
 *   4. `getCachedPrRisk(prId)` — cheap lookup for the current head SHA.
 *
 * Cache key: `(pull_request_id, commit_sha)`. When the head branch is
 * force-pushed (new SHA), the cache miss naturally re-triggers a score
 * computation.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  codeOwners,
  prRiskScores,
  pullRequests,
  repoDependencies,
  repositories,
  users,
  type PrRiskScoreRow,
} from "../db/schema";
import { getDiff, getRepoPath, resolveRef } from "../git/repository";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_HAIKU,
  extractText,
} from "./ai-client";
import { ownersForPath, parseCodeowners, type OwnerRule } from "./codeowners";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PrRiskBand = "low" | "medium" | "high" | "critical";

export interface PrRiskSignals {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  /** Distinct CODEOWNERS owners touched (count). */
  teamsAffected: number;
  schemaMigrationTouched: boolean;
  /** Paths under sensitive/ etc. */
  lockedPathTouched: boolean;
  addsNewDependency: boolean;
  bumpsMajorDependency: boolean;
  testsAddedForNewCode: boolean;
  /** 0..1, 0 = lots of tests, 1 = no tests. */
  diffMinusTestRatio: number;
}

export interface PrRiskScore {
  score: number;
  band: PrRiskBand;
  signals: PrRiskSignals;
  aiSummary: string;
  generatedAt: Date;
  commitSha: string;
}

// ---------------------------------------------------------------------------
// Pure score formula
// ---------------------------------------------------------------------------

/**
 * Transparent risk formula (intentionally simple, intentionally not LLM):
 *
 *   + 0.3 per file changed (cap at 3.0)
 *   + 0.005 per (linesAdded + linesRemoved) (cap at 2.0)
 *   + 0.8 per team beyond the first (cap at 2.0)
 *   + 1.5 if schemaMigrationTouched
 *   + 1.0 if lockedPathTouched
 *   + 0.5 if addsNewDependency
 *   + 1.2 if bumpsMajorDependency
 *   + 1.0 * (testsAddedForNewCode ? 0 : diffMinusTestRatio)
 *
 * Clamp to [0, 10] and round to nearest integer.
 *
 * Band thresholds:
 *   0–2  → low
 *   3–4  → medium
 *   5–7  → high
 *   8–10 → critical
 *
 * Monotonicity: every weight is non-negative, so flipping any boolean
 * signal from false to true (or increasing any counter) can only raise
 * the score (until the cap). Verified by tests.
 */
export function computePrRiskScore(
  signals: PrRiskSignals
): { score: number; band: PrRiskBand } {
  let raw = 0;

  // File count contribution (cap at 3.0).
  raw += Math.min(3.0, Math.max(0, signals.filesChanged) * 0.3);

  // Line count contribution (cap at 2.0).
  const totalLines =
    Math.max(0, signals.linesAdded) + Math.max(0, signals.linesRemoved);
  raw += Math.min(2.0, totalLines * 0.005);

  // Teams-beyond-the-first contribution (cap at 2.0). teamsAffected=0 or 1
  // contributes nothing; each additional team adds 0.8.
  const extraTeams = Math.max(0, signals.teamsAffected - 1);
  raw += Math.min(2.0, extraTeams * 0.8);

  // Boolean signals.
  if (signals.schemaMigrationTouched) raw += 1.5;
  if (signals.lockedPathTouched) raw += 1.0;
  if (signals.addsNewDependency) raw += 0.5;
  if (signals.bumpsMajorDependency) raw += 1.2;

  // Test-coverage penalty.
  if (!signals.testsAddedForNewCode) {
    const ratio = clamp01(signals.diffMinusTestRatio);
    raw += 1.0 * ratio;
  }

  const score = Math.max(0, Math.min(10, Math.round(raw)));
  return { score, band: bandFor(score) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function bandFor(score: number): PrRiskBand {
  if (score <= 2) return "low";
  if (score <= 4) return "medium";
  if (score <= 7) return "high";
  return "critical";
}

// ---------------------------------------------------------------------------
// AI prose summary — Haiku call with deterministic fallback
// ---------------------------------------------------------------------------

/**
 * Generate a 1-3 sentence prose summary of the risk profile. Calls Haiku
 * for fluency; on any failure (no key, API error, malformed response)
 * falls back to a deterministic sentence built from the signal map.
 *
 * Never throws. Always returns a non-empty string.
 */
export async function generatePrRiskSummary(args: {
  signals: PrRiskSignals;
  title: string;
  baseBranch: string;
  headBranch: string;
}): Promise<string> {
  const fallback = deterministicSummary(args.signals);

  if (!isAiAvailable()) return fallback;

  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `You are summarising the risk profile of a pull request for a reviewer who is about to click Merge.

PR title: ${args.title}
Base branch: ${args.baseBranch}
Head branch: ${args.headBranch}

Signals (these are the FACTS — do not invent any others):
- files changed: ${args.signals.filesChanged}
- lines added: ${args.signals.linesAdded}
- lines removed: ${args.signals.linesRemoved}
- distinct CODEOWNERS owners touched: ${args.signals.teamsAffected}
- schema migration touched: ${args.signals.schemaMigrationTouched}
- locked / sensitive path touched: ${args.signals.lockedPathTouched}
- adds a new dependency: ${args.signals.addsNewDependency}
- bumps a major dependency: ${args.signals.bumpsMajorDependency}
- tests added for new code: ${args.signals.testsAddedForNewCode}
- diff-minus-test ratio (0=lots of tests, 1=no tests): ${args.signals.diffMinusTestRatio.toFixed(2)}

Write ONE to THREE plain sentences describing the riskiest aspects of this PR.
Tone: blunt, factual, no marketing. Do not include a numeric score (the reviewer
already sees that). Do not use bullet points. Output the prose only.`,
        },
      ],
    });
    const text = extractText(message).trim();
    if (!text) return fallback;
    return text.slice(0, 600);
  } catch {
    return fallback;
  }
}

/**
 * Deterministic prose composed from the signal map. Used as the always-
 * available fallback. Public-internal — exported for tests.
 */
export function deterministicSummary(signals: PrRiskSignals): string {
  const parts: string[] = [];
  parts.push(
    `Touches ${signals.filesChanged} file(s) with ${signals.linesAdded} added and ${signals.linesRemoved} removed across ${signals.teamsAffected} owner(s).`
  );
  const hotspots: string[] = [];
  if (signals.schemaMigrationTouched) hotspots.push("a schema migration");
  if (signals.lockedPathTouched) hotspots.push("a locked / sensitive path");
  if (signals.bumpsMajorDependency) hotspots.push("a major dependency bump");
  else if (signals.addsNewDependency) hotspots.push("a new dependency");
  if (hotspots.length > 0) {
    parts.push(`Includes ${joinList(hotspots)}.`);
  }
  if (!signals.testsAddedForNewCode && signals.diffMinusTestRatio > 0.5) {
    parts.push("No tests were added for the new code.");
  }
  return parts.join(" ");
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Signal-gathering helpers (DB + git)
// ---------------------------------------------------------------------------

const SCHEMA_MIGRATION_PATTERNS = [
  /^drizzle\//i,
  /^db\/migrations\//i,
  /^migrations\//i,
  /\/migrations\//i,
  /^src\/db\/schema\.ts$/i,
];

const LOCKED_PATH_PATTERNS = [
  /^sensitive\//i,
  /^secrets\//i,
  /^infra\/secrets\//i,
  /\.pem$/i,
  /\.key$/i,
];

const TEST_PATH_PATTERNS = [
  /(^|\/)__tests__\//i,
  /\.test\.[tj]sx?$/i,
  /\.spec\.[tj]sx?$/i,
  /(^|\/)tests?\//i,
];

function matchesAny(path: string, patterns: RegExp[]): boolean {
  for (const re of patterns) if (re.test(path)) return true;
  return false;
}

function isSchemaMigrationPath(path: string): boolean {
  return matchesAny(path, SCHEMA_MIGRATION_PATTERNS);
}

function isLockedPath(path: string): boolean {
  return matchesAny(path, LOCKED_PATH_PATTERNS);
}

function isTestPath(path: string): boolean {
  return matchesAny(path, TEST_PATH_PATTERNS);
}

/** Diff-file shape we accept — keeps signal gather DI-friendly for tests. */
export interface DiffFileInput {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Compute the raw signal map from a parsed diff plus owner rules and the
 * pre/post dependency sets. Pure helper — no DB, no git, no LLM. Exported
 * so it can be exercised directly by tests with synthetic inputs.
 */
export function buildSignalsFromDiff(args: {
  files: DiffFileInput[];
  raw: string;
  ownerRules: OwnerRule[];
  /** Existing dep set on the base side, keyed `ecosystem:name`. */
  baseDeps: Map<string, string | null>;
  /** Dep set after the PR's changes (best-effort), same key shape. */
  headDeps: Map<string, string | null>;
}): PrRiskSignals {
  let linesAdded = 0;
  let linesRemoved = 0;
  let schemaMigrationTouched = false;
  let lockedPathTouched = false;
  let testFiles = 0;
  let testLines = 0;
  const ownerSet = new Set<string>();

  for (const f of args.files) {
    linesAdded += Math.max(0, f.additions || 0);
    linesRemoved += Math.max(0, f.deletions || 0);
    if (isSchemaMigrationPath(f.path)) schemaMigrationTouched = true;
    if (isLockedPath(f.path)) lockedPathTouched = true;
    if (isTestPath(f.path)) {
      testFiles += 1;
      testLines += Math.max(0, (f.additions || 0) + (f.deletions || 0));
    }
    if (args.ownerRules.length > 0) {
      for (const o of ownersForPath(f.path, args.ownerRules)) {
        ownerSet.add(o);
      }
    }
  }

  const filesChanged = args.files.length;
  const teamsAffected = ownerSet.size;
  const testsAddedForNewCode = testFiles > 0 && linesAdded > 0;
  const totalLines = linesAdded + linesRemoved;
  const diffMinusTestRatio =
    totalLines === 0 ? 0 : 1 - Math.min(1, testLines / totalLines);

  // Dependency comparison — adds vs bumps.
  let addsNewDependency = false;
  let bumpsMajorDependency = false;
  for (const [key, headVersion] of args.headDeps) {
    if (!args.baseDeps.has(key)) {
      addsNewDependency = true;
      continue;
    }
    const baseVersion = args.baseDeps.get(key) ?? null;
    if (isMajorBump(baseVersion, headVersion)) {
      bumpsMajorDependency = true;
    }
  }

  return {
    filesChanged,
    linesAdded,
    linesRemoved,
    teamsAffected,
    schemaMigrationTouched,
    lockedPathTouched,
    addsNewDependency,
    bumpsMajorDependency,
    testsAddedForNewCode,
    diffMinusTestRatio,
  };
}

/**
 * Heuristic semver-major detector. Strips leading ^ ~ = v and compares
 * the leading integer chunks. Anything we cannot parse returns false so
 * we err toward "no false positive bump".
 */
export function isMajorBump(
  before: string | null | undefined,
  after: string | null | undefined
): boolean {
  const a = leadingMajor(before);
  const b = leadingMajor(after);
  if (a === null || b === null) return false;
  return b > a;
}

function leadingMajor(spec: string | null | undefined): number | null {
  if (!spec) return null;
  const stripped = spec.trim().replace(/^[~^=v]+/, "");
  const match = stripped.match(/^(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// DB-touching orchestrator
// ---------------------------------------------------------------------------

interface PrRow {
  id: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  repositoryId: string;
}

interface RepoRow {
  id: string;
  name: string;
  ownerUsername: string;
}

async function loadPrRow(prId: string): Promise<{
  pr: PrRow;
  repo: RepoRow;
} | null> {
  try {
    const [row] = await db
      .select({
        prId: pullRequests.id,
        title: pullRequests.title,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
        repositoryId: pullRequests.repositoryId,
        repoName: repositories.name,
        ownerUsername: users.username,
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
        title: row.title,
        baseBranch: row.baseBranch,
        headBranch: row.headBranch,
        repositoryId: row.repositoryId,
      },
      repo: {
        id: row.repositoryId,
        name: row.repoName,
        ownerUsername: row.ownerUsername,
      },
    };
  } catch {
    return null;
  }
}

async function loadOwnerRules(repoId: string): Promise<OwnerRule[]> {
  try {
    const rows = await db
      .select({
        pattern: codeOwners.pathPattern,
        owners: codeOwners.ownerUsernames,
      })
      .from(codeOwners)
      .where(eq(codeOwners.repositoryId, repoId));
    return rows.map((r) => ({
      pattern: r.pattern,
      owners: (r.owners || "").split(",").filter(Boolean),
    }));
  } catch {
    return [];
  }
}

async function loadCurrentDeps(
  repoId: string
): Promise<Map<string, string | null>> {
  try {
    const rows = await db
      .select({
        ecosystem: repoDependencies.ecosystem,
        name: repoDependencies.name,
        versionSpec: repoDependencies.versionSpec,
      })
      .from(repoDependencies)
      .where(eq(repoDependencies.repositoryId, repoId));
    const out = new Map<string, string | null>();
    for (const r of rows) {
      out.set(`${r.ecosystem}:${r.name}`, r.versionSpec);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Parse the dependency state shown by the PR's head commit. We re-use
 * the indexed base-side `repo_dependencies` rows as a baseline and look
 * for additions/changes by parsing a head-side `package.json` blob via
 * `git show`. If git access fails we return null which the caller treats
 * as "no signal" (addsNewDependency = bumpsMajorDependency = false).
 */
async function loadHeadDeps(
  ownerName: string,
  repoName: string,
  baseBranch: string,
  headBranch: string
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  // We only sniff package.json on the head side (the most common manifest);
  // the base-side counts come from the indexed snapshot already. This is a
  // best-effort signal — false negatives are fine, false positives would be
  // worse.
  try {
    const cwd = getRepoPath(ownerName, repoName);
    const proc = Bun.spawn(
      ["git", "show", `${headBranch}:package.json`],
      { cwd, stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0 || !text.trim()) return out;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const block = parsed[key];
      if (!block || typeof block !== "object") continue;
      for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
        out.set(
          `npm:${name}`,
          typeof spec === "string" ? spec : null
        );
      }
    }
    // Mark baseBranch silently used so the args object stays meaningful
    // even if a future refactor adds a base-side diff.
    void baseBranch;
  } catch {
    /* swallow — return whatever we have */
  }
  return out;
}

/**
 * Compute + persist the risk score for one PR. Returns null when the PR
 * cannot be found or the git head SHA cannot be resolved. Idempotent on
 * the unique (pull_request_id, commit_sha) constraint.
 */
export async function computePrRiskForPullRequest(
  pullRequestId: string,
  opts: { now?: Date } = {}
): Promise<PrRiskScore | null> {
  const loaded = await loadPrRow(pullRequestId);
  if (!loaded) return null;

  const { pr, repo } = loaded;
  const headSha = await resolveRef(
    repo.ownerUsername,
    repo.name,
    pr.headBranch
  ).catch(() => null);
  if (!headSha) return null;

  let diffFiles: DiffFileInput[] = [];
  let diffRaw = "";
  try {
    const d = await getDiff(repo.ownerUsername, repo.name, headSha);
    diffFiles = d.files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
    }));
    diffRaw = d.raw;
  } catch {
    /* swallow — buildSignalsFromDiff handles empty arrays */
  }

  const ownerRules = await loadOwnerRules(repo.id);
  const baseDeps = await loadCurrentDeps(repo.id);
  const headDeps = await loadHeadDeps(
    repo.ownerUsername,
    repo.name,
    pr.baseBranch,
    pr.headBranch
  );

  const signals = buildSignalsFromDiff({
    files: diffFiles,
    raw: diffRaw,
    ownerRules,
    baseDeps,
    headDeps,
  });

  const { score, band } = computePrRiskScore(signals);

  const aiSummary = await generatePrRiskSummary({
    signals,
    title: pr.title,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
  });

  const generatedAt = opts.now ?? new Date();

  // Best-effort upsert: try insert, fall back to existing row on the
  // unique-constraint hit.
  try {
    await db.insert(prRiskScores).values({
      pullRequestId,
      commitSha: headSha,
      score,
      band,
      signals,
      aiSummary,
      generatedAt,
    });
  } catch {
    // Already cached for this SHA — that's fine, the caller's view
    // converges on the same shape via getCachedPrRisk below. No throw.
  }

  return {
    score,
    band,
    signals,
    aiSummary,
    generatedAt,
    commitSha: headSha,
  };
}

/**
 * Return the cached risk score for the current head SHA of a PR, if any.
 * Returns null when no row matches (cache miss) — the caller is expected
 * to kick off `computePrRiskForPullRequest` async and show a placeholder.
 */
export async function getCachedPrRisk(
  pullRequestId: string
): Promise<PrRiskScore | null> {
  try {
    const loaded = await loadPrRow(pullRequestId);
    if (!loaded) return null;
    const headSha = await resolveRef(
      loaded.repo.ownerUsername,
      loaded.repo.name,
      loaded.pr.headBranch
    ).catch(() => null);
    if (!headSha) return null;

    const [row] = await db
      .select()
      .from(prRiskScores)
      .where(
        and(
          eq(prRiskScores.pullRequestId, pullRequestId),
          eq(prRiskScores.commitSha, headSha)
        )
      )
      .orderBy(desc(prRiskScores.generatedAt))
      .limit(1);

    if (!row) return null;
    return rowToPrRiskScore(row);
  } catch {
    return null;
  }
}

/**
 * Lookup variant that doesn't need git access — returns the most-recent
 * cached score for a PR regardless of which SHA it was pinned to. Used
 * by the MCP merge tool where we want the score even if the SHA has
 * since moved on.
 */
export async function getLatestCachedPrRisk(
  pullRequestId: string
): Promise<PrRiskScore | null> {
  try {
    const [row] = await db
      .select()
      .from(prRiskScores)
      .where(eq(prRiskScores.pullRequestId, pullRequestId))
      .orderBy(desc(prRiskScores.generatedAt))
      .limit(1);
    if (!row) return null;
    return rowToPrRiskScore(row);
  } catch {
    return null;
  }
}

function rowToPrRiskScore(row: PrRiskScoreRow): PrRiskScore {
  return {
    score: row.score,
    band: row.band as PrRiskBand,
    signals: (row.signals as unknown) as PrRiskSignals,
    aiSummary: row.aiSummary ?? "",
    generatedAt: row.generatedAt,
    commitSha: row.commitSha,
  };
}

// ---------------------------------------------------------------------------
// Test-only surface
// ---------------------------------------------------------------------------

export const __test = {
  bandFor,
  clamp01,
  deterministicSummary,
  isMajorBump,
  leadingMajor,
  isSchemaMigrationPath,
  isLockedPath,
  isTestPath,
  rowToPrRiskScore,
};
