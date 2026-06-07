/**
 * Cloud dev environments (migration 0072).
 *
 * Hosted VS Code in the browser, one env per (repository, user). The URL
 * is computed deterministically from the env id so we can render it the
 * moment an env is enqueued — even while the underlying container is
 * still warming.
 *
 *   https://dev-<env-id>.gluecron.com
 *
 * The domain suffix is configurable via `DEV_ENV_DOMAIN` so self-hosted
 * installs can point it at their own wildcard subdomain. The default
 * intentionally lives on the bare `dev-` prefix (distinct from
 * `sandbox.gluecron.com` / `preview.gluecron.com`) so VS Code servers
 * and PR sandboxes never collide on the same hostname.
 *
 * Philosophy (mirrors pr-sandbox.ts): never throw — every DB call is
 * wrapped in try/catch so a Postgres outage cannot break the
 * /:owner/:repo/dev render path. Callers fire-and-forget where possible.
 *
 * Lifecycle:
 *   cold     → warming  → ready    (container up; VS Code Server live)
 *   warming  → failed              (build/spin-up errored)
 *   ready    → stopped             (idle sweep or manual stop)
 *   stopped  → warming → ready     (restart upserts on same row, URL stable)
 *
 * Idempotency: starting an env for the same (repo, user) twice UPSERTs
 * onto the existing row (unique index). Status flips back to 'warming'
 * and prior error_message is cleared.
 *
 * Foundation: re-uses the workflow-runner container substrate + the
 * pr-sandbox playground.yml resolution pattern. We do NOT fork
 * pr-sandbox.ts — `readDevYml` / `generateDevYml` are new but cribbed
 * from the same shape so consistency is obvious.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { devEnvs, repositories, users } from "../db/schema";
import type { DevEnv } from "../db/schema";
import { slugifyForUrl } from "./branch-previews";
import { getBlob } from "../git/repository";
import {
  getAnthropic,
  isAiAvailable,
  MODEL_HAIKU,
  extractText,
} from "./ai-client";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Default idle minutes if the caller doesn't override. Mirrors SQL default. */
export const DEFAULT_IDLE_MINUTES = 30;

/** Cap for `error_message` so a giant stack trace can't blow up the row. */
const ERROR_MESSAGE_CAP = 2_000;

/** Allowed machine sizes. */
export type MachineSize = "small" | "medium" | "large";
const ALLOWED_MACHINE_SIZES: ReadonlyArray<MachineSize> = [
  "small",
  "medium",
  "large",
];

/** Allowed env statuses. */
export type DevEnvStatus =
  | "cold"
  | "warming"
  | "ready"
  | "failed"
  | "stopped";

/** Default `.gluecron/dev.yml` when no file is committed AND AI is unavailable. */
const DEFAULT_DEV_YML = `# .gluecron/dev.yml — auto-generated default.
# Commit this file under .gluecron/dev.yml on your repo to control how
# the cloud dev environment is provisioned.
image: node:20-alpine
ports: [3000]
install:
  - npm install
postCreate: []
command: npm run dev
recommendedExtensions:
  - dbaeumer.vscode-eslint
  - esbenp.prettier-vscode
`;

// ---------------------------------------------------------------------------
// URL + label helpers (pure — exported so route handlers can render
// without going through the DB).
// ---------------------------------------------------------------------------

/**
 * Compute the VS-Code-Server URL for a dev env id. The id is slugified so
 * a UUID with dashes lands cleanly into a single DNS label.
 */
export function buildDevEnvUrl(envId: string): string {
  const domain = (process.env.DEV_ENV_DOMAIN || "gluecron.com").replace(
    /^https?:\/\//,
    ""
  );
  const slug = slugifyForUrl(envId || "unknown");
  return `https://dev-${slug}.${domain}`;
}

/** Visible string for the status pill. */
export function devEnvStatusLabel(status: string): string {
  switch (status) {
    case "cold":
      return "Cold";
    case "warming":
      return "Warming up";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return status;
  }
}

/** Validate machine-size strings coming from query params / form bodies. */
export function normalizeMachineSize(
  value: string | undefined | null
): MachineSize {
  if (!value) return "small";
  return (ALLOWED_MACHINE_SIZES as ReadonlyArray<string>).includes(value)
    ? (value as MachineSize)
    : "small";
}

// ---------------------------------------------------------------------------
// dev.yml resolution
// ---------------------------------------------------------------------------

