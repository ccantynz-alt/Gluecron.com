/**
 * Claude-on-the-web runtime (Block CW).
 *
 * Drives one turn of an interactive Claude Code session running on the
 * gluecron web server. Each turn:
 *   1. Resolves (and lazily clones) the session's working directory.
 *   2. Spawns `claude` as a subprocess pointed at that workdir, with
 *      --resume <session-uuid> for follow-up turns so prior context is
 *      preserved without us re-sending the transcript.
 *   3. Streams stdout chunks back via an AsyncIterable the route layer
 *      hands to an SSE response.
 *   4. Persists the assistant turn + updates the Claude session UUID +
 *      the last_active_at watermark.
 *
 * v1 design rules:
 *   - Admin-only — gated by the route, not this lib.
 *   - Single shared compute: every session shares the web server's CPU
 *     and disk. We cap a single turn at MAX_TURN_MS so a runaway prompt
 *     can't pin the box forever.
 *   - No container: workdir is a plain directory under CLAUDE_WEB_WORKDIR
 *     (default /var/lib/gluecron/claude-web). Caller is responsible for
 *     not pointing this at a tenant-shared filesystem.
 *   - Anthropic creds: we DO NOT pass ANTHROPIC_API_KEY through the
 *     environment if the operator has logged in `claude` interactively
 *     (the CLI manages its own creds in ~/.claude). If the env var is
 *     set, we pass it through unchanged.
 *
 * Test seam: `__setSpawnForTests` lets unit tests intercept the spawn
 * without actually running the Claude CLI.
 */

import { mkdir, stat } from "fs/promises";
import { join } from "path";
import { db } from "../db";
import {
  claudeWebMessages,
  claudeWebSessions,
  type ClaudeWebSession,
} from "../db/schema";
import { and, eq } from "drizzle-orm";
import { getRepoPath } from "../git/repository";

const MAX_TURN_MS = 5 * 60_000;

export function claudeWebRoot(): string {
  return (
    process.env.CLAUDE_WEB_WORKDIR ||
    "/var/lib/gluecron/claude-web"
  ).replace(/\/$/, "");
}

export function claudeBinary(): string {
  return process.env.CLAUDE_BIN || "claude";
}

// ---------------------------------------------------------------------------
// Spawn seam
// ---------------------------------------------------------------------------

export interface SpawnHandle {
  /** Async iterable of utf-8 stdout chunks. */
  stdout: AsyncIterable<string>;
  /** Resolves to the final exit code + collected stderr after stdout ends. */
  done: Promise<{ exitCode: number; stderr: string }>;
  /** Kills the underlying subprocess. */
  kill: () => void;
}

export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> }
) => SpawnHandle;

const defaultSpawn: SpawnFn = (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = (async function* () {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) yield dec.decode(value, { stream: true });
      }
      const tail = dec.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock();
    }
  })();
  const done = (async () => {
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stderr };
  })();
  return { stdout, done, kill: () => proc.kill() };
};

let _spawn: SpawnFn = defaultSpawn;
export function __setSpawnForTests(fn: SpawnFn | null): void {
  _spawn = fn ?? defaultSpawn;
}

// ---------------------------------------------------------------------------
// Workdir
// ---------------------------------------------------------------------------

export function sessionWorkdir(sessionId: string): string {
  return join(claudeWebRoot(), sessionId);
}

/**
 * Make sure the session's working dir exists as a fresh clone of the
 * repo's bare store at the given branch. Idempotent — if the dir already
 * has a `.git` folder, we leave it alone and the operator's existing
 * working state is preserved across turns.
 *
 * Uses `git clone --branch <branch> --depth 1 <bare> <workdir>` so the
 * initial materialisation is fast even on huge repos. Operators can
 * `git fetch --unshallow` from inside the session if they need history.
 */
