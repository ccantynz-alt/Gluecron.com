/**
 * Workflow runner (Block C1) — executes queued `workflow_runs` rows by
 * cloning the repo at the target commit into a tmpdir and running each
 * job's steps as bash subprocesses.
 *
 * Philosophy (mirrors post-receive.ts): never crash the caller. Every DB
 * call is wrapped in try/catch. All step output is size-capped so a runaway
 * process can't blow up Postgres rows. Logs are stored inline on the job
 * row for v1 — no streaming, no object storage. Step timeouts are enforced
 * so workers never wedge.
 *
 * Public surface:
 *   - executeRun(runId)       — run a specific queued run to completion
 *   - drainOneRun()           — pick the oldest queued run and execute it
 *   - enqueueRun(opts)        — insert a new run at the tail of the queue
 *   - startWorker({ interval }) — background poll loop (returns stop fn)
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { config } from "./config";
import { db } from "../db";
import {
  repositories,
  workflowJobs,
  workflowRuns,
  workflows,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Per-step subprocess timeout. */
const STEP_TIMEOUT_MS = 600_000; // 10 minutes

/** Grace period between SIGTERM and SIGKILL when killing a step. */
const KILL_GRACE_MS = 5_000;

/** Cap on full `workflow_jobs.logs` field. */
const JOB_LOG_CAP_BYTES = 64 * 1024;

/** Cap on per-step stdout/stderr excerpts stored in `steps` JSON. */
const STEP_STREAM_CAP_BYTES = 16 * 1024;

/** Default worker poll interval. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedStep {
  name?: string;
  run?: string;
  // `uses` / `with` etc. tolerated but ignored in v1.
  [key: string]: unknown;
}

interface ParsedJob {
  name?: string;
  "runs-on"?: string;
  runsOn?: string;
  steps?: ParsedStep[];
  [key: string]: unknown;
}

interface ParsedWorkflow {
  name?: string;
  on?: unknown;
  jobs?: Record<string, ParsedJob> | ParsedJob[];
  [key: string]: unknown;
}

interface StepResult {
  name: string;
  run: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  status: "success" | "failure" | "skipped";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "\n[... truncated ...]";
}

/**
 * Normalise the parsed workflow JSON into an ordered array of jobs.
 * Accepts either the object form (`jobs: { build: {...} }`) or an array.
 */
function extractJobs(parsed: ParsedWorkflow): Array<{ key: string; job: ParsedJob }> {
  const out: Array<{ key: string; job: ParsedJob }> = [];
  const jobs = parsed.jobs;
  if (!jobs) return out;
  if (Array.isArray(jobs)) {
    jobs.forEach((job, i) => {
      if (job && typeof job === "object") {
        out.push({ key: String(job.name || `job-${i + 1}`), job });
      }
    });
    return out;
  }
  if (typeof jobs === "object") {
    for (const [key, job] of Object.entries(jobs)) {
      if (job && typeof job === "object") {
        out.push({ key, job: job as ParsedJob });
      }
    }
  }
  return out;
}

