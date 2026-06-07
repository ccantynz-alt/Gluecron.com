/**
 * Per-PR runnable sandboxes (migration 0067).
 *
 * Every open PR can be reified into an *executable* sandbox so reviewers
 * try the change live before merging instead of pulling the branch
 * locally. The sandbox URL is computed deterministically from PR number +
 * owner + repo so we can render it the moment a sandbox is enqueued —
 * even while the underlying container is still spinning up.
 *
 *   https://pr-<n>-<owner>-<repo>.sandbox.gluecron.com
 *
 * The domain suffix is configurable via `PR_SANDBOX_DOMAIN` so self-hosted
 * installs can point it at their own wildcard subdomain. The default is
 * intentionally distinct from `preview.gluecron.com` (migration 0062) so
 * read-only previews and runnable sandboxes never collide on the same
 * hostname.
 *
 * Philosophy (mirrors branch-previews.ts): never throw — every DB call is
 * wrapped in try/catch so a Postgres outage cannot break the PR-detail
 * render path. Callers fire-and-forget where possible.
 *
 * Lifecycle:
 *   provisioning → ready      (sandbox spun up; URL is live)
 *   provisioning → failed     (build/spin-up errored)
 *   ready        → destroyed  (manual or autopilot teardown past TTL)
 *
 * Idempotency: provisioning the same PR a second time UPSERTs onto the
 * existing row (unique index on pr_id). Status flips back to
 * 'provisioning' and the prior error_message is cleared — i.e. a force-push
 * always points at the freshest head.
 */

import { and, eq, lt } from "drizzle-orm";
import { db } from "../db";
import { prSandboxes, pullRequests, repositories, users } from "../db/schema";
import type { PrSandbox } from "../db/schema";
import { slugifyForUrl } from "./branch-previews";
import { getBlob } from "../git/repository";
import { getAnthropic, isAiAvailable, MODEL_HAIKU, extractText } from "./ai-client";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** TTL since the moment a sandbox was provisioned. Mirrors the SQL default. */
export const SANDBOX_TTL_MS = 4 * 60 * 60 * 1000;

/** Cap for `error_message` so a giant stack trace can't blow up the row. */
const ERROR_MESSAGE_CAP = 2_000;

/** Default playground.yml when no file is committed AND AI is unavailable. */
const DEFAULT_PLAYGROUND_YML = `# .gluecron/playground.yml — auto-generated default.
# Customize and commit this file under .gluecron/playground.yml on your
# repo to control how PR sandboxes are provisioned.
runtime: docker
image: node:20-alpine
ports: [3000]
seed:
  - "npm install"
command: "npm start"
env:
  NODE_ENV: development
`;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Compute the sandbox URL for `<owner>/<repo>` PR `#n`. Pure — exported
 * so route handlers + the UI can render it without going through the DB.
 */
