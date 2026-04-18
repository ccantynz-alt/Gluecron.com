/**
 * Block I9 — Repository mirroring.
 *
 * Pull-style mirroring: a mirrored repo has an upstream URL that we
 * periodically `git fetch` from. We run it as `git remote update` into
 * the bare repo so refs/heads/* are kept in sync with upstream's.
 *
 * SECURITY: only http(s) and git:// URLs are accepted. We refuse any URL
 * with shell metacharacters, `file://`, `ssh://`, or paths that could
 * escape the bare repo. Credentials embedded in URLs are allowed (the
 * caller decides whether to persist them) but stripped from logs.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import {
  repoMirrors,
  repoMirrorRuns,
  repositories,
  users,
} from "../db/schema";
import { getRepoPath } from "../git/repository";

const MIRROR_REMOTE_NAME = "gluecron-mirror";
const FETCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Pure — validates an upstream URL for use as a mirror. */
export function validateUpstreamUrl(url: string): ValidationResult {
  if (!url || typeof url !== "string") {
    return { ok: false, error: "URL is required" };
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "URL is required" };
  }
  if (trimmed.length > 2048) {
    return { ok: false, error: "URL too long" };
  }
  // Reject shell metacharacters that Bun.spawn would pass through safely,
  // but which should never appear in a legitimate git URL.
  if (/[\s;&|`$\\<>]/.test(trimmed)) {
    return { ok: false, error: "URL contains invalid characters" };
  }
  // Accept only https/http/git schemes. Reject ssh/file/local paths —
  // ssh needs key management we don't have yet, file:// lets the user
  // escape into the server's filesystem.
  const allowed = /^(https?:\/\/|git:\/\/)/i;
  if (!allowed.test(trimmed)) {
    return { ok: false, error: "URL must start with https://, http://, or git://" };
  }
  return { ok: true };
}

/** Strip credentials from a URL for safe logging. */
export function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

export interface UpsertMirrorInput {
  repositoryId: string;
  upstreamUrl: string;
  intervalMinutes?: number;
  isEnabled?: boolean;
}

/** Create or update the mirror config for a repository. */
export async function upsertMirror(
  input: UpsertMirrorInput
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const v = validateUpstreamUrl(input.upstreamUrl);
  if (!v.ok) return { ok: false, error: v.error! };

  try {
    const [existing] = await db
      .select()
      .from(repoMirrors)
      .where(eq(repoMirrors.repositoryId, input.repositoryId))
      .limit(1);

    if (existing) {
      await db
        .update(repoMirrors)
        .set({
          upstreamUrl: input.upstreamUrl.trim(),
          intervalMinutes: input.intervalMinutes ?? existing.intervalMinutes,
          isEnabled: input.isEnabled ?? existing.isEnabled,
          updatedAt: new Date(),
        })
        .where(eq(repoMirrors.id, existing.id));
      return { ok: true, id: existing.id };
    }

    const [row] = await db
      .insert(repoMirrors)
      .values({
        repositoryId: input.repositoryId,
        upstreamUrl: input.upstreamUrl.trim(),
        intervalMinutes: input.intervalMinutes ?? 1440,
        isEnabled: input.isEnabled ?? true,
      })
      .returning({ id: repoMirrors.id });
    return { ok: true, id: row.id };
  } catch (err) {
    console.error("[mirrors] upsertMirror error:", err);
    return { ok: false, error: "Failed to save mirror configuration" };
  }
}

export async function deleteMirror(repositoryId: string): Promise<void> {
  try {
    await db
      .delete(repoMirrors)
      .where(eq(repoMirrors.repositoryId, repositoryId));
  } catch (err) {
    console.error("[mirrors] deleteMirror error:", err);
  }
}

export async function getMirrorForRepo(repositoryId: string) {
  try {
    const [row] = await db
      .select()
      .from(repoMirrors)
      .where(eq(repoMirrors.repositoryId, repositoryId))
      .limit(1);
    return row || null;
  } catch {
    return null;
  }
}

export async function listRecentRuns(
  mirrorId: string,
  limit = 20
): Promise<Array<typeof repoMirrorRuns.$inferSelect>> {
  try {
    return await db
      .select()
      .from(repoMirrorRuns)
      .where(eq(repoMirrorRuns.mirrorId, mirrorId))
      .orderBy(desc(repoMirrorRuns.startedAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * Execute one sync run for a mirror. Returns the run row after completion.
 * Safe to call concurrently per-repo (we'd still end up fetching serially
 * because git locks `packed-refs` during fetch).
 */
export async function runMirrorSync(
  mirrorId: string
): Promise<{ ok: boolean; message: string; exitCode: number }> {
  // Load mirror + owning repo in one shot.
  const [row] = await db
    .select({
      mirror: repoMirrors,
      repoName: repositories.name,
      ownerName: users.username,
    })
    .from(repoMirrors)
    .innerJoin(repositories, eq(repoMirrors.repositoryId, repositories.id))
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repoMirrors.id, mirrorId))
    .limit(1);

  if (!row) {
    return { ok: false, message: "mirror not found", exitCode: -1 };
  }
  if (!row.mirror.isEnabled) {
    return { ok: false, message: "mirror disabled", exitCode: -1 };
  }

  const repoPath = getRepoPath(row.ownerName, row.repoName);

  const [runRow] = await db
    .insert(repoMirrorRuns)
    .values({ mirrorId, status: "running" })
    .returning();

  const url = row.mirror.upstreamUrl;
  let exitCode = -1;
  let stdout = "";
  let stderr = "";

  try {
    // Ensure the remote exists and points at the current URL.
    await runGit(["git", "remote", "remove", MIRROR_REMOTE_NAME], repoPath);
    const addRes = await runGit(
      ["git", "remote", "add", MIRROR_REMOTE_NAME, url],
      repoPath
    );
    if (addRes.exitCode !== 0) {
      throw new Error(`remote add failed: ${addRes.stderr}`);
    }

    const fetchRes = await runGit(
      [
        "git",
        "fetch",
        "--prune",
        "--tags",
        "--no-write-fetch-head",
        MIRROR_REMOTE_NAME,
        "+refs/heads/*:refs/heads/*",
      ],
      repoPath,
      FETCH_TIMEOUT_MS
    );
    exitCode = fetchRes.exitCode;
    stdout = fetchRes.stdout;
    stderr = fetchRes.stderr;
    if (exitCode !== 0) {
      throw new Error(stderr.slice(0, 4000) || "git fetch failed");
    }

    const messageLines: string[] = [];
    if (stdout.trim()) messageLines.push(`stdout:\n${stdout.trim()}`);
    if (stderr.trim()) messageLines.push(`stderr:\n${stderr.trim()}`);
    const message =
      messageLines.join("\n\n").slice(0, 4000) || "Mirror synced (no changes)";

    await db
      .update(repoMirrorRuns)
      .set({
        finishedAt: new Date(),
        status: "ok",
        message,
        exitCode,
      })
      .where(eq(repoMirrorRuns.id, runRow.id));

    await db
      .update(repoMirrors)
      .set({
        lastSyncedAt: new Date(),
        lastStatus: "ok",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(repoMirrors.id, mirrorId));

    return { ok: true, message, exitCode };
  } catch (err: any) {
    const errMsg = String(err?.message || err || "unknown error").slice(0, 4000);
    await db
      .update(repoMirrorRuns)
      .set({
        finishedAt: new Date(),
        status: "error",
        message: errMsg,
        exitCode,
      })
      .where(eq(repoMirrorRuns.id, runRow.id));

    await db
      .update(repoMirrors)
      .set({
        lastSyncedAt: new Date(),
        lastStatus: "error",
        lastError: errMsg,
        updatedAt: new Date(),
      })
      .where(eq(repoMirrors.id, mirrorId));

    return { ok: false, message: errMsg, exitCode };
  }
}

// ---------- Internal ----------

async function runGit(
  cmd: string[],
  cwd: string,
  timeoutMs = 60_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0", // never prompt for creds
      },
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    return { exitCode, stdout, stderr };
  } catch (err: any) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: String(err?.message || err || "spawn failed"),
    };
  }
}

/** Returns mirrors that are due for a sync (used by admin cron trigger). */
export async function listDueMirrors(
  now: Date = new Date()
): Promise<Array<{ id: string; repositoryId: string; upstreamUrl: string }>> {
  try {
    const rows = await db
      .select()
      .from(repoMirrors)
      .where(eq(repoMirrors.isEnabled, true));
    const due: Array<{
      id: string;
      repositoryId: string;
      upstreamUrl: string;
    }> = [];
    for (const r of rows) {
      if (!r.lastSyncedAt) {
        due.push({
          id: r.id,
          repositoryId: r.repositoryId,
          upstreamUrl: r.upstreamUrl,
        });
        continue;
      }
      const last = new Date(r.lastSyncedAt as any).getTime();
      const elapsedMin = (now.getTime() - last) / 60000;
      if (elapsedMin >= r.intervalMinutes) {
        due.push({
          id: r.id,
          repositoryId: r.repositoryId,
          upstreamUrl: r.upstreamUrl,
        });
      }
    }
    return due;
  } catch {
    return [];
  }
}

/** Run sync for every due mirror. Returns summary counts. */
export async function syncAllDue(): Promise<{
  total: number;
  ok: number;
  failed: number;
}> {
  const due = await listDueMirrors();
  let ok = 0;
  let failed = 0;
  for (const m of due) {
    const r = await runMirrorSync(m.id);
    if (r.ok) ok++;
    else failed++;
  }
  return { total: due.length, ok, failed };
}

// Suppress unused import warning for `and`.
void and;

export const __internal = {
  MIRROR_REMOTE_NAME,
  FETCH_TIMEOUT_MS,
};
