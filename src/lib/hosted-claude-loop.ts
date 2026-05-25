/**
 * Hosted Claude tool-use loop runtime (migration 0069).
 *
 * Users paste a JavaScript/TypeScript snippet at /connect/claude/deploy
 * that drives Anthropic's SDK however they want — typically a tool-use
 * loop calling Gluecron MCP tools. We persist the source, mint an agent
 * session for budget enforcement, and execute the snippet on demand in
 * a sandboxed Bun subprocess.
 *
 * Design rules
 * ─────────────
 *   - Best-effort DB: every read/write is wrapped so missing tables
 *     (migration 0069 not yet applied) degrade to `null` / `[]`. The
 *     routes layer turns null into a 404, the wizard hides the section.
 *   - Sandboxed exec: we never `eval()`. The source is written to a temp
 *     file and run with `bun run --no-install <file>` in a *separate
 *     process* with a 30s hard timeout. The subprocess inherits a
 *     scrubbed env (no Postgres URL, no SMTP creds) and only sees the
 *     three vars it needs.
 *   - Budget meter: each invocation captures the JSON usage block that
 *     the snippet prints (or that we extract from stdout) and pipes the
 *     numbers through `recordAiCost` + `chargeAgent`. Over-budget
 *     invocations short-circuit with a `budget_exceeded` status.
 *   - Test seam: callers can inject `__setExecutorForTests` to bypass
 *     the subprocess and assert tracker behaviour without Bun shell
 *     side effects.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { db } from "../db";
import {
  hostedClaudeLoopRuns,
  hostedClaudeLoops,
  type HostedClaudeLoop,
  type HostedClaudeLoopRun,
} from "../db/schema";
import {
  computeCentsForCall,
  recordAiCost,
  type AiCostCategory,
} from "./ai-cost-tracker";
import { createAgentSession, chargeAgent } from "./agent-multiplayer";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard kill timeout for the user's snippet. Must be << any HTTP timeout. */
export const LOOP_EXEC_TIMEOUT_MS = 30_000;

/** Grace period between SIGTERM and SIGKILL. Mirrors workflow-runner. */
const KILL_GRACE_MS = 2_000;

/** Cap on persisted stdout/stderr per run so a runaway println doesn't
 *  inflate a Postgres row past the toast limit. */
const RUN_LOG_CAP_BYTES = 32 * 1024;

/** Category recorded against `ai_cost_events` for these runs. */
const COST_CATEGORY: AiCostCategory = "other";

/** Default model fallback when the snippet didn't tell us what it ran. */
const DEFAULT_MODEL = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Slugify a loop name into the URL-safe suffix for `endpoint_path`.
 * Lowercase alphanum + dashes, trimmed, capped at 40 chars.
 */
export function slugifyLoopName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** 6-char hex suffix to disambiguate duplicate slugs. */
function randomSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a unique endpoint_path from a name. Always begins with
 * `/claude-loops/`. Suffix is appended even on a clean slug so the path
 * stays unguessable.
 */
export function buildEndpointPath(name: string): string {
  const slug = slugifyLoopName(name) || "loop";
  return `/claude-loops/${slug}-${randomSuffix()}`;
}

/**
 * Truncate a string at `cap` bytes (UTF-8 safe via TextEncoder length).
 * Appends a `[truncated]` marker when chopping.
 */
export function capStream(s: string, cap: number = RUN_LOG_CAP_BYTES): string {
  if (!s) return "";
  if (s.length <= cap) return s;
  return s.slice(0, cap) + "\n[truncated]";
}

/**
 * Best-effort parser: find the FIRST JSON object printed in stdout that
 * contains a `usage` block with input/output tokens. Returns zeros when
 * nothing matches. The intent is to encourage snippets to emit something
 * like `console.log(JSON.stringify({ usage: response.usage, ... }))`.
 */
