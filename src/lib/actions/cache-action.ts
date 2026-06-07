/**
 * `gluecron/cache@v1` — cache action with RESTORE (load) and SAVE sides.
 *
 * RESTORE: looks up `workflow_run_cache` by (repoId, key, scope='repo') and
 * unpacks the stored tar archive into `ctx.workspace/<path>`. If no exact key
 * hit, tries each `restoreKeys` entry as a prefix match ordered by
 * most-recently used. Sets `cache-hit` output to 'true' or 'false'.
 *
 * SAVE: called by the workflow runner after a job's steps all succeed.
 * Tarballs the `path` list relative to `workdir` and upserts the archive into
 * `workflow_run_cache`. On key conflict the existing row is replaced so the
 * runner always ends up with the freshest tarball for a given key. Size cap is
 * enforced before the DB write; oversize payloads are logged and silently
 * dropped so CI never fails due to cache infrastructure.
 *
 * Failure tolerance: any error — DB miss, tar failure, unknown scope —
 * results in `cache-hit: false` (on restore) or a silent no-op (on save).
 * Caching is an optimization; losing it must never break a pipeline.
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
    `gluecron-cache-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}.tar`
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
      await import("fs/promises")
        .then((fs) => fs.unlink(tmpPath))
        .catch((err) => {
          console.warn(
            `[cache-action] tmpPath cleanup failed for ${tmpPath}:`,
            err instanceof Error ? err.message : err
          );
        });
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

/**
 * Pack `paths` (relative to `workdir`) into a gzip-compressed tar archive and
 * upsert it into `workflow_run_cache` under `key` for `repoId`.
 *
 * On key conflict the existing row is replaced. This mirrors how GitHub Actions
 * handles re-runs with the same key: the freshest content wins.
 *
 * The archive is written to a temp file first (avoids EAGAIN edge cases on
 * Bun's subprocess stdin pipe) then read back into a Buffer for the DB write.
 * Callers must treat any thrown error as non-fatal — caching failures must
 * never abort a pipeline.
 */
export async function saveCacheEntry(
  repoId: string,
  key: string,
  paths: string[],
  workdir: string
): Promise<void> {
  const validPaths = paths.filter((p) => typeof p === "string" && p.length > 0);
  if (!key || validPaths.length === 0) return;

  const tmpPath = join(
    tmpdir(),
    `gluecron-cache-save-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}.tar.gz`
  );

  try {
    const proc = Bun.spawn(
      ["tar", "-czf", tmpPath, "--", ...validPaths],
      {
        cwd: workdir,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    await proc.exited;

    const file = Bun.file(tmpPath);
    const exists = await file.exists();
    if (!exists) return;

    const arrayBuf = await file.arrayBuffer();
    const content = Buffer.from(arrayBuf);

    // Drop oversized archives silently so a large workspace never blocks CI.
    if (content.byteLength > MAX_CACHE_BYTES) {
      console.warn(
        `[cache-action] save skipped: archive for key=${key} is ${content.byteLength} bytes, exceeds cap ${MAX_CACHE_BYTES}`
      );
      return;
    }

    const contentHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", content)
    ).toString("hex");

    // Manual upsert: the unique index includes nullable `scope_ref` so
    // Postgres `ON CONFLICT (…, scope_ref)` won't fire when scope_ref IS NULL
    // (each NULL is distinct in a standard B-tree index). We do a targeted
    // UPDATE first; if zero rows were touched we INSERT instead.
    const now = new Date();
    const existing = await db
      .select({ id: workflowRunCache.id })
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

    if (existing[0]) {
      await db
        .update(workflowRunCache)
        .set({
          content,
          contentHash,
          sizeBytes: content.byteLength,
          lastAccessedAt: now,
        })
        .where(eq(workflowRunCache.id, existing[0].id));
    } else {
      await db.insert(workflowRunCache).values({
        repositoryId: repoId,
        cacheKey: key,
        scope: "repo",
        scopeRef: null,
        content,
        contentHash,
        sizeBytes: content.byteLength,
        lastAccessedAt: now,
      });
    }
  } finally {
    await import("fs/promises")
      .then((fs) => fs.unlink(tmpPath))
      .catch(() => {
        // Best-effort cleanup.
      });
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
