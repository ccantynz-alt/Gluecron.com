/**
 * Block K1 — Autonomous agent runtime + sandbox.
 *
 * The substrate every other Block K agent (triage, fix, review_response,
 * deploy_watcher, heal_bot) runs on top of. A single `agent_runs` row records
 * one invocation: its kind + trigger, lifecycle status, a size-capped
 * append-only log, cost accounting, and an optional error message.
 *
 * File layout mirrors commit-statuses.ts:
 *   1. Pure helpers (types, truncation, state machine)       — fully unit-testable
 *   2. Sandboxing primitive (runSandboxed)                   — Bun.spawn wrapper
 *   3. DB helpers                                            — wrap every call in try/catch
 *
 * Every DB helper returns null/false on failure and console.errors; this
 * matches the "never crash the caller" philosophy of workflow-runner.ts and
 * post-receive.ts.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "killed"
  | "timeout";

export type AgentRunTrigger =
  | "issue.opened"
  | "pr.opened"
  | "pr.review_comment"
  | "deploy.failed"
  | "manual"
  | "scheduled";

export type AgentKind =
  | "triage"
  | "fix"
  | "review_response"
  | "deploy_watcher"
  | "heal_bot"
  | "custom";

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "succeeded",
  "failed",
  "killed",
  "timeout",
]);

/** True iff `s` is a final, immutable status. */
export function isTerminalStatus(s: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/**
 * Allowed transitions:
 *   queued  → running | killed   (killed lets an operator cancel before start)
 *   running → succeeded | failed | timeout | killed
 *   terminal → nothing
 *
 * Self-transitions are disallowed so a double-write doesn't silently "succeed".
 */
export function canTransition(
  from: AgentRunStatus,
  to: AgentRunStatus
): boolean {
  if (from === to) return false;
  if (isTerminalStatus(from)) return false;
  if (from === "queued") {
    return to === "running" || to === "killed";
  }
  if (from === "running") {
    return (
      to === "succeeded" ||
      to === "failed" ||
      to === "timeout" ||
      to === "killed"
    );
  }
  return false;
}

const LOG_TRUNCATED_SENTINEL = "[log truncated]\n";

/**
 * Append `addition` to `existing` and cap the total at `maxBytes`.
 *
 * When the combined length exceeds the cap we keep only the last `maxBytes`
 * characters and prepend the `[log truncated]\n` sentinel — but only once.
 * If `existing` already starts with the sentinel we don't double it.
 *
 * Measurement is character-based (JS string .length) rather than UTF-8 byte
 * length. For our log content (ASCII-dominant stdout/stderr) the two are
 * equivalent to within a few percent; correctness of the cap in the
 * pathological multibyte case is not worth the Buffer round-trip cost.
 */
export function truncateLog(
  existing: string,
  addition: string,
  maxBytes: number = 256 * 1024
): string {
  const combined = (existing || "") + (addition || "");
  if (combined.length <= maxBytes) return combined;

  // Strip any prior sentinel so we don't double it after a re-truncation.
  const stripped = combined.startsWith(LOG_TRUNCATED_SENTINEL)
    ? combined.slice(LOG_TRUNCATED_SENTINEL.length)
    : combined;

  // Take the last maxBytes chars and prepend a single sentinel. Reserve space
  // for the sentinel so the final string length is <= maxBytes + sentinel.
  const tail = stripped.slice(-maxBytes);
  return LOG_TRUNCATED_SENTINEL + tail;
}

/** Cap an error message / stack trace for DB storage. */
export function truncateError(
  msg: string,
  maxChars: number = 4096
): string {
  if (!msg) return "";
  if (msg.length <= maxChars) return msg;
  return msg.slice(0, maxChars) + "\n[... truncated ...]";
}

// ---------------------------------------------------------------------------
// Sandboxing
// ---------------------------------------------------------------------------

export interface SandboxOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdoutCapBytes?: number;
  stderrCapBytes?: number;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SANDBOX_STREAM_CAP = 64 * 1024; // 64 KB per stream
const SANDBOX_KILL_GRACE_MS = 5_000;

function capStream(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "\n[... truncated ...]";
}

/**
 * Spawn `cmd args` under a minimal env with a hard timeout.
 *
 * Semantics:
 *   - env defaults to `{ PATH, HOME }` from the parent process if the caller
 *     passes nothing. This is deliberately narrower than `process.env` so
 *     secrets (DATABASE_URL, ANTHROPIC_API_KEY, etc) aren't accidentally
 *     leaked to agent-authored commands.
 *   - On timeout we send SIGTERM, then SIGKILL 5s later.
 *   - stdout/stderr are capped to 64 KB each by default; overflow is
 *     replaced with a `\n[... truncated ...]` sentinel.
 *   - Never throws — a spawn failure is reported as exitCode=null with the
 *     error message on stderr.
 */
export async function runSandboxed(
  cmd: string,
  args: string[],
  opts: SandboxOptions
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  const stdoutCap = opts.stdoutCapBytes ?? DEFAULT_SANDBOX_STREAM_CAP;
  const stderrCap = opts.stderrCapBytes ?? DEFAULT_SANDBOX_STREAM_CAP;

  const env = opts.env
    ? opts.env
    : {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
      };

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let escalateTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        proc?.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      escalateTimer = setTimeout(() => {
        try {
          proc?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, SANDBOX_KILL_GRACE_MS);
    }, timeoutMs);

    const stdoutPromise = proc.stdout
      ? new Response(proc.stdout as ReadableStream).text()
      : Promise.resolve("");
    const stderrPromise = proc.stderr
      ? new Response(proc.stderr as ReadableStream).text()
      : Promise.resolve("");

    const [stdoutRaw, stderrRaw] = await Promise.all([
      stdoutPromise.catch(() => ""),
      stderrPromise.catch(() => ""),
    ]);
    const exitCode = await proc.exited;

    if (killTimer) clearTimeout(killTimer);
    if (escalateTimer) clearTimeout(escalateTimer);

    return {
      exitCode,
      stdout: capStream(stdoutRaw, stdoutCap),
      stderr: capStream(
        timedOut
          ? `${stderrRaw}\n[sandbox killed after ${timeoutMs}ms timeout]`
          : stderrRaw,
        stderrCap
      ),
      timedOut,
    };
  } catch (err) {
    if (killTimer) clearTimeout(killTimer);
    if (escalateTimer) clearTimeout(escalateTimer);
    return {
      exitCode: null,
      stdout: "",
      stderr: capStream(
        `[sandbox] spawn failed: ${(err as Error).message}`,
        stderrCap
      ),
      timedOut,
    };
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Shape of a row in `agent_runs` — mirrors drizzle/0034_agent_runs.sql.
 * Defined here (rather than imported from db/schema) because the Drizzle
 * table is added by the main thread; this file stays self-contained so
 * agents can build against it before the schema ships.
 */
export interface AgentRun {
  id: string;
  repositoryId: string;
  kind: AgentKind | string;
  trigger: AgentRunTrigger | string;
  triggerRef: string | null;
  status: AgentRunStatus;
  summary: string | null;
  log: string;
  costInputTokens: number;
  costOutputTokens: number;
  costCents: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  errorMessage: string | null;
}

/**
 * Map a raw Postgres row (snake_case) to our TS shape. Neon returns values
 * pre-parsed (timestamps as Date, ints as number) so we only rename.
 */
function rowToAgentRun(row: Record<string, unknown>): AgentRun {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    kind: String(row.kind),
    trigger: String(row.trigger),
    triggerRef: (row.trigger_ref as string | null) ?? null,
    status: String(row.status) as AgentRunStatus,
    summary: (row.summary as string | null) ?? null,
    log: String(row.log ?? ""),
    costInputTokens: Number(row.cost_input_tokens ?? 0),
    costOutputTokens: Number(row.cost_output_tokens ?? 0),
    costCents: Number(row.cost_cents ?? 0),
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
    createdAt: (row.created_at as Date) ?? new Date(0),
    errorMessage: (row.error_message as string | null) ?? null,
  };
}

export interface StartAgentRunInput {
  repositoryId: string;
  kind: AgentKind;
  trigger: AgentRunTrigger;
  triggerRef?: string | null;
}

/** Insert a queued run. Returns the row or null on DB failure. */
export async function startAgentRun(
  input: StartAgentRunInput
): Promise<AgentRun | null> {
  try {
    const rows = (await db.execute(sql`
      INSERT INTO agent_runs (repository_id, kind, trigger, trigger_ref, status)
      VALUES (
        ${input.repositoryId},
        ${input.kind},
        ${input.trigger},
        ${input.triggerRef ?? null},
        'queued'
      )
      RETURNING *
    `)) as unknown as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? rowToAgentRun(row) : null;
  } catch (err) {
    console.error("[agent-runtime] startAgentRun:", err);
    return null;
  }
}

export async function getAgentRun(id: string): Promise<AgentRun | null> {
  try {
    const rows = (await db.execute(sql`
      SELECT * FROM agent_runs WHERE id = ${id} LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row ? rowToAgentRun(row) : null;
  } catch (err) {
    console.error("[agent-runtime] getAgentRun:", err);
    return null;
  }
}

export interface ListAgentRunsOptions {
  limit?: number;
  status?: AgentRunStatus;
  kind?: AgentKind;
}

export async function listAgentRunsForRepo(
  repositoryId: string,
  opts: ListAgentRunsOptions = {}
): Promise<AgentRun[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  try {
    // Filters are composed conditionally — sql`` interpolation handles
    // parameterisation safely.
    const statusFilter = opts.status
      ? sql`AND status = ${opts.status}`
      : sql``;
    const kindFilter = opts.kind ? sql`AND kind = ${opts.kind}` : sql``;
    const rows = (await db.execute(sql`
      SELECT * FROM agent_runs
      WHERE repository_id = ${repositoryId}
      ${statusFilter}
      ${kindFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `)) as unknown as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return [];
    return rows.map(rowToAgentRun);
  } catch (err) {
    console.error("[agent-runtime] listAgentRunsForRepo:", err);
    return [];
  }
}

async function setStatus(
  runId: string,
  status: AgentRunStatus,
  extra: {
    summary?: string | null;
    errorMessage?: string | null;
    setStartedAt?: boolean;
    setFinishedAt?: boolean;
  } = {}
): Promise<boolean> {
  try {
    const summaryClause =
      extra.summary !== undefined
        ? sql`, summary = ${extra.summary}`
        : sql``;
    const errorClause =
      extra.errorMessage !== undefined
        ? sql`, error_message = ${extra.errorMessage}`
        : sql``;
    const startedClause = extra.setStartedAt ? sql`, started_at = now()` : sql``;
    const finishedClause = extra.setFinishedAt
      ? sql`, finished_at = now()`
      : sql``;
    await db.execute(sql`
      UPDATE agent_runs
      SET status = ${status}
      ${summaryClause}
      ${errorClause}
      ${startedClause}
      ${finishedClause}
      WHERE id = ${runId}
    `);
    return true;
  } catch (err) {
    console.error("[agent-runtime] setStatus:", err);
    return false;
  }
}

export interface AgentExecutorContext {
  appendLog: (line: string) => Promise<void>;
  recordCost: (
    inputTokens: number,
    outputTokens: number,
    cents: number
  ) => Promise<void>;
}

export interface AgentExecutorResult {
  ok: boolean;
  summary: string;
}

export interface ExecuteAgentRunOptions {
  timeoutMs?: number;
}

const DEFAULT_EXECUTOR_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Drive a queued run through its lifecycle. Never throws.
 *
 * 1. Transition queued → running (abort if transition fails).
 * 2. Invoke `executor` with a context that lets it append logs + record cost.
 * 3. If executor resolves: transition running → succeeded|failed + store summary.
 * 4. If timeout fires first: transition running → timeout.
 * 5. If executor throws: transition running → failed with truncated stack.
 *
 * Note: this wrapper does NOT hold a Bun.Subprocess handle — the executor
 * owns any child process. On timeout we simply stop awaiting and flip DB
 * state; the executor's runSandboxed call should be passed a timeout slightly
 * lower than ours so its own SIGKILL happens first.
 */
export async function executeAgentRun<T extends AgentExecutorResult>(
  runId: string,
  executor: (ctx: AgentExecutorContext) => Promise<T>,
  opts: ExecuteAgentRunOptions = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS;

  const transitioned = await setStatus(runId, "running", {
    setStartedAt: true,
  });
  if (!transitioned) {
    console.error(
      `[agent-runtime] executeAgentRun: could not transition ${runId} to running`
    );
    return;
  }

  const ctx: AgentExecutorContext = {
    appendLog: async (line: string) => {
      await appendAgentLog(runId, line);
    },
    recordCost: async (input, output, cents) => {
      await recordAgentCost(runId, input, output, cents);
    },
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;
  const timeoutPromise = new Promise<"__timeout__">((resolve) => {
    timeoutHandle = setTimeout(() => {
      didTimeout = true;
      resolve("__timeout__");
    }, timeoutMs);
  });

  try {
    const race = await Promise.race([executor(ctx), timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (didTimeout || race === "__timeout__") {
      await setStatus(runId, "timeout", {
        setFinishedAt: true,
        errorMessage: truncateError(
          `Agent run exceeded timeout of ${timeoutMs}ms`
        ),
      });
      return;
    }

    const result = race as T;
    await setStatus(runId, result.ok ? "succeeded" : "failed", {
      setFinishedAt: true,
      summary: (result.summary ?? "").slice(0, 2000),
    });
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const stack =
      err instanceof Error
        ? err.stack || err.message
        : String(err);
    await setStatus(runId, "failed", {
      setFinishedAt: true,
      errorMessage: truncateError(stack),
    });
  }
}

/**
 * Best-effort kill: flip DB status from queued/running → killed. Does NOT
 * terminate an in-flight subprocess — that subprocess is owned by whichever
 * executor invoked runSandboxed. Cross-process SIGKILL would require tracking
 * a Bun.Subprocess handle in memory, which doesn't survive restarts and is
 * out of scope for v1. Operators wanting a real kill should restart the
 * worker; the executor's own runSandboxed timeout will then bound runtime.
 */
export async function killAgentRun(runId: string): Promise<boolean> {
  try {
    await db.execute(sql`
      UPDATE agent_runs
      SET status = 'killed', finished_at = now()
      WHERE id = ${runId}
        AND status IN ('queued', 'running')
    `);
    return true;
  } catch (err) {
    console.error("[agent-runtime] killAgentRun:", err);
    return false;
  }
}

/**
 * Append `line` to the run's log, capped at 256 KB. Re-reads the current
 * log then writes back — good enough for v1 since a run has a single
 * executor and therefore no concurrent writers.
 */
export async function appendAgentLog(
  runId: string,
  line: string
): Promise<boolean> {
  try {
    const rows = (await db.execute(sql`
      SELECT log FROM agent_runs WHERE id = ${runId} LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return false;
    const existing = String(row.log ?? "");
    const next = truncateLog(existing, line.endsWith("\n") ? line : line + "\n");
    await db.execute(sql`
      UPDATE agent_runs SET log = ${next} WHERE id = ${runId}
    `);
    return true;
  } catch (err) {
    console.error("[agent-runtime] appendAgentLog:", err);
    return false;
  }
}

/** Atomically add to the cost counters. */
export async function recordAgentCost(
  runId: string,
  inputTokens: number,
  outputTokens: number,
  cents: number
): Promise<boolean> {
  try {
    const dIn = Math.max(0, Math.floor(inputTokens || 0));
    const dOut = Math.max(0, Math.floor(outputTokens || 0));
    const dCents = Math.max(0, Math.floor(cents || 0));
    await db.execute(sql`
      UPDATE agent_runs
      SET cost_input_tokens = cost_input_tokens + ${dIn},
          cost_output_tokens = cost_output_tokens + ${dOut},
          cost_cents = cost_cents + ${dCents}
      WHERE id = ${runId}
    `);
    return true;
  } catch (err) {
    console.error("[agent-runtime] recordAgentCost:", err);
    return false;
  }
}

export const __internal = {
  LOG_TRUNCATED_SENTINEL,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_STREAM_CAP,
  SANDBOX_KILL_GRACE_MS,
  DEFAULT_EXECUTOR_TIMEOUT_MS,
};