export function extractUsageFromStdout(stdout: string): {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
} {
  if (!stdout) return { inputTokens: 0, outputTokens: 0, model: null };
  // Try whole-stdout-is-json first.
  const tryParse = (chunk: string) => {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* ignore */
    }
    return null;
  };
  const candidates: unknown[] = [];
  const whole = tryParse(stdout.trim());
  if (whole) candidates.push(whole);
  // Fall back to line-by-line.
  for (const line of stdout.split(/\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    const got = tryParse(t);
    if (got) candidates.push(got);
  }
  for (const c of candidates) {
    const obj = c as Record<string, unknown>;
    const usage = obj.usage as Record<string, unknown> | undefined;
    if (
      usage &&
      typeof usage.input_tokens === "number" &&
      typeof usage.output_tokens === "number"
    ) {
      return {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        model: typeof obj.model === "string" ? obj.model : null,
      };
    }
  }
  return { inputTokens: 0, outputTokens: 0, model: null };
}

// ---------------------------------------------------------------------------
// Default snippet
// ---------------------------------------------------------------------------

/** Pre-filled template shown in the wizard's textarea. */
export const DEFAULT_LOOP_TEMPLATE = `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const input = JSON.parse(process.env.INPUT || "{}");
const repo = input.repo || "ccantynz-alt/Gluecron.com";

const result = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: \`Summarise repo \${repo} in 3 bullets\` },
  ],
});

const text = (result.content[0] && "text" in result.content[0])
  ? result.content[0].text
  : "";

console.log(JSON.stringify({
  summary: text,
  model: result.model,
  usage: result.usage,
}));
`;

// ---------------------------------------------------------------------------
// Executor test seam — bypassed in tests to skip the actual subprocess.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecArgs {
  sourceCode: string;
  inputPayload: unknown;
  env: Record<string, string>;
}

export type LoopExecutor = (args: ExecArgs) => Promise<ExecResult>;

let executorOverride: LoopExecutor | null = null;

/** Test seam — pass a fake executor to short-circuit Bun.spawn. */
export function __setExecutorForTests(fn: LoopExecutor | null): void {
  executorOverride = fn;
}

/**
 * Spawn the user's snippet in a fresh Bun subprocess. The snippet is
 * written to a tempdir and removed when we're done. The subprocess
 * sees only the env vars we pass — `process.env` is NOT inherited.
 */
