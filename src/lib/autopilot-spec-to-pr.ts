/**
 * Autopilot task — spec-to-PR loop.
 *
 * Every tick, walk every repo the owner-user maintains and look at the
 * files under `.gluecron/specs/*.md`. For each spec whose front-matter is
 * `status: ready` AND that does not yet have an open PR pointing at the
 * same spec path, dispatch `runSpecToPr`.
 *
 * Mirrors the dependency-injection shape of `ai-build-tasks.ts`:
 *   - `findCandidates` — surface ready specs across enabled repos.
 *   - `hasOpenLinkedPr`  — short-circuit if a previous tick already opened a PR.
 *   - `dispatcher`     — runs `runSpecToPr`. Tests inject a stub.
 *
 * Skip rules (graceful no-ops):
 *   - `AUTOPILOT_DISABLED=1` short-circuits the task entirely.
 *   - Missing `ANTHROPIC_API_KEY` short-circuits (the dispatcher would also
 *     refuse, but skipping here saves a DB round-trip per tick).
 *   - Repos flagged as archived are filtered out at the SQL layer.
 *
 * Never throws. Per-repo failures are logged and swallowed so one broken
 * spec can't wedge the autopilot tick.
 */

import { and, eq, like } from "drizzle-orm";
import { join } from "path";
import { db } from "../db";
import { pullRequests, repositories, users } from "../db/schema";
import { getBlob, getTreeRecursive } from "../git/repository";
import {
  AI_SPEC_PR_MARKER,
  parseFrontMatter,
  runSpecToPr,
  type RunSpecToPrResult,
} from "./spec-to-pr";

/** Hard cap to bound work per tick on big multi-tenant deployments. */
const DEFAULT_MAX_SPECS_PER_TICK = 10;
/** Per-repo cap so one busy repo can't starve the rest. */
const DEFAULT_MAX_SPECS_PER_REPO = 3;

export interface SpecToPrCandidate {
  repositoryId: string;
  ownerName: string;
  repoName: string;
  defaultBranch: string;
  /** Path inside the repo, e.g. `.gluecron/specs/foo.md`. */
  specPath: string;
}

export interface SpecToPrDispatcher {
  (args: {
    repositoryId: string;
    specPath: string;
    baseSha?: string;
  }): Promise<RunSpecToPrResult>;
}

export interface SpecToPrTaskDeps {
  /** Inject candidate finder (defaults walk every enabled repo). */
  findCandidates?: (
    limit: number,
    perRepoLimit: number
  ) => Promise<SpecToPrCandidate[]>;
  /** Inject the dedup check (looks for any PR body referencing the spec path). */
  hasOpenLinkedPr?: (
    repositoryId: string,
    specPath: string
  ) => Promise<boolean>;
  /** Inject the dispatcher (real one calls `runSpecToPr`). */
  dispatcher?: SpecToPrDispatcher;
  /** Override the per-tick cap. */
  maxSpecsPerTick?: number;
  /** Override the per-repo cap. */
  maxSpecsPerRepo?: number;
}

export interface SpecToPrTaskSummary {
  considered: number;
  dispatched: number;
  skipped: number;
  failed: number;
}

/**
 * Default candidate finder. For every non-archived repo (capped via
 * `limit`), list `.gluecron/specs/*.md` on the default branch, parse each
 * file's front-matter, and surface specs whose status is `ready`.
 *
 * We intentionally cap the per-repo result at `perRepoLimit` so one repo
 * with hundreds of ready specs can't monopolise the tick.
 */