export function buildSandboxUrl(
  prNumber: number,
  ownerName: string,
  repoName: string
): string {
  const domain = (
    process.env.PR_SANDBOX_DOMAIN || "sandbox.gluecron.com"
  ).replace(/^https?:\/\//, "");
  const repoSlug = slugifyForUrl(`${ownerName}-${repoName}`);
  const n = Number.isFinite(prNumber) ? Math.max(0, Math.floor(prNumber)) : 0;
  return `https://pr-${n}-${repoSlug}.${domain}`;
}

/** Visible string for the status pill. */
export function sandboxStatusLabel(status: string): string {
  switch (status) {
    case "provisioning":
      return "Provisioning";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "destroyed":
      return "Destroyed";
    default:
      return status;
  }
}

/** Compute "expires in" label — pure helper used by the UI. */
export function formatSandboxExpiresIn(
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

// ---------------------------------------------------------------------------
// playground.yml resolution
// ---------------------------------------------------------------------------

/**
 * Read `.gluecron/playground.yml` from the PR's head branch. Returns the
 * file contents, or `null` if the file isn't in the tree (either the repo
 * hasn't opted-in or the branch doesn't exist yet).
 *
 * Pure git read — wrapped in try/catch so a missing repo on disk degrades
 * to `null` instead of throwing into the caller.
 */
export async function readPlaygroundYml(
  ownerName: string,
  repoName: string,
  ref: string
): Promise<string | null> {
  if (!ownerName || !repoName || !ref) return null;
  try {
    const blob = await getBlob(
      ownerName,
      repoName,
      ref,
      ".gluecron/playground.yml"
    );
    if (!blob || blob.isBinary) return null;
    const content = (blob.content || "").trim();
    if (!content) return null;
    return blob.content;
  } catch {
    return null;
  }
}

/**
 * Ask Claude (Sonnet) to draft a playground.yml for a repo. Used when the
 * repo hasn't committed one. Returns the YAML body, or
 * `DEFAULT_PLAYGROUND_YML` if AI is unavailable / errors. Never throws.
 *
 * `repoHint` is a short blurb — typically `"<owner>/<repo>"` plus the PR
 * title — to give Claude enough context to pick a sensible runtime.
 */
export async function generatePlaygroundYml(
  repoHint: string
): Promise<string> {
  if (!isAiAvailable()) return DEFAULT_PLAYGROUND_YML;
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content:
            "Generate a `playground.yml` for the following repo so PR " +
            "reviewers can try the change live in a sandbox container. " +
            "Output ONLY YAML — no prose, no code fences. Required keys: " +
            "`runtime` (docker), `image`, `ports` (array), `seed` " +
            "(array of shell commands run once at startup), `command` " +
            "(the long-running process), `env` (map). Pick conservative " +
            "defaults if unsure.\n\nRepo: " +
            repoHint,
        },
      ],
    });
    const text = extractText(message).trim();
    if (!text) return DEFAULT_PLAYGROUND_YML;
    // Strip ``` fences if the model included them.
    const cleaned = text
      .replace(/^```(?:yaml|yml)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    return cleaned || DEFAULT_PLAYGROUND_YML;
  } catch (err) {
    console.warn(
      "[pr-sandbox] generatePlaygroundYml failed; using default:",
      err instanceof Error ? err.message : err
    );
    return DEFAULT_PLAYGROUND_YML;
  }
}

// ---------------------------------------------------------------------------
// Core lifecycle
// ---------------------------------------------------------------------------

export interface ProvisionArgs {
  prId: string;
  /** Override the "now" clock — only used by tests. */
  now?: () => Date;
  /** Override the URL — only used by tests. */
  sandboxUrl?: string;
  /** Override the resolved YAML — only used by tests so we don't call AI. */
  playgroundYml?: string;
}

/**
 * Provision (or re-provision) a sandbox for the given PR.
 *
 * Resolves the PR's head branch + owner/repo, computes the deterministic
 * sandbox URL, reads `.gluecron/playground.yml` from the head if present
 * (otherwise asks Claude to draft one), and upserts the row. Status starts
 * at `provisioning` — a downstream worker is responsible for flipping it
 * to `ready` / `failed` once the underlying container is up.
 *
 * Returns the row, or `null` if the PR doesn't exist or the DB is down.
 */
export async function provisionSandbox(
  args: ProvisionArgs
): Promise<PrSandbox | null> {
  if (!args.prId) return null;
  const now = (args.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + SANDBOX_TTL_MS);

  let resolved: {
    prNumber: number;
    headBranch: string;
    ownerName: string;
    repoName: string;
  } | null = null;

  try {
    const [row] = await db
      .select({
        prNumber: pullRequests.number,
        headBranch: pullRequests.headBranch,
        ownerId: repositories.ownerId,
        repoName: repositories.name,
      })
      .from(pullRequests)
      .innerJoin(
        repositories,
        eq(pullRequests.repositoryId, repositories.id)
      )
      .where(eq(pullRequests.id, args.prId))
      .limit(1);
    if (!row) return null;
    const [owner] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, row.ownerId))
      .limit(1);
    if (!owner) return null;
    resolved = {
      prNumber: row.prNumber,
      headBranch: row.headBranch,
      ownerName: owner.username,
      repoName: row.repoName,
    };
  } catch (err) {
    console.warn(
      "[pr-sandbox] resolve PR failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }

  const url =
    args.sandboxUrl ??
    buildSandboxUrl(resolved.prNumber, resolved.ownerName, resolved.repoName);

  // Resolve playground.yml — committed file wins, else ask AI, else default.
  let yml = args.playgroundYml;
  if (yml === undefined) {
    const fromGit = await readPlaygroundYml(
      resolved.ownerName,
      resolved.repoName,
      resolved.headBranch
    );
    yml =
      fromGit ??
      (await generatePlaygroundYml(
        `${resolved.ownerName}/${resolved.repoName} (PR #${resolved.prNumber})`
      ));
  }

  try {
    const [row] = await db
      .insert(prSandboxes)
      .values({
        prId: args.prId,
        status: "provisioning",
        sandboxUrl: url,
        playgroundYml: yml,
        provisionedAt: now,
        expiresAt,
        destroyedAt: null,
        errorMessage: null,
      })
      .onConflictDoUpdate({
        target: prSandboxes.prId,
        set: {
          status: "provisioning",
          sandboxUrl: url,
          playgroundYml: yml,
          provisionedAt: now,
          expiresAt,
          destroyedAt: null,
          errorMessage: null,
        },
      })
      .returning();
    return row ?? null;
  } catch (err) {
    console.warn(
      "[pr-sandbox] upsert failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Mark a sandbox as successfully spun up.
 */
export async function markSandboxReady(
  id: string,
  containerId?: string
): Promise<void> {
  if (!id) return;
  try {
    await db
      .update(prSandboxes)
      .set({
        status: "ready",
        errorMessage: null,
        ...(containerId ? { containerId } : {}),
      })
      .where(eq(prSandboxes.id, id));
  } catch (err) {
    console.warn(
      "[pr-sandbox] markReady failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Mark a sandbox as failed and record the error (truncated).
 */
export async function markSandboxFailed(
  id: string,
  error: string
): Promise<void> {
  if (!id) return;
  try {
    await db
      .update(prSandboxes)
      .set({
        status: "failed",
        errorMessage: (error || "").slice(0, ERROR_MESSAGE_CAP),
      })
      .where(eq(prSandboxes.id, id));
  } catch (err) {
    console.warn(
      "[pr-sandbox] markFailed failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Destroy a sandbox (status='destroyed' + destroyed_at = now). Idempotent.
 * A real implementation would also tell the hoster to tear down the
 * container; for v1 we just flip the row.
 */
export async function destroySandbox(
  id: string,
  now: () => Date = () => new Date()
): Promise<void> {
  if (!id) return;
  try {
    await db
      .update(prSandboxes)
      .set({ status: "destroyed", destroyedAt: now() })
      .where(eq(prSandboxes.id, id));
  } catch (err) {
    console.warn(
      "[pr-sandbox] destroy failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Look up the sandbox row for a PR, or null if there isn't one. Used by
 * the PR detail page + the JSON status endpoint.
 */
export async function getSandboxForPr(
  prId: string
): Promise<PrSandbox | null> {
  if (!prId) return null;
  try {
    const [row] = await db
      .select()
      .from(prSandboxes)
      .where(eq(prSandboxes.prId, prId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Autopilot task: tear down every sandbox whose `expires_at` is in the
 * past. Already-destroyed/failed rows are skipped so the loop stays cheap.
 * Returns the number of rows transitioned for observability.
 */
export async function expireOldSandboxes(
  now: () => Date = () => new Date()
): Promise<number> {
  try {
    const ready = await db
      .update(prSandboxes)
      .set({ status: "destroyed", destroyedAt: now() })
      .where(
        and(
          lt(prSandboxes.expiresAt, now()),
          eq(prSandboxes.status, "ready")
        )
      )
      .returning({ id: prSandboxes.id });
    const stuck = await db
      .update(prSandboxes)
      .set({ status: "destroyed", destroyedAt: now() })
      .where(
        and(
          lt(prSandboxes.expiresAt, now()),
          eq(prSandboxes.status, "provisioning")
        )
      )
      .returning({ id: prSandboxes.id });
    return ready.length + stuck.length;
  } catch (err) {
    console.warn(
      "[pr-sandbox] expireOldSandboxes failed:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}