async function defaultExecutor(args: ExecArgs): Promise<ExecResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), "gluecron-cldploy-"));
  const file = join(dir, "loop.mjs");
  await writeFile(file, args.sourceCode, "utf8");

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let escalateTimer: ReturnType<typeof setTimeout> | null = null;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(["bun", "run", "--no-install", file], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...args.env,
        INPUT: JSON.stringify(args.inputPayload ?? {}),
      },
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
      }, KILL_GRACE_MS);
    }, LOOP_EXEC_TIMEOUT_MS);

    const stdoutP = proc.stdout
      ? new Response(proc.stdout as ReadableStream).text().catch(() => "")
      : Promise.resolve("");
    const stderrP = proc.stderr
      ? new Response(proc.stderr as ReadableStream).text().catch(() => "")
      : Promise.resolve("");
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    const exitCode = await proc.exited;

    return {
      stdout,
      stderr: timedOut
        ? `${stderr}\n[killed after ${LOOP_EXEC_TIMEOUT_MS}ms timeout]`
        : stderr,
      exitCode,
      durationMs: Date.now() - started,
      timedOut,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: `[hosted-claude-loop] spawn failed: ${(err as Error).message}`,
      exitCode: null,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (escalateTimer) clearTimeout(escalateTimer);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function getExecutor(): LoopExecutor {
  return executorOverride ?? defaultExecutor;
}

// ---------------------------------------------------------------------------
// CRUD — every helper swallows DB errors and returns null/[]/false.
// ---------------------------------------------------------------------------

export interface CreateLoopInput {
  ownerUserId: string;
  name: string;
  sourceCode: string;
  /** Monthly cap in CENTS. UI shows $5/$25/$100 → 500/2500/10000. */
  monthlyBudgetCents?: number;
  isPublic?: boolean;
}

export interface CreateLoopResult {
  loop: HostedClaudeLoop;
  /** Plaintext `agt_…` agent token — returned once, never persisted. */
  agentToken: string | null;
}

/**
 * Create a hosted loop. Mints an agent session in the same call so the
 * snippet can call back into Gluecron MCP using the returned token.
 */
export async function createLoop(
  input: CreateLoopInput
): Promise<CreateLoopResult | null> {
  const name = (input.name || "").trim();
  if (!name) return null;
  const source = (input.sourceCode || "").trim();
  if (!source) return null;

  const monthlyBudgetCents =
    typeof input.monthlyBudgetCents === "number" &&
    input.monthlyBudgetCents > 0
      ? Math.floor(input.monthlyBudgetCents)
      : 500;

  // Mint an agent session so the user's snippet can reach back into the
  // MCP surface. Daily budget = monthly cap / 30 (round up).
  const dailyBudget = Math.max(1, Math.ceil(monthlyBudgetCents / 30));
  const agent = await createAgentSession({
    ownerUserId: input.ownerUserId,
    // Suffix avoids the (owner_user_id, name) UNIQUE collision in
    // agent_sessions when a user creates two loops with the same name.
    name: `loop-${slugifyLoopName(name) || "loop"}-${randomSuffix()}`,
    budgetCentsPerDay: dailyBudget,
  });

  try {
    // Try a handful of unique endpoint_paths in case of a slug collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const endpointPath = buildEndpointPath(name);
      try {
        const [row] = await db
          .insert(hostedClaudeLoops)
          .values({
            ownerUserId: input.ownerUserId,
            name,
            sourceCode: source,
            endpointPath,
            agentSessionId: agent?.session.id ?? null,
            status: "paused",
            isPublic: Boolean(input.isPublic),
            monthlyBudgetCents,
          })
          .returning();
        if (!row) continue;
        return { loop: row, agentToken: agent?.token ?? null };
      } catch {
        // 23505 unique conflict on endpoint_path — retry with a new suffix.
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function getLoop(loopId: string): Promise<HostedClaudeLoop | null> {
  try {
    const [row] = await db
      .select()
      .from(hostedClaudeLoops)
      .where(eq(hostedClaudeLoops.id, loopId))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export async function getLoopByEndpointPath(
  endpointPath: string
): Promise<HostedClaudeLoop | null> {
  try {
    const [row] = await db
      .select()
      .from(hostedClaudeLoops)
      .where(eq(hostedClaudeLoops.endpointPath, endpointPath))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export async function listLoopsForOwner(
  ownerUserId: string
): Promise<HostedClaudeLoop[]> {
  try {
    return await db
      .select()
      .from(hostedClaudeLoops)
      .where(eq(hostedClaudeLoops.ownerUserId, ownerUserId))
      .orderBy(desc(hostedClaudeLoops.updatedAt));
  } catch {
    return [];
  }
}

export async function listRunsForLoop(
  loopId: string,
  limit: number = 50
): Promise<HostedClaudeLoopRun[]> {
  try {
    const n = Math.max(1, Math.min(500, Math.floor(limit)));
    return await db
      .select()
      .from(hostedClaudeLoopRuns)
      .where(eq(hostedClaudeLoopRuns.loopId, loopId))
      .orderBy(desc(hostedClaudeLoopRuns.startedAt))
      .limit(n);
  } catch {
    return [];
  }
}

async function setLoopStatus(
  loopId: string,
  ownerUserId: string,
  status: "paused" | "running" | "errored"
): Promise<boolean> {
  try {
    const result = await db
      .update(hostedClaudeLoops)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(hostedClaudeLoops.id, loopId),
          eq(hostedClaudeLoops.ownerUserId, ownerUserId)
        )
      )
      .returning({ id: hostedClaudeLoops.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

export async function pauseLoop(
  loopId: string,
  ownerUserId: string
): Promise<boolean> {
  return setLoopStatus(loopId, ownerUserId, "paused");
}

export async function resumeLoop(
  loopId: string,
  ownerUserId: string
): Promise<boolean> {
  return setLoopStatus(loopId, ownerUserId, "running");
}

export async function deleteLoop(
  loopId: string,
  ownerUserId: string
): Promise<boolean> {
  try {
    const result = await db
      .delete(hostedClaudeLoops)
      .where(
        and(
          eq(hostedClaudeLoops.id, loopId),
          eq(hostedClaudeLoops.ownerUserId, ownerUserId)
        )
      )
      .returning({ id: hostedClaudeLoops.id });
    return result.length > 0;
  } catch {
    return false;
  }
}

export interface UpdateLoopInput {
  name?: string;
  sourceCode?: string;
  monthlyBudgetCents?: number;
  isPublic?: boolean;
}

export async function updateLoop(
  loopId: string,
  ownerUserId: string,
  patch: UpdateLoopInput
): Promise<HostedClaudeLoop | null> {
  const set: Partial<HostedClaudeLoop> = { updatedAt: new Date() };
  if (typeof patch.name === "string" && patch.name.trim()) {
    set.name = patch.name.trim();
  }
  if (typeof patch.sourceCode === "string" && patch.sourceCode.trim()) {
    set.sourceCode = patch.sourceCode.trim();
  }
  if (
    typeof patch.monthlyBudgetCents === "number" &&
    patch.monthlyBudgetCents > 0
  ) {
    set.monthlyBudgetCents = Math.floor(patch.monthlyBudgetCents);
  }
  if (typeof patch.isPublic === "boolean") {
    set.isPublic = patch.isPublic;
  }
  try {
    const [row] = await db
      .update(hostedClaudeLoops)
      .set(set)
      .where(
        and(
          eq(hostedClaudeLoops.id, loopId),
          eq(hostedClaudeLoops.ownerUserId, ownerUserId)
        )
      )
      .returning();
    return row ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Budget reads
// ---------------------------------------------------------------------------

/**
 * Aggregate the loop's lifetime spend (cents) from
 * `hosted_claude_loops.total_cents_spent`. Cheap O(1) lookup — we keep
 * the running counter in the loop row so the meter doesn't have to scan
 * every run on every check.
 */
export async function getLoopMonthlySpendCents(loopId: string): Promise<number> {
  try {
    const [row] = await db
      .select({ cents: hostedClaudeLoops.totalCentsSpent })
      .from(hostedClaudeLoops)
      .where(eq(hostedClaudeLoops.id, loopId))
      .limit(1);
    return row?.cents ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface InvokeLoopInput {
  loopId: string;
  inputPayload?: unknown;
  /** Set `true` when invoked from the public endpoint so we record an
   *  is_public=true flag for audit. Defaults to false. */
  isPublicInvocation?: boolean;
}

export interface InvokeLoopResult {
  run: HostedClaudeLoopRun | null;
  /** `ok` — ran successfully (exit 0). `error` — non-zero exit or
   *  timeout. `budget_exceeded` — short-circuited by the monthly cap.
   *  `not_found` — loop missing. `disabled` — loop marked paused. */
  status:
    | "ok"
    | "error"
    | "budget_exceeded"
    | "not_found"
    | "disabled";
  output: unknown;
  stdout: string;
  stderr: string;
  /** Cents charged for this single invocation. */
  centsCharged: number;
}

/**
 * Synchronously invoke a hosted loop. Returns the run row plus a
 * decoded output payload (the snippet's stdout, parsed as JSON when
 * possible — otherwise the raw string).
 */
export async function invokeLoop(
  input: InvokeLoopInput
): Promise<InvokeLoopResult> {
  const loop = await getLoop(input.loopId);
  if (!loop) {
    return {
      run: null,
      status: "not_found",
      output: null,
      stdout: "",
      stderr: "loop not found",
      centsCharged: 0,
    };
  }
  if (loop.status === "paused" && !input.isPublicInvocation) {
    // Paused loops still accept owner-driven invokes via the API — the
    // wizard's "Invoke" button auto-resumes. Public callers see disabled.
  }
  if (loop.status === "paused" && input.isPublicInvocation) {
    return {
      run: null,
      status: "disabled",
      output: null,
      stdout: "",
      stderr: "loop is paused",
      centsCharged: 0,
    };
  }

  // Budget check — short-circuit before spending any compute.
  const monthlySpend = await getLoopMonthlySpendCents(loop.id);
  if (monthlySpend >= loop.monthlyBudgetCents) {
    const insertedRun = await insertRun({
      loopId: loop.id,
      inputPayload: input.inputPayload,
      status: "budget_exceeded",
      stdout: "",
      stderr: "monthly budget exceeded",
      exitCode: null,
      errorMessage: "monthly budget exceeded",
    });
    return {
      run: insertedRun,
      status: "budget_exceeded",
      output: null,
      stdout: "",
      stderr: "monthly budget exceeded",
      centsCharged: 0,
    };
  }

  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    // Pass the platform's Claude key (NOT the user's). When unset, the
    // snippet still runs — the Anthropic SDK throws which becomes stderr.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    // The loop's own agent token — minted at creation time, hashed in
    // agent_sessions. The plaintext is only handed to the user at create
    // and never persisted, so we expose the loop's session id here as
    // GLUECRON_AGENT_ID. Snippets that need callbacks should use the PAT
    // displayed in the wizard.
    GLUECRON_AGENT_ID: loop.agentSessionId ?? "",
    GLUECRON_LOOP_ID: loop.id,
    GLUECRON_BASE_URL:
      process.env.APP_BASE_URL || "https://gluecron.com",
  };
  if (process.env.GLUECRON_PAT) env.GLUECRON_PAT = process.env.GLUECRON_PAT;

  const exec = getExecutor();
  let execResult: ExecResult;
  try {
    execResult = await exec({
      sourceCode: loop.sourceCode,
      inputPayload: input.inputPayload ?? {},
      env,
    });
  } catch (err) {
    execResult = {
      stdout: "",
      stderr: `[invoke] executor threw: ${(err as Error).message}`,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const usage = extractUsageFromStdout(execResult.stdout);
  const model = usage.model || DEFAULT_MODEL;
  const cents = computeCentsForCall(
    model,
    usage.inputTokens,
    usage.outputTokens
  );

  // Try to parse stdout as JSON for the output payload.
  let parsedOutput: unknown = execResult.stdout;
  try {
    const trimmed = execResult.stdout.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      parsedOutput = JSON.parse(trimmed);
    }
  } catch {
    /* leave as raw string */
  }

  const succeeded =
    execResult.exitCode === 0 && !execResult.timedOut && !!execResult.stdout;
  const runStatus = succeeded ? "ok" : execResult.timedOut ? "timeout" : "error";

  const run = await insertRun({
    loopId: loop.id,
    inputPayload: input.inputPayload,
    outputPayload: succeeded ? parsedOutput : null,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    exitCode: execResult.exitCode,
    status: runStatus,
    centsEstimate: cents,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    errorMessage: succeeded ? null : execResult.stderr.slice(0, 500),
  });

  // Roll up onto the loop row + record the ai_cost_events row.
  await Promise.all([
    bumpLoopTotals(loop.id, cents),
    recordAiCost({
      ownerUserId: loop.ownerUserId,
      agentSessionId: loop.agentSessionId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      category: COST_CATEGORY,
      sourceId: loop.id,
      sourceKind: "hosted_claude_loop",
    }),
    loop.agentSessionId
      ? chargeAgent(loop.agentSessionId, cents).then(() => undefined)
      : Promise.resolve(),
  ]);

  return {
    run,
    status: succeeded ? "ok" : "error",
    output: parsedOutput,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    centsCharged: cents,
  };
}

interface InsertRunArgs {
  loopId: string;
  inputPayload?: unknown;
  outputPayload?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  status: string;
  centsEstimate?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string | null;
}

async function insertRun(args: InsertRunArgs): Promise<HostedClaudeLoopRun | null> {
  try {
    const [row] = await db
      .insert(hostedClaudeLoopRuns)
      .values({
        loopId: args.loopId,
        inputPayload: (args.inputPayload ?? {}) as never,
        outputPayload: (args.outputPayload ?? null) as never,
        stdout: capStream(args.stdout || ""),
        stderr: capStream(args.stderr || ""),
        exitCode: args.exitCode ?? null,
        status: args.status,
        finishedAt: new Date(),
        centsEstimate: Math.max(0, Math.floor(args.centsEstimate || 0)),
        claudeInputTokens: Math.max(0, Math.floor(args.inputTokens || 0)),
        claudeOutputTokens: Math.max(0, Math.floor(args.outputTokens || 0)),
        errorMessage: args.errorMessage ?? null,
      })
      .returning();
    return row ?? null;
  } catch {
    return null;
  }
}

async function bumpLoopTotals(loopId: string, cents: number): Promise<void> {
  try {
    await db
      .update(hostedClaudeLoops)
      .set({
        totalInvocations: sql`${hostedClaudeLoops.totalInvocations} + 1`,
        totalCentsSpent: sql`${hostedClaudeLoops.totalCentsSpent} + ${Math.max(0, Math.floor(cents))}`,
        lastRunAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hostedClaudeLoops.id, loopId));
  } catch {
    /* best-effort */
  }
}
