/**
 * `gluecron/cache@v1` — RESTORE-only cache action (v1 scope).
 *
 * Looks up `workflow_run_cache` by (repoId, key, scope='repo') and unpacks
 * the stored tar archive into `ctx.workspace/<path>`. If no exact key hit,
 * tries each `restoreKeys` entry as a prefix match ordered by most-recently
 * used. Sets `cache-hit` output to 'true' or 'false'.
 *
 * TODO (v2): cache SAVE on job success. The deferred design is for the
 * runner to honor a `save-cache: true` flag emitted by this action and
 * call a `saveCache(ctx, key, path)` helper at end-of-job. Implementing
 * save inline here is error-prone (we'd need a post-hook) and the spec
 * explicitly endorsed shipping restore-only for v1. Size cap logic is
 * stubbed below so it's trivial to wire up later.
 *
 * Failure tolerance: any error — DB miss, tar failure, unknown scope —
 * results in `cache-hit: false` with exitCode 0. Caching is an optimization;
 * losing it must never break a pipeline.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ActionHandler, ActionContext } from "../action-registry";
import { db } from "../../db";
import { workflowRunCache } from "../../db/schema";

// 100MB cap — reserved for the eventual save path. Kept here so both
// halves of the action share the constant when v2 lands.
export const MAX_CACHE_BYTES = 100 * 1024 * 1024;

function parseInputs(ctx: ActionContext): {
  key: string;
  path: string;
  restoreKeys: string[];
} | null {
  const w = ctx.with || {};
  const key = typeof w.key === "string" ? w.key : "";
  const path = typeof w.path === "string" ? w.path : "";
  const restoreKeysRaw = w.restoreKeys ?? w["restore-keys"];
  const restoreKeys = Array.isArray(restoreKeysRaw)
    ? restoreKeysRaw.filter((k): k is string => typeof k === "string")
    : [];
  if (!key || !path) return null;
  return { key, path, restoreKeys };
}

/**
 * Find a cache row for this repo matching either the exact key or any
 * of the prefix restoreKeys. Returns the first hit (prefix matches are
 * ordered by `last_accessed_at DESC`).
 */
async function lookupCache(
  repoId: string,
  key: string,
  restoreKeys: string[]
): Promise<
  | { hit: true; id: string; content: Buffer; matchedKey: string; exact: boolean }
  | { hit: false }
> {
  // Exact match first.
  const exact = await db
    .select()
    .from(workflowRunCache)
    .where(
      and(
        eq(workflowRunCache.repositoryId, repoId),
        eq(workflowRunCache.cacheKey, key),
        eq(workflowRunCache.scope, "repo"),
        isNull(workflowRunCache.scopeRef)
      )
    )
    .limit(1);
  const exactRow = exact[0];
  if (exactRow) {
    return {
      hit: true,
      id: exactRow.id,
      content: normalizeBytea(exactRow.content),
      matchedKey: exactRow.cacheKey,
      exact: true,
    };
  }

  // Prefix fallbacks (LRU order).
  for (const prefix of restoreKeys) {
    if (!prefix) continue;
    const rows = await db
      .select()
      .from(workflowRunCache)
      .where(
        and(
          eq(workflowRunCache.repositoryId, repoId),
          eq(workflowRunCache.scope, "repo"),
          isNull(workflowRunCache.scopeRef),
          sql`${workflowRunCache.cacheKey} LIKE ${prefix + "%"}`
        )
      )
      .orderBy(sql`${workflowRunCache.lastAccessedAt} DESC`)
      .limit(1);
    const row = rows[0];
    if (row) {
      return {
        hit: true,
        id: row.id,
        content: normalizeBytea(row.content),
        matchedKey: row.cacheKey,
        exact: false,
      };
    }
  }

  return { hit: false };
}

/**
 * `content` arrives as a Buffer, Uint8Array, or (if the driver ran through
 * text serialization) a base64/hex string. Normalize to Buffer.
 */
function normalizeBytea(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === "string") {
    // Postgres `bytea` text encoding can be `\x…` hex. Handle defensively.
    if (raw.startsWith("\\x")) return Buffer.from(raw.slice(2), "hex");
    // Otherwise assume base64 (matches workflow-artifacts convention).
    try {
      return Buffer.from(raw, "base64");
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

async function unpackTar(content: Buffer, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  // Write the archive to a tmp file then untar. Piping through stdin works
  // but a tmp file avoids subtle Bun subprocess stdin EAGAIN edge cases.
  const tmpPath = join(
    tmpdir(),
    `gluecron-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.tar`
  );
  await Bun.write(tmpPath, content);
  try {
    const proc = Bun.spawn(["tar", "-xf", tmpPath, "-C", destDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } finally {
    try {
      await Bun.file(tmpPath).exists();
      // Best-effort cleanup; ignore errors.
      await import("fs/promises").then((fs) => fs.unlink(tmpPath)).catch(() => {});
    } catch {
      /* noop */
    }
  }
}

async function touchLastAccessed(id: string): Promise<void> {
  try {
    await db
      .update(workflowRunCache)
      .set({ lastAccessedAt: new Date() })
      .where(eq(workflowRunCache.id, id));
  } catch {
    // Non-fatal — LRU accuracy is best-effort.
  }
}

export const cacheAction: ActionHandler = {
  name: "gluecron/cache",
  version: "v1",
  async run(ctx): Promise<import("../action-registry").ActionResult> {
    // Every failure path below returns exitCode 0 with cache-hit=false so
    // the pipeline keeps flowing. This is load-bearing behaviour.
    try {
      const inputs = parseInputs(ctx);
      if (!inputs) {
        return {
          exitCode: 0,
          outputs: { "cache-hit": "false" },
          stderr: "cache: missing required inputs `key` and `path` — skipping",
        };
      }

      const result = await lookupCache(
        ctx.repoId,
        inputs.key,
        inputs.restoreKeys
      );

      if (!result.hit) {
        return {
          exitCode: 0,
          outputs: { "cache-hit": "false" },
          stdout: `cache miss for key=${inputs.key}`,
        };
      }

      const dest = join(ctx.workspace, inputs.path);
      await unpackTar(result.content, dest);
      await touchLastAccessed(result.id);

      return {
        exitCode: 0,
        outputs: {
          "cache-hit": result.exact ? "true" : "false",
          "matched-key": result.matchedKey,
        },
        stdout: `cache ${result.exact ? "hit" : "partial hit"} for key=${inputs.key} (matched=${result.matchedKey})`,
      };
    } catch (err) {
      // Fail-open: swallow and report as miss.
      return {
        exitCode: 0,
        outputs: { "cache-hit": "false" },
        stderr:
          "cache error (non-fatal): " +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  },
};