/**
 * Read `.gluecron/dev.yml` from the repo's default branch (or the given
 * ref). Returns the file contents, or `null` if the file isn't in the
 * tree (the repo hasn't opted in) or git read fails.
 */
export async function readDevYml(
  ownerName: string,
  repoName: string,
  ref: string = "HEAD"
): Promise<string | null> {
  if (!ownerName || !repoName) return null;
  try {
    const blob = await getBlob(
      ownerName,
      repoName,
      ref,
      ".gluecron/dev.yml"
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
 * Ask Claude (Sonnet) to draft a `.gluecron/dev.yml` for a repo. Used when
 * the repo hasn't committed one. Returns the YAML body, or
 * `DEFAULT_DEV_YML` if AI is unavailable / errors. Never throws.
 */
export async function generateDevYml(repoHint: string): Promise<string> {
  if (!isAiAvailable()) return DEFAULT_DEV_YML;
  try {
    const client = getAnthropic();
    const message = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content:
            "Generate a `.gluecron/dev.yml` for the following repo so " +
            "developers can open a cloud dev environment (VS Code in the " +
            "browser) on this repo. Output ONLY YAML — no prose, no code " +
            "fences. Required keys: `image` (a docker image), `ports` " +
            "(array of ints), `install` (array of shell commands run on " +
            "first start), `postCreate` (array of shell commands run after " +
            "install), `command` (the long-running dev command), " +
            "`recommendedExtensions` (array of VS Code extension IDs). " +
            "Pick conservative defaults if unsure.\n\nRepo: " +
            repoHint,
        },
      ],
    });
    const text = extractText(message).trim();
    if (!text) return DEFAULT_DEV_YML;
    const cleaned = text
      .replace(/^```(?:yaml|yml)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    return cleaned || DEFAULT_DEV_YML;
  } catch (err) {
    console.warn(
      "[dev-env] generateDevYml failed; using default:",
      err instanceof Error ? err.message : err
    );
    return DEFAULT_DEV_YML;
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Look up an env by id. */
export async function getDevEnv(envId: string): Promise<DevEnv | null> {
  if (!envId) return null;
  try {
    const [row] = await db
      .select()
      .from(devEnvs)
      .where(eq(devEnvs.id, envId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

/** Look up the env row for a (repo, user), or null if none. */
export async function getDevEnvForOwner(
  repositoryId: string,
  ownerUserId: string
): Promise<DevEnv | null> {
  if (!repositoryId || !ownerUserId) return null;
  try {
    const [row] = await db
      .select()
      .from(devEnvs)
      .where(
        and(
          eq(devEnvs.repositoryId, repositoryId),
          eq(devEnvs.ownerUserId, ownerUserId)
        )
      )
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core lifecycle
// ---------------------------------------------------------------------------

export interface StartDevEnvArgs {
  repositoryId: string;
  ownerUserId: string;
  machineSize?: MachineSize;
  idleMinutes?: number;
  /** Override the resolved YAML — only used by tests so we don't hit AI. */
  devYml?: string;
  /** Override "now" — tests only. */
  now?: () => Date;
}

export type StartDevEnvResult =
  | {
      ok: true;
      env: DevEnv;
      /** Convenience: env.previewUrl computed eagerly. */
      url: string;
    }
  | {
      ok: false;
      reason:
        | "repo_not_found"
        | "not_opted_in"
        | "db_unavailable"
        | "invalid_input";
    };

/**
 * Start (or restart) a dev env for `(repositoryId, ownerUserId)`.
 *
 * - Refuses if the repo doesn't have `dev_envs_enabled = true`.
 * - Reads `.gluecron/dev.yml` from the repo if committed; otherwise asks
 *   Claude (Haiku) to draft one; otherwise falls back to a sane default.
 * - Upserts the env row (one per repo+user) with status='warming' and a
 *   deterministic preview_url.
 * - A downstream worker (or the workflow-runner foundation) is responsible
 *   for actually spinning the container and flipping the row to 'ready'
 *   via `markReady` — kept out of this v1 path so the route stays cheap.
 *
 * Returns the row + URL on success, or a typed reason for refusal.
 */
export async function startDevEnv(
  args: StartDevEnvArgs
): Promise<StartDevEnvResult> {
  if (!args.repositoryId || !args.ownerUserId) {
    return { ok: false, reason: "invalid_input" };
  }
  const now = (args.now ?? (() => new Date()))();
  const machineSize = normalizeMachineSize(args.machineSize);
  const idleMinutes =
    Number.isFinite(args.idleMinutes) && args.idleMinutes! > 0
      ? Math.floor(args.idleMinutes!)
      : DEFAULT_IDLE_MINUTES;

  // Repo gate — must exist and have opted in.
  let repoRow: { id: string; name: string; ownerId: string; enabled: boolean } | null = null;
  try {
    const [row] = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        ownerId: repositories.ownerId,
        enabled: repositories.devEnvsEnabled,
      })
      .from(repositories)
      .where(eq(repositories.id, args.repositoryId))
      .limit(1);
    repoRow = row ?? null;
  } catch (err) {
    console.warn(
      "[dev-env] repo lookup failed:",
      err instanceof Error ? err.message : err
    );
    return { ok: false, reason: "db_unavailable" };
  }
  if (!repoRow) return { ok: false, reason: "repo_not_found" };
  if (!repoRow.enabled) return { ok: false, reason: "not_opted_in" };

  // Resolve dev.yml — committed file wins, else ask AI, else default.
  let yml = args.devYml;
  if (yml === undefined) {
    let ownerName = "";
    try {
      const [owner] = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, repoRow.ownerId))
        .limit(1);
      ownerName = owner?.username || "";
    } catch {
      /* swallow — fall back to default */
    }
    const fromGit = ownerName
      ? await readDevYml(ownerName, repoRow.name)
      : null;
    yml =
      fromGit ??
      (await generateDevYml(`${ownerName || "?"}/${repoRow.name}`));
  }

  // Pre-compute the deterministic URL. We need the env id to slot into
  // the subdomain, so the upsert path is:
  //   1. Try insert with a NULL preview_url
  //   2. On conflict, leave preview_url as-is (existing URL is the truth)
  //   3. After the upsert resolves, if preview_url is NULL we update it
  //      with the freshly-known id.
  // This keeps the URL stable across restarts (the env id never changes
  // for a given (repo, user) pair).
  let row: DevEnv | null = null;
  try {
    const [inserted] = await db
      .insert(devEnvs)
      .values({
        repositoryId: args.repositoryId,
        ownerUserId: args.ownerUserId,
        status: "warming",
        previewUrl: null,
        containerId: null,
        machineSize,
        idleMinutes,
        devYml: yml,
        errorMessage: null,
        lastActiveAt: now,
        expiresAt: null,
      })
      .onConflictDoUpdate({
        target: [devEnvs.repositoryId, devEnvs.ownerUserId],
        set: {
          status: "warming",
          machineSize,
          idleMinutes,
          devYml: yml,
          errorMessage: null,
          lastActiveAt: now,
        },
      })
      .returning();
    row = inserted ?? null;
  } catch (err) {
    console.warn(
      "[dev-env] upsert failed:",
      err instanceof Error ? err.message : err
    );
    return { ok: false, reason: "db_unavailable" };
  }

  if (!row) return { ok: false, reason: "db_unavailable" };

  // Backfill preview_url if missing (first-ever start for this pair).
  if (!row.previewUrl) {
    const url = buildDevEnvUrl(row.id);
    try {
      await db
        .update(devEnvs)
        .set({ previewUrl: url })
        .where(eq(devEnvs.id, row.id));
      row = { ...row, previewUrl: url };
    } catch (err) {
      console.warn(
        "[dev-env] preview_url backfill failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    ok: true,
    env: row,
    url: row.previewUrl || buildDevEnvUrl(row.id),
  };
}

/**
 * Mark a dev env as successfully spun up. Called by the warmer once the
 * container is live + VS Code Server is reachable.
 */
export async function markReady(
  envId: string,
  containerId?: string
): Promise<void> {
  if (!envId) return;
  try {
    await db
      .update(devEnvs)
      .set({
        status: "ready",
        errorMessage: null,
        ...(containerId ? { containerId } : {}),
      })
      .where(eq(devEnvs.id, envId));
  } catch (err) {
    console.warn(
      "[dev-env] markReady failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Mark a dev env as failed and record the error (truncated).
 */
export async function markFailed(envId: string, error: string): Promise<void> {
  if (!envId) return;
  try {
    await db
      .update(devEnvs)
      .set({
        status: "failed",
        errorMessage: (error || "").slice(0, ERROR_MESSAGE_CAP),
      })
      .where(eq(devEnvs.id, envId));
  } catch (err) {
    console.warn(
      "[dev-env] markFailed failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Graceful shutdown — flip status to 'stopped'. The URL is intentionally
 * preserved so a later restart reuses it.
 *
 * A real implementation would also tell the hoster to tear down the
 * container; for v1 we just flip the row.
 */
export async function stopDevEnv(envId: string): Promise<void> {
  if (!envId) return;
  try {
    await db
      .update(devEnvs)
      .set({ status: "stopped", containerId: null })
      .where(eq(devEnvs.id, envId));
  } catch (err) {
    console.warn(
      "[dev-env] stopDevEnv failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Called on every URL hit to bump last_active_at. Best-effort — never
 * blocks the request even if the DB is down.
 */
export async function recordActivity(envId: string): Promise<void> {
  if (!envId) return;
  try {
    await db
      .update(devEnvs)
      .set({ lastActiveAt: new Date() })
      .where(eq(devEnvs.id, envId));
  } catch {
    /* best effort */
  }
}

/**
 * Autopilot task: stop every env where `last_active_at + idle_minutes` is
 * in the past, but only if status is 'ready' or 'warming'. Already-
 * stopped / failed rows are skipped so the loop stays cheap. Returns the
 * number of rows transitioned for observability.
 *
 * The idle window is per-row (each env carries its own `idle_minutes`)
 * so we compare against `now() - idle_minutes * interval '1 minute'`.
 */
export async function expireIdleEnvs(
  now: () => Date = () => new Date()
): Promise<number> {
  const cutoffNow = now();
  try {
    // We compute the cutoff per-row inside SQL: lastActiveAt + idleMinutes < now.
    // Drizzle's lt/eq can't combine column + literal arithmetic cleanly, so
    // we drop into a `sql` template. Postgres-only — fine for our deploy.
    const ready = await db
      .update(devEnvs)
      .set({ status: "stopped", containerId: null })
      .where(
        and(
          eq(devEnvs.status, "ready"),
          sql`${devEnvs.lastActiveAt} + (${devEnvs.idleMinutes} * interval '1 minute') < ${cutoffNow.toISOString()}::timestamptz`
        )
      )
      .returning({ id: devEnvs.id });
    const stuck = await db
      .update(devEnvs)
      .set({ status: "stopped", containerId: null })
      .where(
        and(
          eq(devEnvs.status, "warming"),
          sql`${devEnvs.lastActiveAt} + (${devEnvs.idleMinutes} * interval '1 minute') < ${cutoffNow.toISOString()}::timestamptz`
        )
      )
      .returning({ id: devEnvs.id });
    return ready.length + stuck.length;
  } catch (err) {
    console.warn(
      "[dev-env] expireIdleEnvs failed:",
      err instanceof Error ? err.message : err
    );
    // Fallback: client-side filter (used when the SQL template is rejected
    // by the test driver). We pull idle-candidate rows and compute the
    // cutoff in JS. Bounded by the small expected env count.
    try {
      const rows = await db.select().from(devEnvs);
      let stopped = 0;
      for (const r of rows) {
        if (r.status !== "ready" && r.status !== "warming") continue;
        const cutoff =
          (r.lastActiveAt?.getTime?.() ?? 0) +
          (r.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
        if (cutoff < cutoffNow.getTime()) {
          await db
            .update(devEnvs)
            .set({ status: "stopped", containerId: null })
            .where(eq(devEnvs.id, r.id));
          stopped++;
        }
      }
      return stopped;
    } catch (err2) {
      console.warn(
        "[dev-env] expireIdleEnvs fallback failed:",
        err2 instanceof Error ? err2.message : err2
      );
      return 0;
    }
  }
}

/**
 * Convenience: also expire rows whose `expires_at` is past (when set).
 * Currently unused by the route layer but exposed so admins can wire a
 * hard cap if/when they want one.
 */
export async function expireHardCappedEnvs(
  now: () => Date = () => new Date()
): Promise<number> {
  try {
    const stopped = await db
      .update(devEnvs)
      .set({ status: "stopped", containerId: null })
      .where(
        and(lt(devEnvs.expiresAt, now()), eq(devEnvs.status, "ready"))
      )
      .returning({ id: devEnvs.id });
    return stopped.length;
  } catch (err) {
    console.warn(
      "[dev-env] expireHardCappedEnvs failed:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}