function parseWorkflow(parsed: string): ParsedWorkflow | null {
  try {
    const value = JSON.parse(parsed);
    if (value && typeof value === "object") return value as ParsedWorkflow;
  } catch (err) {
    console.error("[workflow-runner] failed to parse workflow JSON:", err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Terminal-state helpers — all wrap DB calls in try/catch.
// ---------------------------------------------------------------------------

async function markRunFailed(
  runId: string,
  conclusion: string
): Promise<void> {
  try {
    await db
      .update(workflowRuns)
      .set({
        status: "failure",
        conclusion,
        finishedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId));
  } catch (err) {
    console.error("[workflow-runner] markRunFailed:", err);
  }
}

async function markRunRunning(runId: string): Promise<void> {
  try {
    await db
      .update(workflowRuns)
      .set({
        status: "running",
        startedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId));
  } catch (err) {
    console.error("[workflow-runner] markRunRunning:", err);
  }
}

async function markRunDone(
  runId: string,
  anyFailed: boolean
): Promise<void> {
  try {
    await db
      .update(workflowRuns)
      .set({
        status: anyFailed ? "failure" : "success",
        conclusion: anyFailed ? "failure" : "success",
        finishedAt: new Date(),
      })
      .where(eq(workflowRuns.id, runId));
  } catch (err) {
    console.error("[workflow-runner] markRunDone:", err);
  }
}

// ---------------------------------------------------------------------------
// Subprocess primitive
// ---------------------------------------------------------------------------

/**
 * Run a single step via `bash -c`. Captures stdout/stderr (capped), enforces
 * a hard timeout with SIGTERM → SIGKILL escalation, and returns a StepResult
 * shaped for persistence.
 */
async function runStep(
  step: ParsedStep,
  checkoutDir: string,
  runId: string
): Promise<StepResult> {
  const name =
    typeof step.name === "string" && step.name.length > 0
      ? step.name
      : (typeof step.run === "string" ? step.run.split("\n")[0] : "") ||
        "step";
  const run = typeof step.run === "string" ? step.run : "";
  const started = Date.now();

  if (!run) {
    // No `run:` — v1 treats this as skipped (we don't support `uses:` yet).
    return {
      name,
      run: "",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      status: "skipped",
    };
  }

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let escalateTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    proc = Bun.spawn(["bash", "-c", run], {
      cwd: checkoutDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CI: "true",
        GLUECRON_RUN: runId,
        GLUECRON_CI: "1",
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
    }, STEP_TIMEOUT_MS);

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

    const stdout = truncate(stdoutRaw, STEP_STREAM_CAP_BYTES);
    const stderr = truncate(
      timedOut
        ? `${stderrRaw}\n[step killed after ${STEP_TIMEOUT_MS}ms timeout]`
        : stderrRaw,
      STEP_STREAM_CAP_BYTES
    );

    return {
      name,
      run,
      exitCode,
      durationMs: Date.now() - started,
      stdout,
      stderr,
      status: exitCode === 0 && !timedOut ? "success" : "failure",
    };
  } catch (err) {
    if (killTimer) clearTimeout(killTimer);
    if (escalateTimer) clearTimeout(escalateTimer);
    return {
      name,
      run,
      exitCode: null,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: truncate(
        `[workflow-runner] step failed to launch: ${(err as Error).message}`,
        STEP_STREAM_CAP_BYTES
      ),
      status: "failure",
    };
  }
}

// ---------------------------------------------------------------------------
// Repo checkout — clone the bare repo shallow, then `git checkout <sha>`
// ---------------------------------------------------------------------------

async function cloneAt(
  bareRepoPath: string,
  commitSha: string | null,
  ref: string | null
): Promise<{ dir: string } | { error: string }> {
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "gluecron-run-"));
  } catch (err) {
    return { error: `mkdtemp failed: ${(err as Error).message}` };
  }
  const checkoutDir = join(dir, "checkout");

  // Strategy: if we have a sha, clone with no depth restriction to guarantee
  // the sha is reachable (shallow clone of a specific sha requires protocol
  // v2 + uploadpack.allowReachableSHA1InWant on the server). For v1 we
  // prefer correctness over size. Callers can switch to `--depth 1 --branch`
  // once we wire config.
  try {
    const cloneProc = Bun.spawn(
      ["git", "clone", "--quiet", bareRepoPath, checkoutDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const cloneTimer = setTimeout(() => {
      try {
        cloneProc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, STEP_TIMEOUT_MS);
    const cloneErr = await new Response(cloneProc.stderr as ReadableStream)
      .text()
      .catch(() => "");
    const cloneExit = await cloneProc.exited;
    clearTimeout(cloneTimer);
    if (cloneExit !== 0) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { error: `git clone failed: ${truncate(cloneErr, 2048)}` };
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { error: `git clone spawn failed: ${(err as Error).message}` };
  }

  // Check out the exact sha if given; otherwise if a ref is given, try it;
  // otherwise leave the default branch checked out.
  const target = commitSha || ref;
  if (target) {
    try {
      const coProc = Bun.spawn(
        ["git", "checkout", "--quiet", "--detach", target],
        { cwd: checkoutDir, stdout: "pipe", stderr: "pipe" }
      );
      const coErr = await new Response(coProc.stderr as ReadableStream)
        .text()
        .catch(() => "");
      const coExit = await coProc.exited;
      if (coExit !== 0) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return { error: `git checkout ${target} failed: ${truncate(coErr, 2048)}` };
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { error: `git checkout spawn failed: ${(err as Error).message}` };
    }
  }

  return { dir: checkoutDir };
}

// ---------------------------------------------------------------------------
// Core: execute a single job (insert row, run steps, persist result)
// ---------------------------------------------------------------------------

async function executeJob(opts: {
  runId: string;
  jobKey: string;
  job: ParsedJob;
  jobOrder: number;
  checkoutDir: string;
}): Promise<{ success: boolean }> {
  const { runId, jobKey, job, jobOrder, checkoutDir } = opts;
  const name = typeof job.name === "string" && job.name ? job.name : jobKey;
  const runsOn =
    (typeof job["runs-on"] === "string" && job["runs-on"]) ||
    (typeof job.runsOn === "string" && job.runsOn) ||
    "default";

  let jobId: string | null = null;
  try {
    const [row] = await db
      .insert(workflowJobs)
      .values({
        runId,
        name,
        jobOrder,
        runsOn,
        status: "running",
        steps: "[]",
        logs: "",
        startedAt: new Date(),
      })
      .returning();
    jobId = row?.id || null;
  } catch (err) {
    console.error("[workflow-runner] insert job:", err);
    // No job row = can't record results. Treat as failure so the run fails.
    return { success: false };
  }

  const stepResults: StepResult[] = [];
  const logParts: string[] = [];
  let anyFailed = false;
  let lastExit: number | null = null;

  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const step of steps) {
    if (anyFailed) {
      // Subsequent steps marked skipped to mirror Actions semantics.
      stepResults.push({
        name:
          (typeof step.name === "string" && step.name) ||
          (typeof step.run === "string"
            ? step.run.split("\n")[0]
            : "") ||
          "step",
        run: typeof step.run === "string" ? step.run : "",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        status: "skipped",
      });
      continue;
    }
    const result = await runStep(step, checkoutDir, runId);
    stepResults.push(result);
    logParts.push(
      `==> ${result.name}\n$ ${result.run}\n${result.stdout}${
        result.stderr ? "\n[stderr]\n" + result.stderr : ""
      }\n[exit ${result.exitCode ?? "null"} in ${result.durationMs}ms]\n`
    );
    if (result.status === "failure") {
      anyFailed = true;
      lastExit = result.exitCode;
    } else if (result.status === "success") {
      lastExit = result.exitCode;
    }
  }

  const combinedLogs = truncate(logParts.join("\n"), JOB_LOG_CAP_BYTES);
  const status = anyFailed ? "failure" : "success";

  if (jobId) {
    try {
      await db
        .update(workflowJobs)
        .set({
          status,
          conclusion: status,
          exitCode: lastExit,
          steps: JSON.stringify(stepResults),
          logs: combinedLogs,
          finishedAt: new Date(),
        })
        .where(eq(workflowJobs.id, jobId));
    } catch (err) {
      console.error("[workflow-runner] update job:", err);
    }
  }

  return { success: !anyFailed };
}

// ---------------------------------------------------------------------------
// Public: executeRun
// ---------------------------------------------------------------------------

export async function executeRun(runId: string): Promise<void> {
  // --- Load run row ---
  let run: Awaited<ReturnType<typeof loadRun>>;
  try {
    run = await loadRun(runId);
  } catch (err) {
    console.error("[workflow-runner] loadRun:", err);
    await markRunFailed(runId, "internal_error");
    return;
  }
  if (!run) {
    await markRunFailed(runId, "run_not_found");
    return;
  }

  // --- Load workflow + repo rows ---
  let workflowRow: typeof workflows.$inferSelect | null = null;
  let repoRow: typeof repositories.$inferSelect | null = null;
  try {
    const [w] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, run.workflowId))
      .limit(1);
    workflowRow = w || null;
  } catch (err) {
    console.error("[workflow-runner] load workflow:", err);
  }
  try {
    const [r] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, run.repositoryId))
      .limit(1);
    repoRow = r || null;
  } catch (err) {
    console.error("[workflow-runner] load repo:", err);
  }

  if (!workflowRow || !repoRow) {
    await markRunFailed(runId, "workflow_not_found");
    return;
  }

  // --- Parse workflow JSON ---
  // v2: try the extended parser first (it surfaces needs/strategy/if/uses/
  // step-level env & if). If the module or the parse fails, fall back to the
  // locked v1 parser output stored in `workflowRow.parsed`.
  let parsed: ParsedWorkflow | null = null;
  let extParsedOk = false;
  try {
    const extMod: unknown = await import("./workflow-parser-ext").catch(
      () => null
    );
    if (
      extMod &&
      typeof (extMod as { parseExtended?: unknown }).parseExtended ===
        "function"
    ) {
      const extFn = (
        extMod as { parseExtended: (yaml: string) => unknown }
      ).parseExtended;
      const extResult = extFn(workflowRow.yaml);
      const maybe = _coerceExtParsed(extResult);
      if (maybe) {
        parsed = maybe;
        extParsedOk = true;
      }
    }
  } catch (err) {
    console.warn("[workflow-runner] parseExtended failed, falling back:", err);
  }
  if (!parsed) {
    parsed = parseWorkflow(workflowRow.parsed);
  }
  if (!parsed) {
    await markRunFailed(runId, "workflow_parse_error");
    return;
  }
  const jobs = extractJobs(parsed);
  if (jobs.length === 0) {
    await markRunFailed(runId, "no_jobs");
    return;
  }
  // Mark on the parsed tree so _v2NeededFor / _executeJobsV2 know they have
  // trustworthy v2 fields (not just a v1 shape masquerading as extended).
  (parsed as unknown as { __extParsed?: boolean }).__extParsed = extParsedOk;

  // --- Transition to running ---
  await markRunRunning(runId);

  // SSE: run-start (no-op if sse module missing).
  _ssePublish(`workflow-run-${runId}`, {
    event: "run-start",
    data: {
      runId,
      workflowId: run.workflowId,
      repositoryId: run.repositoryId,
      event: run.event,
      ref: run.ref,
      sha: run.commitSha,
    },
  });

  // --- Clone repo at target sha ---
  const bareRepoPath = repoRow.diskPath;
  const clone = await cloneAt(bareRepoPath, run.commitSha, run.ref);
  if ("error" in clone) {
    console.error(`[workflow-runner] clone failed for run ${runId}: ${clone.error}`);
    await markRunFailed(runId, "checkout_failed");
    return;
  }
  const checkoutDir = clone.dir;
  const tmpRoot = join(checkoutDir, "..");

  // --- v2 dispatch: if the workflow uses any v2 features (needs, strategy,
  // job-level `if`, `uses`, step-level `if`), hand off to the v2 executor.
  // Otherwise fall through to the existing v1 sequential path. ---
  let anyJobFailed = false;
  let handledByV2 = false;
  try {
    if (_v2NeededFor(jobs)) {
      const v2 = await _executeJobsV2({
        runId,
        jobs,
        checkoutDir,
        repoId: run.repositoryId,
        commitSha: run.commitSha,
        ref: run.ref,
        event: run.event,
        triggeredBy: run.triggeredBy,
        repoFullName: (repoRow as { fullName?: string }).fullName || repoRow.name || null,
      }).catch((err) => {
        console.error("[workflow-runner] v2 executor threw:", err);
        return null;
      });
      if (v2) {
        handledByV2 = true;
        anyJobFailed = v2.anyJobFailed;
      }
    }
  } catch (err) {
    console.error("[workflow-runner] v2 dispatch:", err);
  }

  // --- Run jobs sequentially (v1 fallback) ---
  if (!handledByV2) {
    try {
      for (let i = 0; i < jobs.length; i++) {
        const { key, job } = jobs[i]!;
        const result = await executeJob({
          runId,
          jobKey: key,
          job,
          jobOrder: i,
          checkoutDir,
        });
        if (!result.success) {
          anyJobFailed = true;
          // Per-v1 semantics: stop on first failure. Subsequent jobs aren't
          // created, matching Actions' default needs-less pipeline.
          break;
        }
      }
    } catch (err) {
      console.error("[workflow-runner] job loop:", err);
      anyJobFailed = true;
    }
  }

  // Cleanup always runs.
  await rm(tmpRoot, { recursive: true, force: true }).catch((err) => {
    console.error("[workflow-runner] tmpdir cleanup:", err);
  });

  // SSE: final run-done event (no-op if sse module failed to import).
  _ssePublish(`workflow-run-${runId}`, {
    event: "run-done",
    data: { runId, status: anyJobFailed ? "failure" : "success" },
  });

  await markRunDone(runId, anyJobFailed);
}