async function defaultFindCandidates(
  limit: number,
  perRepoLimit: number
): Promise<SpecToPrCandidate[]> {
  let repoRows: Array<{
    id: string;
    name: string;
    defaultBranch: string;
    ownerName: string | null;
  }>;
  try {
    repoRows = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
        ownerName: users.username,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(repositories.isArchived, false))
      .limit(200);
  } catch (err) {
    console.error("[autopilot] spec-to-pr: repo query failed:", err);
    return [];
  }

  const out: SpecToPrCandidate[] = [];
  for (const repo of repoRows) {
    if (out.length >= limit) break;
    if (!repo.ownerName) continue;
    const defaultBranch = repo.defaultBranch || "main";
    let specPaths: string[] = [];
    try {
      const tree = await getTreeRecursive(repo.ownerName, repo.name, defaultBranch, 5000);
      if (!tree) continue;
      specPaths = tree.tree
        .filter(
          (e) =>
            e.type === "blob" &&
            e.path.startsWith(".gluecron/specs/") &&
            e.path.toLowerCase().endsWith(".md")
        )
        .map((e) => e.path)
        .slice(0, perRepoLimit * 5); // headroom — we'll filter by status next
    } catch (err) {
      console.warn(
        `[autopilot] spec-to-pr: tree scan failed for ${repo.ownerName}/${repo.name}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }

    let perRepo = 0;
    for (const path of specPaths) {
      if (perRepo >= perRepoLimit) break;
      if (out.length >= limit) break;
      try {
        const blob = await getBlob(
          repo.ownerName,
          repo.name,
          defaultBranch,
          path
        );
        if (!blob || blob.isBinary) continue;
        const parsed = parseFrontMatter(blob.content);
        const status = (parsed.frontMatter.status || "").toLowerCase();
        if (status !== "ready") continue;
        out.push({
          repositoryId: repo.id,
          ownerName: repo.ownerName,
          repoName: repo.name,
          defaultBranch,
          specPath: path,
        });
        perRepo += 1;
      } catch (err) {
        console.warn(
          `[autopilot] spec-to-pr: blob read failed for ${repo.ownerName}/${repo.name}:${path}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  return out;
}

/**
 * Default dedup check. We look for any PR (open or otherwise) whose body
 * embeds the spec path; the autopilot writes the spec path into the PR
 * body so this is a reliable signal.
 */
async function defaultHasOpenLinkedPr(
  repositoryId: string,
  specPath: string
): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          like(pullRequests.body, `%${AI_SPEC_PR_MARKER}%`),
          like(pullRequests.body, `%${specPath}%`)
        )
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Default dispatcher just calls `runSpecToPr`. */
async function defaultDispatcher(args: {
  repositoryId: string;
  specPath: string;
  baseSha?: string;
}): Promise<RunSpecToPrResult> {
  try {
    return await runSpecToPr(args);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * One iteration of the spec-to-pr loop. Returns a counts summary suitable
 * for the autopilot tick log. Never throws.
 */
export async function runSpecToPrTaskOnce(
  deps: SpecToPrTaskDeps = {}
): Promise<SpecToPrTaskSummary> {
  // Graceful gates — keep the work-skip cheap.
  if (process.env.AUTOPILOT_DISABLED === "1") {
    return { considered: 0, dispatched: 0, skipped: 0, failed: 0 };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { considered: 0, dispatched: 0, skipped: 0, failed: 0 };
  }

  const limit = deps.maxSpecsPerTick ?? DEFAULT_MAX_SPECS_PER_TICK;
  const perRepoLimit = deps.maxSpecsPerRepo ?? DEFAULT_MAX_SPECS_PER_REPO;
  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const hasOpenLinkedPr = deps.hasOpenLinkedPr ?? defaultHasOpenLinkedPr;
  const dispatcher = deps.dispatcher ?? defaultDispatcher;

  let candidates: SpecToPrCandidate[] = [];
  try {
    candidates = await findCandidates(limit, perRepoLimit);
  } catch (err) {
    console.error("[autopilot] spec-to-pr: findCandidates threw:", err);
    return { considered: 0, dispatched: 0, skipped: 0, failed: 0 };
  }

  let dispatched = 0;
  let skipped = 0;
  let failed = 0;

  for (const cand of candidates) {
    try {
      if (await hasOpenLinkedPr(cand.repositoryId, cand.specPath)) {
        skipped += 1;
        continue;
      }
      const result = await dispatcher({
        repositoryId: cand.repositoryId,
        specPath: cand.specPath,
      });
      if (result.ok) {
        dispatched += 1;
      } else {
        failed += 1;
        console.warn(
          `[autopilot] spec-to-pr: dispatch failed for ${cand.ownerName}/${cand.repoName}:${cand.specPath}: ${result.error}`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[autopilot] spec-to-pr: per-spec failure for ${cand.specPath}:`,
        err
      );
    }
  }

  return {
    considered: candidates.length,
    dispatched,
    skipped,
    failed,
  };
}

// Re-export the disk-path helper so callers can build the same paths the
// task computes internally — useful in admin tooling / observability.
export function repoDiskPath(ownerName: string, repoName: string): string {
  const base = process.env.GIT_REPOS_PATH || "./repos";
  return join(base, ownerName, `${repoName}.git`);
}

/** Test-only exports. */
export const __test = {
  defaultFindCandidates,
  defaultHasOpenLinkedPr,
  defaultDispatcher,
  DEFAULT_MAX_SPECS_PER_TICK,
  DEFAULT_MAX_SPECS_PER_REPO,
};