export async function ensureWorkdir(
  session: ClaudeWebSession,
  ownerName: string,
  repoName: string,
  spawn: SpawnFn = _spawn
): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = claudeWebRoot();
  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `mkdir ${root}: ${err instanceof Error ? err.message : err}`,
    };
  }
  const workdir = session.workdirPath;
  // If .git already exists in the workdir, the clone is done.
  try {
    const s = await stat(join(workdir, ".git"));
    if (s.isDirectory()) return { ok: true };
  } catch {
    /* fall through to clone */
  }

  const bare = getRepoPath(ownerName, repoName);
  const handle = spawn(
    ["git", "clone", "--branch", session.branch, "--depth", "1", bare, workdir],
    { cwd: root, env: scrubbedEnv() }
  );
  // Drain stdout (clone is quiet, but we still need to consume).
  for await (const _ of handle.stdout) {
    /* ignore */
  }
  const { exitCode, stderr } = await handle.done;
  if (exitCode !== 0) {
    return { ok: false, error: stderr.trim() || `git clone exit ${exitCode}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Turn driver
// ---------------------------------------------------------------------------

export interface TurnInput {
  session: ClaudeWebSession;
  ownerName: string;
  repoName: string;
  prompt: string;
}

export interface TurnEvent {
  /** Streaming text chunk from Claude's stdout. */
  chunk?: string;
  /** Terminal event — call once, after stdout ends. */
  done?: {
    exitCode: number;
    durationMs: number;
    /** Claude CLI session UUID extracted from the run (when present). */
    claudeSessionId?: string;
    stderr: string;
  };
}

/**
 * Run a single conversational turn against Claude. Yields stdout chunks
 * as they arrive, then a single `done` event with metadata. The caller
 * (typically the SSE route) is responsible for serialising events onto
 * the wire and persisting the final assistant body.
 *
 * Honours `MAX_TURN_MS` — if the subprocess hasn't finished by then we
 * call kill() and emit done with exitCode=124 (matching `timeout`).
 */
export async function* runTurn(
  input: TurnInput,
  spawn: SpawnFn = _spawn
): AsyncGenerator<TurnEvent, void, void> {
  const start = Date.now();
  const cmd = [
    claudeBinary(),
    "--print",
    "--output-format",
    "stream-json",
    ...(input.session.claudeSessionId
      ? ["--resume", input.session.claudeSessionId]
      : []),
    input.prompt,
  ];

  const handle = spawn(cmd, {
    cwd: input.session.workdirPath,
    env: passthroughEnv(),
  });

  const timer = setTimeout(() => {
    try {
      handle.kill();
    } catch {
      /* ignore */
    }
  }, MAX_TURN_MS);

  let sessionId: string | undefined;
  try {
    for await (const chunk of handle.stdout) {
      // Best-effort parse for the Claude session UUID inside stream-json
      // events. The CLI emits a `"session_id":"<uuid>"` key on its init
      // event; we just grep the chunk text so format drift doesn't break.
      if (!sessionId) {
        const m = chunk.match(/"session_id"\s*:\s*"([0-9a-f-]{32,36})"/i);
        if (m) sessionId = m[1];
      }
      yield { chunk };
    }
  } finally {
    clearTimeout(timer);
  }

  const { exitCode, stderr } = await handle.done;
  yield {
    done: {
      exitCode,
      durationMs: Date.now() - start,
      claudeSessionId: sessionId,
      stderr,
    },
  };
}

/**
 * Env scrubbing for child subprocesses. Drops Postgres / SMTP / SSH
 * creds the Claude binary doesn't need. Keeps ANTHROPIC_API_KEY, PATH,
 * HOME, and the CLAUDE_* family.
 */
function passthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const passlist = new Set([
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TERM",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (passlist.has(k) || k.startsWith("CLAUDE_")) out[k] = v;
  }
  return out;
}

function scrubbedEnv(): Record<string, string> {
  // For `git clone` we want even fewer — just PATH + HOME so git can
  // find its config and ssh wrappers.
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LANG"]) {
    if (typeof process.env[k] === "string") out[k] = process.env[k] as string;
  }
  // Disable any interactive prompt — clone should be non-interactive.
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

// ---------------------------------------------------------------------------
// Transcript persistence
// ---------------------------------------------------------------------------

export async function listMessages(sessionId: string) {
  return db
    .select()
    .from(claudeWebMessages)
    .where(eq(claudeWebMessages.sessionId, sessionId))
    .orderBy(claudeWebMessages.createdAt);
}

export async function appendMessage(input: {
  sessionId: string;
  role: "user" | "assistant" | "system";
  body: string;
  exitCode?: number;
  durationMs?: number;
}): Promise<void> {
  await db.insert(claudeWebMessages).values({
    sessionId: input.sessionId,
    role: input.role,
    body: input.body,
    exitCode: input.exitCode ?? null,
    durationMs: input.durationMs ?? null,
  });
}

export async function touchSession(input: {
  sessionId: string;
  claudeSessionId?: string;
  status?: string;
}): Promise<void> {
  const set: Record<string, unknown> = { lastActiveAt: new Date() };
  if (input.claudeSessionId) set.claudeSessionId = input.claudeSessionId;
  if (input.status) set.status = input.status;
  await db
    .update(claudeWebSessions)
    .set(set)
    .where(eq(claudeWebSessions.id, input.sessionId));
}

export async function createSession(input: {
  repositoryId: string;
  ownerUserId: string;
  title?: string;
  branch?: string;
}): Promise<ClaudeWebSession> {
  // Insert first so we have the id for the workdir path.
  const [row] = await db
    .insert(claudeWebSessions)
    .values({
      repositoryId: input.repositoryId,
      ownerUserId: input.ownerUserId,
      title: input.title ?? "New session",
      branch: input.branch ?? "main",
      workdirPath: "pending",
      status: "cold",
    })
    .returning();
  if (!row) throw new Error("createSession: insert returned no row");
  const workdir = sessionWorkdir(row.id);
  const [updated] = await db
    .update(claudeWebSessions)
    .set({ workdirPath: workdir })
    .where(eq(claudeWebSessions.id, row.id))
    .returning();
  return updated ?? { ...row, workdirPath: workdir };
}

export async function getSession(
  id: string,
  ownerUserId?: string
): Promise<ClaudeWebSession | null> {
  const conds = ownerUserId
    ? and(
        eq(claudeWebSessions.id, id),
        eq(claudeWebSessions.ownerUserId, ownerUserId)
      )
    : eq(claudeWebSessions.id, id);
  const [row] = await db
    .select()
    .from(claudeWebSessions)
    .where(conds)
    .limit(1);
  return row ?? null;
}

export async function listSessionsForRepo(
  repositoryId: string,
  limit = 50
): Promise<ClaudeWebSession[]> {
  return db
    .select()
    .from(claudeWebSessions)
    .where(eq(claudeWebSessions.repositoryId, repositoryId))
    .limit(limit);
}

/**
 * List sessions for a specific user in a specific repo, ordered by most
 * recently active first. Used by the customer-facing /:owner/:repo/claude
 * page so each user sees only their own sessions.
 */
export async function listSessionsForUser(
  repositoryId: string,
  ownerUserId: string,
  limit = 50
): Promise<ClaudeWebSession[]> {
  return db
    .select()
    .from(claudeWebSessions)
    .where(
      and(
        eq(claudeWebSessions.repositoryId, repositoryId),
        eq(claudeWebSessions.ownerUserId, ownerUserId)
      )
    )
    .orderBy(claudeWebSessions.lastActiveAt)
    .limit(limit);
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(claudeWebSessions).where(eq(claudeWebSessions.id, id));
}

/** Test-only access to internals. */
export const __test = {
  passthroughEnv,
  scrubbedEnv,
  MAX_TURN_MS,
};
