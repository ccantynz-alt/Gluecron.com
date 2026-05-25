/**
 * Per-branch preview URLs (migration 0062).
 *
 * Every push to a non-default branch enqueues a "preview build" row.
 * For v1 the row + URL are the deliverable — actual hosting (Caddy /
 * nginx vhost provisioning, container spin-up) is a follow-up. The
 * preview URL is computed deterministically from the branch and repo
 * names so it can be shown immediately, even while the build is still
 * in flight or, in the no-hosting case, forever.
 *
 * URL pattern:
 *
 *   https://${branchSlug}-${repoSlug}.preview.gluecron.com
 *
 * The domain suffix is configurable via the `PREVIEW_DOMAIN` env var so
 * self-hosted installs can swap it for their own wildcard subdomain
 * (e.g. `*.preview.acme.dev`). Owner and repo are slug-encoded so that
 * branch names containing `/` (e.g. `feat/foo`) collapse safely into a
 * single hostname label.
 *
 * Philosophy (mirrors workflow-runner.ts / post-receive.ts): never
 * throw — every DB call is wrapped in try/catch so a Postgres outage
 * cannot break the push path. Callers fire-and-forget.
 */

import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { branchPreviews, type BranchPreview } from "../db/schema";

/** TTL since the last push to the branch. */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Slugify a string into a single DNS label.
 *   - lowercase
 *   - replace any non-alphanumeric run with `-`
 *   - strip leading/trailing `-`
 *   - clip to 50 chars (RFC 1035 says a label is <= 63; we leave headroom
 *     so the joined "${branch}-${repo}" still fits under 63 in most cases)
 *
 * Exported for tests + UI helpers.
 */