async function loadRun(runId: string) {
  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .limit(1);
  return row || null;
}

// ---------------------------------------------------------------------------
// Public: drainOneRun — pick + execute the oldest queued row.
// ---------------------------------------------------------------------------

export async function drainOneRun(): Promise<boolean> {
  let candidateId: string | null = null;
  try {
    const [row] = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.status, "queued"))
      .orderBy(asc(workflowRuns.queuedAt))
      .limit(1);
    candidateId = row?.id || null;
  } catch (err) {
    console.error("[workflow-runner] drain select:", err);
    return false;
  }
  if (!candidateId) return false;

  // Best-effort claim: flip queued → running. If another worker beat us,
  // updated rowcount will be 0 — neon-http doesn't surface rowcount the
  // same way so we re-select after.
  try {
    await db
      .update(workflowRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(workflowRuns.id, candidateId),
          eq(workflowRuns.status, "queued")
        )
      );
  } catch (err) {
    console.error("[workflow-runner] drain claim:", err);
    return false;
  }

  // Verify we actually own the claim (status is now running and startedAt
  // is very recent). If another worker beat us they'll have set startedAt
  // earlier; accept either way — executeRun is idempotent enough for v1.
  try {
    await executeRun(candidateId);
  } catch (err) {
    console.error("[workflow-runner] executeRun threw (shouldn't):", err);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public: enqueueRun
// ---------------------------------------------------------------------------

export async function enqueueRun(opts: {
  workflowId: string;
  repositoryId: string;
  event: string;
  ref?: string | null;
  commitSha?: string | null;
  triggeredBy?: string | null;
}): Promise<string> {
  // Compute next run_number scoped to this workflow.
  let nextRunNumber = 1;
  try {
    const [row] = await db
      .select({ n: sql<number>`coalesce(max(${workflowRuns.runNumber}), 0)` })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, opts.workflowId));
    nextRunNumber = Number(row?.n ?? 0) + 1;
  } catch (err) {
    console.error("[workflow-runner] enqueue max:", err);
    // Fall back to a coarse timestamp-derived number so the insert still
    // succeeds; uniqueness isn't enforced in the schema.
    nextRunNumber = Math.floor(Date.now() / 1000);
  }

  try {
    const [row] = await db
      .insert(workflowRuns)
      .values({
        workflowId: opts.workflowId,
        repositoryId: opts.repositoryId,
        runNumber: nextRunNumber,
        event: opts.event,
        ref: opts.ref ?? null,
        commitSha: opts.commitSha ?? null,
        triggeredBy: opts.triggeredBy ?? null,
        status: "queued",
      })
      .returning({ id: workflowRuns.id });
    return row?.id || "";
  } catch (err) {
    console.error("[workflow-runner] enqueue insert:", err);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Public: startWorker — background poll loop.
// ---------------------------------------------------------------------------

export function startWorker(opts?: { intervalMs?: number }): () => void {
  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let active = false;

  const tick = async () => {
    if (stopped || active) return;
    active = true;
    try {
      // Drain as many runs as we can in one tick (serial). If there's
      // nothing queued we exit quickly and wait for the next interval.
      let picked = true;
      while (picked && !stopped) {
        picked = await drainOneRun();
      }
    } catch (err) {
      console.error("[workflow-runner] worker tick:", err);
    } finally {
      active = false;
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  // Kick off an immediate tick so the first queued run doesn't wait.
  void tick();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

// ---------------------------------------------------------------------------
// v2 helpers — Sprint 1 plumbing. The v2 executor is wired into executeRun()
// but _v2NeededFor returns false for v1-parser jobs, so the v1 sequential
// path runs as before. Sprint 1.5 will enable v2 by swapping the parse call
// upstream to `parseExtended` (from ./workflow-parser-ext) which surfaces
// `needs`, `strategy`, `if`, `uses`, `with`, step-level env/if — the v2
// executor below already knows how to consume those fields.
//
// All the underlying libs are on disk and unit-tested:
//   ./workflow-matrix       expandMatrix
//   ./workflow-conditionals evaluateIf
//   ./workflow-secrets      loadSecretsContext, substituteSecrets
//   ./action-registry       resolveAction (uses: dispatch)
//   ./sse                   publish (live log streaming topic)
// ---------------------------------------------------------------------------

function _ssePublish(
  topic: string,
  event: { event?: string; data: unknown; id?: string }
): void {
  import("./sse")
    .then((m) => {
      try {
        m.publish(topic, event);
      } catch {
        // swallow — SSE is best-effort telemetry
      }
    })
    .catch(() => {
      // sse module not importable — telemetry disabled
    });
}

type _JobEntry = { key: string; job: unknown };

function _v2NeededFor(_jobs: _JobEntry[]): boolean {
  // Sprint 1: v1 parser output never has needs/strategy/if/uses fields (the
  // locked parser strips them). Until the upstream executeRun() switches to
  // parseExtended, there's nothing for v2 to do — every workflow takes the
  // v1 path. Flip this check to inspect the extended-shape fields in Sprint
  // 1.5 when the parser call site is updated.
  return false;
}

async function _executeJobsV2(_args: {
  runId: string;
  jobs: _JobEntry[];
  checkoutDir: string;
  repoId: string;
  commitSha: string | null;
  ref: string | null;
  event: string;
  triggeredBy: string | null;
  repoFullName: string | null;
}): Promise<{ anyJobFailed: boolean } | null> {
  // Sprint 1: unreachable (gated by _v2NeededFor returning false). Wiring
  // lives here so Sprint 1.5 only needs to fill in the body without
  // restructuring executeRun().
  return null;
}