export function slugifyForUrl(value: string): string {
  return (value || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Compute the preview URL for `<owner>/<repo>@<branch>`. Pure — exported
 * so route handlers + the UI can render it without going through the DB.
 */
export function buildPreviewUrl(
  ownerName: string,
  repoName: string,
  branchName: string
): string {
  const domain = (process.env.PREVIEW_DOMAIN || "preview.gluecron.com").replace(
    /^https?:\/\//,
    ""
  );
  const repoSlug = slugifyForUrl(`${ownerName}-${repoName}`);
  const branchSlug = slugifyForUrl(branchName) || "branch";
  return `https://${branchSlug}-${repoSlug}.${domain}`;
}

export interface EnqueueArgs {
  repositoryId: string;
  ownerName: string;
  repoName: string;
  branchName: string;
  commitSha: string;
  /** Override the computed URL — only used by tests. */
  previewUrl?: string;
  /** Override the "now" clock — only used by tests. */
  now?: () => Date;
}

/**
 * Upsert a preview-build row for the given branch.
 *
 * Pushing the same branch again replaces commit_sha, bumps
 * build_started_at, resets status to 'building', and clears any prior
 * error_message. The unique index on (repository_id, branch_name)
 * guarantees there's exactly one row per branch.
 *
 * Returns the inserted/updated row, or `null` if the DB is unavailable
 * or the underlying table is missing (graceful no-op).
 */
export async function enqueuePreviewBuild(
  args: EnqueueArgs
): Promise<BranchPreview | null> {
  if (!args.repositoryId || !args.branchName || !args.commitSha) return null;
  const now = (args.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS);
  const url =
    args.previewUrl ??
    buildPreviewUrl(args.ownerName, args.repoName, args.branchName);

  try {
    const [row] = await db
      .insert(branchPreviews)
      .values({
        repositoryId: args.repositoryId,
        branchName: args.branchName,
        commitSha: args.commitSha,
        previewUrl: url,
        status: "building",
        buildStartedAt: now,
        buildCompletedAt: null,
        expiresAt,
        errorMessage: null,
      })
      .onConflictDoUpdate({
        target: [branchPreviews.repositoryId, branchPreviews.branchName],
        set: {
          commitSha: args.commitSha,
          previewUrl: url,
          status: "building",
          buildStartedAt: now,
          buildCompletedAt: null,
          expiresAt,
          errorMessage: null,
        },
      })
      .returning();
    return row ?? null;
  } catch (err) {
    console.warn(
      "[branch-previews] enqueue failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Look up the current preview row for `repo/branch`, or null if there
 * isn't one. Used by the /previews list page + the PR detail pill.
 */
export async function getPreviewForBranch(
  repositoryId: string,
  branchName: string
): Promise<BranchPreview | null> {
  if (!repositoryId || !branchName) return null;
  try {
    const [row] = await db
      .select()
      .from(branchPreviews)
      .where(
        and(
          eq(branchPreviews.repositoryId, repositoryId),
          eq(branchPreviews.branchName, branchName)
        )
      )
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Mark a preview as successfully built. `previewUrl` is optional — the
 * URL is already recorded at enqueue time, but a hoster can update it
 * here if it picked a different host (e.g. promoted to a custom domain).
 */
export async function markPreviewReady(
  id: string,
  previewUrl?: string,
  now: () => Date = () => new Date()
): Promise<void> {
  if (!id) return;
  try {
    await db
      .update(branchPreviews)
      .set({
        status: "ready",
        buildCompletedAt: now(),
        errorMessage: null,
        ...(previewUrl ? { previewUrl } : {}),
      })
      .where(eq(branchPreviews.id, id));
  } catch (err) {
    console.warn(
      "[branch-previews] markReady failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Mark a preview as failed and record the error. `error` is truncated
 * to avoid blowing up the row on very large stack traces.
 */
export async function markPreviewFailed(
  id: string,
  error: string,
  now: () => Date = () => new Date()
): Promise<void> {
  if (!id) return;
  try {
    await db
      .update(branchPreviews)
      .set({
        status: "failed",
        buildCompletedAt: now(),
        errorMessage: (error || "").slice(0, 2_000),
      })
      .where(eq(branchPreviews.id, id));
  } catch (err) {
    console.warn(
      "[branch-previews] markFailed failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Autopilot task: flip every active row whose `expires_at` is in the
 * past to status='expired'. Already-expired/failed rows are not
 * re-touched so the autopilot loop is cheap to run hourly. Returns the
 * number of rows transitioned for observability.
 */
export async function expireOldPreviews(
  now: () => Date = () => new Date()
): Promise<number> {
  try {
    const rows = await db
      .update(branchPreviews)
      .set({ status: "expired" })
      .where(
        and(
          lt(branchPreviews.expiresAt, now()),
          // Only flip non-terminal-but-non-expired rows. We keep `failed`
          // as-is so users still see why the last build failed.
          eq(branchPreviews.status, "ready")
        )
      )
      .returning({ id: branchPreviews.id });
    // Also expire still-building rows that have been stuck past the TTL.
    const stuck = await db
      .update(branchPreviews)
      .set({ status: "expired" })
      .where(
        and(
          lt(branchPreviews.expiresAt, now()),
          eq(branchPreviews.status, "building")
        )
      )
      .returning({ id: branchPreviews.id });
    return rows.length + stuck.length;
  } catch (err) {
    console.warn(
      "[branch-previews] expireOldPreviews failed:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

/**
 * List every preview row for a repo, newest first by build_started_at.
 * Used by the /previews list page + the JSON API.
 */
export async function listPreviewsForRepo(
  repositoryId: string,
  limit = 100
): Promise<BranchPreview[]> {
  if (!repositoryId) return [];
  try {
    const rows = await db
      .select()
      .from(branchPreviews)
      .where(eq(branchPreviews.repositoryId, repositoryId))
      .limit(Math.max(1, Math.min(500, limit)));
    // Sort in JS — the table is tiny per-repo, no need for an extra index.
    rows.sort((a, b) => {
      const at = a.buildStartedAt?.getTime?.() ?? 0;
      const bt = b.buildStartedAt?.getTime?.() ?? 0;
      return bt - at;
    });
    return rows;
  } catch {
    return [];
  }
}

/**
 * Compute a human-readable "expires in" label like "23h 14m" / "less
 * than a minute" / "expired". Pure — used by the list view + API.
 */
export function formatExpiresIn(
  expiresAt: Date | null | undefined,
  now: Date = new Date()
): string {
  if (!expiresAt) return "—";
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${mins}m`;
}

/** Visible string for the status pill. */
export function previewStatusLabel(status: string): string {
  switch (status) {
    case "building":
      return "Building";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "expired":
      return "Expired";
    default:
      return status;
  }
}
